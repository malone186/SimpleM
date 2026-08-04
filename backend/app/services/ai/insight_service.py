"""선제 인사이트 엔진 (백엔드 B) — 사장님이 묻기 전에 DB가 먼저 말하게 한다

이 파일은 "지금 사장님이 놓치고 있을 만한 일"과 "곧 해야 할 일"을 매장 데이터에서
규칙으로 뽑아낸다. 사람이 화면을 열어봐야 알 수 있던 것들을 시스템이 먼저 찾는다.

설계 원칙:
  - 전부 DB 사실 기반이다. LLM이 지어낼 여지가 없도록 수치·날짜를 규칙이 계산한다.
    (문장을 다듬는 건 챗봇이 하되, 근거 숫자는 여기서 만든 값만 쓴다)
  - 먼저 말을 걸지 않는다. 결과는 알림 목록으로만 나가고, 대화는 사장님이 시작한다.
  - 스캐너 하나가 실패해도 나머지 인사이트는 정상 반환한다 (매장마다 안 쓰는 기능이 있다).
  - 같은 인사이트는 key로 중복 제거되고, 사장님이 확인/미루기 하면 그 상태를 존중한다.

카테고리: inventory | order | document | tax | sales | staff | data | market(주변 상권 변화)
          settlement(카드 정산·입금) | customer(단골) | marketing(홍보) | system(POS·센서 연동)
          forecast(수요 전망) | menu(메뉴 수익성) | reward(포인트)
심각도  : high(지금 조치) | medium(이번 주) | low(알아두면 좋음)

[두 개의 티어]
앱은 이 스캔을 10분마다 폴링한다. 그래서 스캐너는 '빠른 것'과 '무거운 것'을 나눈다.
  · _SCANNERS      — DB 몇 쿼리로 끝나는 것. 매 호출마다 돈다.
  · _DEEP_SCANNERS — 손님별 방문 통계(N+1)나 외부 사이트 수집처럼 초 단위가 걸리는 것.
                     매장당 DEEP_TTL_SECONDS에 한 번만 돌고, 그 사이에는 직전 결과를
                     그대로 쓴다. 폴링 경로에서는 백그라운드로 갱신해 응답을 막지 않는다.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from datetime import date, datetime, time as dtime, timedelta
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# 규칙 임계값 — 한 곳에 모아 매장 특성에 맞게 조정하기 쉽게 한다
RUNOUT_WARN_DAYS = 5        # 소진까지 이 일수 이하면 알린다
CONSUMPTION_WINDOW = 14     # 일평균 소비량을 계산할 관측 기간(일)
STALE_DRAFT_DAYS = 3        # 초안이 이만큼 방치되면 알린다
PRICE_SURGE_PCT = 10.0      # 단가 인상 알림 기준(%)
SALES_DROP_PCT = 20.0       # 매출 급락 알림 기준(%)
SALES_GAP_DAYS = 2          # 판매 기록이 이만큼 끊기면 입력 누락 의심
STOCKTAKE_CYCLE_DAYS = 30   # 재고실사 권장 주기
DORMANT_DAYS = 60           # 이 기간 움직임이 없으면 사장 재고로 본다
WEEKLY_ALLOWANCE_HOURS = 15 # 주휴수당 발생 기준 주간 근무시간
NEARBY_CHANGE_DAYS = 14     # 주변 카페 개업·폐업을 '최근 소식'으로 볼 기간
STALE_ORDER_DAYS = 3        # 발주서가 초안/대기로 이만큼 머물면 알린다
MARKETING_QUIET_DAYS = 14   # 홍보물을 이 기간 안 만들었으면 제안한다
POS_STALE_HOURS = 24        # POS 자동 동기화가 이만큼 멈추면 연동 이상으로 본다
COST_RATIO_WARN = 45.0      # 메뉴 원가율 경고선(%) — 넘으면 판매가·레시피 점검
DEMAND_SURGE_PCT = 20.0     # 내일 예상 판매가 주간 평균보다 이만큼 높으면 준비 알림
RAIN_PROB_PCT = 60          # 내일 강수확률이 이 이상이면 비 대비 알림
CHECKIN_WAIT_MINUTES = 3    # 단골 체크인(결제 요청)이 이만큼 대기하면 알린다
DEEP_TTL_SECONDS = 6 * 3600 # 무거운 스캐너 재실행 간격 (매장당)

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _db():
    from app.core.database import SessionLocal

    return SessionLocal()


def _now() -> datetime:
    """현지 시간대가 붙은 현재 시각.

    PostgreSQL의 TIMESTAMPTZ 컬럼(sold_at, created_at 등)은 시간대가 붙은 값으로 돌아온다.
    naive datetime과 직접 비교하면 TypeError가 나므로, 파이썬 쪽 비교는 항상 이 값을 쓴다.
    """
    return datetime.now().astimezone()


def _aware(dt: datetime) -> datetime:
    """tz 정보가 없는 값은 현지 시간대로 간주 — 그래야 _now()와 뺄 수 있다."""
    return dt if dt.tzinfo else dt.astimezone()


def _insight(
    key: str,
    category: str,
    severity: str,
    title: str,
    body: str,
    action: str,
    due_date: Optional[str] = None,
    days_left: Optional[int] = None,
    todo: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "category": category,
        "severity": severity,
        "title": title,
        "body": body,
        "action": action,       # 챗봇에게 그대로 말하면 처리되는 문구
        "due_date": due_date,
        "days_left": days_left,
        # 홈 '오늘 할 일'에 그대로 얹을 짧은 라벨 (없으면 title에서 만든다).
        # 알림 제목은 상황을 알리는 문장이지만, 투두 한 줄은 훑어보는 라벨이라야 한다
        # — "어제 매출이 입력되지 않았어요"(알림) vs "어제 매출 입력"(할 일).
        "todo": todo,
    }


# ---------------------------------------------------------------------------
# 스캐너 — 각각 독립적으로 동작하고, 실패해도 나머지에 영향을 주지 않는다
# ---------------------------------------------------------------------------

def _scan_stock_runout(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """재고 소진 예측 — 최근 소비 속도로 '며칠 뒤 바닥나는지' 계산한다.

    안전재고 미달 경고(이미 있는 기능)와 다르다. 아직 넉넉해 보여도 빨리 나가는
    재료는 미리 잡아내고, 안 나가는 재료로 헛알림을 만들지 않는다.
    """
    from app.models.inventory import Ingredient, Stock, StockTransaction

    since = _now() - timedelta(days=CONSUMPTION_WINDOW)
    rows = (
        db.query(Stock, Ingredient.name, Ingredient.unit, Ingredient.id)
        .join(Ingredient, Stock.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id)
        .all()
    )
    if not rows:
        return []

    ing_ids = [r[3] for r in rows]
    consumed: dict[int, float] = defaultdict(float)
    for tx in (
        db.query(StockTransaction)
        .filter(
            StockTransaction.ingredient_id.in_(ing_ids),
            StockTransaction.created_at >= since,
            StockTransaction.quantity_change < 0,
        )
        .all()
    ):
        consumed[tx.ingredient_id] += abs(float(tx.quantity_change or 0))

    out: list[dict[str, Any]] = []
    for stock, name, unit, ing_id in rows:
        daily = consumed.get(ing_id, 0.0) / CONSUMPTION_WINDOW
        if daily <= 0:
            continue  # 최근 안 나간 재료는 소진 예측 대상이 아니다
        remaining = float(stock.current_quantity or 0)
        days_left = int(remaining / daily)
        if days_left > RUNOUT_WARN_DAYS:
            continue
        runout_date = today + timedelta(days=days_left)
        severity = "high" if days_left <= 2 else "medium"
        when = "오늘내일 중" if days_left <= 1 else f"{days_left}일 뒤"
        out.append(_insight(
            key=f"stock_runout:{ing_id}:{runout_date.isoformat()}",
            category="inventory",
            severity=severity,
            title=f"{name} {when} 소진 예상",
            body=(
                f"남은 수량 {round(remaining, 2)}{unit}, 최근 {CONSUMPTION_WINDOW}일 평균 "
                f"하루 {round(daily, 2)}{unit}씩 나가고 있어요. 이 속도면 "
                f"{runout_date.isoformat()}쯤 바닥납니다."
            ),
            action=f"{name} 재고 얼마나 남았어?",
            todo=f"{name} 발주",
            due_date=runout_date.isoformat(),
            days_left=days_left,
        ))
    return out


def _scan_renewals(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """보건증·위생교육·계약 갱신 만료 임박 — 등록해 둔 만료일 기준."""
    from app.models.ai import ComplianceItem

    out = []
    for item in db.query(ComplianceItem).filter(ComplianceItem.store_id == store_id).all():
        try:
            expiry = date.fromisoformat(item.expiry_date)
        except (TypeError, ValueError):
            continue
        days_left = (expiry - today).days
        if days_left > (item.remind_before_days or 30):
            continue
        if days_left < 0:
            severity, title = "high", f"{item.name} 이미 만료됨"
            body = f"만료일이 {item.expiry_date}로 {-days_left}일 지났어요. 갱신이 필요합니다."
        elif days_left <= 7:
            severity, title = "high", f"{item.name} 만료 {days_left}일 전"
            body = f"만료일 {item.expiry_date}. 발급 기관 예약에 시간이 걸릴 수 있어요."
        else:
            severity, title = "medium", f"{item.name} 만료 {days_left}일 전"
            body = f"만료일은 {item.expiry_date}입니다."
        out.append(_insight(
            key=f"renewal:{item.id}:{item.expiry_date}",
            category="document",
            severity=severity,
            title=title,
            body=body + (f" (메모: {item.memo})" if item.memo else ""),
            action="갱신 임박한 서류 목록 보여줘",
            todo=f"{item.name} 갱신",
            due_date=item.expiry_date,
            days_left=days_left,
        ))
    return out


def _scan_nearby_changes(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """주변 카페 개업·폐업 — 매일 쌓아 둔 관측 대장(nearby_cafe_watch)만 읽는다.

    여기서는 네이버를 부르지 않는다. 이 스캐너는 앱이 10분마다 폴링하는 경로라
    외부 호출을 넣으면 화면 전체가 그만큼 느려진다. 수집은 알림 스케줄러와
    지도 화면 조회가 백그라운드로 하고(nearby_watch_service), 여기서는 결과만 본다.
    """
    from app.services.ai import nearby_watch_service

    changes = nearby_watch_service.recent_changes(db, store_id, days=NEARBY_CHANGE_DAYS)
    out = []

    for cafe in changes["opened"][:3]:
        out.append(_insight(
            key=f"nearby_open:{cafe['place_key']}",
            category="market",
            severity="medium",
            title=f"근처에 카페가 새로 생겼어요 — {cafe['name']}",
            body=f"내 매장에서 {cafe['distance_m']}m. {cafe['first_seen']}부터 검색에 잡히기 시작했어요.",
            action=f"{cafe['name']} 어떤 카페야?",
            todo="",
            due_date=cafe["first_seen"] or None,
        ))

    for cafe in changes["closed"][:3]:
        out.append(_insight(
            key=f"nearby_close:{cafe['place_key']}",
            category="market",
            severity="medium",
            title=f"근처 카페가 문을 닫은 것 같아요 — {cafe['name']}",
            body=(f"내 매장에서 {cafe['distance_m']}m. 며칠째 검색에서 사라졌어요(추정). "
                  "그 가게 손님을 받을 준비를 해 보세요."),
            action="우리 동네 상권 어때?",
            todo="",
            due_date=cafe.get("closed_on"),
        ))

    return out


def _scan_tax_deadlines(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """세무 신고 기한 임박 — 개인사업자 기준 고정 일정."""
    y = today.year
    schedule = [
        (date(y, 1, 25), "부가가치세 확정신고 (2기)", "작년 하반기 매출·매입분"),
        (date(y, 5, 31), "종합소득세 신고", "작년 한 해 소득분"),
        (date(y, 7, 25), "부가가치세 확정신고 (1기)", "올해 상반기 매출·매입분"),
        (date(y + 1, 1, 25), "부가가치세 확정신고 (2기)", "올해 하반기 매출·매입분"),
    ]
    out = []
    for due, name, note in schedule:
        days_left = (due - today).days
        if not 0 <= days_left <= 14:
            continue
        out.append(_insight(
            key=f"tax:{due.isoformat()}",
            category="tax",
            severity="high" if days_left <= 5 else "medium",
            title=f"{name} D-{days_left}",
            body=f"신고 기한은 {due.isoformat()}입니다 ({note}). 참고자료를 미리 만들어 두면 수월해요.",
            action="부가세 신고 참고자료 만들어줘",
            todo=f"{name} 준비",
            due_date=due.isoformat(),
            days_left=days_left,
        ))
    return out


def _scan_stale_ocr_drafts(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """촬영해 놓고 확정 안 한 명세서 — 확정 전엔 재고·장부 어디에도 안 잡힌다."""
    from app.models.ai import OcrDocument

    cutoff = _now() - timedelta(days=STALE_DRAFT_DAYS)
    drafts = (
        db.query(OcrDocument)
        .filter(
            OcrDocument.store_id == store_id,
            OcrDocument.status == "draft",
            OcrDocument.created_at <= cutoff,
        )
        .order_by(OcrDocument.created_at)
        .limit(20)
        .all()
    )
    if not drafts:
        return []
    oldest = drafts[0]
    waited = (_now().date() - oldest.created_at.date()).days
    total = sum(float(d.total or 0) for d in drafts)
    return [_insight(
        key=f"ocr_stale:{len(drafts)}:{oldest.id}",
        category="document",
        severity="medium",
        title=f"확정 안 한 명세서 {len(drafts)}건",
        body=(
            f"가장 오래된 건은 {waited}일째 초안 상태예요"
            + (f" ({oldest.vendor_name})" if oldest.vendor_name else "")
            + f". 합계 {int(total):,}원이 아직 재고·장부에 반영되지 않았습니다."
        ),
        action="확정 안 된 OCR 문서 목록 보여줘",
        todo=f"명세서 {len(drafts)}건 확정",
    )]
def _scan_price_surge(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """매입 단가 인상 — 원가율에 바로 영향을 준다."""
    from app.models.inventory import Ingredient, IngredientPriceHistory

    since = _now() - timedelta(days=30)
    rows = (
        db.query(IngredientPriceHistory, Ingredient.name, Ingredient.id)
        .join(Ingredient, IngredientPriceHistory.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id, IngredientPriceHistory.changed_at >= since)
        .order_by(IngredientPriceHistory.changed_at)
        .all()
    )
    prices: dict[int, list[int]] = defaultdict(list)
    names: dict[int, str] = {}
    for h, name, ing_id in rows:
        if h.price and h.price > 0:
            prices[ing_id].append(int(h.price))
            names[ing_id] = name

    out = []
    for ing_id, series in prices.items():
        if len(series) < 2:
            continue
        oldest, newest = series[0], series[-1]
        change = (newest - oldest) / oldest * 100
        if change < PRICE_SURGE_PCT:
            continue
        out.append(_insight(
            key=f"price_surge:{ing_id}:{newest}",
            category="inventory",
            severity="medium" if change < 25 else "high",
            title=f"{names[ing_id]} 단가 {round(change, 1)}% 인상",
            body=(
                f"최근 30일 사이 {oldest:,}원에서 {newest:,}원으로 올랐어요. "
                "원가율이 함께 오르니 판매가나 공급처를 점검해 보시는 게 좋겠습니다."
            ),
            action=f"{names[ing_id]} 인터넷 최저가 비교해줘",
            todo=f"{names[ing_id]} 단가 확인",
        ))
    return out


def _scan_sales_anomaly(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """매출 급락과 판매 입력 누락 — 두 가지 모두 판매 원장에서 읽는다."""
    from app.models.inventory import Sale

    out: list[dict[str, Any]] = []
    now = _now()

    recent = (
        db.query(Sale)
        .filter(Sale.store_id == store_id, Sale.sold_at >= now - timedelta(days=14))
        .all()
    )
    if not recent:
        return out

    this_week = sum(
        int(s.total_price or 0) for s in recent if s.sold_at >= now - timedelta(days=7)
    )
    last_week = sum(
        int(s.total_price or 0)
        for s in recent
        if now - timedelta(days=14) <= s.sold_at < now - timedelta(days=7)
    )
    if last_week > 0:
        change = (this_week - last_week) / last_week * 100
        if change <= -SALES_DROP_PCT:
            out.append(_insight(
                key=f"sales_drop:{today.isoformat()}",
                category="sales",
                severity="high",
                title=f"최근 7일 매출 {abs(round(change, 1))}% 감소",
                body=(
                    f"직전 7일 {last_week:,}원 → 최근 7일 {this_week:,}원입니다. "
                    "요일 구성이나 날씨 영향일 수도 있어 원인을 함께 보시면 좋겠어요."
                ),
                action="이번 주 경영 리포트 만들어줘",
                todo="매출 하락 원인 보기",
            ))

    last_sale = max(s.sold_at for s in recent)
    gap_days = (now.date() - last_sale.date()).days
    if gap_days >= SALES_GAP_DAYS:
        out.append(_insight(
            key=f"sales_gap:{last_sale.date().isoformat()}",
            category="data",
            severity="medium",
            title=f"판매 기록이 {gap_days}일째 없어요",
            body=(
                f"마지막 매출 입력이 {last_sale.date().isoformat()}입니다. "
                "휴무였다면 넘기셔도 되고, 입력이 밀린 거라면 채워두셔야 원가·예측이 정확해져요."
            ),
            action="최근 판매 내역 보여줘",
            todo="판매 기록 입력",
        ))
    return out


def _scan_staff_hours(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """주휴수당 발생 임박 — 주 15시간을 넘기면 수당이 붙는다."""
    from app.models.operation import Employee, Schedule

    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    rows = (
        db.query(Schedule, Employee.name, Employee.hourly_rate)
        .join(Employee, Schedule.employee_id == Employee.id)
        .filter(
            Employee.store_id == store_id,
            Schedule.date >= monday.isoformat(),
            Schedule.date <= sunday.isoformat(),
        )
        .all()
    )
    hours: dict[str, float] = defaultdict(float)
    rates: dict[str, int] = {}
    for s, name, rate in rows:
        if s.start_time and s.end_time:
            hours[name] += (s.end_time - s.start_time).total_seconds() / 3600
        rates[name] = int(rate or 0)

    out = []
    for name, h in hours.items():
        if h < WEEKLY_ALLOWANCE_HOURS - 1.5:
            continue
        weekly_pay = int(rates.get(name, 0) * (h / 40) * 8) if h >= WEEKLY_ALLOWANCE_HOURS else 0
        if h >= WEEKLY_ALLOWANCE_HOURS:
            out.append(_insight(
                key=f"weekly_allowance:{name}:{monday.isoformat()}",
                category="staff",
                severity="medium",
                title=f"{name}님 이번 주 {round(h, 1)}시간 — 주휴수당 발생",
                body=(
                    f"주 {WEEKLY_ALLOWANCE_HOURS}시간을 넘겨 주휴수당 지급 대상이에요. "
                    f"예상 주휴수당은 약 {weekly_pay:,}원입니다 (실제 지급액은 임금명세서에서 확인)."
                ),
                action=f"{name} 이번 달 임금명세서 초안 만들어줘",
                todo=f"{name}님 주휴수당 확인",
            ))
        else:
            out.append(_insight(
                key=f"weekly_allowance_near:{name}:{monday.isoformat()}",
                category="staff",
                severity="low",
                title=f"{name}님 이번 주 {round(h, 1)}시간 — 주휴수당 경계",
                body=(
                    f"{round(WEEKLY_ALLOWANCE_HOURS - h, 1)}시간만 더 배정되면 주휴수당이 발생해요. "
                    "의도한 편성인지 확인해 보시면 좋겠습니다."
                ),
                action="이번 주 근무 스케줄 보여줘",
                todo="",
            ))
    return out


def _scan_missing_contracts(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """근로계약서 없는 직원 — 미작성은 근로기준법 위반이다."""
    from app.models.ai import GeneratedDocument
    from app.models.operation import Employee

    employees = db.query(Employee).filter(Employee.store_id == store_id).all()
    if not employees:
        return []
    contracts = (
        db.query(GeneratedDocument)
        .filter(
            GeneratedDocument.store_id == store_id,
            GeneratedDocument.kind == "employment_contract",
        )
        .all()
    )
    titles = " ".join(c.title or "" for c in contracts)
    missing = [e.name for e in employees if e.name and e.name not in titles]
    if not missing:
        return []
    shown = ", ".join(missing[:4]) + (f" 외 {len(missing) - 4}명" if len(missing) > 4 else "")
    return [_insight(
        key=f"contract_missing:{','.join(sorted(missing))}",
        category="staff",
        severity="medium",
        title=f"근로계약서 없는 직원 {len(missing)}명",
        body=(
            f"{shown}의 근로계약서 초안이 아직 없어요. 서면 작성·교부는 법정 의무라 "
            "미작성 시 과태료 대상이 될 수 있습니다."
        ),
        action=f"{missing[0]} 근로계약서 초안 만들어줘",
        todo="근로계약서 작성",
    )]


def _scan_periodic_documents(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """주기적으로 만들어야 하는 문서 — 재고실사표, 지난달 장부."""
    from app.models.ai import GeneratedDocument

    out = []
    latest_stocktake = (
        db.query(GeneratedDocument)
        .filter(
            GeneratedDocument.store_id == store_id,
            GeneratedDocument.kind == "stocktake_sheet",
        )
        .order_by(GeneratedDocument.created_at.desc())
        .first()
    )
    if latest_stocktake is None:
        out.append(_insight(
            key="stocktake:never",
            category="document",
            severity="low",
            title="재고실사를 아직 한 번도 안 하셨어요",
            body=(
                "장부 수량과 실제 수량은 시간이 지날수록 벌어집니다. "
                "실사표를 뽑아 한 번 맞춰두면 원가 계산이 정확해져요."
            ),
            action="재고실사표 만들어줘",
            todo="재고 실사",
        ))
    else:
        elapsed = (today - latest_stocktake.created_at.date()).days
        if elapsed >= STOCKTAKE_CYCLE_DAYS:
            out.append(_insight(
                key=f"stocktake:{latest_stocktake.created_at.date().isoformat()}",
                category="document",
                severity="low",
                title=f"재고실사 {elapsed}일째 안 함",
                body=(
                    f"마지막 실사표가 {latest_stocktake.created_at.date().isoformat()}자예요. "
                    f"{STOCKTAKE_CYCLE_DAYS}일에 한 번은 맞춰보시길 권합니다."
                ),
                action="재고실사표 만들어줘",
            todo="재고 실사",
            ))

    # 지난달 장부 — 달이 바뀌고 5일이 지났는데 없으면 알린다
    if today.day >= 5:
        last_month = (today.replace(day=1) - timedelta(days=1))
        period = f"{last_month.year}-{last_month.month:02d}"
        exists = (
            db.query(GeneratedDocument)
            .filter(
                GeneratedDocument.store_id == store_id,
                GeneratedDocument.kind == "monthly_ledger",
                GeneratedDocument.period == period,
            )
            .first()
        )
        if exists is None:
            out.append(_insight(
                key=f"ledger_missing:{period}",
                category="document",
                severity="medium",
                title=f"{last_month.month}월 매입·매출 장부가 없어요",
                body=(
                    f"{period} 장부를 아직 만들지 않으셨습니다. 부가세 신고 때 근거자료가 되니 "
                    "미리 정리해 두시면 편해요."
                ),
                action=f"{last_month.year}년 {last_month.month}월 장부 만들어줘",
            todo=f"{last_month.month}월 장부 만들기",
            ))
    return out


def _scan_data_quality(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """데이터가 비어 기능이 못 도는 구멍 — 레시피 없는 메뉴, 잠자는 재고."""
    from app.models.inventory import Ingredient, Menu, Recipe, Stock, StockTransaction

    out = []

    menus = db.query(Menu).filter(Menu.store_id == store_id, Menu.is_active.is_(True)).all()
    if menus:
        menu_ids = [m.id for m in menus]
        with_recipe = {
            r.menu_id for r in db.query(Recipe).filter(Recipe.menu_id.in_(menu_ids)).all()
        }
        missing = [m.name for m in menus if m.id not in with_recipe]
        if missing:
            shown = ", ".join(missing[:4]) + (f" 외 {len(missing) - 4}개" if len(missing) > 4 else "")
            out.append(_insight(
                key=f"menu_no_recipe:{len(missing)}",
                category="data",
                severity="medium",
                title=f"레시피 없는 메뉴 {len(missing)}개",
                body=(
                    f"{shown}에 레시피가 없어 원가율과 재고 자동 차감이 계산되지 않아요. "
                    "재료와 사용량을 넣어주시면 판매할 때마다 재고가 알아서 빠집니다."
                ),
                action="레시피 없는 메뉴 알려줘",
            todo="레시피 등록",
            ))

    dormant_cutoff = _now() - timedelta(days=DORMANT_DAYS)
    stocks = (
        db.query(Stock, Ingredient.name, Ingredient.unit, Ingredient.id, Ingredient.current_price)
        .join(Ingredient, Stock.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id, Stock.current_quantity > 0)
        .all()
    )
    if stocks:
        ing_ids = [s[3] for s in stocks]
        recent_ids = {
            tx.ingredient_id
            for tx in db.query(StockTransaction)
            .filter(
                StockTransaction.ingredient_id.in_(ing_ids),
                StockTransaction.created_at >= dormant_cutoff,
            )
            .all()
        }
        dormant = [
            {"name": name, "quantity": float(st.current_quantity or 0), "price": int(price or 0)}
            for st, name, _unit, ing_id, price in stocks
            if ing_id not in recent_ids
        ]
        if dormant:
            tied = sum(d["quantity"] * d["price"] for d in dormant)
            shown = ", ".join(d["name"] for d in dormant[:4])
            rest = f" 외 {len(dormant) - 4}종" if len(dormant) > 4 else ""
            out.append(_insight(
                key=f"dormant_stock:{len(dormant)}",
                category="inventory",
                severity="low",
                title=f"{DORMANT_DAYS}일간 안 움직인 재고 {len(dormant)}종",
                body=(
                    f"{shown}{rest}이(가) 입출고 없이 쌓여 있어요. "
                    f"묶인 금액이 약 {int(tied):,}원입니다. 유통기한이나 폐기 위험을 확인해 보세요."
                ),
                action="재고 현황 보여줘",
            todo="안 쓰는 재고 정리",
            ))
    return out


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    """그 날 00:00 ~ 다음 날 00:00 (현지 시간대 부착).

    TIMESTAMPTZ 컬럼과 비교하려면 tz가 붙어 있어야 한다 — naive와 비교하면 TypeError.
    """
    start = datetime.combine(day, dtime.min).astimezone()
    return start, start + timedelta(days=1)


# ---------------------------------------------------------------------------
# 카드 정산 — 어제 매출 입력 누락 · 오늘 들어올 돈
# ---------------------------------------------------------------------------

def _scan_settlement(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """정산 화면을 안 열어도 '입력 안 한 날'과 '오늘 입금'을 먼저 알려준다.

    매출 입력이 빠지면 정산·리포트·예측이 전부 한 칸씩 어긋난다. 그런데 그 사실은
    화면을 열어봐야만 보인다 — 그래서 어제분이 비어 있으면 여기서 먼저 말한다.
    """
    from app.models.ai import DailySalesEntry
    from app.models.inventory import Sale

    out: list[dict[str, Any]] = []
    yesterday = today - timedelta(days=1)

    # ① 어제 매출 미입력 — 정산 입력과 메뉴별 판매(POS·수기) 둘 다 없을 때만.
    #    한쪽이라도 있으면 그날 장사 기록은 남아 있는 것이라 잔소리가 된다.
    entered = (
        db.query(DailySalesEntry.id)
        .filter(DailySalesEntry.store_id == store_id,
                DailySalesEntry.entry_date == yesterday.isoformat())
        .first()
    )
    if entered is None:
        start, end = _day_bounds(yesterday)
        sold = (
            db.query(Sale.id)
            .filter(Sale.store_id == store_id, Sale.sold_at >= start, Sale.sold_at < end)
            .first()
        )
        if sold is None:
            out.append(_insight(
                key=f"settlement_missing:{yesterday.isoformat()}",
                category="settlement",
                severity="medium",
                title="어제 매출이 아직 입력되지 않았어요",
                body=(
                    f"{yesterday.isoformat()}의 현금·카드 매출 기록이 비어 있습니다. "
                    "휴무였다면 넘기셔도 되고, 아니라면 30초만 들여 채워두셔야 "
                    "입금 예정일·리포트·수요 예측이 어긋나지 않아요."
                ),
                action="어제 매출 입력하는 법 알려줘",
            todo="어제 매출 입력",
                due_date=yesterday.isoformat(),
            ))

    # ② 오늘 통장에 들어올 카드 대금 — 아는 것만으로 자금 계획이 달라진다
    try:
        from app.services.ai import settlement_service

        deposits = settlement_service.upcoming_deposits(store_id, lookback_days=14, ahead_days=7)
    except Exception:
        logger.debug("정산 입금 예정 조회 실패 (%s)", store_id, exc_info=True)
        return out

    nxt = deposits.get("next_deposit")
    if nxt and nxt.get("deposit_date") == today.isoformat() and int(nxt.get("net") or 0) > 0:
        issuers = ", ".join(sorted({i["issuer_name"] for i in nxt.get("items", [])})[:3])
        out.append(_insight(
            key=f"settlement_deposit:{today.isoformat()}",
            category="settlement",
            severity="low",
            title=f"오늘 카드 대금 {int(nxt['net']):,}원 입금 예정",
            body=(
                f"{issuers or '카드사'}에서 수수료 {int(nxt.get('fee') or 0):,}원을 뗀 금액이 "
                f"오늘 들어옵니다. 이번 주 입금 예정 합계는 {int(deposits.get('this_week_net') or 0):,}원이에요."
            ),
            action="이번 주 카드 입금 예정 알려줘",
            todo="",
            due_date=today.isoformat(),
        ))
    return out


# ---------------------------------------------------------------------------
# 단골 손님 — 대기 중인 체크인 (지금 매장에 서 있는 손님이다)
# ---------------------------------------------------------------------------

def _scan_waiting_checkins(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """QR로 결제를 요청해 놓고 처리를 기다리는 단골 — 손님이 카운터 앞에 있다는 뜻이다."""
    from app.services import membership_service

    waiting = membership_service.list_waiting_checkins(db, store_id)
    stuck = [w for w in waiting if w.get("waited_minutes", 0) >= CHECKIN_WAIT_MINUTES]
    if not stuck:
        return []

    head = stuck[0]
    name = head.get("name") or head.get("phone_masked") or "단골 손님"
    return [_insight(
        # 대기 인원이 바뀌면 새 인사이트가 된다 — 한 번 확인 처리해도 다음 손님은 다시 뜬다
        key=f"checkin_waiting:{len(stuck)}:{head['checkin_id']}",
        category="customer",
        severity="high",
        title=f"{name}님이 {head['waited_minutes']}분째 기다리고 있어요",
        body=(
            f"QR {'회원 등록' if head.get('is_signup') else '결제 요청'}이 {len(stuck)}건 대기 중입니다. "
            "단골 화면에서 확인해 주세요."
        ),
        action="대기 중인 단골 손님 알려줘",
        todo="대기 손님 응대",
    )]


# ---------------------------------------------------------------------------
# 홍보 — 만들어 둔 홍보 도구를 쓰지 않고 지나가는 것도 손실이다
# ---------------------------------------------------------------------------

def _scan_marketing(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """홍보 공백과 '이번 주말' 타이밍을 잡아 먼저 제안한다."""
    from app.models.ai import GeneratedDocument
    from app.services.ai.marketing_service import DOC_KIND

    latest = (
        db.query(GeneratedDocument.created_at)
        .filter(GeneratedDocument.store_id == store_id, GeneratedDocument.kind == DOC_KIND)
        .order_by(GeneratedDocument.created_at.desc())
        .first()
    )
    elapsed = None if latest is None else (today - latest[0].date()).days
    if elapsed is not None and elapsed < MARKETING_QUIET_DAYS:
        return []

    # 목·금이면 주말 장사를 걸고, 아니면 공백 자체를 이유로 삼는다
    weekend = today.weekday() in (3, 4)
    if weekend:
        title = "이번 주말 홍보물, 지금 만들어 두세요"
        body = ("주말 전에 올린 게시물이 주말 손님을 부릅니다. 메뉴 하나만 고르면 "
                "브루가 문구와 사진을 만들어 드려요 (30초).")
    elif elapsed is None:
        title = "아직 홍보물을 한 번도 안 만드셨어요"
        body = ("메뉴 사진 한 장이면 인스타·배달앱에 쓸 문구와 홍보 이미지가 만들어집니다. "
                "가장 잘 팔리는 메뉴로 한 번 해 보세요.")
    else:
        title = f"홍보물을 만든 지 {elapsed}일 됐어요"
        body = ("사람들은 최근에 본 가게를 고릅니다. 신메뉴나 시즌 메뉴로 "
                "게시물 하나만 올려도 검색·재방문에 도움이 돼요.")

    return [_insight(
        # 주 단위로 키가 바뀐다 — 한 번 넘겨도 다음 주에 다시 권한다(매일 조르지는 않는다)
        key=f"marketing_quiet:{today.isocalendar()[0]}-W{today.isocalendar()[1]:02d}",
        category="marketing",
        severity="low",
        title=title,
        body=body,
        action="인스타에 올릴 홍보 문구 만들어줘",
        todo="",
    )]


# ---------------------------------------------------------------------------
# 연동 상태 — POS·센서가 조용히 죽어 있으면 모든 자동화가 함께 멈춘다
# ---------------------------------------------------------------------------

def _scan_pos_health(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """POS 연동 오류·동기화 정지. 연결한 적 없는 매장은 건너뛴다."""
    from app.models.ai import PosConnection

    conn = db.query(PosConnection).filter(PosConnection.store_id == store_id).first()
    if conn is None:
        return []

    if conn.last_status == "error":
        return [_insight(
            key=f"pos_error:{(conn.last_error or '')[:40]}",
            category="system",
            severity="high",
            title="POS 연동에 오류가 났어요",
            body=(
                f"마지막 동기화가 실패했습니다: {(conn.last_error or '원인 미상')[:120]}. "
                "매출이 앱으로 들어오지 않으면 리포트·예측·재고 차감이 모두 멈춥니다."
            ),
            action="POS 연동 상태 확인해줘",
            todo="POS 연동 점검",
        )]

    if conn.auto_sync and conn.last_synced_at is not None:
        hours = (_now() - _aware(conn.last_synced_at)).total_seconds() / 3600
        if hours >= POS_STALE_HOURS:
            return [_insight(
                key=f"pos_stale:{_aware(conn.last_synced_at).date().isoformat()}",
                category="system",
                severity="medium",
                title=f"POS 매출이 {int(hours / 24)}일째 들어오지 않았어요",
                body=(
                    f"마지막 동기화 {_aware(conn.last_synced_at).strftime('%m월 %d일 %H:%M')}. "
                    "휴무였다면 정상이고, 아니라면 연결이 끊겼을 수 있어요."
                ),
                action="POS 지금 동기화해줘",
                todo="POS 동기화 확인",
            )]
    return []


def _scan_sensor_faults(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """냉장고 온도 이탈 같은 설비 이상 — 식자재 폐기로 직결된다."""
    from app.services.ai import sensor_service

    if not sensor_service.is_feature_enabled(store_id):
        return []

    items = sensor_service.get_recommendations(store_id).get("items") or []
    faults = [i for i in items
              if i.get("priority") == "urgent" and i.get("source") in ("온도센서", "수위센서")]
    return [_insight(
        key=f"sensor_fault:{f.get('source')}:{f.get('title')}",
        category="system",
        severity="high",
        title=str(f.get("title") or "설비 이상"),
        body=f"{f.get('reason', '')} {f.get('action', '')}".strip(),
        action="센서 상태 알려줘",
        todo="설비 이상 확인",
    ) for f in faults[:2]]


# ---------------------------------------------------------------------------
# 발주 — 만들어 놓고 보내지 않은 발주서
# ---------------------------------------------------------------------------

def _scan_stale_orders(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """초안·승인대기로 멈춰 있는 발주서. 보낸 줄 알고 넘어가면 재고가 끊긴다."""
    from app.models.inventory import Order

    cutoff = _now() - timedelta(days=STALE_ORDER_DAYS)
    rows = (
        db.query(Order)
        .filter(Order.store_id == store_id,
                Order.status.in_(["DRAFT", "PENDING"]),
                Order.created_at <= cutoff)
        .order_by(Order.created_at)
        .limit(20)
        .all()
    )
    if not rows:
        return []

    oldest = rows[0]
    waited = (today - oldest.created_at.date()).days
    total = sum(int(o.total_amount or 0) for o in rows)
    return [_insight(
        key=f"order_stale:{len(rows)}:{oldest.id}",
        category="order",
        severity="medium",
        title=f"보내지 않은 발주서 {len(rows)}건",
        body=(
            f"가장 오래된 건이 {waited}일째 {'초안' if oldest.status == 'DRAFT' else '승인 대기'} 상태예요. "
            f"묶여 있는 금액은 {total:,}원입니다. 이미 다른 경로로 발주했다면 정리해 두세요."
        ),
        action="진행 안 된 발주서 보여줘",
        todo=f"발주서 {len(rows)}건 마무리",
    )]


# ---------------------------------------------------------------------------
# 급여 — 임금명세서는 교부가 법정 의무다 (지난달분)
# ---------------------------------------------------------------------------

def _scan_payslips(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """직원이 있는데 지난달 임금명세서가 없으면 알린다 (매월 5일 이후)."""
    if today.day < 5:
        return []

    from app.models.ai import GeneratedDocument
    from app.models.operation import Employee

    if db.query(Employee.id).filter(Employee.store_id == store_id).first() is None:
        return []

    last_month = today.replace(day=1) - timedelta(days=1)
    period = f"{last_month.year}-{last_month.month:02d}"
    exists = (
        db.query(GeneratedDocument.id)
        .filter(GeneratedDocument.store_id == store_id,
                GeneratedDocument.kind == "payslip",
                GeneratedDocument.period == period)
        .first()
    )
    if exists is not None:
        return []

    return [_insight(
        key=f"payslip_missing:{period}",
        category="staff",
        severity="medium",
        title=f"{last_month.month}월 임금명세서가 없어요",
        body=(
            "임금명세서는 급여를 줄 때 서면·문자로 교부해야 하는 법정 서류이고, "
            "임금대장 겸용으로 3년 보관 의무가 있습니다. 근무 기록으로 초안을 만들어 드릴게요."
        ),
        action=f"{last_month.month}월 임금명세서 초안 만들어줘",
        todo=f"{last_month.month}월 임금명세서 만들기",
    )]


# ---------------------------------------------------------------------------
# 수요 전망 — 이미 계산해 둔 예측 캐시만 읽는다 (여기서 예측을 돌리지 않는다)
# ---------------------------------------------------------------------------

def _scan_demand_outlook(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """내일 손님이 몰릴지·비가 올지를 미리 말해 준다.

    예측 계산은 대시보드·알림 스케줄러가 이미 돌려 캐시에 넣어 둔다. 여기서 직접
    forecast()를 부르면 10분마다 SARIMAX가 도는 셈이라, 캐시가 없으면 조용히 넘어간다.
    """
    from app.services.ai import forecast_service

    hit = forecast_service.peek_forecast_cache(store_id)
    if not hit:
        return []
    result = hit[0]
    tomorrow = result.get("tomorrow") or {}
    week = result.get("week") or []
    if not tomorrow:
        return []

    out: list[dict[str, Any]] = []
    cups = int(tomorrow.get("cups") or 0)
    date_iso = tomorrow.get("date") or (today + timedelta(days=1)).isoformat()
    avg = sum(int(d.get("cups") or 0) for d in week) / len(week) if week else 0

    if avg > 0 and cups >= avg * (1 + DEMAND_SURGE_PCT / 100):
        pct = round((cups / avg - 1) * 100)
        reasons = ", ".join(tomorrow.get("adjustments") or []) or tomorrow.get("holiday") or ""
        out.append(_insight(
            key=f"demand_surge:{date_iso}",
            category="forecast",
            severity="medium",
            title=f"내일({tomorrow.get('weekday', '')}) 평소보다 {pct}% 바쁠 것 같아요",
            body=(
                f"예상 {cups}잔 · 매출 {int(tomorrow.get('revenue') or 0):,}원 (이번 주 평균 {round(avg)}잔). "
                + (f"근거: {reasons}. " if reasons else "")
                + "우유·원두·컵을 넉넉히 채워두고 인력을 한 번 더 확인해 보세요."
            ),
            action="내일 얼마나 팔릴 것 같아?",
            todo="내일 재료·인력 준비",
            due_date=date_iso,
            days_left=1,
        ))

    precip = tomorrow.get("precip_prob")
    if precip is not None and int(precip) >= RAIN_PROB_PCT:
        out.append(_insight(
            key=f"weather_rain:{date_iso}",
            category="forecast",
            severity="low",
            title=f"내일 비 예보 (강수확률 {int(precip)}%)",
            body=(
                "비 오는 날은 방문 손님이 줄고 배달·테이크아웃이 늘어납니다. "
                "우산꽂이와 미끄럼 주의 표시를 미리 꺼내두고, 재료 발주는 조금 보수적으로 잡으세요."
            ),
            action="비 오는 날 뭘 준비하면 좋아?",
            todo="",
            due_date=date_iso,
            days_left=1,
        ))
    return out


# ---------------------------------------------------------------------------
# 메뉴 수익성 — 팔수록 손해인 메뉴를 그냥 두지 않는다
# ---------------------------------------------------------------------------

def _scan_menu_margin(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """원가율이 위험한 메뉴 (레시피가 등록된 메뉴만 — 없으면 원가를 알 수 없다)."""
    from app.services.ai import sales_service

    rows = [
        m for m in sales_service.menu_contribution(store_id, days=30).get("menus", [])
        if not m.get("recipe_missing") and m.get("cost_ratio") is not None and m.get("sold_qty", 0) > 0
    ]
    if not rows:
        return []

    losing = [m for m in rows if m["margin_per_cup"] <= 0]
    if losing:
        head = max(losing, key=lambda m: m["sold_qty"])
        names = ", ".join(m["name"] for m in losing[:3])
        return [_insight(
            key=f"menu_loss:{','.join(sorted(str(m['menu_id']) for m in losing))}",
            category="menu",
            severity="high",
            title=f"{head['name']}은(는) 팔수록 손해예요",
            body=(
                f"판매가 {head['selling_price']:,}원인데 재료 원가가 {head['cost_price']:,}원입니다"
                f"(최근 30일 {head['sold_qty']}잔 판매). "
                + (f"같은 상태인 메뉴: {names}. " if len(losing) > 1 else "")
                + "판매가·레시피 용량·재료 단가 중 하나가 잘못 입력됐을 수도 있으니 먼저 확인해 보세요."
            ),
            action=f"{head['name']} 원가 분석해줘",
            todo=f"{head['name']} 판매가 점검",
        )]

    risky = sorted([m for m in rows if m["cost_ratio"] >= COST_RATIO_WARN],
                   key=lambda m: -m["cost_ratio"])
    if not risky:
        return []
    head = risky[0]
    return [_insight(
        key=f"menu_cost:{head['menu_id']}:{int(head['cost_ratio'])}",
        category="menu",
        severity="medium",
        title=f"{head['name']} 원가율 {head['cost_ratio']}%",
        body=(
            f"판매가 {head['selling_price']:,}원 대비 재료비가 {head['cost_price']:,}원입니다. "
            f"한 잔 남는 돈은 {head['margin_per_cup']:,}원이에요"
            + (f" (같은 기준 40% 초과 메뉴 {len(risky)}종). " if len(risky) > 1 else ". ")
            + "재료를 더 싸게 사거나 판매가를 조정할 여지가 있는지 보시면 좋겠어요."
        ),
        action=f"{head['name']} 재료 최저가 비교해줘",
        todo=f"{head['name']} 원가 낮추기",
    )]


# ---------------------------------------------------------------------------
# 포인트 — 쌓아만 두고 안 쓰는 보상
# ---------------------------------------------------------------------------

def _scan_rewards(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """살 수 있는 아이템이 있는데 포인트를 안 쓰고 있으면 가볍게 알린다."""
    from app.models.ai import OwnedItem, PointLedger
    from app.services.ai.reward_service import SHOP_ITEMS

    balance = sum(int(r[0] or 0) for r in
                  db.query(PointLedger.delta).filter(PointLedger.store_id == store_id).all())
    if balance <= 0:
        return []

    owned = {r[0] for r in db.query(OwnedItem.item_id)
             .filter(OwnedItem.store_id == store_id).all()}
    affordable = [i for i in SHOP_ITEMS if i["id"] not in owned and i["price"] <= balance]
    if not affordable:
        return []

    cheapest = min(affordable, key=lambda i: i["price"])
    return [_insight(
        # 100점 단위로 키가 바뀐다 — 한 번 넘기면 더 모을 때까지 조용하다
        key=f"points_idle:{balance // 100}",
        category="reward",
        severity="low",
        title=f"포인트 {balance:,}점이 쌓여 있어요",
        body=(
            f"할 일을 끝낼 때마다 모인 점수예요. 지금 '{cheapest['name']}'"
            f"({cheapest['price']:,}점) 같은 아이템 {len(affordable)}종을 바꿀 수 있어요."
        ),
        action="상점에 뭐 있어?",
        todo="",
    )]


# ---------------------------------------------------------------------------
# 무거운 스캐너 — 매장당 DEEP_TTL_SECONDS에 한 번만 돈다
# ---------------------------------------------------------------------------

def _scan_churn_customers(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """평소 주기보다 오래 안 온 단골. 손님마다 방문 통계를 세므로 무거운 축이다."""
    from app.services import membership_service

    rows = membership_service.find_churn_risk(db, store_id, limit=10)
    if not rows:
        return []

    with_balance = [r for r in rows if (r.get("balance") or 0) > 0]
    head = (with_balance or rows)[0]
    name = head.get("name") or head.get("phone_masked") or "단골 손님"
    reason = (f"잔액 {head['balance']:,}원이 남아 있어 연락할 명분도 있어요."
              if (head.get("balance") or 0) > 0
              else "잔액이 없는 분이라 쿠폰 한 장이 다시 오실 이유가 됩니다.")
    return [_insight(
        key=f"churn_risk:{len(rows)}:{head['customer_id']}",
        category="customer",
        severity="medium",
        title=f"뜸해진 단골 {len(rows)}명 — {name}님 외",
        body=(
            f"{name}님은 평소 {head['median_interval_days']}일마다 오시는데 "
            f"{head['days_since_visit']}일째 안 오셨어요(평소의 {head['overdue_ratio']}배). {reason}"
        ),
        action="요즘 안 오는 단골 알려줘",
        todo="뜸해진 단골 연락",
    )]


def _scan_bean_price_drop(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """생두 시세 하락 — 지금이 사 둘 때인지 알려준다 (외부 사이트 수집)."""
    from app.services.ai import bean_price_watch_service

    drops = bean_price_watch_service.get_today_drops(db)
    if not drops:
        return []
    top = drops[0]
    return [_insight(
        key=f"bean_drop:{today.isoformat()}:{top['bean_id']}",
        category="inventory",
        severity="low",
        title=f"{top['name']} 시세가 {top['drop_pct']:g}% 내렸어요",
        body=(
            f"{top['old_price']:,}원 → {top['new_price']:,}원/kg"
            + (f" (오늘 내린 원두 {len(drops)}종). " if len(drops) > 1 else ". ")
            + "쓰던 원두라면 지금이 채워둘 만한 때예요."
        ),
        action=f"{top['name']} 시세 알려줘",
        todo="",
    )]


_SCANNERS: list[tuple[str, Callable]] = [
    ("stock_runout", _scan_stock_runout),
    ("renewals", _scan_renewals),
    ("tax_deadlines", _scan_tax_deadlines),
    ("stale_ocr", _scan_stale_ocr_drafts),
    ("price_surge", _scan_price_surge),
    ("sales_anomaly", _scan_sales_anomaly),
    ("staff_hours", _scan_staff_hours),
    ("missing_contracts", _scan_missing_contracts),
    ("periodic_documents", _scan_periodic_documents),
    ("data_quality", _scan_data_quality),
    ("nearby_changes", _scan_nearby_changes),
    ("settlement", _scan_settlement),
    ("waiting_checkins", _scan_waiting_checkins),
    ("marketing", _scan_marketing),
    ("pos_health", _scan_pos_health),
    ("sensor_faults", _scan_sensor_faults),
    ("stale_orders", _scan_stale_orders),
    ("payslips", _scan_payslips),
    ("demand_outlook", _scan_demand_outlook),
    ("menu_margin", _scan_menu_margin),
    ("rewards", _scan_rewards),
]

# 손님별 방문 통계·외부 사이트 수집처럼 초 단위가 걸리는 것들 (매장당 6시간에 한 번)
_DEEP_SCANNERS: list[tuple[str, Callable]] = [
    ("churn_customers", _scan_churn_customers),
    ("bean_price_drop", _scan_bean_price_drop),
]


# ---------------------------------------------------------------------------
# 무거운 스캐너 실행·캐시 — 폴링 응답을 막지 않는다
# ---------------------------------------------------------------------------

_deep_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}  # store → (계산 시각, 결과)
_deep_inflight: set[str] = set()
_deep_lock = threading.Lock()


def _run_deep(store_id: str, today: date) -> list[dict[str, Any]]:
    """무거운 스캐너를 실제로 돌린다 (자체 세션 — 백그라운드 스레드에서도 안전)."""
    found: list[dict[str, Any]] = []
    with _db() as db:
        for name, scanner in _DEEP_SCANNERS:
            try:
                found.extend(scanner(db, store_id, today))
            except Exception:
                logger.exception("무거운 인사이트 스캐너 실패: %s (store=%s)", name, store_id)
                db.rollback()
    return found


def _deep_insights(store_id: str, today: date, block: bool = False) -> list[dict[str, Any]]:
    """캐시된 무거운 인사이트. 만료됐으면 백그라운드로 갱신하고 직전 결과를 돌려준다.

    block=True면 지금 계산해서 최신 결과를 준다 — 알림 스케줄러처럼 '한 번 도는 배치'용.
    """
    hit = _deep_cache.get(store_id)
    if hit and time.time() - hit[0] < DEEP_TTL_SECONDS:
        return hit[1]

    if block:
        items = _run_deep(store_id, today)
        _deep_cache[store_id] = (time.time(), items)
        return items

    def _refresh() -> None:
        try:
            items = _run_deep(store_id, today)
            _deep_cache[store_id] = (time.time(), items)
        except Exception:
            logger.exception("무거운 인사이트 갱신 실패 (%s)", store_id)
        finally:
            with _deep_lock:
                _deep_inflight.discard(store_id)

    with _deep_lock:
        if store_id not in _deep_inflight:
            _deep_inflight.add(store_id)
            threading.Thread(target=_refresh, name=f"insight-deep-{store_id[:12]}",
                             daemon=True).start()

    return hit[1] if hit else []


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def scan(store_id: str, include_dismissed: bool = False,
         deep: bool = False) -> dict[str, Any]:
    """매장 데이터를 훑어 지금 알릴 만한 인사이트를 모두 돌려준다.

    include_dismissed=False(기본)면 사장님이 확인했거나 미뤄둔 항목은 빼고 준다.
    deep=True면 무거운 스캐너(단골 이탈·원두 시세)를 지금 돌려 최신 결과를 포함한다 —
    스케줄러처럼 한 번만 도는 배치용이고, 앱 폴링 경로는 기본값(캐시+백그라운드 갱신)을 쓴다.
    """
    from app.models.ai import InsightAck

    today = date.today()
    found: list[dict[str, Any]] = _deep_insights(store_id, today, block=deep)
    failed: list[str] = []

    with _db() as db:
        for name, scanner in _SCANNERS:
            try:
                found.extend(scanner(db, store_id, today))
            except Exception:
                # 매장마다 안 쓰는 기능이 있다 — 한 스캐너가 죽어도 나머지는 살린다.
                # PostgreSQL은 실패한 쿼리가 트랜잭션 전체를 막으므로 반드시 롤백해야
                # 다음 스캐너가 정상 동작한다 (이게 없으면 격리가 무의미해진다).
                logger.exception("인사이트 스캐너 실패: %s (store=%s)", name, store_id)
                db.rollback()
                failed.append(name)

        # 중복 제거 (같은 key가 여러 스캐너에서 나올 수 있다)
        unique: dict[str, dict[str, Any]] = {}
        for item in found:
            unique.setdefault(item["key"], item)

        if not include_dismissed and unique:
            now = _now()
            acks = (
                db.query(InsightAck)
                .filter(
                    InsightAck.store_id == store_id,
                    InsightAck.insight_key.in_(list(unique.keys())),
                )
                .all()
            )
            for ack in acks:
                if ack.snooze_until is None or ack.snooze_until > now:
                    unique.pop(ack.insight_key, None)

    items = sorted(
        unique.values(),
        key=lambda i: (SEVERITY_ORDER.get(i["severity"], 9), i.get("days_left") if i.get("days_left") is not None else 99),
    )
    by_severity = defaultdict(int)
    for i in items:
        by_severity[i["severity"]] += 1

    return {
        "store_id": store_id,
        "generated_at": _now().isoformat(timespec="seconds"),
        "count": len(items),
        "high": by_severity["high"],
        "medium": by_severity["medium"],
        "low": by_severity["low"],
        "failed_scanners": failed,
        "insights": items,
    }


def dismiss(store_id: str, insight_key: str, snooze_days: int = 0) -> dict[str, Any]:
    """인사이트를 확인 처리한다. snooze_days>0이면 그 기간만 숨기고 다시 올라온다."""
    from app.models.ai import InsightAck

    now = _now()
    snooze_until = now + timedelta(days=snooze_days) if snooze_days > 0 else None
    with _db() as db:
        row = (
            db.query(InsightAck)
            .filter(InsightAck.store_id == store_id, InsightAck.insight_key == insight_key)
            .first()
        )
        if row is None:
            row = InsightAck(store_id=store_id, insight_key=insight_key)
            db.add(row)
        row.acked_at = now
        row.snooze_until = snooze_until
        db.commit()
    return {
        "insight_key": insight_key,
        "acked_at": now.isoformat(timespec="seconds"),
        "snooze_until": snooze_until.isoformat(timespec="seconds") if snooze_until else None,
    }
