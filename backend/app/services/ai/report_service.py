"""AI 경영 리포트 로직 (백엔드 B) — 일간·주간·월간

카페 전체 데이터를 한 문서로 통합 집계한다:
  매출(Sale) · 재료비(레시피 × 판매량) · 매입(확정 OCR 문서) · 기타 지출(Expense)
  · 인건비(근무 스케줄 × 시급) · 재고 현황(Stock) · 발주 진행(Order) · 갱신 임박 서류(Compliance)

손익의 재료비는 '팔린 메뉴의 레시피'로 계산한다(_cogs_summary). 매입 문서로 잡던 시절엔
명세서를 언제 촬영했는지가 손익을 좌우했다 — 안 찍은 기간은 순이익이 매출 전액에 가깝게
부풀고, 밀린 명세서를 몰아 찍은 날은 대형 적자로 찍혔다. 레시피가 덜 등록돼 원가율을
믿기 어려우면(_COGS_MIN_COVERAGE 미만) 종전 매입 기준으로 되돌린다. 실제로 나간 돈은
현금수지(profit.cash_balance)로 따로 남겨 둔다.

여기에 영업 리듬(시간대·요일별 매출과 그 시간의 인건비)과 다음 기간 전망(예측 캐시)을
얹어, '지난 기간이 이랬다'에서 '그래서 뭘 하면 되나'로 이어지게 한다.

이전 기간과의 비교(증감률)와 규칙 기반 하이라이트까지 계산해 담고,
문장형 조언·해석과 액션 제안은 Gemini가 이 숫자만 근거로 작성한다(_generate_ai_advice).

생성 결과는 generated_documents(kind="management_report")로 저장된다 —
챗봇 화면에는 카드로 바로 표시되고, 서류 자동화 화면에서도 다시 볼 수 있다.
"""

import hashlib
import json
import logging
import os
import threading
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from app.services.ai import document_service

logger = logging.getLogger(__name__)

PERIOD_LABEL = {"daily": "일간", "weekly": "주간", "monthly": "월간"}
KST = timezone(timedelta(hours=9))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


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

    # 진행 중인 기간은 이전 기간도 같은 경과일까지만 잘라 공정하게 비교한다
    # (예: 7/1~16 매출 vs 6월 전체가 아니라 6/1~16 매출 — 아니면 항상 '감소'로 보인다)
    today = date.today()
    if end > today:
        elapsed = today + timedelta(days=1) - start  # 오늘까지 포함한 경과일
        prev_end = min(prev_end, prev_start + elapsed)
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
    # 원가 계산용 메뉴 id별 집계 — 이름은 중복될 수 있어 레시피 조회는 반드시 id로 한다
    by_menu_id: dict[int, dict[str, Any]] = {}
    # 영업 리듬 — 언제 팔리는가. 인건비 배치를 판단하려면 날짜 합계만으론 부족하다
    by_hour: dict[int, dict[str, int]] = {}
    by_weekday: dict[int, dict[str, Any]] = {}
    for s, menu_name in rows:
        # timestamptz(UTC)로 돌아오는 sold_at을 KST 날짜로 버킷링 — UTC 그대로면 자정 전후 판매가 전날로 밀린다
        sold = s.sold_at.astimezone(KST) if s.sold_at.tzinfo else s.sold_at
        day = sold.date().isoformat()
        daily[day] = daily.get(day, 0) + s.total_price
        hb = by_hour.setdefault(sold.hour, {"total": 0, "cups": 0})
        hb["total"] += s.total_price
        hb["cups"] += s.quantity
        wb = by_weekday.setdefault(sold.weekday(), {"total": 0, "cups": 0, "days": set()})
        wb["total"] += s.total_price
        wb["cups"] += s.quantity
        wb["days"].add(day)  # 같은 요일이 몇 번 있었는지 — 월간은 4~5회라 합계론 비교가 안 된다
        m = by_menu.setdefault(menu_name, {"menu": menu_name, "quantity": 0, "total": 0})
        m["quantity"] += s.quantity
        m["total"] += s.total_price
        mi = by_menu_id.setdefault(s.menu_id, {"name": menu_name, "quantity": 0, "total": 0})
        mi["quantity"] += s.quantity
        mi["total"] += s.total_price

    # 진행 중인 기간은 이전 기간도 '같은 경과 시각'까지만 잘라 비교한다 —
    # _period_range의 날짜 단위 트리밍을 시간 단위로 보강. 오후에 일간 리포트를 열면
    # 오늘(반나절)과 어제(하루 전체)가 비교되어 항상 큰 폭 감소로 보이는 왜곡을 막는다.
    # 끝난 기간은 경과 시간이 기간 길이를 넘어서므로 자연히 prev_end 그대로 쓰인다.
    elapsed = datetime.now(KST) - datetime.combine(start, time.min, tzinfo=KST)
    prev_cutoff = min(
        datetime.combine(prev_end, time.min, tzinfo=KST),
        datetime.combine(prev_start, time.min, tzinfo=KST) + elapsed,
    )
    prev_total = sum(s.total_price for s in (
        db.query(Sale)
        .filter(Sale.store_id == store_id)
        .filter(Sale.sold_at >= prev_start.isoformat(), Sale.sold_at < prev_cutoff)
        .all()
    ))
    return {
        "total": total,
        "cups": cups,
        "prev_total": prev_total,
        "change_pct": _change_pct(total, prev_total),
        "daily_trend": [{"date": d, "total": t} for d, t in sorted(daily.items())],
        "top_menus": sorted(by_menu.values(), key=lambda m: m["total"], reverse=True)[:5],
        "hourly": [{"hour": h, **by_hour[h]} for h in sorted(by_hour)],
        # 요일은 합계가 아니라 '그 요일 하루 평균'으로 비교해야 공정하다
        "weekday": [
            {"weekday": w, "total": v["total"], "cups": v["cups"],
             "days": len(v["days"]), "avg_total": round(v["total"] / len(v["days"]))}
            for w, v in sorted(by_weekday.items())
        ],
        # 원가 집계에만 쓰는 중간 산출물 — 문서로 저장하기 전에 떼어낸다
        "_by_menu_id": by_menu_id,
    }


def _purchase_summary(db, store_id: str, start: date, end: date,
                      prev_start: date, prev_end: date) -> dict[str, Any]:
    """매입: 확정된 OCR 문서(거래명세서·영수증) 기준 + 이전 기간 비교."""
    from app.models.ai import OcrDocument

    def _total(s: date, e: date) -> tuple[float, int]:
        docs = (
            db.query(OcrDocument)
            .filter(OcrDocument.store_id == store_id)  # 내 매장 매입만 — 다른 매장 문서 섞임 방지
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


# 레시피가 걸린 매출이 이 비율에 못 미치면 원가율을 믿을 수 없다고 보고 손익 계산에서 뺀다.
# (레시피를 절반도 안 넣은 매장에서 원가율 12% 같은 숫자가 나와 흑자로 오독되는 걸 막는다)
_COGS_MIN_COVERAGE = 60.0


def _cogs_summary(db, store_id: str, start: date, end: date,
                  sales: dict[str, Any]) -> dict[str, Any]:
    """판매원가: 팔린 잔 수 × 레시피 재료비로 계산한 이론 원가 + 실사에서 빠진 로스.

    매입(OCR 문서)과 달리 명세서를 언제 촬영했는지에 흔들리지 않는다 —
    이번 주에 사진을 한 장도 안 찍어도 판매가 있으면 원가가 잡히고,
    밀린 명세서를 하루에 몰아 찍어도 그날만 원가가 폭증하지 않는다.

    재료 단가는 '현재' 단가를 쓴다 (메뉴판 원가율 화면과 같은 공식). 지난달 리포트를
    오늘 단가로 계산하는 셈이라 단가가 크게 움직였다면 오차가 생기며, note에 밝혀 둔다.

    로스는 OUT(판매 차감)이 아니라 ADJUST(실사 조정)에서 읽는다 — OUT은 레시피대로
    자동 차감된 값이라 이론 원가와 항상 일치해서 비교해도 늘 0이 나온다.
    실사로 깎아낸 양이 곧 폐기·과다투입·계량 오차다.
    """
    from app.models.inventory import Ingredient, Recipe, StockTransaction

    by_menu_id: dict[int, dict[str, Any]] = sales.get("_by_menu_id") or {}
    sales_total = sales["total"]

    # 메뉴 1잔당 재료비 = Σ(레시피 소요량 × 재료 현재 단가) — inventory_service의 원가 공식과 동일
    unit_cost: dict[int, float] = {}
    if by_menu_id:
        for menu_id, qty, price in (
            db.query(Recipe.menu_id, Recipe.quantity, Ingredient.current_price)
            .join(Ingredient, Recipe.ingredient_id == Ingredient.id)
            .filter(Recipe.menu_id.in_(list(by_menu_id.keys())))
            .all()
        ):
            unit_cost[menu_id] = unit_cost.get(menu_id, 0.0) + (qty or 0) * (price or 0)

    theoretical = 0.0
    covered_revenue = 0
    uncovered: list[dict[str, Any]] = []
    per_menu: list[dict[str, Any]] = []
    for menu_id, info in by_menu_id.items():
        cost_each = unit_cost.get(menu_id)
        if cost_each is None:
            # 레시피 미등록 — 원가를 0으로 치면 그만큼 이익이 부풀려지므로 따로 세어 알린다
            uncovered.append({"menu": info["name"], "total": info["total"]})
            continue
        menu_cost = cost_each * info["quantity"]
        theoretical += menu_cost
        covered_revenue += info["total"]
        per_menu.append({
            "menu": info["name"],
            "quantity": info["quantity"],
            "revenue": info["total"],
            "cost": round(menu_cost),
            # 메뉴별 원가율 — 판매가가 아니라 실제 팔린 금액 기준이라 할인·서비스가 반영된다
            "cost_ratio": round(menu_cost / info["total"] * 100, 1) if info["total"] else None,
        })

    coverage = round(covered_revenue / sales_total * 100, 1) if sales_total else None

    # 실사 조정으로 사라진 재고 — 음수 ADJUST만 금액으로 환산 (StockTransaction엔 store_id가 없어 재료로 조인)
    loss_amount = 0.0
    loss_items: dict[str, float] = {}
    for change, price, name in (
        db.query(StockTransaction.quantity_change, Ingredient.current_price, Ingredient.name)
        .join(Ingredient, StockTransaction.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id)
        .filter(StockTransaction.type == "ADJUST", StockTransaction.quantity_change < 0)
        .filter(StockTransaction.created_at >= start.isoformat(),
                StockTransaction.created_at < end.isoformat())
        .all()
    ):
        amount = -(change or 0) * (price or 0)
        loss_amount += amount
        loss_items[name] = loss_items.get(name, 0.0) + amount

    return {
        "theoretical": round(theoretical),
        "cost_ratio": round(theoretical / sales_total * 100, 1) if sales_total else None,
        "coverage_pct": coverage,
        # 레시피가 붙은 매출이 너무 적으면 원가율이 실제보다 낮게 나온다 → 손익 계산에서 제외
        "reliable": bool(by_menu_id) and coverage is not None and coverage >= _COGS_MIN_COVERAGE,
        "uncovered_menus": sorted(uncovered, key=lambda m: m["total"], reverse=True)[:5],
        "uncovered_count": len(uncovered),
        # 원가율이 높은 순 — '많이 팔리는데 남는 게 없는' 메뉴를 먼저 보게 한다
        "worst_margin_menus": sorted(
            [m for m in per_menu if m["cost_ratio"] is not None],
            key=lambda m: m["cost_ratio"], reverse=True)[:3],
        "loss_amount": round(loss_amount),
        "loss_pct": round(loss_amount / theoretical * 100, 1) if theoretical else None,
        "loss_items": [{"name": n, "amount": round(a)}
                       for n, a in sorted(loss_items.items(), key=lambda x: x[1], reverse=True)[:3]],
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


def _labor_summary(db, store_id: str, start: date, end: date) -> dict[str, Any]:
    """인건비: 근무 스케줄 시간 × 직원 시급으로 추정 (주휴수당·보험 미포함 간이 계산).

    아직 끝나지 않은 근무는 지금 시각까지 일한 만큼만 계산한다 —
    진행 중인 기간은 매출도 '지금까지'만 잡히므로, 인건비를 하루치 전체로 잡으면
    오전 리포트가 항상 적자로 보이는 왜곡이 생긴다 (기간 비교 트리밍과 같은 원칙).
    """
    from app.models.operation import Employee, Schedule

    rows = (
        db.query(Schedule, Employee)
        .join(Employee, Schedule.employee_id == Employee.id)
        .filter(Employee.store_id == store_id)
        .filter(Schedule.date >= start.isoformat(), Schedule.date < end.isoformat())
        .all()
    )
    now = datetime.now()
    total_hours = 0.0
    total_cost = 0.0
    employees: set[str] = set()
    # 시간대별 인건비 — 근무를 시(hour) 칸에 쪼개 담는다. 매출과 겹쳐 보면
    # '사람은 있는데 손님이 없는 시간'이 드러난다 (합계 인건비로는 절대 안 보인다)
    by_hour: dict[int, float] = {}
    for sched, emp in rows:
        worked_until = min(sched.end_time, now)
        hours = max((worked_until - sched.start_time).total_seconds() / 3600, 0.0)
        total_hours += hours
        total_cost += hours * emp.hourly_rate
        employees.add(emp.name)

        # 근무 구간을 정시 경계로 잘라 각 시간대에 실제 걸친 만큼만 배분한다
        # (9:30~14:00 근무면 9시 칸에 0.5시간, 10~13시 칸에 1시간씩, 14시 칸엔 0)
        cursor = sched.start_time
        while cursor < worked_until:
            hour_end = (cursor + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
            slice_end = min(hour_end, worked_until)
            span = (slice_end - cursor).total_seconds() / 3600
            if span > 0:
                by_hour[cursor.hour] = by_hour.get(cursor.hour, 0.0) + span * emp.hourly_rate
            cursor = slice_end
    return {
        "scheduled_hours": round(total_hours, 1),
        "estimated_cost": round(total_cost),
        "employee_count": len(employees),
        "shift_count": len(rows),
        "hourly_cost": [{"hour": h, "cost": round(by_hour[h])} for h in sorted(by_hour)],
    }


def _outlook(store_id: str, sales: dict[str, Any], period_type: str) -> Optional[dict[str, Any]]:
    """다음 기간 전망 — 이미 계산돼 있는 예측 캐시를 읽기만 한다.

    리포트가 '지난주 이랬다'로 끝나면 읽고 덮게 된다. 다음 기간 예상 매출이 붙어야
    발주량과 인력 배치를 정할 근거가 된다.

    forecast()를 직접 부르지 않는 이유: SARIMAX 적합과 날씨 API 호출이 들어 있어
    수 초가 걸리는데, 이 리포트는 홈 화면이 열릴 때마다 백그라운드로 재생성된다.
    예측 카드가 자기 경로에서 이미 캐시를 채우므로, 여기서는 있으면 쓰고 없으면 조용히 뺀다.
    """
    if period_type == "monthly":
        return None  # 예측 지평은 최대 14일이라 '다음 달'을 말할 근거가 없다

    try:
        from app.services.ai import forecast_service

        hit = forecast_service.peek_forecast_cache(store_id)
    except Exception:  # 예측 쪽 문제가 리포트를 막아선 안 된다
        logger.debug("예측 캐시 조회 실패 — 전망 없이 발행", exc_info=True)
        return None
    if not hit:
        return None

    result, fresh = hit
    week = result.get("week") or []
    if not week:
        return None

    # 일간 리포트는 '내일 하루', 주간은 '앞으로 7일'을 본다
    horizon = week[:1] if period_type == "daily" else week
    revenue = sum(d.get("revenue") or 0 for d in horizon)
    cups = sum(d.get("cups") or 0 for d in horizon)

    # 비교 기준은 '하루 평균'끼리 — 예측 7일 합계를 이번 주 경과분(3일) 합계와 견주면 늘 급증이다.
    # 오늘은 아직 안 끝난 하루라 평균을 끌어내리므로 뺀다. 남은 완결일이 너무 적으면
    # 그날 사정이 평균 행세를 하게 되므로 아예 비교하지 않는다 (숫자는 그대로 보여 주되 증감률만 생략).
    today_iso = date.today().isoformat()
    complete = [d for d in (sales.get("daily_trend") or []) if d["date"] != today_iso]
    recent = complete[-len(horizon):]
    recent_avg = round(sum(d["total"] for d in recent) / len(recent)) if len(recent) >= 3 else None
    expected_avg = round(revenue / len(horizon)) if horizon else None

    return {
        "days": len(horizon),
        "expected_revenue": revenue,
        "expected_cups": cups,
        "expected_daily_avg": expected_avg,
        "recent_daily_avg": recent_avg,
        "change_pct": _change_pct(expected_avg, recent_avg) if recent_avg else None,
        "model": result.get("model"),
        "stale": not fresh,  # 오늘 만들어졌지만 갱신된 지 오래된 예측
        # 가장 바쁠 것으로 본 날 — 발주·인력을 여기에 맞춘다
        "busiest": max(horizon, key=lambda d: d.get("revenue") or 0) if horizon else None,
        "order_recommendations": (result.get("order_recommendations") or [])[:3],
    }


_WEEKDAY_KR = ["월", "화", "수", "목", "금", "토", "일"]


def _rhythm_analysis(sales: dict[str, Any], labor: dict[str, Any]) -> dict[str, Any]:
    """영업 리듬: 언제 팔리고, 그 시간에 인건비가 얼마나 나갔는지.

    매출 합계와 인건비 합계만 보면 '매출 대비 인건비 38%'에서 멈춘다. 그 38%를
    시간 축에 펼쳐야 '오후 3시엔 인건비가 매출보다 많다' 같은 손댈 수 있는 사실이 나온다.
    """
    hourly = sales.get("hourly") or []
    labor_by_hour = {r["hour"]: r["cost"] for r in (labor.get("hourly_cost") or [])}

    peak = sorted(hourly, key=lambda r: r["total"], reverse=True)[:3]

    # 인건비가 그 시간 매출을 넘어선 시간대 — 사람이 있는데 손님이 없었던 구간.
    # 근무가 잡히지 않은 시간은 비교 대상이 아니므로 인건비가 있는 시간만 본다.
    negative_hours = []
    for hour, cost in sorted(labor_by_hour.items()):
        revenue = next((r["total"] for r in hourly if r["hour"] == hour), 0)
        if cost > revenue:
            negative_hours.append({"hour": hour, "sales": revenue, "labor": cost,
                                   "gap": round(cost - revenue)})
    negative_hours.sort(key=lambda r: r["gap"], reverse=True)

    # 요일 비교는 하루 평균으로 — 월간이면 같은 요일이 4~5번이라 합계로는 비교가 안 된다.
    # 관측이 하루뿐인 요일은 표본이 아니라 그날 사정이므로 비교에서 뺀다.
    weekdays = [w for w in (sales.get("weekday") or []) if w["days"] >= 2]
    best = max(weekdays, key=lambda w: w["avg_total"]) if len(weekdays) >= 2 else None
    worst = min(weekdays, key=lambda w: w["avg_total"]) if len(weekdays) >= 2 else None

    def _label(w: Optional[dict]) -> Optional[dict]:
        if not w:
            return None
        return {"weekday": _WEEKDAY_KR[w["weekday"]], "avg_total": w["avg_total"], "days": w["days"]}

    return {
        "peak_hours": peak,
        "negative_hours": negative_hours[:3],
        "best_weekday": _label(best),
        "worst_weekday": _label(worst),
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
                "name": ing.name,
                "unit": ing.unit,
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

_PREV_WORD = {"daily": "전날보다", "weekly": "지난주보다", "monthly": "지난달보다"}


def _fmt_qty(v: float) -> str:
    """4.0 → '4', 1.5 → '1.5' — 수량을 군더더기 없이 표기."""
    return str(int(v)) if float(v).is_integer() else str(v)


# 지출 카테고리가 '고정비'인지 알아보는 낱말들. 카테고리는 자유 입력이라 목록으로
# 고를 수가 없어 이름으로 판단한다. 못 알아본 쪽으로 틀리면 "임대료를 넣어 달라"는
# 안내가 한 번 더 뜨는 정도지만, 반대로 틀리면 월세가 빠진 금액을 순이익이라 부르게 된다.
_FIXED_COST_WORDS = (
    "임대", "월세", "관리비", "공과", "전기", "수도", "가스", "난방",
    "통신", "인터넷", "보험", "세금", "부가세", "수수료", "렌탈", "렌트", "리스",
    "이자", "상환", "고정비", "구독", "정기결제", "청소", "방역", "음악", "저작권",
)


def _has_fixed_cost(expenses: dict[str, Any]) -> bool:
    """지출에 고정비 성격의 항목이 하나라도 있는지."""
    return any(
        any(w in (row.get("category") or "") for w in _FIXED_COST_WORDS)
        for row in expenses.get("by_category") or []
    )


def _build_note(use_recipe: bool, cogs: dict, fixed_cost_missing: bool = False) -> str:
    """리포트 숫자를 어디까지 믿어야 하는지 밝히는 안내문 — 계산 기준이 바뀌면 문구도 바뀐다."""
    if use_recipe:
        note = ("재료비는 팔린 메뉴의 레시피로 계산한 추정치입니다(재료 현재 단가 기준). "
                "인건비는 지금까지 일한 시간×시급으로 잡았고, 주휴수당·보험료는 빠져 있어요.")
        if cogs["uncovered_count"]:
            note += f" 레시피가 없는 메뉴 {cogs['uncovered_count']}종은 재료비에서 빠졌습니다."
    else:
        # 레시피가 덜 등록돼 매입 기준으로 계산한 경우 — 왜 숫자가 튈 수 있는지 먼저 알린다
        note = ("재료비는 스캔해서 확정한 영수증·거래명세서 기준이라, 명세서를 몰아서 찍거나 "
                "한 장도 안 찍은 기간에는 손익이 크게 튈 수 있어요. "
                "메뉴에 레시피를 등록하면 팔린 만큼으로 재료비를 계산해 훨씬 안정적으로 나옵니다.")
    # 가장 크게 틀리는 원인이라 맨 뒤가 아니라 반드시 붙여서 내보낸다
    if fixed_cost_missing:
        note += (" ⚠️ 임대료·공과금·카드수수료 같은 고정비가 등록되지 않아, 여기 남은 금액은 "
                 "실제 순이익보다 그만큼 높게 나옵니다. 지출에 월 고정비를 넣으면 정확해져요.")
    return note


# 카드에 실을 하이라이트 상한 — 항목을 늘릴수록 읽히지 않는다. 매출 한 줄은 항상 맨 위에 고정.
_HIGHLIGHT_LIMIT = 7


def _build_highlights(sales: dict, cogs: dict, labor: dict, rhythm: dict, outlook: Optional[dict],
                      inventory: dict, compliance: list, profit: dict, period_type: str) -> list[str]:
    """집계에서 바로 읽히는 사실을 중요한 순으로 골라 준다.

    항목이 늘면서 순서가 문제로 바뀌었다. 코드에 적힌 순서대로 9~10줄을 쏟아내면
    맨 아래 '21시대 인건비가 매출보다 많다' 같은 진짜 손댈 거리가 묻힌다.
    그래서 각 사실에 우선순위를 붙여 정렬하고 상한을 둔다 —
    낮은 숫자일수록 먼저. 같은 순위끼리는 아래 작성 순서를 지킨다.
      1) 돈이 새거나 숫자를 못 믿게 만드는 것   2) 놓치면 손해 보는 것
      3) 상태를 알려 주는 수치                4) 늘 있는 배경 정보
    """
    scored: list[tuple[int, str]] = []

    def add(priority: int, text: str) -> None:
        scored.append((priority, text))

    prev_word = _PREV_WORD.get(period_type, "이전 기간보다")

    # [매출 변동] 리포트의 머리글 — 정렬에서 빼고 항상 첫 줄에 둔다
    if sales["change_pct"] is not None:
        direction = "감소" if sales["change_pct"] < 0 else "증가"
        headline = f"매출 {sales['total']:,}원 — {prev_word} {abs(sales['change_pct'])}% {direction}"
    else:
        headline = f"매출 {sales['total']:,}원 (이전 비교 데이터 없음)"

    # [순수익 계산] 모든 비용을 제하고 남은 순수익 혹은 지출 초과(적자) 표시.
    # 고정비가 안 들어온 매장에선 '순이익'이라 부르지 않는다 — 임대료가 빠진 숫자를
    # 순이익이라 읽으면 실제보다 월세만큼 잘 벌고 있다고 믿게 된다.
    if profit.get("fixed_cost_missing"):
        if sales["total"] and profit["estimated_profit"] >= 0:
            add(3, f"재료비·인건비 빼고 {profit['estimated_profit']:,}원 "
                   f"— 임대료·공과금은 아직 안 빠졌어요")
        elif profit["estimated_profit"] < 0:
            add(1, f"재료비·인건비만으로 {abs(profit['estimated_profit']):,}원 모자라요 "
                   f"— 임대료까지 넣으면 더 벌어집니다")
    elif profit["estimated_profit"] >= 0:
        if sales["total"]:
            add(3, f"순이익 {profit['estimated_profit']:,}원")
    else:
        add(1, f"적자 {abs(profit['estimated_profit']):,}원 — 비용 점검 필요")

    # [다음 기간 전망] 과거 정산에서 끝내지 않고 앞을 보여 준다 — 예측 캐시가 있을 때만.
    # 같은 순위 안에서는 작성 순서가 그대로 유지되므로, 상한에 잘리지 않도록 여기(앞쪽)에 둔다.
    if outlook:
        line = f"앞으로 {outlook['days']}일 예상 매출 {outlook['expected_revenue']:,}원"
        if outlook["change_pct"] is not None:
            move = "높아요" if outlook["change_pct"] >= 0 else "낮아요"
            line += f" — 최근 하루 평균보다 {abs(outlook['change_pct'])}% {move}"
        add(3, line)
        busiest = outlook["busiest"]
        if busiest:
            add(4, f"가장 바쁠 날은 {busiest['date']}({busiest['weekday']}) "
                   f"— {busiest['revenue']:,}원 예상")

    # [레시피 미등록] 원가에서 통째로 빠진 매출 — 숫자를 믿을 수 있는지의 문제라 가장 앞에
    if cogs["uncovered_count"]:
        names = " · ".join(m["menu"] for m in cogs["uncovered_menus"][:2])
        more = cogs["uncovered_count"] - 2
        add(1, f"레시피가 없어 재료값이 안 잡힌 메뉴: {names}"
               + (f" 외 {more}종" if more > 0 else ""))

    # [저효율 시간] 인건비가 그 시간 매출을 넘긴 구간 — 시간 축으로 펼쳐야 보이는 사실
    if rhythm["negative_hours"]:
        n = rhythm["negative_hours"][0]
        add(2, f"{n['hour']}시대는 매출 {n['sales']:,}원에 인건비 {n['labor']:,}원 — "
               f"{n['gap']:,}원 모자라요")

    # [원가율 이상] 많이 팔리는데 남는 게 없는 메뉴 — 판매가·레시피를 손볼 후보
    if profit["basis"] == "recipe":
        worst = cogs["worst_margin_menus"][0] if cogs["worst_margin_menus"] else None
        if worst and worst["cost_ratio"] is not None and worst["cost_ratio"] >= 45:
            add(2, f"{worst['menu']}은 재료값이 판매액의 {worst['cost_ratio']}%로 특히 높아요")

    # [로스] 실사에서 깎인 재고 = 폐기·과다투입·계량 오차
    if cogs["loss_amount"] > 0:
        top = cogs["loss_items"][0] if cogs["loss_items"] else None
        detail = f" (가장 큰 항목: {top['name']})" if top else ""
        add(2, f"실사에서 줄어든 재고 {cogs['loss_amount']:,}원{detail}")

    # [재고 경보] 부족한 재료를 한눈에 볼 수 있도록 나열
    if inventory["low_stock"]:
        items = [f"{it['name']} {_fmt_qty(it['current_quantity'])}{it['unit']}"
                 for it in inventory["low_stock"][:3]]
        more = len(inventory["low_stock"]) - 3
        add(2, "재고 부족: " + " · ".join(items) + (f" 외 {more}종" if more > 0 else ""))

    # [서류 관리] 위생교육 등 갱신이 임박한 인허가 서류 — 만료된 건 더 급하다
    for doc in compliance[:2]:
        expired = doc.get("status") == "expired"
        left = "이미 만료" if expired else f"{doc['days_left']}일 남음"
        add(2 if expired else 3, f"갱신 임박 서류: {doc['name']} ({left})")
    if len(compliance) > 2:
        add(4, f"미갱신 서류 외 {len(compliance) - 2}건 추가 대기 중")

    # [재료비 비중] 매출에서 재료값이 차지하는 비율 — 카페 손익을 가르는 핵심 수치
    if profit["basis"] == "recipe" and cogs["cost_ratio"] is not None:
        add(3, f"재료값이 매출의 {cogs['cost_ratio']}% ({cogs['theoretical']:,}원)")

    # [인건비 비율] 매출 총액 대비 예상 인건비 비중 계산
    if labor["estimated_cost"] and sales["total"]:
        ratio = round(labor["estimated_cost"] / sales["total"] * 100, 1)
        add(3, f"매출 대비 인건비 {ratio}%")

    # [요일 편차] 같은 요일끼리 하루 평균으로 비교 (관측 2회 이상인 요일만)
    best, worst_day = rhythm["best_weekday"], rhythm["worst_weekday"]
    if best and worst_day and best["weekday"] != worst_day["weekday"]:
        add(4, f"요일별로는 {best['weekday']}요일이 가장 좋고({best['avg_total']:,}원/일), "
               f"{worst_day['weekday']}요일이 가장 낮아요({worst_day['avg_total']:,}원/일)")

    # [피크 시간] 가장 많이 팔린 시간대 — 인력·재료 준비를 맞출 기준점
    if rhythm["peak_hours"]:
        p = rhythm["peak_hours"][0]
        add(4, f"가장 바쁜 시간은 {p['hour']}시대 ({p['total']:,}원 · {p['cups']}잔)")

    # [베스트 메뉴] 최다 판매 메뉴 — 늘 나오는 배경 정보라 맨 뒤
    if sales["top_menus"]:
        top_menu = sales["top_menus"][0]
        add(5, f"베스트 메뉴: {top_menu['menu']} ({top_menu['quantity']}잔 / {top_menu['total']:,}원)")

    # sorted는 안정 정렬이라 같은 우선순위 안에서는 위 작성 순서가 그대로 유지된다
    ranked = [text for _, text in sorted(scored, key=lambda x: x[0])]
    return [headline] + ranked[:_HIGHLIGHT_LIMIT - 1]


# ---------------------------------------------------------------------------
# AI 문장형 조언 — 집계 숫자를 근거로 원인 → 해석 → 제안을 서술한다
# ---------------------------------------------------------------------------

_ADVICE_PROMPT = """당신은 카페 사장님 곁에서 일을 돕는 친근한 AI 비서 '브루'입니다.
아래는 사장님 카페의 {label} 경영 집계 데이터(JSON)입니다.
이 숫자들만 근거로 사장님께 건넬 조언(summary)과, 지금 손댈 수 있는 일(actions)을 한국어로 작성하세요.

[actions 작성 규칙]
- 0~3건. 데이터에서 실제로 짚이는 게 없으면 빈 배열로 둘 것. 억지로 채우지 말 것.
- title: 무엇을 할지 12자 안팎으로 (예: "카라멜 마끼아또 원가 점검").
- evidence: 그렇게 판단한 근거 숫자 한 문장. 반드시 아래 데이터에 있는 값만 쓸 것.
- action: 사장님이 할 일 한 문장. 해요체로 부드럽게.
- screen: 그 일을 하러 갈 화면. 아래 중 하나만 고를 것.
    Menu(메뉴·레시피·판매가 수정), Cost(원가 분석), Inventory(재고·발주),
    Staff(직원 근무 일정), Document(서류·세무), Marketing(홍보), SalesInput(매출 입력)
  해당하는 화면이 없으면 그 action은 빼는 게 낫다.
- 우선순위: 돈이 새는 것(적자·원가율·로스·빈 시간 인건비) > 놓치면 손해인 것(재고·서류) > 기회(홍보).

[summary 작성 규칙]
- 2~3문장. 옆에서 말을 건네듯 부드러운 해요체로 쓸 것 (예: "~했어요", "~해 보세요").
  '권해드립니다', '~하시기 바랍니다', '운영 효율', '지출 항목을 점검' 같은 딱딱한 보고서 말투는 금지.
- 사장님을 가르치려 들지 말 것. '잊지 말고 챙기세요', '~하셔야 해요' 같은 훈계조 대신
  '~해 두시면 좋을 것 같아요'처럼 조심스럽게 제안할 것.
- 적자·매출 하락 같은 나쁜 숫자는 밝게 포장하지 말고 담담하게 짚을 것. 느낌표는 쓰지 말 것.
- 한 문장에 이야기 하나씩만 담고 짧게 끊을 것. 길게 이어 붙이지 말 것.
- 숫자 근거를 반드시 포함하되 읽기 쉽게 반올림할 것 (예: 34,925원 → 약 3만 5천 원).
- '안전재고', '수지', '원가율', '%p' 같은 전문 용어는 쓰지 말고 누구나 바로 이해하는 쉬운 말로 쓸 것
  (예: '재고가 곧 떨어지는 재료', '재료값', '남는 돈').
- '무엇이 그랬는지 → 왜 그런지 → 그래서 뭘 해 보면 좋을지' 흐름으로 쓸 것.
  예시: "이번 주 재료값이 12만 원 늘었어요. 우유를 많이 쓰는 라떼가 잘 팔린 영향이에요. 우유 납품 단가를 한번 확인해 보세요."
- 데이터에 없는 사실(단가 인상 이유 등)을 지어내지 말 것. 근거가 부족하면 눈에 띄는 수치 하나를 짚고 확인을 제안할 것.
- 인사말·서론 없이 조언 본문만 쓸 것.

[숫자를 읽는 법]
- profit.basis가 "recipe"면 재료비는 팔린 메뉴의 레시피로 계산한 값이다. "purchase"면 촬영한 명세서
  기준이라 들쭉날쭉할 수 있으니, 손익을 단정하지 말고 레시피 등록을 권하는 쪽으로 쓸 것.
- cogs.uncovered_count가 0보다 크면 그만큼 재료비가 빠져 이익이 실제보다 커 보인다 — 이걸 먼저 알릴 것.
- rhythm.negative_hours는 그 시간대 매출보다 인건비가 많았다는 뜻이다.
- cogs.loss_amount는 재고 실사에서 줄어든 금액(폐기·흘림·계량 오차)이다.
- outlook은 앞으로의 예상치다(없을 수도 있다). 지나간 숫자와 섞어 쓰지 말고 '예상'이라고 밝힐 것.
  outlook.stale이 true면 예측이 조금 지난 것이니 단정하지 말 것.

집계 데이터:
{data}"""

# Gemini에게 강제할 응답 구조 — 자유 텍스트로 받으면 마크다운·서론이 섞여 파싱이 무너진다
_ADVICE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                    "action": {"type": "string"},
                    "screen": {"type": "string", "enum": [
                        "Menu", "Cost", "Inventory", "Staff",
                        "Document", "Marketing", "SalesInput"]},
                },
                "required": ["title", "evidence", "action", "screen"],
            },
        },
    },
    "required": ["summary", "actions"],
}

# 스키마의 enum을 어겨서 돌아온 화면 이름은 버튼을 못 만드므로 액션째로 떨군다
_ACTION_SCREENS = {"Menu", "Cost", "Inventory", "Staff", "Document", "Marketing", "SalesInput"}


# 근거 숫자가 바뀌었어도 조언 재생성은 최소 이 간격을 지킨다 — 근무 중 인건비처럼
# 분 단위로 미세하게 변하는 값 때문에 새로고침마다 Gemini가 호출되는 낭비 방지
_ADVICE_MIN_INTERVAL = timedelta(minutes=30)

# 조언의 형식(프롬프트·응답 구조) 버전. 형식을 바꿀 때마다 올린다.
# 데이터 동일성(해시)과 분리해 둔 이유: 형식이 바뀐 건 30분을 기다릴 일이 아니다.
# 해시에 섞어 두면 위 재사용 간격에 걸려, 새로 추가한 필드가 30분 동안 빈 채로 나간다.
_ADVICE_VERSION = 2


def _advice_source(content: dict[str, Any]) -> str:
    """조언의 근거가 되는 집계 요약본(JSON 문자열) — 토큰 절약을 위해 일별 추이 등 긴 목록은 뺀다.

    이 문자열이 지난 리포트와 같으면 조언도 같아야 하므로 Gemini를 다시 부르지 않는다.
    """
    slim = {
        "period": content["period"],
        "sales": {k: v for k, v in content["sales"].items() if k != "daily_trend"},
        "cogs": content["cogs"],
        "rhythm": content["rhythm"],
        "outlook": content["outlook"],
        "purchases": content["purchases"],
        "expenses": content["expenses"],
        "labor": content["labor"],
        "profit": content["profit"],
        "inventory": {
            "low_stock": content["inventory"]["low_stock"],
            "total_value": content["inventory"]["total_value"],
        },
        "orders": content["orders"],
        "compliance_alerts": len(content["compliance_alerts"]),
    }
    return json.dumps(slim, ensure_ascii=False, sort_keys=True)


def _generate_ai_advice(source: str, period_type: str) -> tuple[Optional[str], list[dict[str, Any]]]:
    """Gemini로 (문장형 조언, 액션 목록)을 생성한다. 실패하면 (None, []) — 리포트는 그대로 발행."""
    if not GEMINI_API_KEY:
        logger.info("GEMINI_API_KEY 없음 — AI 조언 생략")
        return None, []

    prompt = _ADVICE_PROMPT.format(
        label=PERIOD_LABEL.get(period_type, period_type),
        data=source,
    )
    try:
        import httpx

        resp = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.3,
                    "responseMimeType": "application/json",
                    "responseSchema": _ADVICE_SCHEMA,
                },
            },
            headers={"x-goog-api-key": GEMINI_API_KEY},
            timeout=20.0,
        )
        resp.raise_for_status()
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(raw)

        summary = (parsed.get("summary") or "").strip() or None
        actions = []
        for a in (parsed.get("actions") or [])[:3]:
            if not isinstance(a, dict):
                continue
            screen = a.get("screen")
            title, action_text = (a.get("title") or "").strip(), (a.get("action") or "").strip()
            # 화면을 못 정했거나 문구가 비면 카드에서 버튼을 만들 수 없다 — 조용히 버린다
            if screen not in _ACTION_SCREENS or not title or not action_text:
                continue
            actions.append({
                "title": title,
                "evidence": (a.get("evidence") or "").strip(),
                "action": action_text,
                "screen": screen,
            })
        return summary, actions
    except Exception as e:  # LLM 실패가 리포트 자체를 막으면 안 된다
        logger.warning("AI 조언 생성 실패 (숫자 리포트만 발행): %s", e)
        return None, []


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
        cogs = _cogs_summary(db, store_id, start, end, sales)
        purchases = _purchase_summary(db, store_id, start, end, prev_start, prev_end)
        expenses = _expense_summary(db, store_id, start, end)
        labor = _labor_summary(db, store_id, start, end)
        inventory = _inventory_snapshot(db, store_id)
        orders = _order_snapshot(db, store_id)

    sales.pop("_by_menu_id", None)  # 원가 계산용 중간 산출물 — 문서에는 남기지 않는다
    rhythm = _rhythm_analysis(sales, labor)
    outlook = _outlook(store_id, sales, period_type)
    compliance = document_service.get_upcoming_renewals(store_id)

    # 손익은 '판매한 만큼의 재료비'(레시피 원가)로 계산한다.
    # 매입(OCR 확정 문서)으로 계산하면 명세서를 언제 촬영했는지가 손익을 좌우한다 —
    # 사진을 안 찍은 주는 매입 0원이라 순이익이 매출 전액에 가깝게 부풀고,
    # 밀린 명세서를 하루에 몰아 찍으면 그날이 대형 적자로 찍힌다.
    # 다만 레시피가 덜 등록된 매장에선 원가율이 실제보다 낮게 나오므로,
    # 커버리지가 기준 미달이면 종전대로 매입 기준으로 되돌린다.
    use_recipe = cogs["reliable"]
    material_cost = cogs["theoretical"] if use_recipe else purchases["total"]
    total_cost = material_cost + expenses["total"] + labor["estimated_cost"]
    estimated_profit = sales["total"] - total_cost
    # 현금 관점 — 실제로 나간 돈(매입·지출·인건비) 기준. 손익과 나란히 두면
    # '이익은 나는데 통장이 빈' 상황(대량 매입한 주)을 구분해 볼 수 있다.
    cash_cost = purchases["total"] + expenses["total"] + labor["estimated_cost"]
    # 지출(Expense)은 사장님이 손으로 넣는 표라 임대료가 대개 없다. 그러면 월세가 통째로
    # 빠진 채 '순이익'이 계산된다 — 월세 200만원 매장이면 200만원이 그대로 이익으로 둔갑한다.
    # 재료비만 보고 '많이 남는다'고 믿게 만드는 바로 그 착각이라, 고정비가 안 잡혔으면
    # 숫자를 감추지는 않되 '순이익'이라고 부르지는 않는다.
    #
    # '지출이 하나라도 있으면 고정비도 넣었겠지'로 판단하면 안 된다. 실제 매장을 열어 보니
    # 지출 15건이 전부 원두매입·우유·소모품(=변동비)이고 임대료는 한 건도 없었다.
    # 카테고리는 자유 입력이라(OperationScreen 플레이스홀더가 "예: 원두매입, 임대료")
    # 이름으로 알아볼 수밖에 없다.
    fixed_cost_missing = not _has_fixed_cost(expenses)
    profit = {
        "basis": "recipe" if use_recipe else "purchase",
        "material_cost": material_cost,
        "total_cost": total_cost,
        "estimated_profit": estimated_profit,
        "margin_pct": round(estimated_profit / sales["total"] * 100, 1) if sales["total"] else None,
        "cash_total_cost": cash_cost,
        "cash_balance": sales["total"] - cash_cost,
        # 고정비가 등록되면(팀 손익분기 기능 포함) 자동으로 꺼진다 — 별도 해제가 필요 없다
        "fixed_cost_missing": fixed_cost_missing,
    }

    content = {
        "period_type": period_type,
        "period": display,
        "sales": sales,
        "cogs": cogs,
        "purchases": purchases,
        "expenses": expenses,
        "labor": labor,
        "rhythm": rhythm,
        "outlook": outlook,
        "profit": profit,
        "inventory": inventory,
        "orders": orders,
        "compliance_alerts": compliance,
        "highlights": _build_highlights(sales, cogs, labor, rhythm, outlook, inventory,
                                        compliance, profit, period_type),
        "note": _build_note(use_recipe, cogs, fixed_cost_missing),
    }
    # AI 조언 — 근거 숫자가 지난 리포트와 같으면 Gemini를 부르지 않고 이전 조언을 재사용하고,
    # 숫자가 바뀌었어도 마지막 생성 후 30분 안에는 재생성하지 않는다
    # (홈 화면이 열릴 때마다 refresh=True로 이 함수가 불려 호출이 누적되던 낭비 제거)
    source = _advice_source(content)
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
    prev = existing["content"] if existing else {}
    reuse = False
    # 옛 형식으로 만들어진 조언은 숫자가 그대로여도 다시 만든다 — 안 그러면 새로 추가한
    # 액션이 빈 채로 남는다. 형식이 같을 때만 아래 재사용 판단으로 넘어간다.
    if prev.get("ai_advice") and prev.get("ai_advice_version") == _ADVICE_VERSION:
        if prev.get("ai_advice_hash") == source_hash:
            reuse = True
        else:
            try:
                age = datetime.now(KST) - datetime.fromisoformat(prev["ai_advice_at"])
                reuse = age < _ADVICE_MIN_INTERVAL
            except (KeyError, TypeError, ValueError):
                reuse = False
    if reuse:
        content["ai_advice"] = prev["ai_advice"]
        content["ai_actions"] = prev.get("ai_actions") or []
        content["ai_advice_hash"] = prev.get("ai_advice_hash")
        content["ai_advice_at"] = prev.get("ai_advice_at")
    else:
        # 생성 실패(None)면 해시를 저장해도 ai_advice가 비어 있어 다음 갱신 때 다시 시도된다
        content["ai_advice"], content["ai_actions"] = _generate_ai_advice(source, period_type)
        content["ai_advice_hash"] = source_hash
        content["ai_advice_at"] = datetime.now(KST).isoformat()
    content["ai_advice_version"] = _ADVICE_VERSION
    if existing:
        return document_service.update_document(store_id, existing["id"], content)
    label = PERIOD_LABEL[period_type]
    return document_service._save_document(
        store_id, "management_report", f"{label} 경영 리포트 ({display})", content, period=display)


def get_cached_management_report(store_id: str, period_type: str = "weekly",
                                 reference_date: Optional[str] = None) -> Optional[dict[str, Any]]:
    """현재 기간의 저장된 리포트를 재계산 없이 돌려준다 (없거나 입력이 이상하면 None).

    홈 화면 stale-while-revalidate용 — 집계 쿼리 10회+와 Gemini 호출 없이
    문서 조회 1회로 끝나므로 원격 DB에서도 즉시 응답한다. 최신화는 호출자가
    refresh_management_report_background로 백그라운드에서 처리한다.
    """
    try:
        ref = date.fromisoformat(reference_date) if reference_date else date.today()
        *_, display = _period_range(period_type, ref)
    except (ValueError, ReportError):
        return None
    return next(
        (d for d in document_service.list_documents(store_id, kind="management_report")
         if d["period"] == display and d["content"].get("period_type") == period_type),
        None,
    )


# 같은 (매장, 기간) 리포트 재계산이 동시에 여러 번 돌지 않게 하는 진행 중 표시.
# 홈 화면이 연달아 열리거나 당겨서 새로고침을 반복해도 백그라운드 재계산은 한 번만 돈다.
_refresh_inflight: set[tuple[str, str]] = set()
_refresh_lock = threading.Lock()


def refresh_management_report_background(store_id: str, period_type: str = "weekly") -> None:
    """리포트를 백그라운드에서 최신 수치로 재계산한다 (BackgroundTasks용, 실패는 로그만)."""
    key = (store_id, period_type)
    with _refresh_lock:
        if key in _refresh_inflight:
            return
        _refresh_inflight.add(key)
    try:
        generate_management_report(store_id, period_type=period_type, force_refresh=True)
    except Exception:
        logger.exception("경영 리포트 백그라운드 갱신 실패 (%s, %s)", store_id, period_type)
    finally:
        with _refresh_lock:
            _refresh_inflight.discard(key)


def list_management_reports(store_id: str, period_type: Optional[str] = None) -> list[dict[str, Any]]:
    """생성된 경영 리포트 목록 (period_type으로 필터 가능)."""
    docs = document_service.list_documents(store_id, kind="management_report")
    if period_type:
        docs = [d for d in docs if d["content"].get("period_type") == period_type]
    return docs
