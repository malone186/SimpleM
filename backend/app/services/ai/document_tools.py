"""문서 챗봇 도구 (백엔드 B) — ERP-12 서류 자동화

돈이 걸린 문서(발주서·임금명세서)는 draft_ 접두어로 초안만 만든다 — 확정·전송은 사람이 (PRD §5.3).
모든 도구는 store_id(로그인 이메일)가 필요하다 — 에이전트가 대화 컨텍스트에서 채워 넣는다.
"""

import json

from langchain_core.tools import tool

from app.schemas.ai import ComplianceItemCreate, EmploymentContractRequest, PayslipRequest
from app.services.ai import document_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def draft_purchase_order_document(store_id: str) -> str:
    """발주서 초안을 만든다. 안전재고 이하로 떨어진 재료를 자동 추출해 발주 수량을 제안한다.
    초안만 생성하며 실제 발주는 사장님이 확인 후 직접 진행한다."""
    return _dump(document_service.draft_purchase_order(store_id))


@tool
def create_stocktake_sheet(store_id: str) -> str:
    """재고실사표를 만든다. 전체 재료의 장부상 수량이 채워진 시트로, 실사 수량은 현장에서 기입한다."""
    return _dump(document_service.generate_stocktake_sheet(store_id))


@tool
def create_inspection_report(store_id: str, ocr_doc_id: str) -> str:
    """검수확인서를 만든다. OCR로 등록한 거래명세서/영수증(ocr_doc_id) 품목 기준의 입고 검수 문서."""
    try:
        return _dump(document_service.generate_inspection_report(store_id, ocr_doc_id))
    except document_service.DocumentError as e:
        return str(e)


@tool
def create_monthly_ledger(store_id: str, year: int, month: int) -> str:
    """해당 월의 매입·매출 장부를 만든다. 매입은 확정된 OCR 문서, 매출은 판매 기록 기준."""
    return _dump(document_service.generate_monthly_ledger(store_id, year, month))


@tool
def create_vat_reference(store_id: str, start_date: str, end_date: str) -> str:
    """부가가치세 신고 참고자료를 만든다 (기간: YYYY-MM-DD ~ YYYY-MM-DD).
    참고용 집계일 뿐이며 최종 신고는 반드시 사람이 홈택스/세무사를 통해 진행해야 한다."""
    return _dump(document_service.generate_vat_reference(store_id, start_date, end_date))


@tool
def draft_payslip_document(store_id: str, employee_name: str, year: int, month: int) -> str:
    """임금명세서 초안을 만든다. 근무 스케줄에서 시간을 자동 집계해 기본급·주휴수당·공제(3.3%)를
    계산한다. 초안일 뿐 실제 지급은 사장님이 확인 후 진행한다. 스케줄이 없으면 안내 메시지를 반환한다."""
    try:
        req = PayslipRequest(employee_name=employee_name, year=year, month=month)
        return _dump(document_service.draft_payslip(store_id, req))
    except document_service.DocumentError as e:
        return str(e)


@tool
def get_wage_ledger(store_id: str, year: int) -> str:
    """임금대장을 조회한다 — 그해 생성한 임금명세서의 직원·월별 집계 (3년 보관 의무 대응)."""
    return _dump(document_service.get_wage_ledger(store_id, year))


@tool
def draft_employment_contract_document(store_id: str, contract_json: str) -> str:
    """근로계약서 초안을 만든다. contract_json은 JSON 문자열:
    {"employee_name": "홍길동", "start_date": "2026-08-01", "hourly_wage": 10500,
     "work_days_per_week": 5, "work_hours_per_day": 6, "duties": "음료 제조"(선택),
     "end_date": "2027-07-31"(선택)}. 근로기준법 필수 기재사항이 채워진 초안을 반환한다."""
    try:
        req = EmploymentContractRequest.model_validate_json(contract_json)
    except ValueError as e:
        return f"contract_json 형식 오류: {e}"
    return _dump(document_service.draft_employment_contract(store_id, req))


@tool
def add_renewal_reminder(store_id: str, name: str, expiry_date: str,
                         remind_before_days: int = 30, memo: str = "") -> str:
    """정기 갱신 서류의 만료일을 등록한다 — 위생교육 수료증, 보건증(직원별), 임대차계약,
    공급업체 계약 등. expiry_date는 YYYY-MM-DD. 만료 remind_before_days일 전부터 알림 대상이 된다."""
    try:
        req = ComplianceItemCreate(name=name, expiry_date=expiry_date,
                                   remind_before_days=remind_before_days, memo=memo or None)
        return _dump(document_service.add_compliance_item(store_id, req))
    except ValueError as e:
        return f"입력 오류: {e}"


@tool
def list_renewal_reminders(store_id: str) -> str:
    """등록된 정기 갱신 서류 전체와 만료까지 남은 일수를 조회한다."""
    items = document_service.list_compliance_items(store_id)
    return _dump(items) if items else "등록된 갱신 서류가 없습니다. add_renewal_reminder로 등록하세요."


@tool
def get_upcoming_renewals(store_id: str) -> str:
    """갱신이 임박했거나 만료된 서류만 조회한다 — 위생교육/보건증 미갱신은 과태료 대상이므로
    사장님이 물어보지 않아도 임박 건이 있으면 알려주는 것이 좋다."""
    items = document_service.get_upcoming_renewals(store_id)
    return _dump(items) if items else "갱신이 임박한 서류가 없습니다."


@tool
def list_generated_documents(store_id: str, kind: str = "") -> str:
    """생성된 문서 목록을 조회한다. kind로 필터 가능: purchase_order(발주서), stocktake_sheet(재고실사표),
    inspection_report(검수확인서), monthly_ledger(장부), vat_reference(부가세), payslip(임금명세서),
    employment_contract(근로계약서). 빈 값이면 전체."""
    docs = document_service.list_documents(store_id, kind=kind or None)
    if not docs:
        return "생성된 문서가 없습니다."
    brief = [{"id": d["id"], "kind": d["kind"], "title": d["title"], "period": d["period"],
              "created_at": d["created_at"]} for d in docs]
    return _dump(brief)


TOOLS = [
    add_renewal_reminder,
    create_inspection_report,
    create_monthly_ledger,
    create_stocktake_sheet,
    create_vat_reference,
    draft_employment_contract_document,
    draft_payslip_document,
    draft_purchase_order_document,
    get_upcoming_renewals,
    get_wage_ledger,
    list_generated_documents,
    list_renewal_reminders,
]
