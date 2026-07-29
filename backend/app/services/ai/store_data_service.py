"""매장 데이터 통합 조회 (백엔드 B) — 챗봇이 시스템 전체를 읽을 수 있게 하는 계층

기존 도구는 도메인별로 나뉘어 있어(재고·문서·예측·리포트) 그 사이에 끼어 있는
원천 테이블들은 챗봇이 아예 볼 수 없었다. 이 파일은 그 빈칸을 채운다:

    users                      매장 프로필 (상호·연락처·가입일)
    sales                      판매 원장 (일별·메뉴별)
    stock_transactions         입출고 이력
    ingredient_price_histories 재료 단가 변동 이력
    orders / order_items       발주 이력
    expenses                   지출 내역
    employees / schedules      직원·근무 스케줄
    employee_unavailabilities  직원 기피 시간
    estimated_payrolls         급여 계산 이력
    admin_notifications        관리자 공지
    inquiries                  내 1:1 문의

전부 읽기 전용이다. 쓰기는 각 도메인 담당자의 서비스를 통해서만 이뤄진다.
집계는 SQL 방언에 기대지 않고 파이썬에서 수행한다 (PostgreSQL·SQLite 동일 동작).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Optional

from app.services.ai.untrusted import quote_fields

logger = logging.getLogger(__name__)

# 조회 상한 — 챗봇 컨텍스트에 넣을 수 있는 현실적인 크기로 자른다
MAX_ROWS = 200


def _db():
    from app.core.database import SessionLocal

    return SessionLocal()


def _d(value: Any) -> Optional[str]:
    """datetime/date/문자열을 YYYY-MM-DD 문자열로 통일한다."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)[:10]


def _dt(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(timespec="minutes")
    return str(value)


# ---------------------------------------------------------------------------
# 매장 프로필
# ---------------------------------------------------------------------------

def get_store_profile(store_id: str) -> dict[str, Any]:
    """매장 기본 정보와 등록 규모 — 챗봇이 '이 매장이 어떤 곳인지' 알 수 있게."""
    from app.models.inventory import Ingredient, Menu
    from app.models.operation import Employee
    from app.models.user import User

    with _db() as db:
        user = db.query(User).filter(User.email == store_id).first()
        ingredient_count = db.query(Ingredient).filter(Ingredient.store_id == store_id).count()
        menu_count = db.query(Menu).filter(Menu.store_id == store_id, Menu.is_active.is_(True)).count()
        employee_count = db.query(Employee).filter(Employee.store_id == store_id).count()

    if user is None:
        return {
            "found": False,
            "store_id": store_id,
            "message": "이 계정으로 등록된 매장 정보를 찾을 수 없습니다.",
        }
    return {
        "found": True,
        "store_id": store_id,
        "store_name": user.store_name,
        "owner_name": user.name,
        "phone": user.phone,
        "joined_at": _d(user.created_at),
        "registered": {
            "ingredients": ingredient_count,
            "active_menus": menu_count,
            "employees": employee_count,
        },
    }


# ---------------------------------------------------------------------------
# 판매 원장
# ---------------------------------------------------------------------------

def get_sales_history(store_id: str, days: int = 14) -> dict[str, Any]:
    """최근 N일 판매 원장 — 일별 매출·잔 수와 메뉴별 판매 순위."""
    from app.models.inventory import Menu, Sale

    since = datetime.now() - timedelta(days=max(1, days))
    with _db() as db:
        rows = (
            db.query(Sale, Menu.name)
            .join(Menu, Sale.menu_id == Menu.id)
            .filter(Sale.store_id == store_id, Sale.sold_at >= since)
            .order_by(Sale.sold_at.desc())
            .limit(2000)
            .all()
        )

    by_day: dict[str, dict[str, int]] = defaultdict(lambda: {"revenue": 0, "cups": 0})
    by_menu: dict[str, dict[str, int]] = defaultdict(lambda: {"revenue": 0, "cups": 0})
    for sale, menu_name in rows:
        day = _d(sale.sold_at) or ""
        by_day[day]["revenue"] += int(sale.total_price or 0)
        by_day[day]["cups"] += int(sale.quantity or 0)
        by_menu[menu_name]["revenue"] += int(sale.total_price or 0)
        by_menu[menu_name]["cups"] += int(sale.quantity or 0)

    daily = [{"date": d, **v} for d, v in sorted(by_day.items(), reverse=True)]
    menus = sorted(
        ({"menu": m, **v} for m, v in by_menu.items()),
        key=lambda x: x["revenue"],
        reverse=True,
    )
    return {
        "period_days": days,
        "total_revenue": sum(v["revenue"] for v in by_day.values()),
        "total_cups": sum(v["cups"] for v in by_day.values()),
        "days_with_sales": len(by_day),
        "daily": daily[:days],
        "by_menu": menus[:20],
    }


# ---------------------------------------------------------------------------
# 재고 입출고 · 단가 이력
# ---------------------------------------------------------------------------

def get_stock_movements(
    store_id: str, days: int = 7, ingredient_name: str = ""
) -> dict[str, Any]:
    """재고 입출고 이력 — 언제 무엇이 얼마나 들어오고 나갔는지."""
    from app.models.inventory import Ingredient, StockTransaction

    since = datetime.now() - timedelta(days=max(1, days))
    with _db() as db:
        q = (
            db.query(StockTransaction, Ingredient.name, Ingredient.unit)
            .join(Ingredient, StockTransaction.ingredient_id == Ingredient.id)
            .filter(Ingredient.store_id == store_id, StockTransaction.created_at >= since)
        )
        if ingredient_name.strip():
            q = q.filter(Ingredient.name.ilike(f"%{ingredient_name.strip()}%"))
        rows = q.order_by(StockTransaction.created_at.desc()).limit(MAX_ROWS).all()

    movements = [
        {
            "at": _dt(tx.created_at),
            "ingredient": name,
            "change": float(tx.quantity_change or 0),
            "unit": unit,
            "type": tx.type,
            "reason": tx.description,
        }
        for tx, name, unit in rows
    ]
    inbound = sum(m["change"] for m in movements if m["change"] > 0)
    outbound = sum(-m["change"] for m in movements if m["change"] < 0)
    return {
        "period_days": days,
        "filter_ingredient": ingredient_name or None,
        "count": len(movements),
        "total_inbound": round(inbound, 3),
        "total_outbound": round(outbound, 3),
        "movements": movements,
    }


def get_price_trend(store_id: str, ingredient_name: str = "", days: int = 90) -> dict[str, Any]:
    """재료 매입 단가 변동 이력 — 어떤 재료가 언제 얼마나 올랐는지."""
    from app.models.inventory import Ingredient, IngredientPriceHistory

    since = datetime.now() - timedelta(days=max(1, days))
    with _db() as db:
        q = (
            db.query(IngredientPriceHistory, Ingredient.name, Ingredient.unit, Ingredient.current_price)
            .join(Ingredient, IngredientPriceHistory.ingredient_id == Ingredient.id)
            .filter(Ingredient.store_id == store_id, IngredientPriceHistory.changed_at >= since)
        )
        if ingredient_name.strip():
            q = q.filter(Ingredient.name.ilike(f"%{ingredient_name.strip()}%"))
        rows = q.order_by(IngredientPriceHistory.changed_at.desc()).limit(MAX_ROWS).all()

    history: dict[str, list[dict[str, Any]]] = defaultdict(list)
    current: dict[str, int] = {}
    for h, name, unit, cur_price in rows:
        history[name].append({"at": _d(h.changed_at), "price": int(h.price or 0), "unit": unit})
        current[name] = int(cur_price or 0)

    trends = []
    for name, points in history.items():
        prices = [p["price"] for p in points if p["price"] > 0]
        if not prices:
            continue
        oldest, newest = prices[-1], prices[0]
        change_pct = round((newest - oldest) / oldest * 100, 1) if oldest else 0.0
        trends.append({
            "ingredient": name,
            "current_price": current.get(name, newest),
            "oldest_price": oldest,
            "latest_price": newest,
            "change_pct": change_pct,
            "points": points[:20],
        })
    trends.sort(key=lambda t: t["change_pct"], reverse=True)
    return {"period_days": days, "filter_ingredient": ingredient_name or None, "trends": trends}


# ---------------------------------------------------------------------------
# 발주
# ---------------------------------------------------------------------------

def get_purchase_orders(store_id: str, limit: int = 10, status: str = "") -> dict[str, Any]:
    """발주 이력 — 상태(DRAFT/PENDING/CONFIRMED)와 품목 상세."""
    from app.models.inventory import Ingredient, Order, OrderItem

    with _db() as db:
        q = db.query(Order).filter(Order.store_id == store_id)
        if status.strip():
            q = q.filter(Order.status == status.strip().upper())
        orders = q.order_by(Order.created_at.desc()).limit(max(1, min(limit, 50))).all()
        order_ids = [o.id for o in orders]

        items_by_order: dict[int, list[dict[str, Any]]] = defaultdict(list)
        if order_ids:
            item_rows = (
                db.query(OrderItem, Ingredient.name, Ingredient.unit)
                .join(Ingredient, OrderItem.ingredient_id == Ingredient.id)
                .filter(OrderItem.order_id.in_(order_ids))
                .all()
            )
            for item, name, unit in item_rows:
                items_by_order[item.order_id].append({
                    "ingredient": name,
                    "quantity": float(item.quantity or 0),
                    "unit": unit,
                    "unit_price": int(item.price_at_order or 0),
                })

        result = [
            {
                "id": o.id,
                "status": o.status,
                "total_amount": int(o.total_amount or 0),
                "created_at": _d(o.created_at),
                "item_count": len(items_by_order.get(o.id, [])),
                "items": items_by_order.get(o.id, []),
            }
            for o in orders
        ]
    pending = [o for o in result if o["status"] in ("DRAFT", "PENDING")]
    return {"count": len(result), "pending_count": len(pending), "orders": result}


# ---------------------------------------------------------------------------
# 지출
# ---------------------------------------------------------------------------

def get_expenses(store_id: str, days: int = 30) -> dict[str, Any]:
    """지출 내역 — 카테고리별 합계와 최근 건별 목록."""
    from app.models.operation import Expense

    since = date.today() - timedelta(days=max(1, days))
    with _db() as db:
        rows = (
            db.query(Expense)
            .filter(Expense.store_id == store_id, Expense.expense_date >= since)
            .order_by(Expense.expense_date.desc())
            .limit(MAX_ROWS)
            .all()
        )

    by_category: dict[str, int] = defaultdict(int)
    items = []
    for e in rows:
        amount = int(e.amount or 0)
        by_category[e.category or "기타"] += amount
        items.append({
            "date": _d(e.expense_date),
            "category": e.category,
            "amount": amount,
            "description": e.description,
        })
    categories = sorted(
        ({"category": c, "amount": a} for c, a in by_category.items()),
        key=lambda x: x["amount"],
        reverse=True,
    )
    return {
        "period_days": days,
        "total": sum(by_category.values()),
        "by_category": categories,
        "expenses": items,
    }


# ---------------------------------------------------------------------------
# 직원 · 스케줄
# ---------------------------------------------------------------------------

def get_staff_roster(store_id: str) -> dict[str, Any]:
    """직원 명단 — 시급·직책과 각자의 기피/불가 시간."""
    from app.models.operation import Employee, EmployeeUnavailability

    _DOW = ["월", "화", "수", "목", "금", "토", "일"]
    with _db() as db:
        employees = db.query(Employee).filter(Employee.store_id == store_id).all()
        emp_ids = [e.id for e in employees]
        blocks_by_emp: dict[int, list[dict[str, Any]]] = defaultdict(list)
        if emp_ids:
            for u in (
                db.query(EmployeeUnavailability)
                .filter(EmployeeUnavailability.employee_id.in_(emp_ids))
                .all()
            ):
                when = (
                    f"매주 {_DOW[u.day_of_week]}요일"
                    if u.unavailability_type == "weekly_recurring" and u.day_of_week is not None
                    else u.specific_date or "지정 없음"
                )
                blocks_by_emp[u.employee_id].append({
                    "when": when,
                    "hours": f"{u.start_hour}시~{u.end_hour}시",
                    "level": u.restriction_level,  # hard=배정 금지, soft=가급적 회피
                    "reason": u.reason,
                })

        staff = [
            {
                "id": e.id,
                "name": e.name,
                "role": e.role,
                "hourly_rate": int(e.hourly_rate or 0),
                "unavailabilities": blocks_by_emp.get(e.id, []),
            }
            for e in employees
        ]
    return {"count": len(staff), "staff": staff}


def get_work_schedules(store_id: str, start_date: str = "", end_date: str = "") -> dict[str, Any]:
    """근무 스케줄 — 기간 내 직원별 배정과 실제 출퇴근 기록. 기본은 이번 주."""
    from app.models.operation import Employee, Schedule

    today = date.today()
    start = start_date.strip() or (today - timedelta(days=today.weekday())).isoformat()
    end = end_date.strip() or (today + timedelta(days=6 - today.weekday())).isoformat()

    with _db() as db:
        rows = (
            db.query(Schedule, Employee.name, Employee.hourly_rate)
            .join(Employee, Schedule.employee_id == Employee.id)
            .filter(
                Employee.store_id == store_id,
                Schedule.date >= start,
                Schedule.date <= end,
            )
            .order_by(Schedule.date, Schedule.start_time)
            .limit(MAX_ROWS)
            .all()
        )

    schedules = []
    hours_by_employee: dict[str, float] = defaultdict(float)
    for s, name, rate in rows:
        planned_hours = 0.0
        if s.start_time and s.end_time:
            planned_hours = round((s.end_time - s.start_time).total_seconds() / 3600, 2)
        hours_by_employee[name] += planned_hours
        schedules.append({
            "date": s.date,
            "employee": name,
            "planned": f"{_dt(s.start_time)} ~ {_dt(s.end_time)}",
            "planned_hours": planned_hours,
            "actual_start": _dt(s.actual_start_time),
            "actual_end": _dt(s.actual_end_time),
            "done": s.actual_end_time is not None,
            "hourly_rate": int(rate or 0),
        })
    return {
        "start_date": start,
        "end_date": end,
        "count": len(schedules),
        "hours_by_employee": [
            {"employee": n, "hours": round(h, 2)} for n, h in sorted(hours_by_employee.items())
        ],
        "schedules": schedules,
    }


def get_payroll_history(store_id: str, limit: int = 20) -> dict[str, Any]:
    """급여 계산 이력 — 언제 누구 급여를 얼마로 계산했는지."""
    from app.models.operation import Employee, EstimatedPayroll

    with _db() as db:
        rows = (
            db.query(EstimatedPayroll, Employee.name)
            .join(Employee, EstimatedPayroll.employee_id == Employee.id)
            .filter(Employee.store_id == store_id)
            .order_by(EstimatedPayroll.calculated_at.desc())
            .limit(max(1, min(limit, 100)))
            .all()
        )
    return {
        "count": len(rows),
        "payrolls": [
            {
                "employee": name,
                "period": f"{p.period_start} ~ {p.period_end}",
                "work_hours": float(p.total_work_hours or 0),
                "estimated_salary": int(p.estimated_salary or 0),
                "calculated_at": _d(p.calculated_at),
            }
            for p, name in rows
        ],
    }


# ---------------------------------------------------------------------------
# 공지 · 문의
# ---------------------------------------------------------------------------

def get_notices_and_inquiries(store_id: str, limit: int = 10) -> dict[str, Any]:
    """관리자 공지와 내가 남긴 1:1 문의의 답변 상태."""
    from app.models.ai import AdminNotification
    from app.models.inquiry import Inquiry

    n = max(1, min(limit, 30))
    with _db() as db:
        notices = (
            db.query(AdminNotification)
            .filter(
                (AdminNotification.target_type != "specific")
                | (AdminNotification.target_email == store_id)
            )
            .order_by(AdminNotification.created_at.desc())
            .limit(n)
            .all()
        )
        inquiries = (
            db.query(Inquiry)
            .filter(Inquiry.user_email == store_id)
            .order_by(Inquiry.created_at.desc())
            .limit(n)
            .all()
        )

    # 사람이 쓴 자유 텍스트는 전부 무해화해서 넘긴다.
    #
    # 문의 제목은 공격자가 정할 수 있다 — 문의 등록이 구버전 앱 호환 때문에 인증 없이
    # 열려 있어서, 서버 주소만 알면 남의 이메일로 문의를 넣을 수 있기 때문이다.
    # 그 글이 "내 문의 답변 왔어?" 한마디에 챗봇 컨텍스트로 들어오는데, 챗봇은 재고
    # 조회·발주서 작성 도구를 실제로 실행한다. 지시문처럼 읽히면 안 된다.
    #
    # 공지·답변은 관리자가 쓴 것이라 상대적으로 안전하지만 같이 감싼다 — 관리자 계정이
    # 털렸을 때 그 경로로 챗봇을 조종할 수 있으면 안 된다. (untrusted.py 참고)
    return {
        "notices": [
            quote_fields(
                {"title": x.title, "body": x.body, "at": _d(x.created_at), "author": x.author},
                ("title", "body"),
            )
            for x in notices
        ],
        "inquiries": [
            quote_fields(
                {
                    "id": x.id,
                    "title": x.title,
                    "category": x.category,
                    "status": x.status,
                    "answered": x.status == "answered",
                    "answer": x.answer,
                    "at": _d(x.created_at),
                },
                ("title", "answer"),
            )
            for x in inquiries
        ],
        "unanswered_count": sum(1 for x in inquiries if x.status != "answered"),
    }
