"""카드 매출 정산 (백엔드 B) — 현금/카드사별 매출 입력 → 수수료·입금 예정일 계산

왜 이 기능이 필요한가:
  POS 연동이 없는 매장에서 메뉴별 잔 수를 매일 세는 사장님은 거의 없다. 반면
  "카드사별로 언제 얼마가 통장에 들어오는지"는 매일 궁금하고, 카드사마다 입금일이
  달라 직접 계산하기 번거롭다. 그래서 입력은 '결제수단별 총액'까지만 받고,
  대신 입금 예정일·수수료·실입금액을 대신 계산해 준다.

계산 근거:
  - 지급 기일: 여신전문금융업법 시행령상 카드사는 매출전표 접수일부터 영업일 기준
    3일(영세·중소 가맹점은 2일) 이내에 대금을 지급해야 한다. 여기서는 그 상한을
    기본값으로 쓰고, 실제 통장 입금일과 다르면 사장님이 카드사별로 고칠 수 있다.
  - 수수료율: 금융위 고시 우대수수료율 구간(연매출 3억 이하 / 3~5억 / 5~10억 /
    10~30억)과 30억 초과 일반가맹점 평균을 기본값으로 둔다. 실제 계약률이 다르면
    'custom'으로 직접 입력한다.
  - 영업일: 주말과 대한민국 공휴일(forecast_service의 공휴일표)을 건너뛴다.

즉 여기서 나오는 숫자는 '계약서 기준 예상치'다. 화면에도 예상임을 밝히고,
사장님이 실제 입금일을 보고 보정할 수 있게 만들었다.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from app.utils.datetime_kst import today_kst

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))


class SettlementError(ValueError):
    """정산 입력·조회 실패"""


def _session():
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
    from app.core.database import SessionLocal

    return SessionLocal()


# ---------------------------------------------------------------------------
# 카드사 마스터
# ---------------------------------------------------------------------------
# default_lag = 매출 발생일로부터 입금까지 걸리는 영업일 수 (D+n 영업일).
# 법정 상한(3영업일, 영세·중소 2영업일)을 기준으로 한 기본값이며 매장별로 덮어쓸 수 있다.
CARD_ISSUERS: list[dict[str, Any]] = [
    {"code": "shinhan", "name": "신한카드", "default_lag": 2, "color": "#1F4E9C"},
    {"code": "kb", "name": "KB국민카드", "default_lag": 2, "color": "#6A5A48"},
    {"code": "samsung", "name": "삼성카드", "default_lag": 2, "color": "#1428A0"},
    {"code": "hyundai", "name": "현대카드", "default_lag": 2, "color": "#2C2C2C"},
    {"code": "lotte", "name": "롯데카드", "default_lag": 2, "color": "#B8272D"},
    {"code": "hana", "name": "하나카드", "default_lag": 2, "color": "#00857E"},
    {"code": "woori", "name": "우리카드", "default_lag": 2, "color": "#0067AC"},
    {"code": "nh", "name": "NH농협카드", "default_lag": 2, "color": "#0A8A3C"},
    # BC는 회원사(기업·SC·케이뱅크 등) 매출을 모아 정산하는 구조라 통상 하루 더 걸린다
    {"code": "bc", "name": "BC카드", "default_lag": 3, "color": "#E8380D"},
    # 간편결제(카카오페이·네이버페이 등)는 PG 정산 주기라 카드사와 별개로 잡는다
    {"code": "pay", "name": "간편결제(페이)", "default_lag": 3, "color": "#F4B400"},
    # 카드사를 나눠 적지 않고 총액만 입력했을 때 담기는 자리. 목록에 칩으로 뜨지 않고
    # (selectable=False) 입금일은 법정 상한인 3영업일로 보수적으로 잡는다 — 실제보다
    # 늦게 잡아야 "들어올 줄 알았는데 안 들어왔다"는 오차가 생기지 않는다.
    {"code": "unknown", "name": "카드사 미지정", "default_lag": 3, "color": "#8C6F56",
     "selectable": False},
]

ISSUER_BY_CODE = {i["code"]: i for i in CARD_ISSUERS}

# 연매출 구간별 우대수수료율 (%) — (신용, 체크)
REVENUE_TIERS: list[dict[str, Any]] = [
    {"code": "small", "label": "영세 (연매출 3억 이하)", "credit": 0.40, "check": 0.15},
    {"code": "mid1", "label": "중소1 (3억~5억)", "credit": 1.05, "check": 0.85},
    {"code": "mid2", "label": "중소2 (5억~10억)", "credit": 1.20, "check": 1.00},
    {"code": "mid3", "label": "중소3 (10억~30억)", "credit": 1.45, "check": 1.25},
    {"code": "general", "label": "일반 (30억 초과)", "credit": 2.00, "check": 1.50},
    {"code": "custom", "label": "직접 입력 (계약서 기준)", "credit": 1.50, "check": 1.20},
]

TIER_BY_CODE = {t["code"]: t for t in REVENUE_TIERS}


# ---------------------------------------------------------------------------
# 영업일 계산
# ---------------------------------------------------------------------------

def _holidays() -> dict[str, str]:
    # 입금 예정일이 연말에 다음 해로 넘어갈 수 있어 올해·내년 두 해를 함께 본다
    from app.services.ai.forecast_service import kr_holidays

    y = today_kst().year
    return kr_holidays(y, y + 1)


def is_business_day(d: date) -> bool:
    """주말·공휴일이 아니면 영업일(은행 영업일)."""
    if d.weekday() >= 5:  # 토(5)·일(6)
        return False
    return d.isoformat() not in _holidays()


def add_business_days(start: date, days: int) -> date:
    """start 다음 영업일부터 세어 days번째 영업일. days=0이면 start 자신(또는 다음 영업일)."""
    cur = start
    if days <= 0:
        while not is_business_day(cur):
            cur += timedelta(days=1)
        return cur
    remaining = days
    while remaining > 0:
        cur += timedelta(days=1)
        if is_business_day(cur):
            remaining -= 1
    return cur


# ---------------------------------------------------------------------------
# 매장 설정
# ---------------------------------------------------------------------------

def get_settings(store_id: str) -> dict[str, Any]:
    """매장의 수수료 구간·카드사별 입금 소요일. 없으면 기본값(영세 구간)."""
    from app.models.ai import SettlementSetting

    db = _session()
    try:
        row = db.get(SettlementSetting, store_id)
        tier_code = row.revenue_tier if row else "small"
        tier = TIER_BY_CODE.get(tier_code, TIER_BY_CODE["small"])
        credit = float(row.custom_credit_fee) if (row and row.revenue_tier == "custom" and row.custom_credit_fee is not None) else tier["credit"]
        check = float(row.custom_check_fee) if (row and row.revenue_tier == "custom" and row.custom_check_fee is not None) else tier["check"]
        try:
            overrides = json.loads(row.lag_overrides) if row and row.lag_overrides else {}
        except (ValueError, TypeError):
            overrides = {}
        issuers = [
            {**i, "selectable": i.get("selectable", True),
             "lag": int(overrides.get(i["code"], i["default_lag"])),
             # 사장님이 직접 고친 카드사인지 — 화면에서 '기본값'과 구분해 보여준다
             "customized": i["code"] in overrides
             and int(overrides[i["code"]]) != i["default_lag"]}
            for i in CARD_ISSUERS
        ]
        return {
            # configured=False면 아직 한 번도 설정을 저장한 적이 없다는 뜻이다.
            # 화면은 이때 '설정 마법사'를 먼저 띄운다 — 기본값이 조용히 적용된 채로
            # 두면 사장님은 자기 매장 수수료율이 뭔지 영영 모른다.
            "configured": row is not None,
            "revenue_tier": tier_code,
            "tier_label": tier["label"],
            "credit_fee_pct": credit,
            "check_fee_pct": check,
            "custom_credit_fee": float(row.custom_credit_fee)
            if (row and row.custom_credit_fee is not None) else None,
            "custom_check_fee": float(row.custom_check_fee)
            if (row and row.custom_check_fee is not None) else None,
            "lag_customized": any(i["customized"] for i in issuers),
            "issuers": issuers,
            "tiers": REVENUE_TIERS,
        }
    finally:
        db.close()


def update_settings(
    store_id: str,
    revenue_tier: Optional[str] = None,
    custom_credit_fee: Optional[float] = None,
    custom_check_fee: Optional[float] = None,
    lag_overrides: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    from app.models.ai import SettlementSetting

    if revenue_tier is not None and revenue_tier not in TIER_BY_CODE:
        raise SettlementError(f"알 수 없는 매출 구간입니다: {revenue_tier}")

    db = _session()
    try:
        row = db.get(SettlementSetting, store_id)
        if row is None:
            row = SettlementSetting(store_id=store_id)
            db.add(row)
        if revenue_tier is not None:
            row.revenue_tier = revenue_tier
        if custom_credit_fee is not None:
            row.custom_credit_fee = custom_credit_fee
        if custom_check_fee is not None:
            row.custom_check_fee = custom_check_fee
        if lag_overrides is not None:
            clean = {
                k: max(0, min(10, int(v)))
                for k, v in lag_overrides.items()
                if k in ISSUER_BY_CODE
            }
            row.lag_overrides = json.dumps(clean)
        # '직접 입력'을 골라 놓고 요율을 안 적으면 화면엔 임의의 기본값(1.5%)이 뜬다.
        # 사장님은 그게 자기 계약률인 줄 안다 — 그래서 저장 자체를 막는다.
        if row.revenue_tier == "custom" and (
            row.custom_credit_fee is None or row.custom_check_fee is None
        ):
            db.rollback()
            raise SettlementError("직접 입력을 고르셨으면 신용·체크 수수료율을 모두 적어 주세요.")
        db.commit()
    finally:
        db.close()
    return get_settings(store_id)


# ---------------------------------------------------------------------------
# 처음 쓰는 사장님을 돕는 두 가지: 구간 추천 · 입금 미리보기
# ---------------------------------------------------------------------------

def suggest_tier(store_id: str, lookback_days: int = 90) -> dict[str, Any]:
    """최근 매출로 연매출을 추정해 우대수수료율 구간을 추천한다.

    "연매출이 3억 이하인가요?"는 사장님이 바로 답하기 어려운 질문이다(부가세 신고서를
    꺼내 봐야 안다). 이미 앱에 들어와 있는 매출 — 수기 입력(daily_sales_entries)과
    POS 판매(sales) — 로 하루 평균을 내고 365일로 환산해 구간을 먼저 제안한다.

    두 출처를 더하면 같은 매출이 두 번 잡힐 수 있어(수기 입력한 날에 POS도 들어옴)
    날짜별로 더 큰 쪽만 취한다. 어차피 구간 경계(3억/5억/10억/30억)를 가르는 데는
    이 정도 정밀도로 충분하다.
    """
    from sqlalchemy import func as sa_func

    from app.models.ai import DailySalesEntry
    from app.models.inventory import Sale

    lookback_days = max(7, min(int(lookback_days), 365))
    today = today_kst()
    since = today - timedelta(days=lookback_days - 1)

    by_date: dict[str, int] = {}
    db = _session()
    try:
        manual = (
            db.query(DailySalesEntry.entry_date, sa_func.sum(DailySalesEntry.amount))
            .filter(DailySalesEntry.store_id == store_id,
                    DailySalesEntry.entry_date >= since.isoformat(),
                    DailySalesEntry.entry_date <= today.isoformat())
            .group_by(DailySalesEntry.entry_date)
            .all()
        )
        for d, amount in manual:
            by_date[d] = int(amount or 0)

        # sold_at은 timestamp라 날짜로 잘라 묶는다. 필터는 타입 이슈가 없는
        # timestamp 비교로 걸어 SQLite/Postgres 양쪽에서 같게 동작하게 했다.
        since_dt = datetime.combine(since, time.min, tzinfo=KST)
        # 날짜로 자를 때도 KST 기준이어야 한다 — 그냥 date()를 쓰면 세션 기본(UTC)이라
        # 오전 00~09시 KST 매출이 전날 몫으로 잡혀 일자별 카드 매출이 어긋난다.
        # SQLite에는 timezone()이 없어 테스트에서는 예전 방식으로 떨어진다.
        day_col = (sa_func.date(sa_func.timezone("Asia/Seoul", Sale.sold_at))
                   if db.bind.dialect.name == "postgresql" else sa_func.date(Sale.sold_at))
        pos = (
            db.query(day_col, sa_func.sum(Sale.total_price))
            .filter(Sale.store_id == store_id, Sale.sold_at >= since_dt)
            .group_by(day_col)
            .all()
        )
        for d, amount in pos:
            key = d.isoformat() if hasattr(d, "isoformat") else str(d)[:10]
            by_date[key] = max(by_date.get(key, 0), int(amount or 0))
    except Exception as e:  # POS 테이블이 없는 배포본이어도 추천 자체는 돌아가야 한다
        logger.warning("구간 추천 매출 조회 실패: %s", e)
    finally:
        db.close()

    observed_days = len([v for v in by_date.values() if v > 0])
    total = sum(by_date.values())
    daily_avg = round(total / observed_days) if observed_days else 0
    annual = daily_avg * 365

    if observed_days == 0:
        return {
            "available": False,
            "observed_days": 0,
            "reason": "아직 매출 기록이 없어 추정할 수 없어요. 며칠 입력한 뒤 다시 눌러 주세요.",
        }

    if annual <= 300_000_000:
        code = "small"
    elif annual <= 500_000_000:
        code = "mid1"
    elif annual <= 1_000_000_000:
        code = "mid2"
    elif annual <= 3_000_000_000:
        code = "mid3"
    else:
        code = "general"
    tier = TIER_BY_CODE[code]

    # 며칠치로 1년을 짚는 것이라 관측 일수가 곧 신뢰도다
    confidence = "high" if observed_days >= 28 else "medium" if observed_days >= 14 else "low"
    return {
        "available": True,
        "recommended_tier": code,
        "tier_label": tier["label"],
        "credit_fee_pct": tier["credit"],
        "check_fee_pct": tier["check"],
        "observed_days": observed_days,
        "daily_avg": daily_avg,
        "annual_estimate": annual,
        "confidence": confidence,
        "basis": f"최근 {lookback_days}일 중 매출이 있는 {observed_days}일 기준, "
                 f"하루 평균 {daily_avg:,}원 × 365일",
        "note": "실제 우대수수료율 구간은 국세청 신고 매출을 기준으로 카드사가 정해 통보해요. "
                "여기 추천은 앱에 쌓인 매출로 계산한 참고값이에요.",
    }


def preview(
    store_id: str,
    amount: int = 100_000,
    card_type: str = "credit",
    issuer: str = "",
    sale_date: Optional[str] = None,
) -> dict[str, Any]:
    """'오늘 이 카드로 N원 결제되면 언제 얼마가 들어오는지'를 한 건만 계산해 준다.

    설정 화면에서 숫자를 바꿀 때마다 결과가 눈앞에서 같이 바뀌어야 사장님이 그 설정이
    무슨 뜻인지 안다. 건너뛴 주말·공휴일도 함께 돌려줘 'D+2 영업일'을 눈으로 보게 한다.
    """
    settings = get_settings(store_id)
    lag_by_code = {i["code"]: i["lag"] for i in settings["issuers"]}
    code = issuer if issuer in ISSUER_BY_CODE else "shinhan"
    ctype = "check" if card_type == "check" else "credit"
    amount = max(0, int(amount))

    try:
        start = date.fromisoformat(sale_date) if sale_date else today_kst()
    except ValueError:
        raise SettlementError("날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)")

    detail = _card_detail(code, ctype, amount, start, lag_by_code, settings)
    deposit = date.fromisoformat(detail["deposit_date"])

    holidays = _holidays()
    skipped: list[dict[str, str]] = []
    cur = start + timedelta(days=1)
    while cur <= deposit:
        if not is_business_day(cur):
            skipped.append({
                "date": cur.isoformat(),
                "label": f"{cur.month}/{cur.day}",
                "reason": holidays.get(cur.isoformat())
                or ("토요일" if cur.weekday() == 5 else "일요일"),
            })
        cur += timedelta(days=1)

    return {
        **detail,
        "sale_date": start.isoformat(),
        "deposit_weekday": "월화수목금토일"[deposit.weekday()],
        "calendar_days": (deposit - start).days,
        "skipped": skipped,
        "tier_label": settings["tier_label"],
    }


# ---------------------------------------------------------------------------
# 매출 입력
# ---------------------------------------------------------------------------

def save_day(
    store_id: str,
    entry_date: str,
    cash: int = 0,
    cash_cups: Optional[int] = None,
    cards: Optional[list[dict[str, Any]]] = None,
    memo: Optional[str] = None,
) -> dict[str, Any]:
    """하루치 매출을 통째로 저장(덮어쓰기)한다.

    화면이 '오늘 하루 입력 폼' 하나이므로, 부분 수정이 아니라 그 날짜의 기존 입력을
    지우고 새로 넣는 편이 상태가 어긋나지 않는다. 금액 0은 저장하지 않는다.
    """
    from app.models.ai import DailySalesEntry

    try:
        date.fromisoformat(entry_date)
    except ValueError:
        raise SettlementError("날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)")

    rows: list[DailySalesEntry] = []
    if cash and cash > 0:
        rows.append(DailySalesEntry(
            store_id=store_id, entry_date=entry_date, method="cash", issuer="",
            card_type="credit", amount=int(cash), cups=cash_cups, memo=memo,
        ))
    # 같은 카드사·같은 종류가 두 줄로 오면 합친다. 유니크 키가
    # (매장, 날짜, 수단, 카드사, 종류)라 그대로 넣으면 IntegrityError가 나는데,
    # 그 시점엔 이미 그날 기존 입력을 지운 뒤라 500과 함께 저장돼 있던 하루치가
    # 통째로 날아갔다. 화면에서 '신한'을 두 번 추가하면 재현된다.
    merged: dict[tuple[str, str], DailySalesEntry] = {}
    for c in cards or []:
        code = str(c.get("issuer") or "").strip()
        amount = int(c.get("amount") or 0)
        if amount <= 0:
            continue
        if code not in ISSUER_BY_CODE:
            raise SettlementError(f"알 수 없는 카드사입니다: {code}")
        card_type = "check" if c.get("card_type") == "check" else "credit"
        key = (code, card_type)
        prev = merged.get(key)
        if prev is not None:
            prev.amount += amount
            cups = c.get("cups")
            if cups:
                prev.cups = (prev.cups or 0) + int(cups)
            if c.get("memo") and not prev.memo:
                prev.memo = c.get("memo")
            continue
        merged[key] = DailySalesEntry(
            store_id=store_id, entry_date=entry_date, method="card", issuer=code,
            card_type=card_type, amount=amount,
            cups=c.get("cups"), memo=c.get("memo"),
        )
    rows.extend(merged.values())

    db = _session()
    try:
        db.query(DailySalesEntry).filter(
            DailySalesEntry.store_id == store_id,
            DailySalesEntry.entry_date == entry_date,
        ).delete(synchronize_session=False)
        for r in rows:
            db.add(r)
        db.commit()
    finally:
        db.close()
    return get_day(store_id, entry_date)


def get_day(store_id: str, entry_date: str) -> dict[str, Any]:
    """하루치 입력 내용 + 그날 카드 매출의 수수료·입금 예정 계산."""
    from app.models.ai import DailySalesEntry

    settings = get_settings(store_id)
    lag_by_code = {i["code"]: i["lag"] for i in settings["issuers"]}

    db = _session()
    try:
        rows = db.query(DailySalesEntry).filter(
            DailySalesEntry.store_id == store_id,
            DailySalesEntry.entry_date == entry_date,
        ).all()
    finally:
        db.close()

    cash = sum(r.amount for r in rows if r.method == "cash")
    cash_cups = next((r.cups for r in rows if r.method == "cash"), None)
    cards = []
    sale_date = date.fromisoformat(entry_date)
    for r in rows:
        if r.method != "card":
            continue
        cards.append(_card_detail(r.issuer, r.card_type, r.amount, sale_date,
                                  lag_by_code, settings, cups=r.cups))

    card_total = sum(c["amount"] for c in cards)
    fee_total = sum(c["fee"] for c in cards)
    cups = sum(c["cups"] or 0 for c in cards) + (cash_cups or 0)
    # 객단가는 '잔 수를 아는 매출'끼리만 나눈다.
    #
    # 잔 수는 결제수단별 선택 입력이라 일부만 채우는 매장이 많다. 예전엔 분자에 전체
    # 매출을 넣고 분모엔 입력된 잔 수만 넣어서, 현금 10만원(잔 수 미입력) + 카드 20만원
    # /100잔이면 3,000원으로 나왔다 — 실제로 아는 건 카드분 2,000원뿐인데 50% 부풀린 값이다.
    cups_amount = sum(c["amount"] for c in cards if c["cups"]) + (cash if cash_cups else 0)
    return {
        "date": entry_date,
        "cash": cash,
        "cash_cups": cash_cups,
        "cards": cards,
        "card_total": card_total,
        "total": cash + card_total,
        "fee_total": fee_total,
        "net_total": cash + card_total - fee_total,
        "cups": cups or None,
        "avg_price": round(cups_amount / cups) if cups else None,
        "has_entry": bool(rows),
    }


def _card_detail(
    issuer: str,
    card_type: str,
    amount: int,
    sale_date: date,
    lag_by_code: dict[str, int],
    settings: dict[str, Any],
    cups: Optional[int] = None,
) -> dict[str, Any]:
    meta = ISSUER_BY_CODE.get(issuer, {"name": issuer, "color": "#8C6F56"})
    fee_pct = settings["check_fee_pct"] if card_type == "check" else settings["credit_fee_pct"]
    fee = round(amount * fee_pct / 100)
    lag = lag_by_code.get(issuer, 2)
    deposit = add_business_days(sale_date, lag)
    return {
        "issuer": issuer,
        "issuer_name": meta["name"],
        "color": meta.get("color", "#8C6F56"),
        "card_type": card_type,
        "amount": amount,
        "cups": cups,
        "fee_pct": fee_pct,
        "fee": fee,
        "net": amount - fee,
        "lag": lag,
        "deposit_date": deposit.isoformat(),
    }


# ---------------------------------------------------------------------------
# 입금 예정
# ---------------------------------------------------------------------------

def upcoming_deposits(store_id: str, lookback_days: int = 21, ahead_days: int = 21) -> dict[str, Any]:
    """앞으로 통장에 들어올 카드 대금을 날짜별로 묶어 돌려준다.

    과거 lookback_days일치 매출까지 훑는 이유는, 오늘 이후 입금될 돈의 원천이
    '이미 지나간 며칠간의 매출'이기 때문이다. 이미 입금된 건도 최근 것은 함께
    보여줘야 사장님이 통장과 대조할 수 있다.
    """
    from app.models.ai import DailySalesEntry

    settings = get_settings(store_id)
    lag_by_code = {i["code"]: i["lag"] for i in settings["issuers"]}
    today = today_kst()
    since = (today - timedelta(days=lookback_days)).isoformat()
    until = today.isoformat()

    db = _session()
    try:
        rows = db.query(DailySalesEntry).filter(
            DailySalesEntry.store_id == store_id,
            DailySalesEntry.method == "card",
            DailySalesEntry.entry_date >= since,
            DailySalesEntry.entry_date <= until,
        ).all()
    finally:
        db.close()

    by_date: dict[str, dict[str, Any]] = {}
    for r in rows:
        detail = _card_detail(r.issuer, r.card_type, r.amount,
                              date.fromisoformat(r.entry_date), lag_by_code, settings, cups=r.cups)
        d = detail["deposit_date"]
        bucket = by_date.setdefault(d, {
            "deposit_date": d,
            "weekday": "월화수목금토일"[date.fromisoformat(d).weekday()],
            "gross": 0, "fee": 0, "net": 0, "items": [],
            "settled": date.fromisoformat(d) < today,
        })
        bucket["gross"] += detail["amount"]
        bucket["fee"] += detail["fee"]
        bucket["net"] += detail["net"]
        bucket["items"].append({
            "issuer": detail["issuer"],
            "issuer_name": detail["issuer_name"],
            "color": detail["color"],
            "card_type": detail["card_type"],
            "sale_date": r.entry_date,
            "amount": detail["amount"],
            "fee": detail["fee"],
            "net": detail["net"],
        })

    limit = (today + timedelta(days=ahead_days)).isoformat()
    schedule = sorted(
        (v for k, v in by_date.items() if k <= limit),
        key=lambda x: x["deposit_date"],
    )
    for bucket in schedule:
        bucket["items"].sort(key=lambda i: -i["net"])

    pending = [s for s in schedule if not s["settled"]]
    next_deposit = pending[0] if pending else None
    # 이번 주(오늘~일요일) 안에 들어올 돈 — "이번 주에 얼마 들어와요"가 가장 자주 하는 질문
    week_end = today + timedelta(days=6 - today.weekday())
    this_week_net = sum(
        s["net"] for s in pending if date.fromisoformat(s["deposit_date"]) <= week_end
    )
    return {
        "today": today.isoformat(),
        "schedule": schedule,
        "next_deposit": next_deposit,
        "pending_net": sum(s["net"] for s in pending),
        "pending_gross": sum(s["gross"] for s in pending),
        "pending_fee": sum(s["fee"] for s in pending),
        "this_week_net": this_week_net,
        "fee_note": f"{settings['tier_label']} · 신용 {settings['credit_fee_pct']}% / 체크 {settings['check_fee_pct']}%",
    }


# ---------------------------------------------------------------------------
# 기간 요약 — 전주 동요일 대비까지 함께 (어제 대비는 사장님이 이미 감으로 안다)
# ---------------------------------------------------------------------------

def period_summary(store_id: str, days: int = 28) -> dict[str, Any]:
    """최근 days일 매출 요약 + 현금/카드 비중 + 전주 같은 요일 대비 + 카드사별 비중."""
    from app.models.ai import DailySalesEntry

    settings = get_settings(store_id)
    today = today_kst()
    since = (today - timedelta(days=days - 1)).isoformat()

    db = _session()
    try:
        rows = db.query(DailySalesEntry).filter(
            DailySalesEntry.store_id == store_id,
            DailySalesEntry.entry_date >= since,
        ).all()
    finally:
        db.close()

    daily: dict[str, dict[str, int]] = {}
    issuer_mix: dict[str, int] = {}
    for r in rows:
        d = daily.setdefault(r.entry_date, {"cash": 0, "card": 0, "fee": 0})
        if r.method == "cash":
            d["cash"] += r.amount
        else:
            d["card"] += r.amount
            pct = settings["check_fee_pct"] if r.card_type == "check" else settings["credit_fee_pct"]
            d["fee"] += round(r.amount * pct / 100)
            issuer_mix[r.issuer] = issuer_mix.get(r.issuer, 0) + r.amount

    def total_of(iso: str) -> int:
        d = daily.get(iso)
        return (d["cash"] + d["card"]) if d else 0

    today_iso = today.isoformat()
    last_week_iso = (today - timedelta(days=7)).isoformat()
    lw = total_of(last_week_iso)
    change_pct = round((total_of(today_iso) - lw) / lw * 100, 1) if lw else None

    cash_sum = sum(d["cash"] for d in daily.values())
    card_sum = sum(d["card"] for d in daily.values())
    fee_sum = sum(d["fee"] for d in daily.values())
    total = cash_sum + card_sum
    return {
        "days": days,
        "cash_total": cash_sum,
        "card_total": card_sum,
        "total": total,
        "fee_total": fee_sum,
        "cash_ratio": round(cash_sum / total * 100, 1) if total else None,
        "today_total": total_of(today_iso),
        "last_week_same_day": lw,
        "last_week_change_pct": change_pct,
        "issuer_mix": sorted(
            ({"issuer": k,
              "issuer_name": ISSUER_BY_CODE.get(k, {}).get("name", k),
              "color": ISSUER_BY_CODE.get(k, {}).get("color", "#8C6F56"),
              "amount": v,
              "ratio": round(v / card_sum * 100, 1) if card_sum else 0}
             for k, v in issuer_mix.items()),
            key=lambda x: -x["amount"],
        ),
        "daily": [
            {"date": k, **v, "total": v["cash"] + v["card"]}
            for k, v in sorted(daily.items())
        ],
    }
