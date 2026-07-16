"""OCR 챗봇 도구 (백엔드 B)

챗봇이 OCR 초안을 조회·수정·확정(재고 반영)·반려까지 처리한다.
확정·반려는 사용자가 명확히 요청했을 때만 에이전트가 호출하도록 설명에 명시한다.
"""

import json

from langchain_core.tools import tool

from app.schemas.ai import OcrDocumentUpdate
from app.services.ai import ocr_service


def _summarize(draft: dict) -> dict:
    result = draft["result"]
    return {
        "id": draft["id"],
        "status": draft["status"],
        "doc_type": result.doc_type,
        "vendor": result.vendor.name,
        "issued_date": result.issued_date,
        "items": [i.model_dump() for i in result.items],
        "total": result.total,
        "suggested_target": draft["suggested_target"],
        "warnings": draft["warnings"],
    }


@tool
def list_ocr_documents(status: str = "draft") -> str:
    """OCR 문서 목록을 조회한다. status는 draft/confirmed/rejected 중 하나."""
    docs = ocr_service.list_drafts(status=status)
    if not docs:
        return f"{status} 상태의 OCR 문서가 없습니다."
    brief = [
        {"id": d["id"], "doc_type": d["result"].doc_type, "vendor": d["result"].vendor.name,
         "total": d["result"].total, "warnings": len(d["warnings"])}
        for d in docs
    ]
    return json.dumps(brief, ensure_ascii=False)


@tool
def get_ocr_document(doc_id: str) -> str:
    """OCR 문서 하나의 인식 결과 전체(품목·금액·경고 포함)를 조회한다."""
    try:
        return json.dumps(_summarize(ocr_service.get_draft(doc_id)), ensure_ascii=False)
    except ocr_service.DraftNotFoundError:
        return f"문서 {doc_id}를 찾을 수 없습니다."


@tool
def update_ocr_document(doc_id: str, patch_json: str) -> str:
    """OCR 초안을 사용자의 지시대로 수정한다. patch_json은 OcrDocumentUpdate 형식의 JSON 문자열
    (예: {"items": [...전체 품목 목록...]} 또는 {"issued_date": "2026-07-01"}).
    items를 넣으면 품목 전체가 교체되므로 수정할 항목만이 아니라 전체 목록을 넣어야 한다.
    수정 후 금액 관계 검증이 다시 수행되어 남은 경고가 반환된다."""
    try:
        patch = OcrDocumentUpdate.model_validate_json(patch_json)
        draft = ocr_service.update_draft(doc_id, patch)
    except ocr_service.DraftNotFoundError:
        return f"문서 {doc_id}를 찾을 수 없습니다."
    except ocr_service.DraftStateError as e:
        return f"수정 불가: {e}"
    except ValueError as e:
        return f"patch_json 형식 오류: {e}"
    return json.dumps(_summarize(draft), ensure_ascii=False)


@tool
def confirm_ocr_document(store_id: str, doc_id: str) -> str:
    """OCR 초안 문서를 확정하고 품목을 내 매장 재고에 입고 반영한다.
    사용자가 명확히 반영을 요청한 경우에만 호출할 것 — 어떤 문서인지 불명확하면
    list_ocr_documents로 먼저 확인한다."""
    try:
        _, message = ocr_service.confirm_draft(doc_id, target="inventory_inbound", store_id=store_id)
        return message
    except ocr_service.DraftNotFoundError:
        return f"문서 {doc_id}를 찾을 수 없습니다."
    except ocr_service.DraftStateError as e:
        return f"확정 불가: {e}"


@tool
def reject_ocr_document(doc_id: str) -> str:
    """OCR 초안 문서를 반려(폐기)한다. 되돌릴 수 없으므로 사용자가 명확히 요청한 경우에만 호출할 것."""
    try:
        ocr_service.reject_draft(doc_id)
        return f"문서 {doc_id}를 반려했습니다."
    except ocr_service.DraftNotFoundError:
        return f"문서 {doc_id}를 찾을 수 없습니다."
    except ocr_service.DraftStateError as e:
        return f"반려 불가: {e}"


TOOLS = [confirm_ocr_document, get_ocr_document, list_ocr_documents, reject_ocr_document, update_ocr_document]
