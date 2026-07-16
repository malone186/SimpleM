"""AI 경영 리포트 로직 (백엔드 B) — 일간·주간·월간

카페 전체 데이터를 한 문서로 통합 집계한다:
  매출(Sale) · 매입(확정 OCR 문서) · 기타 지출(Expense) · 인건비(근무 스케줄 × 시급)
  · 재고 현황(Stock) · 발주 진행(Order) · 갱신 임박 서류(Compliance)

이전 기간과의 비교(증감률)와 규칙 기반 하이라이트까지 계산해 담고,
문장형 조언·해석은 리포트 전문가(서브에이전트 LLM)가 이 숫자를 근거로 작성한다.

생성 결과는 generated_documents(kind="management_report")로 저장된다 —
챗봇 화면에는 카드로 바로 표시되고, 서류 자동화 화면에서도 다시 볼 수 있다.
"""

import logging
from datetime import date, timedelta
from typing import Any, Optional

from app.services.ai import document_service

logger = logging.getLogger(__name__)

PERIOD_LABEL = {"daily": "일간", "weekly": "주간", "monthly": "월간"}


class ReportError(ValueError):
    """리포트 생성 실패 (입력 오류)"""


# ---------------------------------------------------------------------------
# 기간 계산
# ---------------------------------------------------------------------------

def _period_range(period_type: str, ref: date) -> tuple[date, date, date, date, str]:
    """(시작, 끝[미포함], 이전 시작, 이전 끝[미포함], 표시용 라벨)을 돌려준다."""
    if period_type == "daily":
        start, end = ref, ref + timedelta(days=1)
        prev_start, prev_end = start - timedelta(days=1), start
        display = start.isoformat()
    elif period_type == "weekly":
        start = ref - timedelta(days=ref.weekday())  # 월요일 시작
        end = start + timedelta(days=7)
        prev_start, prev_end = start - timedelta(days=7), start
        display = f"{start.isoformat()} ~ {(end - timedelta(days=1)).isoformat()}"
    elif period_type == "monthly":
        start = ref.replace(day=1)
        end = date(start.year + 1, 1, 1) if start.month == 12 else start.replace(month=start.month + 1)
        prev_end = start
        prev_start = date(start.year - 1, 12, 1) if start.month == 1 else start.replace(month=start.month - 1)
        display = f"{start.year:04d}-{start.month:02d}"
    else:
        raise ReportError(f"period_type은 daily/weekly/monthly 중 하나여야 합니다 (받은 값: {period_type})")
    return start, end, prev_start, prev_end, display


def _change_pct(current: float, previous: float) -> Optional[float]:
    """이전 기간 대비 증감률(%). 이전 값이 0이면 비교 불가(None)."""
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


# ---------------------------------------------------------------------------
# 영역별 집계 — 다른 팀원의 모델은 읽기만 한다
# ---------------------------------------------------------------------------

def _sales_summary(db, store_id: str, start: date, end: date,
                   prev_start: date, prev_end: date) -> dict[str, Any]:
    """매출: 총액·판매 잔 수·일별 추이·베스트 메뉴 + 이전 기간 비교."""
    from app.models.inventory import Menu, Sale

    rows = (
        db.query(Sale, Menu.name)
        .join(Menu, Sale.menu_id == Menu.id)
        .filter(Sale.store_id == store_id)
        .filter(Sale.sold_at >= start.isoformat(), Sale.sold_at < end.isoformat())
        .all()
    )
    total = sum(s.total_price for s, _ in rows)
    cups = sum(s.quantity for s, _ in rows)

    daily: dict[str, int] = {}
    by_menu: dict[str, dict[str, Any]] = {}
    for s, menu_name in rows:
        day = s.sold_at.date().isoformat()
        daily[day] = daily.get(day, 0) + s.total_price
        m = by_menu.setdefault(menu_name, {"menu": menu_name, "quantity": 0, "total": 0})
        m["quantity"] += s.quantity
        m["total"] += s.total_price

    prev_total = sum(s.total_price for s in (
        db.query(Sale)
        .filter(Sale.store_id == store_id)
        .filter(Sale.sold_at >= prev_start.isoformat(), Sale.sold_at < prev_end.isoformat())
        .all()
    ))
    return {
        "total": total,
        "cups": cups,
        "prev_total": prev_total,
        "change_pct": _change_pct(total, prev_total),
        "daily_trend": [{"date": d, "total": t} for d, t in sorted(daily.items())],
        "top_menus": sorted(by_menu.values(), key=lambda m: m["total"], reverse=True)[:5],
    }


def _purchase_summary(db, start: date, end: date,
                      prev_start: date, prev_end: date) -> dict[str, Any]:
    """매입: 확정된 OCR 문서(거래명세서·영수증) 기준 + 이전 기간 비교."""
    from app.models.ai import OcrDocument

    def _total(s: date, e: date) -> tuple[float, int]:
        docs = (
            db.query(OcrDocument)
            .filter(OcrDocument.status == "confirmed")
            .filter(OcrDocument.created_at >= s.isoformat(), OcrDocument.created_at < e.isoformat())
            .all()
        )
        return sum(float(d.total) for d in docs if d.total is not None), len(docs)

    total, count = _total(start, end)
    prev_total, _ = _total(prev_start, prev_end)
    return {
        "total": round(total),
        "document_count": count,
        "prev_total": round(prev_total),
        "change_pct": _change_pct(total, prev_total),
    }


def _expense_summary(db, store_id: str, start: date, end: date) -> dict[str, Any]:
    """기타 지출(Expense 테이블) — 카테고리별 집계."""
    from app.models.operation import Expense

    rows = (
        db.query(Expense)
        .filter(Expense.store_id == store_id)
        .filter(Expense.expense_date >= start, Expense.expense_date < end)
        .all()
    )
    by_category: dict[str, int] = {}
    for r in rows:
        by_category[r.category] = by_category.get(r.category, 0) + r.amount
    return {
        "total": sum(r.amount for r in rows),
        "by_category": [{"category": c, "amount": a}
                        for c, a in sorted(by_category.items(), key=lambda x: x[1], reverse=True)],
    }


def _labor_summary(db, start: date, end: date) -> dict[str, Any]:
    """인건비: 근무 스케줄 시간 × 직원 시급으로 추정 (주휴수당·보험 미포함 간이 계산)."""
    from app.models.operation import Employee, Schedule

    rows = (
        db.query(Schedule, Employee)
        .join(Employee, Schedule.employee_id == Employee.id)
        .filter(Schedule.date >= start.isoformat(), Schedule.date < end.isoformat())
        .all()
    )
    total_hours = 0.0
    total_cost = 0.0
    employees: set[str] = set()
    for sched, emp in rows:
        hours = (sched.end_time - sched.start_time).total_seconds() / 3600
        total_hours += hours
        total_cost += hours * emp.hourly_rate
        employees.add(emp.name)
    return {
        "scheduled_hours": round(total_hours, 1),
        "estimated_cost": round(total_cost),
        "employee_count": len(employees),
        "shift_count": len(rows),
    }


def _inventory_snapshot(db, store_id: str) -> dict[str, Any]:
    """재고: 현재 시점 스냅샷 — 총 평가액과 안전재고 이하 품목."""
    from app.models.inventory import Ingredient, Stock

    rows = (
        db.query(Ingredient, Stock)
        .outerjoin(Stock, Stock.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id)
        .all()
    )
    low_stock = []
    total_value = 0.0
    for ing, stock in rows:
        qty = stock.current_quantity if stock else 0
        total_value += qty * ing.current_price
        if stock and stock.safety_quantity > 0 and stock.current_quantity <= stock.safety_quantity:
            low_stock.append({
                "name": f"{ing.name} ({ing.unit})",
                "current_quantity": stock.current_quantity,
                "safety_quantity": stock.safety_quantity,
            })
    return {
        "ingredient_count": len(rows),
        "total_value": round(total_value),
        "low_stock": low_stock,
    }


def _order_snapshot(db, store_id: str) -> dict[str, Any]:
    """발주: 아직 진행 중(초안·승인대기)인 발주 건수와 금액."""
    from app.models.inventory import Order

    rows = (
        db.query(Order)
        .filter(Order.store_id == store_id, Order.status.in_(["DRAFT", "PENDING"]))
        .all()
    )
    return {
        "open_count": len(rows),
        "open_amount": sum(r.total_amount for r in rows),
    }


# ---------------------------------------------------------------------------
# 하이라이트 — 숫자에서 바로 읽어낼 수 있는 사실만 (해석·조언은 LLM 몫)
# ---------------------------------------------------------------------------

def _build_highlights(sales: dict, labor: dict,
                      inventory: dict, compliance: list, profit: dict) -> list[str]:
    h: list[str] = []
    if sales["change_pct"] is not None:
        direction = "증가" if sales["change_pct"] >= 0 else "감소"
        h.append(f"매출 {sales['total']:,}원 — 이전 기간 대비 {abs(sales['change_pct'])}% {direction}")
    else:
        h.append(f"매출 {sales['total']:,}원 (이전 기간 매출이 없어 비교 불가)")
    if sales["top_menus"]:
        best = sales["top_menus"][0]
        h.append(f"베스트 메뉴: {best['menu']} ({best['quantity']}잔, {best['total']:,}원)")
    if profit["estimated_profit"] < 0:
        h.append(f"추정 수지 적자 {abs(profit['estimated_profit']):,}원 — 비용 점검 필요")
    if inventory["low_stock"]:
        h.append(f"안전재고 이하 재료 {len(inventory['low_stock'])}종 — 발주 검토 필요")
    if compliance:
        h.append(f"갱신 임박·만료 서류 {len(compliance)}건")
    if labor["estimated_cost"] and sales["total"]:
        ratio = round(labor["estimated_cost"] / sales["total"] * 100, 1)
        h.append(f"인건비 비중: 매출의 {ratio}%")
    return h


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def generate_management_report(store_id: str, period_type: str = "weekly",
                               reference_date: Optional[str] = None,
                               force_refresh: bool = True) -> dict[str, Any]:
    """경영 리포트를 생성해 문서로 저장하고 전문을 돌려준다.

    period_type: daily(reference_date 하루) / weekly(그 주 월~일) / monthly(그 달)
    reference_date: YYYY-MM-DD, 생략하면 오늘.

    같은 기간의 리포트가 이미 있으면 새로 만들지 않고 그 문서를 최신 수치로 갱신한다
    (문서가 기간마다 하나씩만 쌓이도록). force_refresh=False면 있던 문서를 그대로 돌려준다.
    """
    try:
        ref = date.fromisoformat(reference_date) if reference_date else date.today()
    except ValueError:
        raise ReportError(f"reference_date 형식 오류: '{reference_date}' (YYYY-MM-DD로 입력)")
    start, end, prev_start, prev_end, display = _period_range(period_type, ref)

    existing = next(
        (d for d in document_service.list_documents(store_id, kind="management_report")
         if d["period"] == display and d["content"].get("period_type") == period_type),
        None,
    )
    if existing and not force_refresh:
        return existing

    with document_service._session() as db:
        sales = _sales_summary(db, store_id, start, end, prev_start, prev_end)
        purchases = _purchase_summary(db, start, end, prev_start, prev_end)
        expenses = _expense_summary(db, store_id, start, end)
        labor = _labor_summary(db, start, end)
        inventory = _inventory_snapshot(db, store_id)
        orders = _order_snapshot(db, store_id)

    compliance = document_service.get_upcoming_renewals(store_id)

    total_cost = purchases["total"] + expenses["total"] + labor["estimated_cost"]
    estimated_profit = sales["total"] - total_cost
    profit = {
        "total_cost": total_cost,
        "estimated_profit": estimated_profit,
        "margin_pct": round(estimated_profit / sales["total"] * 100, 1) if sales["total"] else None,
    }

    content = {
        "period_type": period_type,
        "period": display,
        "sales": sales,
        "purchases": purchases,
        "expenses": expenses,
        "labor": labor,
        "profit": profit,
        "inventory": inventory,
        "orders": orders,
        "compliance_alerts": compliance,
        "highlights": _build_highlights(sales, labor, inventory, compliance, profit),
        "note": "매입은 확정 OCR 문서, 인건비는 스케줄×시급 간이 추정 기준입니다. "
                "현금 매입·주휴수당 등 누락분이 있을 수 있어 참고용으로 활용하세요.",
    }
    if existing:
        return document_service.update_document(store_id, existing["id"], content)
    label = PERIOD_LABEL[period_type]
    return document_service._save_document(
        store_id, "management_report", f"{label} 경영 리포트 ({display})", content, period=display)


def list_management_reports(store_id: str, period_type: Optional[str] = None) -> list[dict[str, Any]]:
    """생성된 경영 리포트 목록 (period_type으로 필터 가능)."""
    docs = document_service.list_documents(store_id, kind="management_report")
    if period_type:
        docs = [d for d in docs if d["content"].get("period_type") == period_type]
    return docs
