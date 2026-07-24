"""챗봇 API (백엔드 B)

제공 기능:
  OCR 초안 플로우(AI-2): 업로드 → 초안 생성 → 사용자 수정 → 확정(사람) 또는 반려
  서류 자동화(ERP-12): 발주서·재고실사표·검수확인서·장부·임금명세서·근로계약서 초안 + 갱신 알림
챗봇 대화 엔드포인트는 main_agent 구현 시 추가 예정.
"""

import json
import logging
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.ai.agents import main_agent

from app.core.auth import get_current_user
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
    EmploymentContractRequest,
    GeneratedDocumentResponse,
    GeneratedDocumentUpdate,
    OcrConfirmRequest,
    OcrConfirmResponse,
    OcrDocumentResponse,
    OcrDocumentUpdate,
    OcrStatus,
    PayslipRequest,
)
from app.services.ai import (
    document_service,
    forecast_service,
    ocr_service,
    price_service,
    report_service,
    sales_service,
)

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


# ---------------------------------------------------------------------------
# 서류 자동화 (ERP-12) — 모든 문서는 초안(draft)으로만 생성, 확정·전송은 사람이
# 매장별 데이터이므로 로그인 필수 (store_id = 로그인 이메일)
# ---------------------------------------------------------------------------

@router.post("/documents/purchase-order", response_model=GeneratedDocumentResponse, status_code=201)
def create_purchase_order_draft(current_user: User = Depends(get_current_user)):
    """발주서 초안 — 안전재고 이하 재료를 자동 추출해 발주 수량을 제안한다."""
    return document_service.draft_purchase_order(current_user.email)


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
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    days: int = 7,
    current_user: User = Depends(get_current_user),
):
    """익일·금주 예상 판매량과 발주 추천을 돌려준다.

    lat/lon: 매장 GPS 좌표 (프론트가 기기 위치 전달, 없으면 서울 기준 날씨).
    판매 기록이 14일 미만이면 409와 함께 안내 메시지를 준다.
    """
    try:
        return forecast_service.forecast(current_user.email, lat=lat, lon=lon, days=days)
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


class SaleItemIn(BaseModel):
    menu_id: int
    quantity: int = Field(1, ge=1)


class SalesRecordRequest(BaseModel):
    items: list[SaleItemIn]


@router.post("/sales", status_code=201)
def record_sales_api(
    body: SalesRecordRequest,
    current_user: User = Depends(get_current_user),
):
    """판매 수동 등록 — Sale 기록 + 레시피 기준 재고 자동 차감.

    여기로 등록한 판매는 대시보드·경영 리포트·예측이 읽는 Sale 테이블에 바로 반영된다.
    """
    try:
        return sales_service.record_sales(
            current_user.email, [i.model_dump() for i in body.items])
    except sales_service.SalesError as e:
        raise HTTPException(400, str(e))


@router.get("/sales/recent")
def recent_sales_api(
    limit: int = 10,
    current_user: User = Depends(get_current_user),
):
    """최근 판매 내역 (판매 입력 화면 표시용)."""
    return sales_service.recent_sales(current_user.email, limit=limit)


@router.get("/sales/calendar")
def get_sales_calendar_api(
    year: int = 0,
    month: int = 0,
    current_user: User = Depends(get_current_user),
):
    """월간 캘린더용 일별 판매 집계 (기본: 이번 달) — 대시보드 월간 뷰 표시용.

    일별 매출·잔 수·베스트 메뉴·피크 시간대와 월 합계·전월 대비 증감을 준다.
    """
    today = date.today()
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
    period_type: str = "weekly",
    refresh: bool = True,
    current_user: User = Depends(get_current_user),
):
    """현재 기간(오늘 기준)의 경영 리포트를 돌려준다 — 없으면 생성, 있으면 최신 수치로 갱신.

    period_type: daily(오늘) / weekly(이번 주) / monthly(이번 달).
    refresh=false면 이미 있는 리포트를 다시 계산하지 않고 그대로 돌려준다.
    같은 기간 리포트는 문서 하나로 유지된다(중복 생성 없음).
    """
    try:
        return report_service.generate_management_report(
            current_user.email, period_type=period_type, force_refresh=refresh)
    except report_service.ReportError as e:
        raise HTTPException(400, str(e))


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
    if row is None:
        row = ChatSession(id=session_id, store_id=current_user.email)
        db.add(row)
    row.title = body.title
    row.messages = json.dumps(body.messages, ensure_ascii=False)
    row.created_at_ms = body.created_at
    row.updated_at_ms = body.updated_at

    # 상한 초과분은 오래된 것부터 정리 (로컬 보관소와 같은 정책)
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
def get_agent_overview_api() -> dict:
    """멀티에이전트 편성 현황 — 관리자 콘솔(3000) AI 에이전트 탭 표시용.

    메인 오케스트레이터(브루)와 서브에이전트(전문가)별 활성 여부·보유 도구 목록을 돌려준다.
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
    
    try:
        # [한글 주석] 챗봇 에이전트의 대화 처리 루프 실행 — 답변 텍스트 + 이번 턴에 만든 문서 전문
        result = await main_agent.generate_response(
            user_message=body.message,
            store_id=store_key,
            history=body.history
        )
        return ChatResponse(response=result["text"], documents=result["documents"])
    except Exception as e:
        # [한글 주석] 장애 추적을 위해 로컬 콘솔에 상세 예외 Traceback을 기록합니다.
        logger.exception("챗봇 서비스 실행 중 장애 발생")
        raise HTTPException(500, f"챗봇 서비스 실행 중 장애 발생: {str(e)}")
