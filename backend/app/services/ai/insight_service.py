"""선제 인사이트 엔진 (백엔드 B) — 사장님이 묻기 전에 DB가 먼저 말하게 한다

이 파일은 "지금 사장님이 놓치고 있을 만한 일"과 "곧 해야 할 일"을 매장 데이터에서
규칙으로 뽑아낸다. 사람이 화면을 열어봐야 알 수 있던 것들을 시스템이 먼저 찾는다.

설계 원칙:
  - 전부 DB 사실 기반이다. LLM이 지어낼 여지가 없도록 수치·날짜를 규칙이 계산한다.
    (문장을 다듬는 건 챗봇이 하되, 근거 숫자는 여기서 만든 값만 쓴다)
  - 먼저 말을 걸지 않는다. 결과는 알림 목록으로만 나가고, 대화는 사장님이 시작한다.
  - 스캐너 하나가 실패해도 나머지 인사이트는 정상 반환한다 (매장마다 안 쓰는 기능이 있다).
  - 같은 인사이트는 key로 중복 제거되고, 사장님이 확인/미루기 하면 그 상태를 존중한다.

카테고리: inventory | order | document | tax | sales | staff | data
심각도  : high(지금 조치) | medium(이번 주) | low(알아두면 좋음)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
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


def _insight(
    key: str,
    category: str,
    severity: str,
    title: str,
    body: str,
    action: str,
    due_date: Optional[str] = None,
    days_left: Optional[int] = None,
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
            action=f"{name} 발주서 초안 만들어줘",
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
            due_date=item.expiry_date,
            days_left=days_left,
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
    )]


def _scan_pending_orders(db, store_id: str, today: date) -> list[dict[str, Any]]:
    """만들어만 두고 안 보낸 발주 — 재고가 비는 원인이 되기 쉽다."""
    from app.models.inventory import Order

    cutoff = _now() - timedelta(days=STALE_DRAFT_DAYS)
    orders = (
        db.query(Order)
        .filter(
            Order.store_id == store_id,
            Order.status.in_(["DRAFT", "PENDING"]),
            Order.created_at <= cutoff,
        )
        .order_by(Order.created_at)
        .limit(20)
        .all()
    )
    if not orders:
        return []
    oldest = orders[0]
    waited = (_now().date() - oldest.created_at.date()).days
    total = sum(int(o.total_amount or 0) for o in orders)
    return [_insight(
        key=f"order_pending:{len(orders)}:{oldest.id}",
        category="order",
        severity="medium",
        title=f"진행 안 된 발주 {len(orders)}건",
        body=(
            f"가장 오래된 발주가 {waited}일째 {oldest.status} 상태입니다. "
            f"합계 {total:,}원 — 실제로 주문을 넣으셨는지 확인이 필요해요."
        ),
        action="발주 진행 상황 알려줘",
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
                f"마지막 판매 입력이 {last_sale.date().isoformat()}입니다. "
                "휴무였다면 넘기셔도 되고, 입력이 밀린 거라면 채워두셔야 원가·예측이 정확해져요."
            ),
            action="최근 판매 내역 보여줘",
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
            ))
    return out


_SCANNERS: list[tuple[str, Callable]] = [
    ("stock_runout", _scan_stock_runout),
    ("renewals", _scan_renewals),
    ("tax_deadlines", _scan_tax_deadlines),
    ("stale_ocr", _scan_stale_ocr_drafts),
    ("pending_orders", _scan_pending_orders),
    ("price_surge", _scan_price_surge),
    ("sales_anomaly", _scan_sales_anomaly),
    ("staff_hours", _scan_staff_hours),
    ("missing_contracts", _scan_missing_contracts),
    ("periodic_documents", _scan_periodic_documents),
    ("data_quality", _scan_data_quality),
]


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def scan(store_id: str, include_dismissed: bool = False) -> dict[str, Any]:
    """매장 데이터를 훑어 지금 알릴 만한 인사이트를 모두 돌려준다.

    include_dismissed=False(기본)면 사장님이 확인했거나 미뤄둔 항목은 빼고 준다.
    """
    from app.models.ai import InsightAck

    today = date.today()
    found: list[dict[str, Any]] = []
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
