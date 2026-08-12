"""챗봇 API (백엔드 B)

제공 기능:
  OCR 초안 플로우(AI-2): 업로드 → 초안 생성 → 사용자 수정 → 확정(사람) 또는 반려
  서류 자동화(ERP-12): 발주서·재고실사표·검수확인서·장부·임금명세서·근로계약서 초안 + 갱신 알림
챗봇 대화 엔드포인트는 main_agent 구현 시 추가 예정.
"""

import asyncio
import json
import logging
import os
import secrets
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, Request, UploadFile,
)
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.ai.agents import main_agent

from app.core.auth import get_current_admin, get_current_user, require_owner
from app.core.database import get_db
from app.models.ai import ChatSession
from app.models.user import User

# [한글 주석] 상세 장애 진단을 위한 로거 선언
logger = logging.getLogger(__name__)

from app.schemas.ai import (
    ChatSessionResponse,
    ChatSessionUpsert,
    ComplianceItemCreate,
    ComplianceItemResponse,
    DeviceTokenRegister,
    EmploymentContractRequest,
    GeneratedDocumentResponse,
    GeneratedDocumentUpdate,
    MarketingCopyRequest,
    MarketingImageRequest,
    MarketingOverlayRequest,
    MenuChangeApplyRequest,
    MenuReviewRequest,
    NotificationSettingBody,
    NotificationSettingResponse,
    OcrConfirmRequest,
    OcrConfirmResponse,
    OcrDocumentResponse,
    OcrDocumentUpdate,
    OcrStatus,
    PayslipRequest,
    PhotoCutoutComposeRequest,
    TodoCreate,
    TodoForwardRequest,
    TodoResponse,
    TodoUpdate,
)
from app.utils.datetime_kst import today_kst
from app.services.ai import (
    admob_ssv,
    briefing_service,
    cafe_similarity_service,
    chat_quota_service,
    demo_seed_service,
    document_service,
    forecast_service,
    insight_service,
    marketing_service,
    menu_ocr_service,
    menu_review_service,
    nearby_cafe_service,
    nearby_event_service,
    nearby_watch_service,
    notification_service,
    ocr_service,
    photo_promo_service,
    price_service,
    push_service,
    report_service,
    reward_service,
    sales_import_service,
    sales_service,
    todo_service,
    tts_service,
)

router = APIRouter(prefix="/chatbot", tags=["chatbot"])

MAX_IMAGE_BYTES = 15 * 1024 * 1024
# 사진(촬영·앨범)과 함께 PDF도 받는다 — 거래처 명세서는 이메일 PDF로 오는 일이 더 많다.
# heic/heif는 아이폰 기본 촬영 포맷이라 파일로 고르면 그대로 올라온다.
ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
    "application/pdf",
}
# 브라우저·OS가 확장자를 못 알아보면 application/octet-stream으로 올려보낸다.
# 그때는 파일명 확장자로 판정한다 (그것마저 없으면 415).
_EXT_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
    ".pdf": "application/pdf",
}


def _resolve_content_type(file: UploadFile) -> str:
    """업로드 파일의 실제 형식을 정한다 — content_type 우선, 없으면 확장자."""
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    if ctype in ALLOWED_CONTENT_TYPES:
        return ctype
    ext = Path(file.filename or "").suffix.lower()
    guessed = _EXT_MIME.get(ext)
    if guessed:
        return guessed
    raise HTTPException(
        415,
        f"지원하지 않는 형식입니다: {file.content_type or ext or '알 수 없음'} "
        "(사진 jpg·png·webp·heic 또는 PDF만 가능해요)",
    )

_oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def _optional_store_id(
    token: Optional[str] = Depends(_oauth2_optional),
    db: Session = Depends(get_db),
) -> Optional[str]:
    """로그인했으면 매장 식별자(이메일)를, 토큰이 아예 없으면 None을 돌려준다.

    토큰이 '있는데 틀린'(만료 등) 경우는 None으로 눙치지 않고 401을 그대로 던진다.
    예전엔 만료 토큰도 None이 되어 챗봇이 데모 매장(owner@cafe.com) 데이터를
    "우리 매장 매출"인 것처럼 보여줬다 — 사용자는 그게 남의 숫자인지 알 방법이 없다.
    401을 받으면 앱이 재로그인을 안내한다.
    """
    if not token:
        return None
    return get_current_user(token=token, db=db).email


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
        created_at=draft["created_at"],
        updated_at=draft["updated_at"],
    )


@router.get("/ocr/demo", include_in_schema=False)
async def ocr_demo_page() -> FileResponse:
    """개발용 OCR 데모 페이지 — 정식 화면은 프론트 A의 재고 페이지에서 제공 예정"""
    return FileResponse(Path(__file__).resolve().parents[2] / "static" / "ocr_demo.html")


@router.post("/ocr/documents", response_model=OcrDocumentResponse, status_code=201)
async def analyze_document(
    file: UploadFile = File(...),
    store_id: Optional[str] = Depends(_optional_store_id),
) -> OcrDocumentResponse:
    """거래명세서/영수증을 OCR해 등록 초안을 만든다. 어떤 시스템에도 아직 반영되지 않는다.

    사진(촬영·앨범)뿐 아니라 PDF도 받는다 — 거래처 명세서는 이메일 PDF로 오는 일이
    더 많아서, 굳이 화면을 찍어 올릴 필요 없이 파일 그대로 올리면 된다.
    초안에 업로드 매장(store_id)이 새겨져 이후 목록·조회는 그 매장에서만 보인다.
    """
    content_type = _resolve_content_type(file)
    image_bytes = await file.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "파일이 15MB를 초과합니다")
    if not image_bytes:
        raise HTTPException(400, "빈 파일입니다")
    try:
        draft = await ocr_service.analyze_image(
            image_bytes, filename=file.filename, store_id=store_id, mime_type=content_type)
    except ocr_service.OcrError as e:
        raise HTTPException(502, str(e))
    return _to_response(draft)


@router.post("/ocr/menu-board")
async def analyze_menu_board(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """메뉴판 사진 → 메뉴·가격·표준 레시피 초안. 아직 아무것도 저장하지 않는다.

    원가를 보려면 메뉴와 레시피가 있어야 하는데 손으로 넣으면 30분이 든다.
    메뉴판은 어느 매장에나 붙어 있으니 찍기만 하면 되게 했다.
    반환된 초안을 화면에서 확인·수정한 뒤 /ocr/menu-board/confirm 으로 확정한다.
    """
    content_type = _resolve_content_type(file)
    image_bytes = await file.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "파일이 15MB를 초과합니다")
    if not image_bytes:
        raise HTTPException(400, "빈 파일입니다")
    try:
        return await menu_ocr_service.analyze_menu_board(
            db, current_user.email, image_bytes, mime_type=content_type)
    except menu_ocr_service.MenuOcrError as e:
        raise HTTPException(502, str(e))


@router.post("/ocr/menu-board/confirm")
def confirm_menu_board(
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """확인·수정을 마친 메뉴를 실제로 등록한다 (사람 승인 없이는 저장하지 않는다).

    body: {"menus": [{"name","price","recipes":[{"ingredient_id","quantity"}]}]}
    """
    menus = body.get("menus")
    if not isinstance(menus, list) or not menus:
        raise HTTPException(400, "등록할 메뉴가 없습니다")
    return menu_ocr_service.confirm_menu_board(db, current_user.email, menus)


@router.get("/menu/suggestions")
def suggest_menu_improvements(
    include_new: bool = True,
    current_user: User = Depends(get_current_user),
):
    """AI가 지금 매장 숫자를 훑어 '바꾸면 좋을 것'을 찾아 준다. 저장하지 않는다.

    팔수록 손해인 메뉴의 적정 가격, 재료비 비중이 높은 메뉴의 인상 폭, 안 나가는 메뉴 정리,
    신메뉴 아이디어까지. 각 제안은 /menu/review와 같은 채점기를 통과하므로 숫자가 어긋나지 않는다.
    """
    try:
        return menu_review_service.recommend(current_user.email, include_new=include_new)
    except menu_review_service.MenuReviewError as e:
        raise HTTPException(422, str(e))


@router.post("/menu/review")
def review_menu_changes(
    body: MenuReviewRequest,
    current_user: User = Depends(get_current_user),
):
    """메뉴 개선안을 실제 판매·원가로 점검한다. 아무것도 저장하지 않는다.

    가격을 올릴 때 사장님이 진짜 궁금한 건 "손님이 얼마나 빠져도 괜찮나"라서,
    항목마다 '버틸 수 있는 판매 감소폭'(breakeven_drop_pct)을 함께 돌려준다.
    """
    try:
        return menu_review_service.review(
            current_user.email,
            [c.model_dump(exclude_none=True) for c in body.changes],
            days=body.days,
            comment=body.comment,
        )
    except menu_review_service.MenuReviewError as e:
        raise HTTPException(422, str(e))


@router.post("/menu/review/board")
async def review_menu_board(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """새로 만든 메뉴판 사진 → 지금 등록된 메뉴와 대조해 바뀐 점을 찾아 점검한다.

    사장님은 무엇을 바꿨는지 일일이 적지 않는다 — 새 메뉴판을 찍는 것으로 끝나야 한다.
    등록(/ocr/menu-board)과 달리 여기서는 아무것도 저장하지 않는다.
    """
    content_type = _resolve_content_type(file)
    image_bytes = await file.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "파일이 15MB를 초과합니다")
    if not image_bytes:
        raise HTTPException(400, "빈 파일입니다")
    try:
        return await menu_review_service.review_menu_board(
            db, current_user.email, image_bytes, mime_type=content_type)
    except menu_ocr_service.MenuOcrError as e:
        raise HTTPException(502, str(e))
    except menu_review_service.MenuReviewError as e:
        raise HTTPException(422, str(e))


@router.post("/menu/review/apply")
def apply_menu_changes(
    body: MenuChangeApplyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """점검을 마친 개선안을 실제 메뉴에 반영한다 (사장님이 눌렀을 때만).

    빼기는 삭제가 아니라 숨김이다 — 지우면 지난달 리포트의 메뉴 이름까지 사라진다.
    """
    try:
        return menu_review_service.apply_changes(
            db, current_user.email, [c.model_dump(exclude_none=True) for c in body.changes])
    except menu_review_service.MenuReviewError as e:
        raise HTTPException(422, str(e))


@router.get("/ocr/documents", response_model=list[OcrDocumentResponse])
def list_documents(
    status: Optional[OcrStatus] = None,
    store_id: Optional[str] = Depends(_optional_store_id),
) -> list[OcrDocumentResponse]:
    """내 매장 초안만 — 다른 계정(매장)의 문서는 보이지 않는다. 새 계정은 빈 목록."""
    return [_to_response(d) for d in ocr_service.list_drafts(status=status, store_id=store_id)]


@router.get("/ocr/documents/{doc_id}", response_model=OcrDocumentResponse)
def get_document(
    doc_id: str, store_id: Optional[str] = Depends(_optional_store_id)
) -> OcrDocumentResponse:
    try:
        return _to_response(ocr_service.get_draft(doc_id, store_id=store_id))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")


@router.patch("/ocr/documents/{doc_id}", response_model=OcrDocumentResponse)
def update_document(
    doc_id: str,
    patch: OcrDocumentUpdate,
    store_id: Optional[str] = Depends(_optional_store_id),
) -> OcrDocumentResponse:
    """사용자 직접 수정 — 품목·금액·문서 종류 등을 고치면 관계 검증을 다시 수행한다."""
    try:
        return _to_response(ocr_service.update_draft(doc_id, patch, store_id=store_id))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")
    except ocr_service.DraftStateError as e:
        raise HTTPException(409, str(e))


@router.post("/ocr/documents/{doc_id}/confirm", response_model=OcrConfirmResponse)
def confirm_document(
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
def reject_document(
    doc_id: str, store_id: Optional[str] = Depends(_optional_store_id)
) -> OcrDocumentResponse:
    try:
        return _to_response(ocr_service.reject_draft(doc_id, store_id=store_id))
    except ocr_service.DraftNotFoundError:
        raise HTTPException(404, "문서를 찾을 수 없습니다")
    except ocr_service.DraftStateError as e:
        raise HTTPException(409, str(e))


# ---------------------------------------------------------------------------
# 서류 자동화 (ERP-12) — 모든 문서는 초안(draft)으로만 생성, 확정·전송은 사람이
# 매장별 데이터이므로 로그인 필수 (store_id = 로그인 이메일)
# ---------------------------------------------------------------------------

@router.post("/documents/purchase-order", response_model=GeneratedDocumentResponse, status_code=201)
def create_purchase_order(current_user: User = Depends(get_current_user)):
    """발주서 초안 — 최소 보유량 아래로 떨어진 재료를 모아 발주 수량까지 채운 문서.

    담을 품목이 없으면(재고가 모두 넉넉하면) 409와 함께 그 사실을 문장으로 준다 —
    프론트가 그대로 띄우면 "왜 안 만들어지지"를 붙잡을 일이 없다.
    """
    try:
        return document_service.generate_purchase_order(current_user.email)
    except document_service.DocumentError as e:
        raise HTTPException(409, str(e))


@router.post("/documents/stocktake", response_model=GeneratedDocumentResponse, status_code=201)
def create_stocktake_sheet(current_user: User = Depends(get_current_user)):
    """재고실사표 — 장부상 수량이 채워진 실사용 시트."""
    return document_service.generate_stocktake_sheet(current_user.email)


@router.post("/documents/inspection-report/{ocr_doc_id}", response_model=GeneratedDocumentResponse, status_code=201)
def create_inspection_report(ocr_doc_id: str, current_user: User = Depends(get_current_user)):
    """검수확인서 — OCR로 등록한 명세서/영수증 품목 기준 입고 검수 문서."""
    try:
        return document_service.generate_inspection_report(current_user.email, ocr_doc_id)
    except document_service.DocumentError as e:
        raise HTTPException(404, str(e))


@router.post("/documents/ledger", response_model=GeneratedDocumentResponse, status_code=201)
def create_monthly_ledger(year: int, month: int, current_user: User = Depends(get_current_user)):
    """매입·매출 장부 — 확정 OCR 문서(매입)와 판매 기록(매출)의 월 집계."""
    return document_service.generate_monthly_ledger(current_user.email, year, month)


@router.post("/documents/vat-reference", response_model=GeneratedDocumentResponse, status_code=201)
def create_vat_reference(start_date: str, end_date: str, current_user: User = Depends(get_current_user)):
    """부가세 신고 참고자료 — 참고용 집계이며 최종 신고는 사람이 확인 후 진행."""
    return document_service.generate_vat_reference(current_user.email, start_date, end_date)


@router.post("/documents/payslip", response_model=GeneratedDocumentResponse, status_code=201)
def create_payslip_draft(body: PayslipRequest, current_user: User = Depends(get_current_user)):
    """임금명세서 초안 — 근무 스케줄 자동 집계로 기본급·주휴수당·공제를 계산한다."""
    try:
        return document_service.draft_payslip(current_user.email, body)
    except document_service.DocumentError as e:
        raise HTTPException(400, str(e))


@router.post("/documents/contract", response_model=GeneratedDocumentResponse, status_code=201)
def create_contract_draft(body: EmploymentContractRequest, current_user: User = Depends(get_current_user)):
    """근로계약서 초안 — 근로기준법 필수 기재사항을 채운 표준 양식."""
    return document_service.draft_employment_contract(current_user.email, body)


@router.get("/documents/wage-ledger/{year}")
def get_wage_ledger(year: int, current_user: User = Depends(get_current_user)):
    """임금대장 — 그해 임금명세서의 직원·월별 집계 (3년 보관 의무 대응)."""
    return document_service.get_wage_ledger(current_user.email, year)


@router.get("/documents", response_model=list[GeneratedDocumentResponse])
def list_generated_documents(kind: Optional[str] = None, current_user: User = Depends(get_current_user)):
    """생성된 문서 목록 (kind로 필터 가능)."""
    return document_service.list_documents(current_user.email, kind=kind)


@router.get("/documents/{doc_id}", response_model=GeneratedDocumentResponse)
def get_generated_document(doc_id: str, current_user: User = Depends(get_current_user)):
    try:
        return document_service.get_document(current_user.email, doc_id)
    except document_service.DocumentError as e:
        raise HTTPException(404, str(e))


@router.delete("/documents/{doc_id}")
def delete_generated_document(doc_id: str, current_user: User = Depends(get_current_user)) -> dict:
    """문서 삭제 — 임금명세서는 임금대장 보관 의무 때문에 삭제 불가(409)."""
    try:
        document_service.delete_document(current_user.email, doc_id)
    except document_service.DocumentLockedError as e:
        raise HTTPException(409, str(e))
    except document_service.DocumentError as e:
        raise HTTPException(404, str(e))
    return {"deleted": doc_id}  # 프론트 apiFetch가 JSON 응답을 기대하므로 204 대신 본문 반환


@router.patch("/documents/{doc_id}", response_model=GeneratedDocumentResponse)
def update_generated_document(
    doc_id: str,
    body: GeneratedDocumentUpdate,
    current_user: User = Depends(get_current_user),
):
    """문서 수정 — 자동 생성된 값을 사람이 바로잡는다 (content는 수정된 전체 본문)."""
    try:
        return document_service.update_document(current_user.email, doc_id, body.content, title=body.title)
    except document_service.DocumentError as e:
        raise HTTPException(404, str(e))


# ---------------------------------------------------------------------------
# AI 판매량 예측 (AI-3) — GPS·날씨·요일·공휴일·행사 + POS 시계열
# ---------------------------------------------------------------------------

@router.get("/forecast")
def get_sales_forecast_api(
    background_tasks: BackgroundTasks,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    days: int = 7,
    current_user: User = Depends(get_current_user),
):
    """익일·금주 예상 판매량과 발주 추천을 돌려준다.

    lat/lon: 매장 GPS 좌표 (프론트가 기기 위치 전달, 없으면 서울 기준 날씨).
    판매 기록이 14일 미만이면 409와 함께 안내 메시지를 준다.

    대시보드 첫 화면이 부르는 엔드포인트라 stale-while-revalidate로 응답한다:
    같은 날 만든 캐시가 있으면 즉시 돌려주고, 오래됐으면 백그라운드로 재계산해
    다음 조회부터 최신이 된다 (SARIMAX 적합 + 외부 API 왕복을 사용자가 기다리지 않게).
    """
    # 좌표 미전달이면 등록된 매장 고정 위치를 쓴다 — 기기 GPS(사장님 현위치)로 날씨를 잡으면
    # 집에서 앱을 켰을 때 엉뚱한 지역 날씨로 예측이 흔들린다.
    if lat is None or lon is None:
        lat = current_user.store_lat if current_user.store_lat is not None else lat
        lon = current_user.store_lon if current_user.store_lon is not None else lon

    cached = forecast_service.peek_forecast_cache(current_user.email, lat=lat, lon=lon, days=days)
    if cached is not None:
        result, fresh = cached
        if not fresh:
            background_tasks.add_task(
                forecast_service.refresh_forecast_background,
                current_user.email, lat, lon, days)
        return result
    try:
        return forecast_service.forecast(current_user.email, lat=lat, lon=lon, days=days)
    except forecast_service.ForecastError as e:
        raise HTTPException(409, str(e))


@router.get("/forecast/accuracy")
def get_forecast_accuracy_api(
    target: str = "revenue",
    horizon: int = 7,
    folds: int = 4,
    since: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """예측 정확도 백테스트 — 과거 시점으로 돌아가 실제로 맞혔는지 채점한 결과.

    WAPE(%)가 낮을수록 정확하다. 베이스라인(최근 4주 같은 요일 평균)과 나란히 주므로
    시계열 모델이 단순 규칙보다 나은지도 함께 판단할 수 있다.
    since(YYYY-MM-DD): 매출 수준이 크게 바뀐 시점 이후만 평가하고 싶을 때 쓴다 —
    그 이전을 포함하면 오차가 모델 성능이 아니라 그 단절을 재게 된다.
    판매 기록이 부족하면 409와 함께 필요한 일수를 안내한다.

    SARIMAX를 fold 수만큼 다시 적합하므로 수 초가 걸린다 — 대시보드 첫 화면이 아니라
    '정확도 보기'처럼 사용자가 명시적으로 요청했을 때만 부른다(그래서 캐시도 두지 않는다).
    """
    try:
        return forecast_service.backtest(
            current_user.email, target=target, horizon=horizon, folds=folds, since=since)
    except forecast_service.ForecastError as e:
        raise HTTPException(409, str(e))


@router.get("/geocode")
def geocode_address(query: str):
    """주소/상호 → 좌표 (회원가입 매장 위치 검색용 — 가입 전 화면이라 인증 불필요).

    네이버 지도 전용: 네이버 지역 검색(상호) → NCP Geocoding(주소) 순. 무료 지오코더 폴백 없음.
    """
    result = forecast_service.geocode(query)
    if not result:
        raise HTTPException(404, "주소를 찾지 못했습니다. 도로명주소나 상호를 좀 더 구체적으로 입력해 주세요.")
    return result


@router.get("/reverse-geocode")
def reverse_geocode_point(lat: float, lon: float):
    """좌표 → 주소 (회원가입 지도 핀·현위치용 — 가입 전 화면이라 인증 불필요).

    네이버 지도 전용(NCP Reverse Geocoding). OSM(Nominatim) 폴백 없음.
    """
    address = forecast_service.reverse_geocode_address(lat, lon)
    if not address:
        raise HTTPException(404, "이 위치의 주소를 찾지 못했습니다. 주소를 직접 입력해 주세요.")
    return {"lat": lat, "lon": lon, "address": address}


# ---------------------------------------------------------------------------
# 주변 카페 상권 분석 — 매장 고정 위치 기준 (네이버 지역검색 + 블로그 후기 + Gemini)
# ---------------------------------------------------------------------------

def _store_point(current_user: User, lat: Optional[float], lon: Optional[float]) -> tuple[float, float]:
    """분석 기준 좌표 — 명시 좌표 > DB에 등록된 매장 고정 위치. 둘 다 없으면 409.

    기기 GPS로 폴백하지 않는다: 사장님이 집에서 앱을 켜도 상권 분석은 '매장' 기준이어야 한다.
    """
    if lat is not None and lon is not None:
        return lat, lon
    if current_user.store_lat is not None and current_user.store_lon is not None:
        return current_user.store_lat, current_user.store_lon
    raise HTTPException(
        409,
        "매장 위치가 등록되어 있지 않습니다. 매장 지도 화면에서 '매장 위치 등록'으로 지도 핀을 찍어 주세요.",
    )


def _linked_place(store_id: str) -> Optional[dict[str, str]]:
    """'내 카페'로 지정(link)한 네이버 장소 — 주변 카페 목록에서 본인 가게를 빼는 데 쓴다."""
    try:
        from app.models.ai import CafeReviewLink
        from app.services.ai.document_service import _session

        with _session() as db:
            row = db.get(CafeReviewLink, store_id)
            if row and row.place_name:
                return {"name": row.place_name, "address": row.place_address or ""}
    except Exception:
        pass
    return None


@router.get("/nearby-cafes")
def get_nearby_cafes_api(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    radius_m: int = 1000,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
):
    """매장 고정 위치 반경 안의 경쟁 카페 목록 (네이버 지역정보, 거리순).

    lat/lon 생략 시 회원가입 때 등록한 매장 좌표를 사용한다.
    """
    p_lat, p_lon = _store_point(current_user, lat, lon)
    try:
        return nearby_cafe_service.find_nearby_cafes(
            p_lat, p_lon,
            radius_m=max(200, min(radius_m, 3000)),
            limit=max(1, min(limit, 30)),
            exclude_name=current_user.store_name or "",
            exclude_place=_linked_place(current_user.email),
        )
    except nearby_cafe_service.NearbyCafeError as e:
        raise HTTPException(503, str(e))


class SimilarityCafeIn(BaseModel):
    name: str
    category: str = ""
    distance_m: int = 0


class SimilarityRequest(BaseModel):
    region: str = ""
    cafes: list[SimilarityCafeIn]


@router.post("/nearby-cafes/similarity")
def cafe_similarity_api(
    body: SimilarityRequest,
    current_user: User = Depends(get_current_user),
):
    """주변 카페들을 내 카페와 5축(메뉴30·가격25·컨셉20·분위기15·고객층10) 비교해
    유사도 0~100%를 매긴다. 내 카페 프로필 = DB(메뉴·가격·업태) + 내 매장 리뷰 분석.

    리뷰 평판은 '내 카페'로 지정한 네이버 장소가 있을 때만 쓴다 — 상호만으로 검색하면
    이름이 같은 남의 카페 후기가 내 분위기·고객층으로 둔갑한다(my-cafe/analysis와 같은 규칙).
    """
    return cafe_similarity_service.score_nearby(
        current_user.email,
        [c.model_dump() for c in body.cafes],
        region=body.region,
        linked_place=_linked_place(current_user.email),
    )


@router.get("/nearby-cafes/insight")
def get_neighborhood_insight_api(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    radius_m: int = 1000,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
):
    """주변 카페 목록 + 상권 AI 분석(경쟁 밀도·트렌드·기회·위협·이번 주 실행안).

    수집(네이버) → 분석(Gemini) 순으로 도는 무거운 호출이라 서비스단에서 캐시한다.
    Gemini 실패 시 insight=null로 내려가고 카페 목록은 그대로 표시된다.
    """
    p_lat, p_lon = _store_point(current_user, lat, lon)
    try:
        return nearby_cafe_service.analyze_neighborhood(
            p_lat, p_lon,
            store_name=current_user.store_name or current_user.name or "내 매장",
            biz_type=current_user.store_biz_type or "",
            radius_m=max(200, min(radius_m, 3000)),
            limit=max(1, min(limit, 30)),
            exclude_place=_linked_place(current_user.email),
        )
    except nearby_cafe_service.NearbyCafeError as e:
        raise HTTPException(503, str(e))


@router.get("/nearby-cafes/analysis")
def get_cafe_analysis_api(
    name: str,
    address: str = "",
    category: str = "",
    distance_m: int = 0,
    region: str = "",
    _current_user: User = Depends(get_current_user),
):
    """경쟁 카페 한 곳의 네이버 블로그 후기 수집 + AI 분석 (지도에서 마커를 눌렀을 때)."""
    result = nearby_cafe_service.analyze_cafe(
        name, address=address, category=category, distance_m=distance_m, region=region)
    if not result["review_count"]:
        raise HTTPException(404, f"'{name}'에 대한 네이버 후기를 찾지 못했습니다.")
    return result


@router.get("/nearby-cafes/changes")
def get_nearby_cafe_changes_api(
    background: BackgroundTasks,
    days: int = 30,
    refresh: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """최근 상권 변화 — 반경 1km에서 새로 생긴 카페와 문 닫은 것으로 보이는 카페.

    응답은 관측 대장(nearby_cafe_watch)만 읽어 즉시 돌려주고, 오늘 아직 훑지 않았으면
    백그라운드로 한 번 스캔한다(다음 조회부터 반영). 화면이 네이버 검색을 기다리지 않는다.

    refresh=true는 사장님이 화면에서 '지금 다시 확인'을 누른 경우다. 이때만 스캔을 앞에서
    끝내고(쿨다운·하루 한 번 제한 무시) 그 결과를 돌려준다 — 눌렀는데 아무것도 안 바뀌면
    버튼이 고장 난 것처럼 보이기 때문이다. 하루 카운트는 날짜로 잠겨 있어 여러 번 눌러도
    개업·폐업 판정이 앞당겨지지는 않는다.

    첫 조회는 비어 있는 게 정상이다 — 첫 스캔은 '지금 있는 가게'를 기준선으로 삼을 뿐,
    그것을 신규 개업이라고 말하지 않는다. 변화는 하루 뒤부터 잡힌다.
    """
    days = max(1, min(days, 180))
    has_point = current_user.store_lat is not None and current_user.store_lon is not None

    if refresh and has_point:
        # 앞에서 훑는다 — 네이버 목록은 6시간 캐시라 대개 재검색 없이 대장만 다시 판정한다
        try:
            nearby_watch_service.scan_if_stale(
                db, current_user.email,
                float(current_user.store_lat), float(current_user.store_lon),
                exclude_name=current_user.store_name or "", force=True)
        except Exception:
            logger.exception("주변 카페 변화 즉시 스캔 실패: %s", current_user.email)
            db.rollback()
        return nearby_watch_service.recent_changes(db, current_user.email, days=days)

    result = nearby_watch_service.recent_changes(db, current_user.email, days=days)

    if has_point:
        background.add_task(
            _scan_nearby_cafes_bg, current_user.email,
            float(current_user.store_lat), float(current_user.store_lon),
            current_user.store_name or "",
        )
    return result


def _scan_nearby_cafes_bg(store_id: str, lat: float, lon: float, store_name: str) -> None:
    """백그라운드 스캔 — 요청 세션과 분리된 자기 세션을 쓴다(응답이 끝난 뒤 도는 작업)."""
    from app.services.ai.document_service import _session

    try:
        with _session() as db:
            nearby_watch_service.scan_if_stale(db, store_id, lat, lon, exclude_name=store_name)
    except Exception:
        logger.exception("주변 카페 변화 스캔(백그라운드) 실패: %s", store_id)


class CafeLinkRequest(BaseModel):
    place_name: str = Field(..., description="'내 카페'로 지정할 네이버 장소 상호")
    place_address: str = Field("", description="그 장소의 주소 (동명 카페 구분용)")


def _get_cafe_link(store_id: str) -> Optional[dict]:
    """사장님이 지정한 '내 카페' 장소(이름+주소)를 읽는다. 없으면 None."""
    from app.models.ai import CafeReviewLink
    from app.services.ai.document_service import _session

    with _session() as db:
        row = db.get(CafeReviewLink, store_id)
        if row:
            return {"place_name": row.place_name, "place_address": row.place_address or ""}
    return None


@router.get("/my-cafe/candidates")
def get_my_cafe_candidates_api(
    query: str = "",
    current_user: User = Depends(get_current_user),
):
    """'내 카페' 지정용 후보 — 상호로 네이버 지역검색을 쳐서 카페 목록을 돌려준다.

    query 생략 시 등록된 매장 상호로 검색한다. 사장님은 이 목록에서 주소를 보고
    자기 가게를 골라 /my-cafe/link로 지정한다.
    """
    q = (query or current_user.store_name or current_user.name or "").strip()
    if not q:
        raise HTTPException(409, "검색할 매장 이름이 없습니다. 설정에서 매장 정보를 입력해 주세요.")
    try:
        cafes = nearby_cafe_service.search_cafe_candidates(
            q, lat=current_user.store_lat, lon=current_user.store_lon)
    except nearby_cafe_service.NearbyCafeError as e:
        raise HTTPException(503, str(e))
    return {"query": q, "candidates": cafes}


@router.post("/my-cafe/link")
def link_my_cafe_api(
    body: CafeLinkRequest,
    current_user: User = Depends(get_current_user),
):
    """후보 중 '이게 내 가게'를 지정해 저장한다 (매장당 한 곳, 재지정은 덮어쓰기).

    지정하면 '내 카페 리뷰'가 이 이름+주소로만 후기를 찾아 이름 충돌(남의 카페 후기)을 막는다.
    """
    from app.models.ai import CafeReviewLink
    from app.services.ai.document_service import _session

    name = (body.place_name or "").strip()
    if not name:
        raise HTTPException(400, "place_name이 비어 있습니다.")
    address = (body.place_address or "").strip() or None
    with _session() as db:
        row = db.get(CafeReviewLink, current_user.email)
        if row is None:
            row = CafeReviewLink(store_id=current_user.email)
            db.add(row)
        row.place_name = name
        row.place_address = address
        db.commit()
    return {"linked": True, "place_name": name, "place_address": address or ""}


@router.delete("/my-cafe/link")
def unlink_my_cafe_api(
    current_user: User = Depends(get_current_user),
):
    """내 카페 지정을 해제한다 (다시 후보에서 고를 수 있게)."""
    from app.models.ai import CafeReviewLink
    from app.services.ai.document_service import _session

    with _session() as db:
        row = db.get(CafeReviewLink, current_user.email)
        if row:
            db.delete(row)
            db.commit()
    return {"linked": False}


@router.get("/my-cafe/analysis")
def get_my_cafe_analysis_api(
    current_user: User = Depends(get_current_user),
):
    """지정한 '내 카페'의 네이버 블로그 후기 수집 + AI 분석 — 지도 화면 '내 카페 리뷰' 카드.

    사장님이 아직 자기 가게를 지정하지 않았으면(linked=false) 후기를 찾지 않고 그대로 알린다 —
    프론트가 '내 카페 연결' 안내를 띄운다. 상호만으로 검색하면 이름이 같은 남의 카페 후기가
    내 것처럼 나올 수 있어, 반드시 지정된 장소(이름+주소)로만 조회한다.
    후기가 0건이어도 404를 던지지 않고 그대로 돌려준다.
    """
    link = _get_cafe_link(current_user.email)
    if not link:
        return {"linked": False, "review_count": 0, "reviews": [], "analysis": None}

    name = link["place_name"]
    address = link["place_address"] or ""
    # 지역명은 동명 카페 혼동을 더 줄이는 힌트 — 매장 위치가 있으면 붙인다.
    region = address
    if not region and current_user.store_lat is not None and current_user.store_lon is not None:
        try:
            region = nearby_cafe_service._region_names(
                current_user.store_lat, current_user.store_lon).get("full", "")
        except Exception:
            region = ""
    result = nearby_cafe_service.analyze_cafe(name, address=address, region=region)
    return {"linked": True, "place_name": name, "place_address": address, **result}


@router.get("/nearby-events")
def get_nearby_events_api(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    days: int = nearby_event_service.DEFAULT_DAYS,
    insight: bool = True,
    current_user: User = Depends(get_current_user),
):
    """매장 반경 3km에서 앞으로 days일 안에 열리는 행사 + 대비 조언 (매장 지도 화면).

    수집 소스는 예측과 같다(한국관광공사·서울 문화행사·네이버 검색+AI 정리).
    insight=false면 AI 조언 없이 목록만 — 챗봇·위젯처럼 빨라야 하는 호출용.
    행사가 0건이어도 200으로 빈 목록을 준다 (없는 것도 정보다).
    """
    p_lat, p_lon = _store_point(current_user, lat, lon)
    if not insight:
        return nearby_event_service.find_nearby_events(p_lat, p_lon, days=days)
    return nearby_event_service.analyze_nearby_events(
        p_lat, p_lon,
        store_name=current_user.store_name or current_user.name or "내 매장",
        biz_type=current_user.store_biz_type or "",
        days=days,
    )


class NearbyEventEcho(BaseModel):
    """화면이 지금 보고 있는 행사 카드 그대로 (POST /nearby-events/plan 본문).

    서버가 같은 행사를 자기 목록에서 찾으면 그쪽 값을 쓰고, 못 찾으면 이 값으로 플랜을 만든다.
    """

    name: str
    place: str = ""
    host: str = ""
    source: str = ""
    start_date: str = ""
    end_date: str = ""
    day_count: int = 1
    distance_km: Optional[float] = None
    boost_pct: int = 0
    d_day: int = 0
    ongoing: bool = False


def _match_event(events: list[dict], name: str, start_date: str = "") -> Optional[dict]:
    """수집 목록에서 같은 행사를 찾는다 — 이름 → 같은 날 이름 겹침 → 같은 날 순으로 느슨하게.

    소스가 뉴스·블로그 검색이라 같은 행사의 이름이 조회마다 조금씩 달라진다
    ("청년 Book Cx클래스" ↔ "청년 북 클래스"). 완전 일치만 보면 화면에 떠 있는 행사인데도
    못 찾는다.
    """
    from app.services.ai.nearby_event_service import _norm

    target = _norm(name)
    if not target:
        return None

    hit = next((e for e in events if _norm(e.get("name", "")) == target), None)
    if hit:
        return hit

    # 한쪽이 다른 쪽을 품고 있으면 같은 행사로 본다 (주최기관·부제가 붙었다 떨어졌다 한다)
    hit = next((e for e in events
                if target in _norm(e.get("name", "")) or _norm(e.get("name", "")) in target), None)
    if hit:
        return hit

    if start_date:
        # 같은 날 열리는 행사 중 이름 글자가 가장 많이 겹치는 것 (3글자 이상 겹쳐야 인정)
        same_day = [e for e in events if e.get("start_date") == start_date]
        best, best_score = None, 0
        for e in same_day:
            score = len(set(target) & set(_norm(e.get("name", ""))))
            if score > best_score:
                best, best_score = e, score
        if best is not None and best_score >= 3:
            return best
    return None


def _echo_to_event(echo: NearbyEventEcho) -> dict:
    """화면이 보내 준 행사 카드를 플랜 생성이 쓰는 형태로 (길이·범위만 다듬는다).

    이 값은 뉴스·블로그에서 나온 남의 글이므로 프롬프트에서는 quote_untrusted로 감싸 쓴다
    (plan_event_promotion이 이미 그렇게 한다).
    """
    return {
        "name": echo.name.strip()[:120],
        "place": echo.place.strip()[:120],
        "host": echo.host.strip()[:80],
        "source": echo.source.strip()[:60],
        "start_date": echo.start_date[:10],
        "end_date": (echo.end_date or echo.start_date)[:10],
        "day_count": max(1, min(echo.day_count, 60)),
        "distance_km": echo.distance_km,
        "boost_pct": max(0, min(echo.boost_pct, 100)),
        "d_day": max(0, min(echo.d_day, 365)),
        "ongoing": echo.ongoing,
    }


def _build_event_plan(db, current_user: User, name: str, start_date: str,
                      echo: Optional[NearbyEventEcho] = None) -> dict:
    """행사 하나에 맞춘 AI 이벤트·준비 플랜 (GET·POST 공통).

    서버가 수집한 목록에서 같은 행사를 먼저 찾는다 — 찾으면 거리·부스팅까지 서버 값이 맞다.
    못 찾으면 화면이 보내 준 카드로 만든다. 수집 파이프라인(네이버 검색 + Gemini 정리)은
    호출마다 결과가 조금씩 달라지고 캐시도 인스턴스별이라, 방금 화면에 뜬 행사인데
    플랜 요청은 못 찾는 일이 실제로 난다. 그때 404를 주면 사장님에게는 기능이 고장 난 것이다.
    """
    p_lat, p_lon = _store_point(current_user, None, None)
    try:
        events = nearby_event_service.find_nearby_events(p_lat, p_lon).get("events", [])
    except Exception:
        logger.exception("행사 플랜용 목록 조회 실패 — 화면이 보낸 행사로 계속")
        events = []

    event = _match_event(events, name, start_date)
    if event is None and echo is not None and echo.name.strip():
        logger.info("행사 플랜: 목록에서 못 찾아 화면 값으로 생성 (%s / %s)", name, start_date)
        event = _echo_to_event(echo)
    if event is None:
        raise HTTPException(404, f"'{name}' 행사를 주변 행사 목록에서 찾지 못했습니다.")

    plan = nearby_watch_service.plan_for_store(db, current_user.email, event)
    if plan is None:
        # 왜 안 되는지를 말해 준다 — "잠시 후 다시"만 보이면 쿼터가 찬 날엔 계속 다시 누르게 된다
        reason = nearby_cafe_service.gemini_last_error()
        if reason == "quota":
            raise HTTPException(503, "오늘 AI 사용량을 다 썼어요. 한도가 초기화되는 오후 늦게 다시 눌러 주세요.")
        if reason == "no_key":
            raise HTTPException(503, "AI 설정이 아직 안 되어 있어요. 행사 일정과 대응 팁은 그대로 보실 수 있어요.")
        raise HTTPException(503, "지금은 AI 준비 플랜을 만들지 못했어요. 잠시 후 다시 시도해 주세요.")
    return {"event": event, "plan": plan}


@router.post("/nearby-events/plan")
def post_nearby_event_plan_api(
    body: NearbyEventEcho,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """행사 하나에 맞춘 AI 이벤트·준비 플랜 (지도 화면 행사 카드의 '뭘 준비할까?' 버튼).

    이벤트 아이디어·한정 메뉴·미리 할 일·재료 준비·인력 배치·홍보 문구를 한 번에 만든다.
    화면이 보고 있는 행사 카드를 그대로 실어 보내므로, 서버 목록이 흔들려도 플랜이 나온다.
    """
    return _build_event_plan(db, current_user, body.name, body.start_date, echo=body)


@router.get("/nearby-events/plan")
def get_nearby_event_plan_api(
    name: str,
    start_date: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """이름만으로 부르는 옛 경로 (OTA 전 앱·챗봇용). 새 앱은 POST를 쓴다."""
    return _build_event_plan(db, current_user, name, start_date)


class EventTodoRequest(BaseModel):
    """행사 준비 플랜의 '해 둘 일'을 그대로 할 일 목록에 담는다 (지도 화면 → 홈 '오늘 할 일')."""

    items: list[str] = Field(..., min_length=1, max_length=12,
                             description="담을 할 일 제목들 (플랜의 prep_actions 등)")
    event_name: str = Field("", max_length=120, description="어느 행사 준비인지 — 부제로 붙는다")
    start_date: str = Field("", description="행사 시작일 YYYY-MM-DD — 기한 계산에 쓴다")


def _prep_due_date(start_date: str) -> Optional[str]:
    """행사 준비의 기한 — '행사 전날'. 단, 오늘보다 이르면 오늘로 당긴다.

    행사 당일을 기한으로 잡으면 이미 늦다(재료·안내문은 전날까지 끝나야 한다).
    이미 진행 중이거나 내일 시작하는 행사면 오늘이 기한이다.

    '오늘'은 반드시 KST다 — 운영 서버(Cloud Run)는 UTC라 date.today()를 쓰면
    한국 시간 오전 9시 전에 기한이 하루 이르게 잡힌다.
    """
    today = datetime.now(nearby_watch_service.KST).date()
    if not start_date:
        return None
    try:
        start = date.fromisoformat(start_date[:10])
    except ValueError:
        return None
    return max(start - timedelta(days=1), today).isoformat()


@router.post("/nearby-events/plan/todos", status_code=201)
def add_event_prep_todos_api(
    body: EventTodoRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """행사 준비 항목을 할 일 목록에 담는다 — 한 번의 호출로 여러 개.

    사장님이 준비 플랜을 보고 "이거 해야지" 하고 화면을 닫으면 그대로 잊힌다. 여기서 담으면
    홈 화면 '오늘 할 일'에 기한(행사 전날)과 함께 올라오고, 완료하면 코인도 쌓인다.
    이미 같은 할 일이 열려 있으면 중복으로 만들지 않고 skipped로 돌려준다.
    """
    due = _prep_due_date(body.start_date)
    # 부제는 '왜 이 할 일이 생겼는지' — 목록에서 행사 준비인 걸 알아볼 수 있어야 한다
    event_name = body.event_name.strip()
    note = f"{event_name} 준비"[:255] if event_name else "주변 행사 준비"
    items = [
        TodoCreate(title=text.strip()[:200], note=note, due_date=due)
        for text in body.items if text and text.strip()
    ]
    try:
        result = todo_service.add_todos_bulk(current_user.email, items, source="ai")
    except todo_service.TodoError as e:
        raise HTTPException(422, str(e))
    return {**result, "due_date": due}


class EventPromoRequest(BaseModel):
    """행사에 맞춘 홍보물(문구 세트) 생성 요청 — 준비 플랜 시트의 '홍보물 만들기'.

    플랜 값(이벤트·한정 메뉴·홍보 문구)을 함께 보내면 카피가 그 플랜과 같은 이야기를 한다.
    비워 보내면 행사 정보만으로 만든다.
    """

    event: NearbyEventEcho
    promotion_title: str = Field("", max_length=60)
    promotion_detail: str = Field("", max_length=200)
    menu_idea: str = Field("", max_length=120)
    busy_window: str = Field("", max_length=60)
    promo_copy: str = Field("", max_length=200)
    channel: str = Field("instagram", description="instagram | blog | banner | sms")
    tone: str = Field("", max_length=60, description="비우면 '설레고 활기차게'")


@router.post("/nearby-events/promo", status_code=201)
def create_event_promotion_api(
    body: EventPromoRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """행사 홍보 문구 세트를 만든다 — 인스타 캡션·해시태그·이미지에 새길 슬로건까지.

    준비 플랜의 promo_copy는 '한 줄'이라 그대로는 게시물이 되지 않는다. 여기서 그 한 줄을
    씨앗 삼아 채널에 맞는 홍보물 한 세트로 부풀리고, 홍보 보관함(kind=marketing_content)에
    저장한다. 이미지는 앱이 이어서 POST /marketing/image?doc_id=... 로 만든다
    (문구는 몇 초, 이미지는 수십 초라 한 요청에 묶으면 문구까지 늦게 보인다).
    """
    event = _echo_to_event(body.event)
    plan = {
        "promotions": [{"title": body.promotion_title, "detail": body.promotion_detail}],
        "menu_idea": body.menu_idea,
        "busy_window": body.busy_window,
        "promo_copy": body.promo_copy,
    }
    topic = nearby_watch_service.event_promo_topic(event, plan)
    try:
        doc = marketing_service.generate_promotion_copy(
            current_user.email, topic=topic, channel=body.channel,
            tone=body.tone or "설레고 활기차게, 행사 나들이 분위기에 어울리게",
            menu=body.menu_idea)
    except marketing_service.MarketingError as e:
        raise HTTPException(429 if "사용량" in str(e) else 502, str(e))
    return {"doc": doc, "event": event}


class SaleItemIn(BaseModel):
    menu_id: int
    quantity: int = Field(1, ge=1)


class SalesRecordRequest(BaseModel):
    items: list[SaleItemIn]


class SalesImportRow(BaseModel):
    menu_id: Optional[int] = None
    quantity: int = 1
    total_price: Optional[int] = None
    sold_at: Optional[str] = None


class SalesImportConfirmRequest(BaseModel):
    rows: list[SalesImportRow]


class RecipeLineIn(BaseModel):
    ingredient_id: int
    quantity: float = Field(..., gt=0, description="1잔 조리 시 소요량 (재료 단위 기준)")


class MenuRegisterItem(BaseModel):
    name: str
    selling_price: int = 0
    # 레시피를 함께 주면 등록과 동시에 재고 차감이 연결된다 (비우면 이름·판매가만 등록)
    recipe: list[RecipeLineIn] = []


class MenuRegisterRequest(BaseModel):
    menus: list[MenuRegisterItem]


def _reward_breakeven_safe(store_id: str, dates) -> dict:
    """본전 달성 보상 확인 — 매출 저장 응답에 실을 수 있게 안전하게 감싼다.

    dates=None이면 '오늘'(reward_service가 KST로 계산). 보상 계산이 실패해도 매출 저장
    자체는 이미 끝났으므로 조용히 빈 결과를 준다 — 게임 보상 때문에 매출이 안 들어가면 안 된다.
    """
    try:
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        if dates is None:
            dates = [(_dt.now(_tz(_td(hours=9)))).date()]
        return reward_service.reward_breakeven_on_dates(store_id, dates)
    except Exception:
        logger.exception("본전 보상 확인 실패 — 매출 저장은 정상")
        return {"achieved": [], "coins": 0, "count": 0}


@router.post("/sales", status_code=201)
def record_sales_api(
    body: SalesRecordRequest,
    current_user: User = Depends(get_current_user),
):
    """판매 수동 등록 — Sale 기록 + 레시피 기준 재고 자동 차감.

    여기로 등록한 판매는 대시보드·경영 리포트·예측이 읽는 Sale 테이블에 바로 반영된다.
    """
    try:
        result = sales_service.record_sales(
            current_user.email, [i.model_dump() for i in body.items])
    except sales_service.SalesError as e:
        raise HTTPException(400, str(e))
    # 오늘 실적이 바뀌었으므로 예측 캐시를 비운다 — 대시보드 그래프가 바로 최신을 본다
    forecast_service.invalidate_forecast_cache(current_user.email)
    # 매출을 올린 '그 순간' 본전 달성을 확인해 코인을 준다 (수동 입력은 오늘 매출)
    result["breakeven_reward"] = _reward_breakeven_safe(current_user.email, None)
    return result


@router.get("/sales/recent")
def recent_sales_api(
    limit: int = 10,
    current_user: User = Depends(get_current_user),
):
    """최근 판매 내역 (매출 입력 화면 표시용)."""
    return sales_service.recent_sales(current_user.email, limit=limit)


@router.post("/sales/import/preview")
async def sales_import_preview_api(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """POS 매출 파일(엑셀/CSV)을 업로드하면 LLM이 열을 매핑해 미리보기를 만든다.

    아직 DB에 저장하지 않는다 — LLM이 틀릴 수 있으므로, 사용자가 미리보기에서 확인·수정한
    뒤 /sales/import/confirm 으로 확정해야 실제 매출(Sale)로 들어간다.
    """
    content = await file.read()
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "파일이 15MB를 초과합니다")
    try:
        grid = sales_import_service.parse_grid(content, file.filename or "")
        mapping = await sales_import_service.infer_mapping(grid)
        return sales_import_service.build_preview(current_user.email, grid, mapping)
    except sales_import_service.SalesImportError as e:
        raise HTTPException(400, str(e))


@router.post("/sales/import/register-menus", status_code=201)
def sales_import_register_menus_api(
    body: MenuRegisterRequest,
    current_user: User = Depends(get_current_user),
):
    """파일에서 발견된 미등록 메뉴를 메뉴로 등록한다(이름·판매가, 그리고 선택적으로 레시피).

    미매칭 행이 그냥 버려지지 않도록, 사용자가 판매가를 확인한 뒤 여기로 등록하면
    같은 파일의 해당 행들이 매칭으로 바뀌어 저장 대상이 된다.
    각 메뉴에 recipe([{ingredient_id, quantity}])를 함께 주면 등록과 동시에 레시피가
    연결돼, 재고 차감까지 바로 동작한다(재료 목록은 GET /inventory/ingredients).
    """
    try:
        return sales_import_service.register_menus(
            current_user.email, [m.model_dump() for m in body.menus])
    except sales_import_service.SalesImportError as e:
        raise HTTPException(400, str(e))


@router.post("/sales/import/confirm", status_code=201)
def sales_import_confirm_api(
    body: SalesImportConfirmRequest,
    current_user: User = Depends(get_current_user),
):
    """미리보기에서 확인·수정한 행을 실제 Sale로 저장하고 레시피 기준 재고를 차감한다."""
    rows = [r.model_dump() for r in body.rows]
    try:
        result = sales_import_service.save_import(current_user.email, rows)
    except sales_import_service.SalesImportError as e:
        raise HTTPException(400, str(e))
    forecast_service.invalidate_forecast_cache(current_user.email)
    # 업로드한 파일에 담긴 날짜들 중 본전 넘긴 날에 보상 (과거 몰아 올려도 날짜당 1회)
    dates = []
    for r in rows:
        if not r.get("menu_id"):
            continue
        d = sales_import_service._coerce_dt(r.get("sold_at"))
        dates.append(d.date() if hasattr(d, "date") else None)
    result["breakeven_reward"] = _reward_breakeven_safe(current_user.email, dates)
    return result


@router.get("/sales/contribution")
def sales_contribution_api(
    days: int = 30,
    current_user: User = Depends(get_current_user),
):
    """메뉴별 기여이익 — 잔당 마진 × 실제 판매 잔 수 (원가 분석 화면용).

    원가율만으로는 '무엇이 매장을 먹여 살리는지' 알 수 없어서, 판매량을 곱한
    실제 벌어들인 금액과 그 비중을 함께 돌려준다.
    """
    return sales_service.menu_contribution(current_user.email, days=days)


@router.get("/sales/calendar")
def get_sales_calendar_api(
    year: int = 0,
    month: int = 0,
    current_user: User = Depends(get_current_user),
):
    """월간 캘린더용 일별 판매 집계 (기본: 이번 달) — 대시보드 월간 뷰 표시용.

    일별 매출·잔 수·베스트 메뉴·피크 시간대와 월 합계·전월 대비 증감을 준다.
    """
    today = today_kst()
    return forecast_service.sales_calendar(
        current_user.email, year or today.year, month or today.month)


# ---------------------------------------------------------------------------
# 인터넷 가격 비교 — 발주 추천 화면에서 품목별 최저가 표시용
# ---------------------------------------------------------------------------

@router.get("/prices/compare")
def compare_prices_api(q: str, current_price: int = 0):
    """상품명(q)의 인터넷 최저가 후보를 돌려준다 — 다나와(+네이버쇼핑 키 있으면 병용).

    current_price(현재 매입 단가)를 주면 절감률(saving_pct)도 계산된다.
    결과는 검색어당 1시간 캐시된다.
    """
    try:
        return price_service.compare_prices(q, current_price=current_price)
    except price_service.PriceError as e:
        raise HTTPException(502, str(e))


# ---------------------------------------------------------------------------
# AI 경영 리포트 — 홈 화면 일간/주간/월간 표시용 (챗봇에서는 report_expert가 담당)
# ---------------------------------------------------------------------------

@router.get("/reports/management", response_model=GeneratedDocumentResponse)
def get_management_report_api(
    background_tasks: BackgroundTasks,
    period_type: str = "weekly",
    refresh: bool = True,
    current_user: User = Depends(get_current_user),
):
    """현재 기간(오늘 기준)의 경영 리포트를 돌려준다 — 없으면 생성, 있으면 즉시 반환 후 갱신.

    period_type: daily(오늘) / weekly(이번 주) / monthly(이번 달).
    같은 기간 리포트는 문서 하나로 유지된다(중복 생성 없음).

    홈 화면 첫 로딩이 부르는 엔드포인트라 stale-while-revalidate로 응답한다:
    저장된 리포트가 있으면 재계산(집계 쿼리 10회+ · Gemini 조언) 없이 즉시 돌려주고,
    refresh=true(기본)면 백그라운드에서 최신 수치로 다시 계산해 다음 조회부터 반영된다.
    """
    cached = report_service.get_cached_management_report(current_user.email, period_type)
    if cached is not None:
        if refresh:
            background_tasks.add_task(
                report_service.refresh_management_report_background,
                current_user.email, period_type)
        return cached
    try:
        return report_service.generate_management_report(
            current_user.email, period_type=period_type, force_refresh=True)
    except report_service.ReportError as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------------------
# 홍보/마케팅 도우미 — AI 홍보 문구 + AI 홍보 이미지 생성
# 목록·수정·삭제는 기존 /documents 엔드포인트를 그대로 쓴다 (kind=marketing_content)
# ---------------------------------------------------------------------------

@router.post("/marketing/promotions", response_model=GeneratedDocumentResponse, status_code=201)
def create_marketing_promotion(
    body: MarketingCopyRequest,
    current_user: User = Depends(get_current_user),
):
    """홍보 문구 세트 생성 — 헤드라인·SNS 캡션·해시태그·이미지 프롬프트를 한 번에.

    매장의 실제 정보(상호·위치·베스트 메뉴)를 근거로 만들어 지어낸 내용이 들어가지 않는다.
    결과는 문서(kind=marketing_content)로 저장돼 다시 볼 수 있다.
    """
    try:
        return marketing_service.generate_promotion_copy(
            current_user.email, topic=body.topic, channel=body.channel,
            tone=body.tone, menu=body.menu)
    except marketing_service.MarketingError as e:
        # 쿼터 소진은 서버 고장이 아니다 — 429로 구분해 앱이 이유를 그대로 보여주게 한다
        raise HTTPException(429 if "사용량" in str(e) else 502, str(e))


@router.post("/marketing/image")
def create_marketing_image(
    body: MarketingImageRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """AI 홍보 이미지 생성 — doc_id를 주면 그 홍보 문구에 맞춰 만들고 문서에 기록한다.

    반환의 url은 한글 슬로건이 얹힌 완성본, raw_url은 글자 없는 원본이다.
    생성에 수십 초가 걸릴 수 있다.
    """
    try:
        return marketing_service.generate_promotion_image(
            current_user.email, doc_id=body.doc_id, request=body.request,
            style=body.style, aspect_ratio=body.aspect_ratio,
            include_text=body.include_text, overlay=body.overlay, quality=body.quality)
    except marketing_service.ImageCapacityError as e:
        # 공급자 한도 소진은 서버 고장이 아니다 — 429로 구분해 앱이 이유를 그대로 보여준다
        raise HTTPException(429, str(e))
    except marketing_service.MarketingError as e:
        raise HTTPException(429 if "사용량" in str(e) else 502, str(e))


@router.get("/marketing/health")
def get_marketing_health(current_user: User = Depends(get_current_user)) -> dict:
    """이미지 생성 파이프라인 상태 — 공급자·모델·Pollen 잔액·폰트·GCS 한눈에.

    '이미지가 안 만들어져요' 신고가 오면 로그를 뒤지기 전에 이걸 먼저 본다.
    잔액 조회가 실시간이라 응답에 몇 초 걸릴 수 있다.
    """
    return marketing_service.image_health()


@router.post("/marketing/photo-image")
def create_marketing_photo_image(
    file: UploadFile = File(...),
    style: str = Form("wood"),
    aspect_ratio: str = Form("1:1"),
    doc_id: str = Form(""),
    current_user: User = Depends(get_current_user),
) -> dict:
    """실물 메뉴 사진으로 홍보 이미지 — 누끼(rembg) + 감성 배경 합성.

    AI 생성 이미지와 달리 '우리 매장 실물'이 그대로 담긴다. doc_id를 주면
    해당 홍보 문서의 images에 붙는다. 배경 스타일: wood/marble/cozy/studio/season.

    [중요] async가 아니라 일반 def다 — 합성(누끼+배경)이 수 초~수십 초짜리 동기
    작업이라, async로 두면 그 시간 동안 이벤트 루프가 얼어 서버 전체(/health 포함)가
    무응답이 된다(실측: 합성 도중 전 엔드포인트 타임아웃 → Cloud Run 502/재시작).
    일반 def는 FastAPI가 스레드풀에서 돌려 서버가 계속 응답한다.
    """
    content = file.file.read()
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "사진이 15MB를 초과합니다")
    try:
        return photo_promo_service.compose_from_photo(
            current_user.email, content, style=style,
            aspect_ratio=aspect_ratio, doc_id=doc_id)
    except photo_promo_service.PhotoPromoError as e:
        raise HTTPException(422, str(e))


@router.get("/marketing/photo-cutouts")
def list_marketing_photo_cutouts(current_user: User = Depends(get_current_user)) -> list[dict]:
    """홍보 누끼 보관함 — 지금까지 오려낸 메뉴 사진 목록 (미리보기 base64, 최신순).

    사진 합성을 할 때마다 오려낸 메뉴가 자동으로 쌓인다. 여기서 골라 다시 만들면
    촬영·업로드·누끼가 전부 생략돼 즉시 나온다.
    """
    return photo_promo_service.list_cutouts(current_user.email)


@router.post("/marketing/photo-image-from-cutout")
def create_marketing_photo_image_from_cutout(
    body: PhotoCutoutComposeRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """보관함 누끼로 홍보 이미지 — 누끼 단계가 없어 1초대에 합성된다.

    [photo-image와 같은 이유로 동기 def] 합성은 CPU 작업이라 async면 이벤트 루프가 언다.
    """
    try:
        return photo_promo_service.compose_from_cutout(
            current_user.email, body.cutout_id, style=body.style,
            aspect_ratio=body.aspect_ratio, doc_id=body.doc_id)
    except photo_promo_service.PhotoPromoError as e:
        raise HTTPException(422, str(e))


@router.delete("/marketing/photo-cutouts/{cutout_id}", status_code=204)
def delete_marketing_photo_cutout(cutout_id: int, current_user: User = Depends(get_current_user)):
    """보관함에서 누끼 삭제 — 잘못 나온 누끼나 안 파는 메뉴 정리용."""
    try:
        photo_promo_service.delete_cutout(current_user.email, cutout_id)
    except photo_promo_service.PhotoPromoError as e:
        raise HTTPException(404, str(e))


@router.post("/marketing/image/overlay")
def restyle_marketing_image(
    body: MarketingOverlayRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """홍보 이미지의 한글 슬로건 위치만 바꾼다 — 저장해 둔 원본을 다시 합성하므로
    AI 호출 없이 즉시 끝나고 화질도 나빠지지 않는다."""
    try:
        return marketing_service.recompose_promotion_image(
            current_user.email, doc_id=body.doc_id, image_id=body.image_id,
            layout=body.layout)
    except marketing_service.MarketingError as e:
        # 쿼터 소진은 서버 고장이 아니다 — 429로 구분해 앱이 이유를 그대로 보여주게 한다
        raise HTTPException(429 if "사용량" in str(e) else 502, str(e))


@router.get("/marketing/images/{filename}")
def get_marketing_image(filename: str):
    """생성된 홍보 이미지 서빙 — 파일명이 12자리 랜덤 hex라 URL 추측이 사실상 불가능하고,
    홍보 이미지는 어차피 공개가 목적이라 인증 없이 서빙한다 (앱 <Image>가 헤더 없이 로드).

    GCS를 쓰기 시작한 뒤로 새 이미지는 버킷 공개 URL을 직접 받으므로 이 경로로 오지
    않는다. 다만 예전에 만들어 문서에 상대 경로로 저장된 이미지가 있어, 로컬에 없으면
    버킷으로 리다이렉트해 옛 홍보물도 계속 보이게 한다.
    """
    try:
        path = marketing_service.image_file(filename)
    except marketing_service.MarketingError as e:
        raise HTTPException(404, str(e))
    if path.is_file():
        return FileResponse(path, headers={"Cache-Control": "public, max-age=86400"})
    if marketing_service._gcs_bucket() is not None:
        return RedirectResponse(marketing_service.image_url(filename), status_code=302)
    raise HTTPException(404, "이미지를 찾을 수 없습니다")


# ---------------------------------------------------------------------------
# 음성 합성 (TTS) — 목소리 4종을 '진짜 다른' Gemini 보이스로 (알림 읽어주기·샘플 듣기)
# ---------------------------------------------------------------------------

class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=600, description="읽어줄 한국어 문장")
    voice_type: str = Field("warm_female",
                            description="warm_female | friendly_male | calm_male | cute_child")


@router.post("/tts")
def synthesize_speech_api(
    body: TtsRequest,
    _current_user: User = Depends(get_current_user),
):
    """텍스트를 WAV 오디오로 합성한다 — 설정의 목소리 4종이 실제 다른 음색으로 나온다.

    같은 (목소리, 문장)은 서버 디스크 캐시에서 즉시 반환된다 (팀 공유 쿼터 절약).
    실패(쿼터·오프라인) 시 프론트 speechPlayer가 기기 로컬 TTS로 폴백하므로
    알림이 끊기지는 않는다. 로그인 필수 — 익명 호출로 쿼터가 새지 않게 한다.

    무료 티어 한도(분당 3회)를 넘으면 429 + Retry-After를 준다 — 프론트는 그 신호를 받아
    기기 기본 목소리로 읽는다 (에러 토스트 없이 조용히 전환). 캐시에서 나온 응답은
    구글을 부르지 않았다는 뜻이라 X-Tts-Cache: hit로 알려준다 — 프론트가 이걸 보고
    "한도가 풀렸다"고 잘못 판단하지 않게.
    """
    from fastapi.responses import Response

    try:
        wav, from_cache = tts_service.synthesize_ex(body.text, voice_type=body.voice_type)
    except tts_service.TtsRateLimited as e:
        raise HTTPException(
            429, str(e),
            headers={"Retry-After": str(e.retry_after), "X-Tts-Fallback": "device"},
        )
    except tts_service.TtsError as e:
        raise HTTPException(503, str(e))
    return Response(content=wav, media_type="audio/wav",
                    headers={"Cache-Control": "private, max-age=3600",
                             "X-Tts-Cache": "hit" if from_cache else "miss"})


# ---------------------------------------------------------------------------
# 푸시 알림 (FCM) — 기기 토큰 등록 · 수신 설정 · 스케줄러 진입점
# ---------------------------------------------------------------------------

# 스케줄러(Cloud Scheduler 등)만 /notifications/run을 부를 수 있게 하는 공유 비밀.
# 비어 있으면 그 엔드포인트는 404를 내 외부에 열리지 않는다 — 설정을 깜빡한 채
# 배포됐을 때 누구나 전체 매장에 푸시를 쏠 수 있는 상태가 되면 안 된다.
CRON_SECRET = os.getenv("NOTIFICATION_CRON_SECRET", "")

# 사진 합성 배경 예열 — 배포 직후 첫 사용자가 배경 생성(수십 초)을 기다리지 않게
# 기동 시 백그라운드로 캐시를 채운다 (데몬 스레드, 실패 무해).
photo_promo_service.warm_backgrounds_async()


@router.post("/push/tokens", status_code=204)
def register_push_token(
    body: DeviceTokenRegister,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """기기 푸시 토큰을 등록/갱신한다 (upsert).

    프론트는 로그인 직후와 토큰 갱신 이벤트(addPushTokenListener)마다 다시 호출한다.
    FCM 토큰은 앱 재설치·데이터 삭제로 언제든 바뀌므로 영구 식별자가 아니다.
    """
    # 직원 로그인 기기면 누구인지 함께 적는다 — '특정 알바 지정 업무' 푸시를 그 기기로만 보내게
    staff = getattr(current_user, "acting_staff", None)
    push_service.register_token(db, current_user.email, body.token,
                                platform=body.platform, device_name=body.device_name,
                                staff_id=staff.id if staff else None)


@router.delete("/push/tokens", status_code=204)
def unregister_push_token(token: str, current_user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """로그아웃 시 호출 — 이 기기로 더는 알림이 가지 않게 한다.

    토큰은 경로가 아니라 쿼리로 받는다 — FCM 토큰에 섞일 수 있는 문자가
    경로 세그먼트에서 잘못 해석되는 일을 피한다.

    store_id를 함께 넘겨 '내 기기'만 지운다 — 안 그러면 인증만 된 사용자가
    토큰 문자열을 아는 것만으로 남의 기기 등록을 해제할 수 있다.
    """
    push_service.unregister_token(db, token, store_id=current_user.email)


@router.get("/notifications/settings", response_model=NotificationSettingResponse)
def get_notification_settings(current_user: User = Depends(get_current_user),
                              db: Session = Depends(get_db)):
    """푸시 수신 설정 조회 (없으면 기본값으로 만들어 돌려준다)."""
    row = notification_service.get_settings(db, current_user.email)
    return NotificationSettingResponse(
        store_id=row.store_id,
        push_enabled=row.push_enabled,
        compliance_alert=row.compliance_alert,
        report_alert=row.report_alert,
        stock_alert=row.stock_alert,
        sensor_alert=row.sensor_alert,
        # 컬럼 보강(ensure_notification_setting_columns) 이전에 만들어진 행이 섞일 수 있어
        # 없으면 켜진 것으로 읽는다 — 새 기능은 기본 on이다
        nearby_alert=getattr(row, "nearby_alert", True),
        insight_alert=getattr(row, "insight_alert", True),
        report_frequency=row.report_frequency,
        dnd_enabled=row.dnd_enabled,
        dnd_start=row.dnd_start,
        dnd_end=row.dnd_end,
        push_configured=push_service.is_configured(),
        device_count=len(push_service.list_tokens(db, current_user.email)),
    )


@router.put("/notifications/settings", response_model=NotificationSettingResponse)
def update_notification_settings(
    body: NotificationSettingBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """설정 화면이 바뀔 때마다 서버로 동기화 — 발송 판단은 서버가 하므로 필수."""
    row = notification_service.get_settings(db, current_user.email)
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    db.commit()
    return get_notification_settings(current_user=current_user, db=db)


@router.post("/notifications/test")
def send_test_push(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """지금 이 계정의 등록 기기로 시험 발송 — 설정 화면의 '테스트 알림' 버튼용."""
    if not push_service.is_configured():
        raise HTTPException(503, "서버에 FCM 자격증명이 설정되지 않았습니다 (FCM_SERVICE_ACCOUNT_JSON)")
    sent = push_service.send_to_store(
        db, current_user.email, "🔔 브루노트 알림 테스트",
        "푸시 알림이 정상적으로 도착했어요.", {"category": "test", "screen": "Settings"})
    if sent == 0:
        raise HTTPException(400, "등록된 기기가 없습니다. 앱에서 알림 권한을 허용했는지 확인해 주세요.")
    return {"sent": sent}


@router.post("/notifications/run")
def run_notifications(x_cron_secret: str = Header(default="")):
    """Tier 1 알림 규칙을 전 매장에 대해 평가·발송한다 (스케줄러 전용).

    Cloud Scheduler가 하루 한 번(아침 8시 30분 KST) 부르는 것을 기준으로 만들었다.
    더 자주 불러도 안전하다 — 같은 사건은 SentNotification 유니크 제약이 한 번만 내보낸다.
    설비 이상만 쿨다운(기본 6시간) 뒤 다시 나간다.
    """
    if not CRON_SECRET:
        raise HTTPException(404, "Not Found")  # 미설정이면 존재 자체를 숨긴다
    if not secrets.compare_digest(x_cron_secret, CRON_SECRET):
        raise HTTPException(403, "invalid cron secret")
    # 데모 매장 더미 데이터 갱신도 이 크론에 얹는다(백그라운드·멱등) — 매시간 불리므로
    # '오늘 실시간' 그래프가 하루 종일 차오르고, 별도 스케줄러 작업이 필요 없다.
    seed_started = demo_seed_service.run_async()
    result = notification_service.run_all()
    if isinstance(result, dict):
        result["demo_seed"] = "started" if seed_started else "already_running"
    return result


# ---------------------------------------------------------------------------
# 정기 갱신 서류 만료 추적 (위생교육·보건증·임대차/공급 계약)
# ---------------------------------------------------------------------------

@router.post("/compliance", response_model=ComplianceItemResponse, status_code=201)
def add_compliance_item(body: ComplianceItemCreate, current_user: User = Depends(get_current_user)):
    """갱신 서류 등록 — 만료일이 다가오면 /compliance/upcoming에 나타난다."""
    try:
        return document_service.add_compliance_item(current_user.email, body)
    except ValueError as e:
        raise HTTPException(400, f"날짜 형식 오류: {e}")


@router.get("/compliance", response_model=list[ComplianceItemResponse])
def list_compliance_items(current_user: User = Depends(get_current_user)):
    """등록된 갱신 서류 전체 + 만료까지 남은 일수."""
    return document_service.list_compliance_items(current_user.email)


@router.get("/compliance/upcoming", response_model=list[ComplianceItemResponse])
def get_upcoming_renewals(current_user: User = Depends(get_current_user)):
    """갱신 임박(설정일 이내)·만료된 서류만 — 대시보드 알림용."""
    return document_service.get_upcoming_renewals(current_user.email)


@router.delete("/compliance/{item_id}")
def delete_compliance_item(item_id: int, current_user: User = Depends(get_current_user)) -> dict:
    try:
        document_service.delete_compliance_item(current_user.email, item_id)
    except document_service.DocumentError as e:
        raise HTTPException(404, str(e))
    return {"deleted": item_id}  # 프론트 apiFetch가 JSON 응답을 기대하므로 204 대신 본문 반환


# ---------------------------------------------------------------------------
# 선제 인사이트 — 사장님이 묻기 전에 시스템이 먼저 찾아내는 "챙길 일"
# 앱은 이걸 폴링해 알림으로만 띄운다 (먼저 말을 걸지는 않는다)
# ---------------------------------------------------------------------------


class InsightDismissRequest(BaseModel):
    snooze_days: int = Field(
        0, ge=0, le=365,
        description="0이면 영구 확인 처리, 1 이상이면 그 일수만큼 숨겼다가 다시 알림",
    )


@router.get("/insights")
def get_insights_api(
    include_dismissed: bool = False,
    current_user: User = Depends(get_current_user),
) -> dict:
    """지금 챙겨야 할 일을 매장 데이터에서 찾아 돌려준다 (심각한 것부터 정렬).

    재고 소진 예상일, 단가 인상, 잠자는 재고, 확정 안 한 명세서, 진행 안 된 발주,
    갱신 임박 서류, 세무 신고 기한, 매출 급락, 판매 입력 누락, 주휴수당 발생,
    근로계약서 미작성, 재고실사·월 장부 미생성, 레시피 없는 메뉴를 검사한다.

    저장된 목록이 아니라 호출 시점에 DB를 훑어 매번 새로 계산한다 —
    사장님이 조치를 끝내면 다음 호출에서 그 항목은 자연히 사라진다.
    """
    return insight_service.scan(current_user.email, include_dismissed=include_dismissed)


@router.get("/briefing")
def get_briefing_api(
    refresh: bool = False,
    current_user: User = Depends(get_current_user),
) -> dict:
    """오늘의 브루 브리핑 — 어제 실적·오늘 근무·오늘 입금 예정 + 지금 급한 일 3가지.

    아침에 푸시로 나가는 것과 같은 내용이고, 매장별로 하루 한 번 만들어 캐시한다
    (refresh=true면 다시 만든다). 인사이트 스캔과 같은 근거를 쓰므로 알림·할 일·
    브리핑이 서로 다른 말을 하지 않는다.
    """
    return briefing_service.build(current_user.email, force_refresh=refresh)


@router.post("/insights/{insight_key:path}/dismiss")
def dismiss_insight_api(
    insight_key: str,
    body: InsightDismissRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    """인사이트 확인 처리 — snooze_days를 주면 그 기간만 숨겼다가 다시 올라온다."""
    return insight_service.dismiss(
        current_user.email, insight_key, snooze_days=body.snooze_days
    )


# ---------------------------------------------------------------------------
# 챗봇 대화 세션 — 사용자별 대화 기록 서버 보관 (새 채팅·과거 채팅 복원/삭제)
# 기기 로컬(AsyncStorage)이 아닌 DB에 저장해 기기·브라우저가 바뀌어도 기록이 따라온다
# ---------------------------------------------------------------------------

MAX_CHAT_SESSIONS = 50  # 사용자당 보관 상한 — 초과분은 오래된 것부터 자동 정리


def _session_to_response(row: ChatSession) -> ChatSessionResponse:
    return ChatSessionResponse(
        id=row.id,
        title=row.title,
        messages=json.loads(row.messages),
        created_at=row.created_at_ms,
        updated_at=row.updated_at_ms,
    )


@router.get("/sessions", response_model=list[ChatSessionResponse])
def list_chat_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ChatSessionResponse]:
    """내 대화 세션 전체 — 최근 수정 순. 복원에 필요한 말풍선 전문을 함께 준다."""
    rows = (
        db.query(ChatSession)
        .filter(ChatSession.store_id == current_user.email)
        .order_by(ChatSession.updated_at_ms.desc())
        .all()
    )
    return [_session_to_response(r) for r in rows]


@router.put("/sessions/{session_id}", response_model=ChatSessionResponse)
def upsert_chat_session(
    session_id: str,
    body: ChatSessionUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatSessionResponse:
    """세션 저장(신규/갱신) — 프론트가 턴마다 대화 전문을 통째로 올린다."""
    row = db.get(ChatSession, (session_id, current_user.email))
    created = row is None
    if created:
        row = ChatSession(id=session_id, store_id=current_user.email)
        db.add(row)
    row.title = body.title
    row.messages = json.dumps(body.messages, ensure_ascii=False)
    row.created_at_ms = body.created_at
    row.updated_at_ms = body.updated_at

    # 상한 초과분은 오래된 것부터 정리 (로컬 보관소와 같은 정책).
    # 세션 수는 새 세션이 생길 때만 늘어나므로 그때만 확인한다 — 기존 세션 갱신은
    # 턴마다 오는 요청이라, 매번 정리 쿼리를 얹으면 대화 한 턴에 Neon 왕복이 하나 더 붙는다.
    if created:
        stale = (
            db.query(ChatSession)
            .filter(ChatSession.store_id == current_user.email, ChatSession.id != session_id)
            .order_by(ChatSession.updated_at_ms.desc())
            .offset(MAX_CHAT_SESSIONS - 1)
            .all()
        )
        for s in stale:
            db.delete(s)

    db.commit()
    db.refresh(row)
    return _session_to_response(row)


@router.delete("/sessions/{session_id}")
def delete_chat_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    row = db.get(ChatSession, (session_id, current_user.email))
    if row is None:
        raise HTTPException(404, "세션을 찾을 수 없습니다")
    db.delete(row)
    db.commit()
    return {"deleted": session_id}  # 프론트 apiFetch가 JSON 응답을 기대하므로 204 대신 본문 반환


@router.delete("/sessions")
def clear_chat_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """과거 채팅 전체 삭제."""
    count = (
        db.query(ChatSession)
        .filter(ChatSession.store_id == current_user.email)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": count}


# [한글 주석] 사용자가 챗봇에게 대화를 보낼 때의 입력 형식 명세
class ChatRequest(BaseModel):
    message: str = Field(..., description="사용자가 보낸 질문 메시지")
    history: list[dict] = Field(default_factory=list, description="이전 대화 기록 목록 (Gemini 형식)")


# [한글 주석] 챗봇이 대답을 돌려줄 때의 출력 형식 명세
class ChatResponse(BaseModel):
    response: str = Field(..., description="챗봇의 답변 텍스트")
    documents: list[dict] = Field(
        default_factory=list,
        description="이번 턴에 생성/수정된 문서 전문 — 챗봇 화면이 말풍선 아래 카드로 렌더링",
    )


@router.get("/agents")
def get_agent_overview_api(admin: User = Depends(get_current_admin)) -> dict:
    """멀티에이전트 편성 현황 — 관리자 콘솔(3000) AI 에이전트 탭 표시용.

    메인 오케스트레이터(브루)와 서브에이전트(전문가)별 활성 여부·보유 도구 목록을 돌려준다.
    최근 턴 기록에 전 매장의 store_id(이메일)·질문 원문이 담기므로 관리자 전용이다
    — 콘솔 app.js의 fetch 래퍼가 이 경로에도 관리자 토큰을 자동 첨부한다.
    """
    return main_agent.get_agent_overview()


@router.post("/chat", response_model=ChatResponse)
async def chat_message(
    body: ChatRequest,
    store_id: Optional[str] = Depends(_optional_store_id),
) -> ChatResponse:
    """[한글 주석] 챗봇 대화 엔드포인트
    
    사용자의 질문을 챗봇 에이전트에게 전달해 적절한 도구 호출 및 답변 완성을 비동기로 수행합니다.
    로그인하지 않은 상태로 호출되는 경우, 안전하게 데모 매장 계정(owner@cafe.com)으로 우회하여 가동합니다.
    """
    # [한글 주석] 매장 고유 식별자가 없을 경우를 위한 대비책 설정
    store_key = store_id or "owner@cafe.com"

    # 무료 할당량을 Gemini 호출 전에 차감한다. 호출 후에 세면 한도를 넘긴 요청이
    # 이미 비용을 쓴 뒤가 된다. 실패하면 아래 except에서 되돌린다.
    # 쿼터는 동기 SQLAlchemy(FOR UPDATE 포함)라 async 엔드포인트에서 그대로 부르면
    # Neon 왕복(0.4~0.6초) 동안 이벤트 루프 전체가 멈춘다 — 스레드로 내린다.
    try:
        quota_snap = await asyncio.to_thread(chat_quota_service.consume, store_key)
    except chat_quota_service.QuotaExhausted as e:
        # detail을 dict로 넘겨 프론트가 '할당량 소진'과 다른 429를 구분할 수 있게 한다
        raise HTTPException(429, {"quota_exhausted": True, "quota": e.args[0]})
    # 환불은 '차감된 그 날' 행에 해야 한다 — 자정 직전 차감 → 직후 실패면 day 없이는
    # 오늘(used=0) 행에서 빼려다 어제 턴이 영영 차감된 채 남는다.
    quota_day = quota_snap.get("date")

    # [비용 상한] history는 클라이언트가 그대로 보내는 무제한 리스트라, 한 턴에 수 MB를
    # 실어 보내면 메인+전문가 모든 모델 호출의 토큰 비용·지연이 배로 뛴다. 최근 40개(20턴)면
    # 대화 맥락으로 충분하다.
    history = (body.history or [])[-40:]

    # [자동 감사] 이번 발화가 "아니 그게 아니라" 같은 부정이면 직전 턴을 사고 후보로 남긴다.
    # 숫자가 그럴듯하게 틀린 오답은 감시 규칙이 못 잡고, 그걸 아는 사람은 사장님뿐이다.
    # 정규식 판정이라 LLM 호출은 없지만, 부정 발화로 판정되면 사고 기록 DB 쓰기가
    # 생기므로 이것도 스레드에서 돌린다.
    from app.services.ai import answer_audit
    await asyncio.to_thread(answer_audit.check_followup, store_key, body.message, history)

    try:
        # [한글 주석] 챗봇 에이전트의 대화 처리 루프 실행 — 답변 텍스트 + 이번 턴에 만든 문서 전문
        result = await main_agent.generate_response(
            user_message=body.message,
            store_id=store_key,
            history=history
        )
        # generate_response는 내부에서 예외를 전부 삼켜 정상 dict로 돌려주므로(사과 문구),
        # 아래 except로는 AI 실패가 안 잡힌다. ok=False면 실질 답변을 못 만든 턴이니
        # 차감한 쿼터를 여기서 되돌린다 (안 그러면 실패한 턴도 사장님 쿼터가 깎인다).
        if not result.get("ok", True):
            await asyncio.to_thread(chat_quota_service.refund, store_key, quota_day)
        return ChatResponse(response=result["text"], documents=result["documents"])
    except Exception as e:
        # 답을 못 준 턴까지 차감하면 부당하다 — 되돌린다 (예외가 여기까지 올라온 드문 경우)
        await asyncio.to_thread(chat_quota_service.refund, store_key, quota_day)
        # [한글 주석] 장애 추적을 위해 로컬 콘솔에 상세 예외 Traceback을 기록합니다.
        logger.exception("챗봇 서비스 실행 중 장애 발생")
        raise HTTPException(500, f"챗봇 서비스 실행 중 장애 발생: {str(e)}")


@router.get("/quota")
def get_chat_quota(store_id: Optional[str] = Depends(_optional_store_id)) -> dict:
    """챗봇 남은 턴 조회 — 조회만으로 소비되지 않는다.

    챗봇 화면 진입 시 불러 "오늘 남은 대화 N회"를 표시하거나, 광고를 미리 받아둘지
    판단하는 데 쓴다.
    """
    return chat_quota_service.get_quota(store_id or "owner@cafe.com")


@router.post("/quota/ad-reward")
def grant_chat_quota(store_id: Optional[str] = Depends(_optional_store_id)) -> dict:
    """광고 시청 완료 보고 → 턴 충전. 로그인 계정만 가능.

    이 경로는 앱의 자기 보고다. 근거로서는 약하므로 두 겹으로 막아 둔다.
      1) 충전 1건이 ad_reward_grants에 원장으로 남는다 — 중복 호출은 거래 id 충돌로 무시.
      2) CHAT_AD_SSV_REQUIRED=1이면 이 경로로는 아예 충전하지 않고, 구글이 서명해
         보내는 SSV 콜백(GET /quota/ad-ssv)만 인정한다. 그때 이 API는 오류 대신
         pending_verification=true를 돌려주고, 앱은 잠시 뒤 쿼터를 다시 조회한다.
    어느 모드든 MAX_ADS_PER_DAY가 하루 상한으로 남는다.

    비로그인은 401 — 익명은 전 세계가 데모 계정(owner@cafe.com)의 쿼터 행 하나를
    공유하므로, 열어 두면 curl 루프 하나로 무한 충전되거나 반대로 한 명이 다 써서
    모든 비로그인 사용자의 체험이 막힌다. (앱은 로그인 후에만 챗봇에 진입한다.)
    """
    if store_id is None:
        raise HTTPException(401, "로그인 후 이용할 수 있습니다.")
    try:
        return chat_quota_service.grant_from_ad(store_id)
    except chat_quota_service.AdLimitReached as e:
        raise HTTPException(429, {"ad_limit_reached": True, "quota": e.args[0]})
    except chat_quota_service.AdVerificationPending as e:
        # 실패가 아니라 '아직'이다 — 200으로 돌려줘야 앱이 오류 문구 대신 재조회를 한다
        return {**e.args[0], "pending_verification": True}


@router.get("/quota/ad-ssv")
def admob_ssv_callback(request: Request) -> dict:
    """AdMob 서버 사이드 검증(SSV) 콜백 — 구글이 직접 호출한다. 앱은 호출하지 않는다.

    인증(토큰)이 없는 이유: 부르는 쪽이 구글 서버라 우리 토큰을 들고 있지 않다. 대신
    요청 자체에 구글의 ECDSA 서명이 붙어 있어, 서명 검증을 통과한 요청만 진짜다.
    서명 대상은 쿼리스트링 원문이므로 `request.url.query`를 그대로 넘긴다 —
    파싱된 query_params로 다시 조립하면 순서·인코딩이 달라져 검증이 깨진다.

    설정: AdMob 콘솔 > 해당 보상형 광고 단위 > 서버 사이드 검증 > 콜백 URL에
    `https://<서버>/api/v1/chatbot/quota/ad-ssv`를 등록한다. 앱은 광고를 요청할 때
    serverSideVerificationOptions.userId에 매장 식별자(로그인 이메일)를 심는다.
    """
    try:
        params = admob_ssv.verify(request.url.query)
    except admob_ssv.SsvInvalid as e:
        # 위조 시도이거나 설정이 틀린 것이다. 어느 쪽이든 충전하지 않는다.
        logger.warning("AdMob SSV 콜백 거절: %s", e)
        raise HTTPException(403, "서명 검증에 실패했습니다.")

    try:
        chat_quota_service.grant_from_ssv(params)
    except chat_quota_service.AdLimitReached:
        # 상한 초과는 정상 동작이다 — 구글에는 200을 돌려줘야 재전송이 반복되지 않는다
        logger.info("AdMob SSV 충전 생략 — 하루 상한 도달 (%s)", params.get("user_id"))
    except ValueError as e:
        logger.warning("AdMob SSV 콜백 형식 오류: %s", e)
        raise HTTPException(400, "콜백 파라미터가 올바르지 않습니다.")

    # 구글은 본문을 보지 않는다 — 2xx면 성공으로 처리한다
    return {"ok": True}


# ---------------------------------------------------------------------------
# 할 일 목록 — 사장님 직접 입력과 브루(AI) 추가가 같은 저장소를 쓴다
# ---------------------------------------------------------------------------

@router.get("/todos/ai-suggestions")
def ai_todo_suggestions_api(current_user: User = Depends(get_current_user)):
    """브루의 오늘 할 일 제안 — 재고·판매 데이터를 LLM이 읽고 실행형 문장으로 만든다.

    '재고 부족' 같은 상태 나열 대신 "원두가 2kg 남았어요 — 오늘 발주하세요"로,
    그리고 홍보 가치가 큰 메뉴 1개를 골라 "○○를 홍보해 보세요"(kind=promo)를 준다.
    매장별 하루 캐시. 키 없으면 규칙 기반 문장으로 폴백.
    """
    from app.services.ai import ai_todo_service

    return ai_todo_service.suggest_todos(current_user.email)


@router.get("/todos", response_model=list[TodoResponse])
def list_todos(current_user: User = Depends(get_current_user)):
    """할 일 목록 조회 — 미완료가 먼저, 기한 임박 순.

    재고 부족·서류 갱신처럼 조건에서 자동으로 도출되는 할 일은 여기 없다.
    그건 대시보드가 재고·서류 API로 매번 조립한다 (상황이 해소되면 저절로 사라져야 하므로).
    """
    return todo_service.list_todos(current_user.email)


@router.post("/todos", response_model=TodoResponse, status_code=201)
def create_todo(body: TodoCreate, current_user: User = Depends(get_current_user)):
    """할 일 추가 (사장님 직접 입력). 같은 제목의 미완료 항목이 있으면 그것을 돌려준다."""
    try:
        return todo_service.add_todo(current_user.email, body, source="owner")
    except todo_service.TodoError as e:
        raise HTTPException(400, str(e))


@router.patch("/todos/{todo_id}", response_model=TodoResponse)
def update_todo(todo_id: int, body: TodoUpdate, current_user: User = Depends(get_current_user)):
    """부분 수정 — 보낸 필드만 바뀐다. 완료 토글이 가장 흔한 용도."""
    try:
        return todo_service.update_todo(current_user.email, todo_id, body)
    except todo_service.TodoError as e:
        raise HTTPException(404, str(e))


@router.delete("/todos/{todo_id}", status_code=204)
def delete_todo(todo_id: int, current_user: User = Depends(get_current_user)):
    try:
        todo_service.delete_todo(current_user.email, todo_id)
    except todo_service.TodoError as e:
        raise HTTPException(404, str(e))


@router.post("/todos/{todo_id}/forward", response_model=TodoResponse)
def forward_todo(todo_id: int, body: TodoForwardRequest,
                 db: Session = Depends(get_db),
                 current_user: User = Depends(require_owner)):
    """할 일을 알바의 근무 체크리스트로 보낸다 — 담당 지정 + 일회성(one_off).

    사장님 전용. 성공하면 그 직원 기기로 푸시가 가고, 할 일에는 전달 흔적이 남아
    사장님 홈에서 완료 여부를 추적할 수 있다 (완료 = 체크리스트 쪽에서 체크됨).
    """
    try:
        result, item, staff_name = todo_service.forward_todo(
            db, current_user.email, todo_id, body.staff_id)
    except todo_service.TodoError as e:  # 할 일이 없거나 이미 완료 — 리소스 문제
        raise HTTPException(404, str(e))
    except ValueError as e:  # 직원 검증 실패(남의 매장·비활성 계정) — 요청 문제
        raise HTTPException(400, str(e))

    # 푸시 — 체크리스트에 직접 추가할 때와 같은 문구·대상 규칙 (실패해도 전달은 성공으로 남긴다)
    try:
        from app.services.ai import push_service
        push_service.send_to_staff(
            db, current_user.email, "담당 업무가 도착했어요",
            f"{staff_name}님 담당 · {item.label}",
            staff_id=item.assigned_staff_id,
            data={"screen": "Checklist"},
        )
    except Exception:  # noqa: BLE001 — 푸시 실패가 전달 실패로 번지면 안 된다
        pass
    return result


# ---------------------------------------------------------------------------
# 챗봇 사고 후보 — 운영 대화에서 자동으로 잡힌 오답 (관리자용)
# ---------------------------------------------------------------------------

@router.get("/incidents")
def list_chat_incidents_api(
    status: str = "pending",
    mine_only: bool = False,
    limit: int = 100,
    current_user: User = Depends(get_current_user),
):
    """감시 규칙·사장님 부정 반응으로 잡힌 사고 후보 목록.

    evals/harvest.py가 이 후보들을 재현 검증해 골든 세트에 자동 등록한다. 이 API는
    사람이 '지금 무엇이 걸려 있는지' 눈으로 보고, 기계가 판단 못 한 건을 직접
    확정/기각하기 위한 창구다.

    status: pending(미검증) / confirmed / registered / rejected. 빈 문자열이면 전부.
    mine_only=true면 내 매장에서 난 것만 본다. 질문·답변 발췌에 매장 데이터가
    담기므로 전체 열람(mine_only=false)은 관리자만 가능 — 일반 사용자는 항상 내 매장만.
    """
    from app.core.auth import ADMIN_EMAILS
    from app.services.ai import answer_audit

    is_admin = current_user.email in ADMIN_EMAILS
    scope = "" if (is_admin and not mine_only) else current_user.email
    return {
        "incidents": answer_audit.list_incidents(status=status, store_id=scope, limit=limit),
    }


class IncidentStatusUpdate(BaseModel):
    status: str = Field(..., description="confirmed / rejected / pending / registered")
    note: str = Field("", max_length=300)


@router.patch("/incidents/{incident_id}")
def update_chat_incident_api(
    incident_id: int,
    body: IncidentStatusUpdate,
    current_user: User = Depends(get_current_user),
):
    """사고 후보 상태를 사람이 바꾼다 — 기계가 재현하지 못한 건을 직접 확정하거나 기각한다.

    일반 사용자는 내 매장의 사고만 바꿀 수 있다 (관리자는 전체).
    """
    from app.core.auth import ADMIN_EMAILS
    from app.services.ai import answer_audit

    scope = "" if current_user.email in ADMIN_EMAILS else current_user.email
    try:
        found = answer_audit.set_status(incident_id, body.status, body.note, store_id=scope)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not found:
        raise HTTPException(404, f"{incident_id}번 사고 후보를 찾을 수 없습니다.")
    return {"id": incident_id, "status": body.status}
