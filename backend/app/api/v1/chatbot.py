"""챗봇 API (백엔드 B)

현재는 OCR 초안 플로우(AI-2)만 제공한다:
  업로드 → 초안 생성 → 사용자 수정 → 확정(사람) 또는 반려
챗봇 대화 엔드포인트는 main_agent 구현 시 추가 예정.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db

from app.schemas.ai import (
    OcrConfirmRequest,
    OcrConfirmResponse,
    OcrDocumentResponse,
    OcrDocumentUpdate,
    OcrStatus,
)
from app.services.ai import ocr_service

router = APIRouter(prefix="/chatbot", tags=["chatbot"])

MAX_IMAGE_BYTES = 15 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}

_oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def _optional_store_id(
    token: Optional[str] = Depends(_oauth2_optional),
    db: Session = Depends(get_db),
) -> Optional[str]:
    """로그인했으면 매장 식별자(이메일)를, 아니면 None을 돌려준다 — 확정 시 재고 반영에 사용."""
    if not token:
        return None
    try:
        return get_current_user(token=token, db=db).email
    except HTTPException:
        return None


def _to_response(draft: dict) -> OcrDocumentResponse:
    return OcrDocumentResponse(
        id=draft["id"],
        status=draft["status"],
        filename=draft["filename"],
        result=draft["result"],
        suggested_target=draft["suggested_target"],
        warnings=draft["warnings"],
        confirmed_target=draft["confirmed_target"],
        applied=draft["applied"],
        elapsed_sec=draft.get("elapsed_sec"),
        ocr_backend=draft.get("ocr_backend"),
        clova_usage=draft.get("clova_usage"),
        created_at=draft["created_at"],
        updated_at=draft["updated_at"],
    )


@router.get("/ocr/demo", include_in_schema=False)
async def ocr_demo_page() -> FileResponse:
    """개발용 OCR 데모 페이지 — 정식 화면은 프론트 A의 재고 페이지에서 제공 예정"""
    return FileResponse(Path(__file__).resolve().parents[2] / "static" / "ocr_demo.html")


@router.post("/ocr/documents", response_model=OcrDocumentResponse, status_code=201)
async def analyze_document(file: UploadFile = File(...)) -> OcrDocumentResponse:
    """거래명세서/영수증 이미지를 OCR해 등록 초안을 만든다. 어떤 시스템에도 아직 반영되지 않는다."""
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(415, f"지원하지 않는 형식: {file.content_type} (jpeg/png/webp만 가능)")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "이미지가 15MB를 초과합니다")
    try:
        draft = await ocr_service.analyze_image(image_bytes, filename=file.filename)
    except ocr_service.OcrError as e:
        raise HTTPException(502, str(e))
    return _to_response(draft)


@router.get("/ocr/documents", response_model=list[OcrDocumentResponse])
async def list_documents(status: Optional[OcrStatus] = None) -> list[OcrDocumentResponse]:
    return [_to_response(d) for d in ocr_service.list_drafts(status=status)]


@router.get("/ocr/documents/{doc_id}", response_model=OcrDocumentResponse)
async def get_document(doc_id: str) -> OcrDocumentResponse:
    try:
        return _to_response(ocr_service.get_draft(doc_id))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")


@router.patch("/ocr/documents/{doc_id}", response_model=OcrDocumentResponse)
async def update_document(doc_id: str, patch: OcrDocumentUpdate) -> OcrDocumentResponse:
    """사용자 직접 수정 — 품목·금액·문서 종류 등을 고치면 관계 검증을 다시 수행한다."""
    try:
        return _to_response(ocr_service.update_draft(doc_id, patch))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")
    except ocr_service.DraftStateError as e:
        raise HTTPException(409, str(e))


@router.post("/ocr/documents/{doc_id}/confirm", response_model=OcrConfirmResponse)
async def confirm_document(
    doc_id: str,
    body: OcrConfirmRequest,
    store_id: Optional[str] = Depends(_optional_store_id),
) -> OcrConfirmResponse:
    """초안 확정 — 반드시 사람이 검토 후 호출한다 (챗봇에는 노출되지 않는 액션).

    로그인 토큰이 있으면 확정 즉시 해당 매장 재고에 입고 반영된다.
    """
    try:
        draft, message = ocr_service.confirm_draft(doc_id, target=body.target, store_id=store_id)
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")
    except ocr_service.DraftStateError as e:
        raise HTTPException(409, str(e))
    return OcrConfirmResponse(
        id=draft["id"],
        status=draft["status"],
        target=draft["confirmed_target"],
        applied=draft["applied"],
        message=message,
    )


@router.post("/ocr/documents/{doc_id}/reject", response_model=OcrDocumentResponse)
async def reject_document(doc_id: str) -> OcrDocumentResponse:
    try:
        return _to_response(ocr_service.reject_draft(doc_id))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")
    except ocr_service.DraftStateError as e:
        raise HTTPException(409, str(e))
