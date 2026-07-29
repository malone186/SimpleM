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
from datetime import date, timedelta
from typing import Any, Optional

logger = logging.getLogger(__name__)


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
    from app.services.ai.forecast_service import KR_HOLIDAYS_2026

    return KR_HOLIDAYS_2026


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
             "lag": int(overrides.get(i["code"], i["default_lag"]))}
            for i in CARD_ISSUERS
        ]
        return {
            "revenue_tier": tier_code,
            "tier_label": tier["label"],
            "credit_fee_pct": credit,
            "check_fee_pct": check,
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
        db.commit()
    finally:
        db.close()
    return get_settings(store_id)


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
    for c in cards or []:
        code = str(c.get("issuer") or "").strip()
        amount = int(c.get("amount") or 0)
        if amount <= 0:
            continue
        if code not in ISSUER_BY_CODE:
            raise SettlementError(f"알 수 없는 카드사입니다: {code}")
        card_type = "check" if c.get("card_type") == "check" else "credit"
        rows.append(DailySalesEntry(
            store_id=store_id, entry_date=entry_date, method="card", issuer=code,
            card_type=card_type, amount=amount,
            cups=c.get("cups"), memo=c.get("memo"),
        ))

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
        "avg_price": round((cash + card_total) / cups) if cups else None,
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
    today = date.today()
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
    today = date.today()
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
