"""AI 경영 리포트 로직 (백엔드 B) — 일간·주간·월간

카페 전체 데이터를 한 문서로 통합 집계한다:
  매출(Sale) · 매입(확정 OCR 문서) · 기타 지출(Expense) · 인건비(근무 스케줄 × 시급)
  · 재고 현황(Stock) · 발주 진행(Order) · 갱신 임박 서류(Compliance)

이전 기간과의 비교(증감률)와 규칙 기반 하이라이트까지 계산해 담고,
문장형 조언·해석은 리포트 전문가(서브에이전트 LLM)가 이 숫자를 근거로 작성한다.

생성 결과는 generated_documents(kind="management_report")로 저장된다 —
챗봇 화면에는 카드로 바로 표시되고, 서류 자동화 화면에서도 다시 볼 수 있다.
"""

import hashlib
import json
import logging
import os
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
    for s, menu_name in rows:
        day = s.sold_at.date().isoformat()
        daily[day] = daily.get(day, 0) + s.total_price
        m = by_menu.setdefault(menu_name, {"menu": menu_name, "quantity": 0, "total": 0})
        m["quantity"] += s.quantity
        m["total"] += s.total_price

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
    """인건비: 근무 스케줄 시간 × 직원 시급으로 추정 (주휴수당·보험 미포함 간이 계산).

    아직 끝나지 않은 근무는 지금 시각까지 일한 만큼만 계산한다 —
    진행 중인 기간은 매출도 '지금까지'만 잡히므로, 인건비를 하루치 전체로 잡으면
    오전 리포트가 항상 적자로 보이는 왜곡이 생긴다 (기간 비교 트리밍과 같은 원칙).
    """
    from app.models.operation import Employee, Schedule

    rows = (
        db.query(Schedule, Employee)
        .join(Employee, Schedule.employee_id == Employee.id)
        .filter(Schedule.date >= start.isoformat(), Schedule.date < end.isoformat())
        .all()
    )
    now = datetime.now()
    total_hours = 0.0
    total_cost = 0.0
    employees: set[str] = set()
    for sched, emp in rows:
        worked_until = min(sched.end_time, now)
        hours = max((worked_until - sched.start_time).total_seconds() / 3600, 0.0)
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


def _build_highlights(sales: dict, labor: dict, inventory: dict,
                      compliance: list, profit: dict, period_type: str) -> list[str]:
    h: list[str] = []
    prev_word = _PREV_WORD.get(period_type, "이전 기간보다")
    
    # [매출 변동] 전 주/달 대비 매출 증감율 표시
    if sales["change_pct"] is not None:
        direction = "감소" if sales["change_pct"] < 0 else "증가"
        h.append(f"매출 {sales['total']:,}원 — {prev_word} {abs(sales['change_pct'])}% {direction}")
    else:
        h.append(f"매출 {sales['total']:,}원 (이전 비교 데이터 없음)")
        
    # [베스트 메뉴] 최다 판매 메뉴와 매출 기여액 표시
    if sales["top_menus"]:
        best = sales["top_menus"][0]
        h.append(f"베스트 메뉴: {best['menu']} ({best['quantity']}잔 / {best['total']:,}원)")
        
    # [순수익 계산] 모든 비용을 제하고 남은 순수익 혹은 지출 초과(적자) 표시
    if profit["estimated_profit"] >= 0:
        if sales["total"]:
            h.append(f"순이익 {profit['estimated_profit']:,}원")
    else:
        h.append(f"적자 {abs(profit['estimated_profit']):,}원 — 비용 점검 필요")

    # [재고 경보] 부족한 재료를 한눈에 볼 수 있도록 나열
    if inventory["low_stock"]:
        items = [f"{it['name']} {_fmt_qty(it['current_quantity'])}{it['unit']}"
                 for it in inventory["low_stock"][:3]]
        more = len(inventory["low_stock"]) - 3
        h.append("재고 부족: " + " · ".join(items) + (f" 외 {more}종" if more > 0 else ""))

    # [서류 관리] 위생교육 등 갱신이 임박한 인허가 서류 잔여일 표기
    for doc in compliance[:2]:
        left = "이미 만료" if doc.get("status") == "expired" else f"{doc['days_left']}일 남음"
        h.append(f"갱신 임박 서류: {doc['name']} ({left})")
    if len(compliance) > 2:
        h.append(f"미갱신 서류 외 {len(compliance) - 2}건 추가 대기 중")
        
    # [인건비 비율] 매출 총액 대비 예상 인건비 비중 계산
    if labor["estimated_cost"] and sales["total"]:
        ratio = round(labor["estimated_cost"] / sales["total"] * 100, 1)
        h.append(f"매출 대비 인건비 {ratio}%")
    return h


# ---------------------------------------------------------------------------
# AI 문장형 조언 — 집계 숫자를 근거로 원인 → 해석 → 제안을 서술한다
# ---------------------------------------------------------------------------

_ADVICE_PROMPT = """당신은 카페 사장님 곁에서 일을 돕는 친근한 AI 비서 '브루'입니다.
아래는 사장님 카페의 {label} 경영 집계 데이터(JSON)입니다.
이 숫자들만 근거로 사장님께 건넬 조언을 한국어로 작성하세요.

규칙:
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
- 인사말·서론 없이 조언 본문만 출력할 것.

집계 데이터:
{data}"""


# 근거 숫자가 바뀌었어도 조언 재생성은 최소 이 간격을 지킨다 — 근무 중 인건비처럼
# 분 단위로 미세하게 변하는 값 때문에 새로고침마다 Gemini가 호출되는 낭비 방지
_ADVICE_MIN_INTERVAL = timedelta(minutes=30)


def _advice_source(content: dict[str, Any]) -> str:
    """조언의 근거가 되는 집계 요약본(JSON 문자열) — 토큰 절약을 위해 일별 추이 등 긴 목록은 뺀다.

    이 문자열이 지난 리포트와 같으면 조언도 같아야 하므로 Gemini를 다시 부르지 않는다.
    """
    slim = {
        "period": content["period"],
        "sales": {k: v for k, v in content["sales"].items() if k != "daily_trend"},
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


def _generate_ai_advice(source: str, period_type: str) -> Optional[str]:
    """Gemini로 리포트 숫자에 대한 문장형 조언을 생성한다. 실패하면 None (리포트는 그대로 발행)."""
    if not GEMINI_API_KEY:
        logger.info("GEMINI_API_KEY 없음 — AI 조언 생략")
        return None

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
                "generationConfig": {"temperature": 0.3},
            },
            headers={"x-goog-api-key": GEMINI_API_KEY},
            timeout=15.0,
        )
        resp.raise_for_status()
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        return text or None
    except Exception as e:  # LLM 실패가 리포트 자체를 막으면 안 된다
        logger.warning("AI 조언 생성 실패 (숫자 리포트만 발행): %s", e)
        return None


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
        "highlights": _build_highlights(sales, labor, inventory, compliance, profit, period_type),
        "note": "매입은 스캔해서 확정한 영수증·거래명세서 기준, 인건비는 지금까지 일한 시간×시급으로 계산한 추정치입니다. "
                "현금 매입·주휴수당 등 빠진 금액이 있을 수 있어 참고용으로 봐 주세요.",
    }
    # AI 조언 — 근거 숫자가 지난 리포트와 같으면 Gemini를 부르지 않고 이전 조언을 재사용하고,
    # 숫자가 바뀌었어도 마지막 생성 후 30분 안에는 재생성하지 않는다
    # (홈 화면이 열릴 때마다 refresh=True로 이 함수가 불려 호출이 누적되던 낭비 제거)
    source = _advice_source(content)
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
    prev = existing["content"] if existing else {}
    reuse = False
    if prev.get("ai_advice"):
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
        content["ai_advice_hash"] = prev.get("ai_advice_hash")
        content["ai_advice_at"] = prev.get("ai_advice_at")
    else:
        # 생성 실패(None)면 해시를 저장해도 ai_advice가 비어 있어 다음 갱신 때 다시 시도된다
        content["ai_advice"] = _generate_ai_advice(source, period_type)
        content["ai_advice_hash"] = source_hash
        content["ai_advice_at"] = datetime.now(KST).isoformat()
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
