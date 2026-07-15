"""문서 자동화 로직 (백엔드 B) — ERP-12

카페 운영 필요서류 체크리스트 기반 자동화:
  매일·매주 : 발주서 초안, 재고실사표, 검수확인서 (거래명세서 보관은 OCR[ocr_service]이 담당)
  매월      : 임금명세서 초안(스케줄 자동 집계)·임금대장, 매입·매출 장부
  분기·연   : 부가세 신고 참고자료 (참고용 — 최종 신고는 사람이 확인 후 진행)
  발생 시   : 근로계약서 초안
  정기 갱신 : 위생교육·보건증·계약 만료일 추적 + 임박 알림 (발급은 기관에서만 가능하므로 알림까지가 범위)

원칙: 돈이 걸린 문서(발주서·임금명세서)는 초안(draft)만 생성하고 확정·전송은 사람이 한다 (PRD §5.3).
"""

import json
import logging
import uuid
from datetime import date, datetime
from typing import Any, Optional

from app.schemas.ai import ComplianceItemCreate, EmploymentContractRequest, PayslipRequest

logger = logging.getLogger(__name__)

# 한 달 평균 주 수 (365.25 / 12 / 7) — 주휴수당 월 환산에 사용
WEEKS_PER_MONTH = 4.345

_tables_ready = False


def _session():
    """DB 세션 획득 + 첫 사용 시 테이블 생성 (없으면)."""
    global _tables_ready
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
    from app.core.database import Base, SessionLocal, engine

    if not _tables_ready:
        Base.metadata.create_all(bind=engine)
        _tables_ready = True
    return SessionLocal()


class DocumentError(ValueError):
    """문서 생성 실패 (입력 오류·데이터 없음)"""


# ---------------------------------------------------------------------------
# 공통: 문서 저장/조회
# ---------------------------------------------------------------------------

def _save_document(store_id: str, kind: str, title: str, content: dict[str, Any],
                   period: Optional[str] = None) -> dict[str, Any]:
    from app.models.ai import GeneratedDocument

    doc_id = uuid.uuid4().hex[:12]
    with _session() as db:
        db.add(GeneratedDocument(
            id=doc_id, store_id=store_id, kind=kind, title=title,
            period=period, content=json.dumps(content, ensure_ascii=False), status="draft",
        ))
        db.commit()
    return {"id": doc_id, "kind": kind, "title": title, "period": period,
            "status": "draft", "content": content, "created_at": datetime.now()}


def _row_to_dict(row) -> dict[str, Any]:
    return {"id": row.id, "kind": row.kind, "title": row.title, "period": row.period,
            "status": row.status, "content": json.loads(row.content), "created_at": row.created_at}


def list_documents(store_id: str, kind: Optional[str] = None) -> list[dict[str, Any]]:
    from app.models.ai import GeneratedDocument

    with _session() as db:
        query = db.query(GeneratedDocument).filter(GeneratedDocument.store_id == store_id)
        if kind:
            query = query.filter(GeneratedDocument.kind == kind)
        return [_row_to_dict(r) for r in query.order_by(GeneratedDocument.created_at.desc()).all()]


def get_document(store_id: str, doc_id: str) -> dict[str, Any]:
    from app.models.ai import GeneratedDocument

    with _session() as db:
        row = db.get(GeneratedDocument, doc_id)
        if row is None or row.store_id != store_id:
            raise DocumentError(f"문서 {doc_id}를 찾을 수 없습니다")
        return _row_to_dict(row)


# ---------------------------------------------------------------------------
# 매일·매주 — 구매·재고
# ---------------------------------------------------------------------------

def draft_purchase_order(store_id: str) -> dict[str, Any]:
    """발주서 초안 — 안전재고 이하로 떨어진 재료를 모아 발주 품목을 제안한다.

    초안일 뿐 실제 발주(전송)는 하지 않는다. 제안 수량 = 안전재고의 2배 - 현재고.
    """
    from app.models.inventory import Ingredient, Stock

    with _session() as db:
        rows = (
            db.query(Ingredient, Stock)
            .join(Stock, Stock.ingredient_id == Ingredient.id)
            .filter(Ingredient.store_id == store_id)
            .filter(Stock.safety_quantity > 0)
            .filter(Stock.current_quantity <= Stock.safety_quantity)
            .order_by(Ingredient.id)
            .all()
        )
        items = []
        for ing, stock in rows:
            suggested = max(round(stock.safety_quantity * 2 - stock.current_quantity, 2), 1)
            items.append({
                "name": ing.name, "unit": ing.unit,
                "current_quantity": stock.current_quantity,
                "safety_quantity": stock.safety_quantity,
                "suggested_quantity": suggested,
                "unit_price": ing.current_price,
                "estimated_amount": round(suggested * ing.current_price),
            })

    today = date.today().isoformat()
    content = {
        "date": today,
        "items": items,
        "total_estimated": sum(i["estimated_amount"] for i in items),
        "note": "안전재고 이하 품목 자동 추출 초안입니다. 수량·거래처 확인 후 직접 발주하세요."
        if items else "안전재고 이하로 떨어진 재료가 없습니다. (안전재고가 설정된 재료만 검사)",
    }
    return _save_document(store_id, "purchase_order", f"발주서 초안 ({today})", content, period=today)


def generate_stocktake_sheet(store_id: str) -> dict[str, Any]:
    """재고실사표 — 장부상 수량을 채워 넣은 실사용 시트 (실사 수량은 현장에서 기입)."""
    from app.models.inventory import Ingredient, Stock

    with _session() as db:
        rows = (
            db.query(Ingredient, Stock)
            .outerjoin(Stock, Stock.ingredient_id == Ingredient.id)
            .filter(Ingredient.store_id == store_id)
            .order_by(Ingredient.id)
            .all()
        )
        items = [{
            "name": ing.name, "unit": ing.unit,
            "book_quantity": stock.current_quantity if stock else 0,
            "counted_quantity": None,  # 현장에서 기입
            "difference": None,
            "note": "",
        } for ing, stock in rows]

    today = date.today().isoformat()
    content = {"date": today, "items": items,
               "note": "counted_quantity에 실사 수량을 기입하면 장부와의 차이를 확인할 수 있습니다."}
    return _save_document(store_id, "stocktake_sheet", f"재고실사표 ({today})", content, period=today)


def generate_inspection_report(store_id: str, ocr_doc_id: str) -> dict[str, Any]:
    """검수확인서 — OCR로 등록한 거래명세서/영수증 기반 입고 검수 문서."""
    from app.models.ai import OcrDocument

    with _session() as db:
        doc = db.get(OcrDocument, ocr_doc_id)
        if doc is None:
            raise DocumentError(f"OCR 문서 {ocr_doc_id}를 찾을 수 없습니다")
        items = [{
            "name": item.name,
            "quantity": float(item.quantity) if item.quantity is not None else None,
            "unit": item.unit,
            "condition": "",  # 양호/파손 등 현장에서 기입
            "note": "",
        } for item in doc.items]
        vendor, issued = doc.vendor_name, doc.issued_date

    today = date.today().isoformat()
    content = {
        "inspection_date": today,
        "vendor": vendor,
        "delivery_date": issued,
        "source_document": ocr_doc_id,
        "items": items,
        "inspector_sign": "",  # 검수자 서명란
        "note": "품목별 상태(condition)를 확인 후 서명하세요.",
    }
    return _save_document(store_id, "inspection_report", f"검수확인서 ({vendor or '거래처 미상'}, {today})",
                          content, period=today)


# ---------------------------------------------------------------------------
# 매월 — 장부·급여
# ---------------------------------------------------------------------------

def _month_range(year: int, month: int) -> tuple[str, str]:
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return start.isoformat(), end.isoformat()


def generate_monthly_ledger(store_id: str, year: int, month: int) -> dict[str, Any]:
    """매입·매출 장부 — 확정된 OCR 문서(매입)와 판매 기록(매출)을 월 단위로 집계."""
    from app.models.ai import OcrDocument
    from app.models.inventory import Menu, Sale

    start, end = _month_range(year, month)
    period = f"{year:04d}-{month:02d}"

    with _session() as db:
        purchases = [{
            "date": d.issued_date or d.created_at.date().isoformat(),
            "vendor": d.vendor_name,
            "doc_type": d.doc_type,
            "subtotal": float(d.subtotal) if d.subtotal is not None else None,
            "tax": float(d.tax) if d.tax is not None else None,
            "total": float(d.total) if d.total is not None else None,
            "source_document": d.id,
        } for d in (
            db.query(OcrDocument)
            .filter(OcrDocument.status == "confirmed")
            .filter(OcrDocument.created_at >= start, OcrDocument.created_at < end)
            .order_by(OcrDocument.created_at)
            .all()
        )]
        sales = [{
            "date": s.sold_at.date().isoformat(),
            "menu": menu_name,
            "quantity": s.quantity,
            "total_price": s.total_price,
        } for s, menu_name in (
            db.query(Sale, Menu.name)
            .join(Menu, Sale.menu_id == Menu.id)
            .filter(Sale.store_id == store_id)
            .filter(Sale.sold_at >= start, Sale.sold_at < end)
            .order_by(Sale.sold_at)
            .all()
        )]

    purchase_total = sum(p["total"] or 0 for p in purchases)
    sales_total = sum(s["total_price"] for s in sales)
    content = {
        "period": period,
        "purchases": purchases,
        "sales": sales,
        "purchase_total": purchase_total,
        "sales_total": sales_total,
        "balance": sales_total - purchase_total,
        "note": "매입은 OCR로 확정한 문서 기준입니다. 현금 매입 등 누락분은 직접 추가하세요.",
    }
    return _save_document(store_id, "monthly_ledger", f"매입·매출 장부 ({period})", content, period=period)


def draft_payslip(store_id: str, req: PayslipRequest) -> dict[str, Any]:
    """임금명세서 초안 — 근무 스케줄에서 시간을 자동 집계해 급여를 계산한다.

    근로기준법 제48조 필수 기재사항(임금 구성항목·계산방법·공제내역)을 담는다.
    간이 계산 초안이므로 4대보험 가입자 등은 지급 전 세무 담당자 확인이 필요하다.
    저장된 명세서 목록이 임금대장이 된다 (3년 보관 — 삭제 기능 없음).
    """
    from app.models.operation import Employee, Schedule

    period = f"{req.year:04d}-{req.month:02d}"
    with _session() as db:
        employee = db.query(Employee).filter(Employee.name == req.employee_name).first()

        hourly_wage = req.hourly_wage or (employee.hourly_rate if employee else None)
        if not hourly_wage:
            raise DocumentError(
                f"'{req.employee_name}' 직원의 시급을 알 수 없습니다 — hourly_wage를 직접 입력하세요")

        work_hours = req.work_hours
        hours_source = "직접 입력"
        if work_hours is None:
            if employee is None:
                raise DocumentError(
                    f"'{req.employee_name}' 직원이 등록돼 있지 않습니다 — work_hours를 직접 입력하세요")
            schedules = (
                db.query(Schedule)
                .filter(Schedule.employee_id == employee.id)
                .filter(Schedule.date.like(f"{period}%"))
                .all()
            )
            work_hours = round(sum(
                (s.end_time - s.start_time).total_seconds() / 3600 for s in schedules), 2)
            hours_source = f"근무 스케줄 자동 집계 ({len(schedules)}건)"
            if work_hours == 0:
                raise DocumentError(f"{period}에 '{req.employee_name}'의 근무 스케줄이 없습니다 — work_hours를 직접 입력하세요")

    base_pay = round(work_hours * hourly_wage)

    # 주휴수당: 1주 평균 15시간 이상 근무 시, (주 근무시간/40) × 8시간 × 시급 (주 8시간 상한)
    weekly_avg = round(work_hours / WEEKS_PER_MONTH, 1)
    holiday_pay = 0
    if req.include_weekly_holiday_pay and weekly_avg >= 15:
        holiday_pay = round(min(weekly_avg, 40) / 40 * 8 * hourly_wage * WEEKS_PER_MONTH)

    gross = base_pay + holiday_pay
    withholding = round(gross * req.withholding_rate / 100)
    net = gross - withholding

    content = {
        "employee_name": req.employee_name,
        "period": period,
        "hourly_wage": hourly_wage,
        "work_hours": work_hours,
        "hours_source": hours_source,
        "earnings": {
            "base_pay": base_pay,
            "weekly_holiday_pay": holiday_pay,
            "weekly_avg_hours": weekly_avg,
            "gross": gross,
        },
        "deductions": {
            "withholding_rate": req.withholding_rate,
            "withholding": withholding,
        },
        "net_pay": net,
        "calculation": (
            f"기본급 {work_hours}시간 × {hourly_wage:,}원 = {base_pay:,}원"
            + (f" / 주휴수당(주평균 {weekly_avg}시간) {holiday_pay:,}원" if holiday_pay else "")
            + f" / 공제 {req.withholding_rate}% = {withholding:,}원 / 실지급 {net:,}원"
        ),
        "note": "간이 계산 초안입니다. 4대보험 가입자는 공제 항목이 다르므로 지급 전 반드시 확인하세요.",
    }
    return _save_document(store_id, "payslip", f"임금명세서 초안 ({req.employee_name}, {period})",
                          content, period=period)


def get_wage_ledger(store_id: str, year: int) -> dict[str, Any]:
    """임금대장 — 그해 생성된 임금명세서를 직원·월별로 모은다 (3년 보관 의무 대응)."""
    from app.models.ai import GeneratedDocument

    with _session() as db:
        rows = (
            db.query(GeneratedDocument)
            .filter(GeneratedDocument.store_id == store_id, GeneratedDocument.kind == "payslip")
            .filter(GeneratedDocument.period.like(f"{year:04d}-%"))
            .order_by(GeneratedDocument.period, GeneratedDocument.created_at)
            .all()
        )
        entries = []
        for r in rows:
            c = json.loads(r.content)
            entries.append({
                "period": r.period,
                "employee_name": c["employee_name"],
                "work_hours": c["work_hours"],
                "gross": c["earnings"]["gross"],
                "withholding": c["deductions"]["withholding"],
                "net_pay": c["net_pay"],
                "payslip_id": r.id,
            })
    return {
        "year": year,
        "entries": entries,
        "total_gross": sum(e["gross"] for e in entries),
        "total_net": sum(e["net_pay"] for e in entries),
        "note": "임금대장은 3년 보관 의무가 있습니다 (명세서 원본은 generated_documents에 보관됨).",
    }


# ---------------------------------------------------------------------------
# 분기·연 — 세무 참고자료
# ---------------------------------------------------------------------------

def generate_vat_reference(store_id: str, start_date: str, end_date: str) -> dict[str, Any]:
    """부가가치세 신고 참고자료 — 기간 매출·매입을 집계한 참고용 요약.

    참고용일 뿐이며 최종 신고는 반드시 사람이 홈택스/세무사를 통해 확인 후 진행한다.
    """
    from app.models.ai import OcrDocument
    from app.models.inventory import Sale

    with _session() as db:
        sales_total = sum(s.total_price for s in (
            db.query(Sale)
            .filter(Sale.store_id == store_id)
            .filter(Sale.sold_at >= start_date, Sale.sold_at < end_date)
            .all()
        ))
        purchase_docs = (
            db.query(OcrDocument)
            .filter(OcrDocument.status == "confirmed")
            .filter(OcrDocument.created_at >= start_date, OcrDocument.created_at < end_date)
            .all()
        )
        purchase_subtotal = sum(float(d.subtotal) for d in purchase_docs if d.subtotal is not None)
        purchase_tax = sum(float(d.tax) for d in purchase_docs if d.tax is not None)

    # 일반과세자 기준 간이 추정: 매출세액(공급대가의 10/110) - 매입세액
    estimated_sales_vat = round(sales_total * 10 / 110)
    estimated_payable = estimated_sales_vat - round(purchase_tax)

    content = {
        "period": {"start": start_date, "end": end_date},
        "sales_total": sales_total,
        "estimated_sales_vat": estimated_sales_vat,
        "purchase_subtotal": purchase_subtotal,
        "purchase_tax": round(purchase_tax),
        "purchase_document_count": len(purchase_docs),
        "estimated_payable_vat": estimated_payable,
        "note": "일반과세자 기준 간이 추정 참고자료입니다. 신용카드 매출세액공제, 의제매입세액 등이 "
                "반영되지 않았으므로 최종 신고는 반드시 홈택스/세무사를 통해 확인 후 진행하세요.",
    }
    return _save_document(store_id, "vat_reference",
                          f"부가세 신고 참고자료 ({start_date} ~ {end_date})", content,
                          period=f"{start_date}~{end_date}")


# ---------------------------------------------------------------------------
# 발생 시 — 근로계약서
# ---------------------------------------------------------------------------

def draft_employment_contract(store_id: str, req: EmploymentContractRequest) -> dict[str, Any]:
    """근로계약서 초안 — 근로기준법 제17조 필수 기재사항을 채운 표준 양식."""
    weekly_hours = round(req.work_days_per_week * req.work_hours_per_day, 1)
    content = {
        "employee_name": req.employee_name,
        "employer": store_id,
        "contract_period": {
            "start": req.start_date,
            "end": req.end_date or "기간의 정함 없음",
        },
        "workplace": req.workplace or "매장",
        "duties": req.duties,
        "working_conditions": {
            "work_days_per_week": req.work_days_per_week,
            "work_hours_per_day": req.work_hours_per_day,
            "weekly_hours": weekly_hours,
            "rest": "4시간 근무당 30분 휴게 (근로기준법 제54조)",
            "weekly_holiday": "주 15시간 이상 근무 시 주휴일 부여",
            "annual_leave": "1년 미만: 1개월 개근 시 1일 / 1년 이상: 15일 (5인 이상 사업장)",
        },
        "wage": {
            "hourly_wage": req.hourly_wage,
            "payment_day": "매월 말일 (협의 후 수정)",
            "payment_method": "근로자 명의 계좌 이체",
        },
        "social_insurance": "주 15시간 이상 근무 시 4대보험 가입 대상 (확인 필요)",
        "signatures": {"employer": "", "employee": ""},
        "note": "초안입니다. 서명 전 근무 조건을 당사자와 확인하고, 서명본은 근로자에게 1부 교부하세요 "
                "(미교부 시 500만원 이하 과태료).",
    }
    return _save_document(store_id, "employment_contract",
                          f"근로계약서 초안 ({req.employee_name})", content, period=req.start_date)


# ---------------------------------------------------------------------------
# 정기 갱신 — 만료 추적·알림 (위생교육·보건증·임대차/공급 계약)
# ---------------------------------------------------------------------------

def _compliance_to_dict(row) -> dict[str, Any]:
    days_left = (date.fromisoformat(row.expiry_date) - date.today()).days
    status = "expired" if days_left < 0 else ("due_soon" if days_left <= row.remind_before_days else "ok")
    return {"id": row.id, "name": row.name, "expiry_date": row.expiry_date,
            "remind_before_days": row.remind_before_days, "memo": row.memo,
            "days_left": days_left, "status": status}


def add_compliance_item(store_id: str, req: ComplianceItemCreate) -> dict[str, Any]:
    """갱신 서류 등록 — 예: 보건증(직원별), 위생교육 수료증, 임대차계약, 공급업체 계약."""
    from app.models.ai import ComplianceItem

    date.fromisoformat(req.expiry_date)  # 형식 검증 (잘못되면 ValueError)
    with _session() as db:
        row = ComplianceItem(store_id=store_id, name=req.name, expiry_date=req.expiry_date,
                             remind_before_days=req.remind_before_days, memo=req.memo)
        db.add(row)
        db.commit()
        db.refresh(row)
        return _compliance_to_dict(row)


def list_compliance_items(store_id: str) -> list[dict[str, Any]]:
    from app.models.ai import ComplianceItem

    with _session() as db:
        rows = (db.query(ComplianceItem).filter(ComplianceItem.store_id == store_id)
                .order_by(ComplianceItem.expiry_date).all())
        return [_compliance_to_dict(r) for r in rows]


def get_upcoming_renewals(store_id: str) -> list[dict[str, Any]]:
    """갱신 임박·만료 서류만 — 각 항목의 remind_before_days 이내로 들어온 것."""
    return [c for c in list_compliance_items(store_id) if c["status"] != "ok"]


def delete_compliance_item(store_id: str, item_id: int) -> None:
    from app.models.ai import ComplianceItem

    with _session() as db:
        row = db.get(ComplianceItem, item_id)
        if row is None or row.store_id != store_id:
            raise DocumentError(f"갱신 서류 {item_id}를 찾을 수 없습니다")
        db.delete(row)
        db.commit()
