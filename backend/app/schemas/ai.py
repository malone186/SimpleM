"""AI 스키마 (백엔드 B)"""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# OCR (AI-2: 명세서/영수증 OCR 자동 입고)
# ---------------------------------------------------------------------------

# 문서 종류: 거래명세서/세금계산서(매입) · 영수증(지출) · 매출 일마감표
OcrDocType = Literal["purchase_statement", "tax_invoice", "receipt", "sales_summary", "unknown"]

# 확정 시 등록될 대상 시스템
RegisterTarget = Literal["inventory_inbound", "expense", "sales"]

OcrStatus = Literal["draft", "confirmed", "rejected"]


class OcrVendor(BaseModel):
    """거래처(공급자) 정보"""

    name: Optional[str] = None
    biz_no: Optional[str] = Field(None, description="사업자등록번호")
    phone: Optional[str] = None


class OcrItem(BaseModel):
    """인식된 품목 한 줄 — 수량×단가=금액 관계 검증 대상"""

    name: str
    spec: Optional[str] = Field(None, description="규격 (예: 1L, 500g)")
    quantity: Optional[float] = None
    unit: Optional[str] = Field(None, description="단위 (개, box, kg 등)")
    unit_price: Optional[float] = None
    amount: Optional[float] = None
    warnings: list[str] = Field(default_factory=list, description="이 품목에서 발견된 불일치 — 사용자 확인 필요")


class OcrResult(BaseModel):
    """VLM이 추출한 문서 전체 구조"""

    doc_type: OcrDocType = "unknown"
    vendor: OcrVendor = Field(default_factory=OcrVendor)
    issued_date: Optional[str] = Field(None, description="발행일 YYYY-MM-DD")
    items: list[OcrItem] = Field(default_factory=list)
    discount: Optional[float] = Field(None, description="할인 총액 (양수, 판촉/쿠폰/멤버십 등)")
    subtotal: Optional[float] = Field(None, description="공급가액")
    tax: Optional[float] = Field(None, description="세액")
    total: Optional[float] = Field(None, description="합계 금액")


class OcrDocumentResponse(BaseModel):
    """OCR 초안 문서 — 사용자가 수정·확인 후 확정하는 단위"""

    id: str
    status: OcrStatus
    filename: Optional[str] = None
    result: OcrResult
    suggested_target: Optional[RegisterTarget] = Field(None, description="doc_type 기반 등록 대상 추천 (사용자 변경 가능)")
    warnings: list[str] = Field(default_factory=list, description="문서 수준 불일치 (합계 검증 등)")
    confirmed_target: Optional[RegisterTarget] = None
    applied: bool = Field(False, description="확정 후 대상 시스템 반영 여부")
    elapsed_sec: Optional[float] = Field(None, description="OCR 처리 소요 시간(초)")
    ocr_backend: Optional[str] = Field(None, description="사용된 OCR 백엔드 (gemini)")
    created_at: datetime
    updated_at: datetime


class OcrItemUpdate(BaseModel):
    """품목 수정 입력 — None이 아닌 필드만 반영"""

    name: Optional[str] = None
    spec: Optional[str] = None
    quantity: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    amount: Optional[float] = None


class OcrDocumentUpdate(BaseModel):
    """사용자 직접 수정 입력. items를 보내면 품목 전체가 교체된다."""

    doc_type: Optional[OcrDocType] = None
    vendor: Optional[OcrVendor] = None
    issued_date: Optional[str] = None
    items: Optional[list[OcrItem]] = None
    discount: Optional[float] = None
    subtotal: Optional[float] = None
    tax: Optional[float] = None
    total: Optional[float] = None
    suggested_target: Optional[RegisterTarget] = None


class OcrConfirmRequest(BaseModel):
    target: Optional[RegisterTarget] = Field(None, description="미지정 시 suggested_target 사용")


class OcrConfirmResponse(BaseModel):
    id: str
    status: OcrStatus
    target: RegisterTarget
    applied: bool
    message: str


# ---------------------------------------------------------------------------
# 문서 자동화 (ERP-12: 카페 운영 필요서류 체크리스트)
# ---------------------------------------------------------------------------

DocumentKind = Literal[
    "purchase_order",       # 발주서 (매일·매주)
    "stocktake_sheet",      # 재고실사표 (매일·매주)
    "inspection_report",    # 검수확인서 (매일·매주)
    "monthly_ledger",       # 매입·매출 장부 (매월)
    "vat_reference",        # 부가세/종소세 참고자료 (분기·연)
    "payslip",              # 임금명세서 (매월, 임금대장 겸용)
    "employment_contract",  # 근로계약서 (발생 시)
    "management_report",    # AI 경영 리포트 (일간·주간·월간 — 전체 데이터 통합)
    "marketing_content",    # 홍보/마케팅 콘텐츠 (홍보 문구 + 생성 이미지 목록)
]


class GeneratedDocumentResponse(BaseModel):
    """자동 생성 문서 — content 스키마는 kind별로 다르다"""

    id: str
    kind: DocumentKind
    title: str
    period: Optional[str] = None
    status: str
    content: dict
    created_at: datetime


class GeneratedDocumentUpdate(BaseModel):
    """문서 수정 입력 — content는 수정된 전체 본문 (부분 수정 아님)"""

    content: dict
    title: Optional[str] = Field(None, description="문서 제목 변경 (선택)")


class MarketingCopyRequest(BaseModel):
    """홍보 문구 생성 입력 — 전부 선택. 비우면 매장 정보만으로 일반 홍보 문구를 만든다."""

    topic: str = Field("", description="홍보 주제 (예: 신메뉴 딸기라떼 출시, 여름 시즌)")
    channel: str = Field("instagram", description="게시 채널: instagram | blog | banner | sms")
    tone: str = Field("", description="원하는 말투 (예: 감성적으로, 유쾌하게)")
    menu: str = Field("", description="특별히 강조할 메뉴 이름")


class MarketingImageRequest(BaseModel):
    """홍보 이미지 생성 입력 — doc_id를 주면 그 홍보 문구에 맞는 이미지가 만들어진다."""

    doc_id: str = Field("", description="홍보 콘텐츠 문서 id (비우면 request로 직접 생성)")
    request: str = Field("", description="원하는 이미지 설명 (한국어 가능, doc_id 없을 때 필수 권장)")
    style: str = Field("", description="스타일 지시 (예: 수채화 일러스트) — 비우면 실사 사진풍")
    aspect_ratio: str = Field("1:1", description="화면비: 1:1 | 4:5 | 9:16 | 16:9 등")
    include_text: bool = Field(True, description="문서의 슬로건을 이미지에 한글로 새길지")
    overlay: str = Field("auto", description="슬로건 위치: auto | none | bottom | center | top")
    quality: str = Field("high", description="화질: high(기본, 고해상도) | standard")


class MarketingOverlayRequest(BaseModel):
    """이미 만든 홍보 이미지의 슬로건 위치만 바꾸는 입력 — AI 재호출 없이 즉시 처리된다."""

    doc_id: str = Field(..., description="홍보 콘텐츠 문서 id")
    image_id: str = Field("", description="대상 이미지 id (비우면 마지막 이미지)")
    layout: str = Field("bottom", description="none | bottom | center | top | auto")


class PayslipRequest(BaseModel):
    """임금명세서 초안 생성 입력 — 근무시간은 스케줄 테이블에서 자동 집계, 없으면 직접 입력"""

    employee_name: str
    year: int
    month: int = Field(ge=1, le=12)
    hourly_wage: Optional[int] = Field(None, description="미입력 시 직원 테이블의 시급 사용")
    work_hours: Optional[float] = Field(None, description="미입력 시 근무 스케줄에서 자동 집계")
    withholding_rate: float = Field(3.3, description="원천징수율 % (프리랜서 3.3, 0이면 공제 없음)")
    include_weekly_holiday_pay: bool = Field(True, description="주휴수당 포함 여부 (주 15시간 이상 시)")


class EmploymentContractRequest(BaseModel):
    """근로계약서 초안 생성 입력 — 근로기준법 필수 기재사항"""

    employee_name: str
    start_date: str = Field(description="근로 개시일 YYYY-MM-DD")
    end_date: Optional[str] = Field(None, description="계약 종료일 (없으면 기간의 정함 없음)")
    hourly_wage: int
    work_days_per_week: int = Field(5, ge=1, le=7)
    work_hours_per_day: float = Field(8, gt=0, le=12)
    duties: str = Field("음료 제조 및 매장 관리", description="업무 내용")
    workplace: str = Field("", description="근무 장소 (미입력 시 매장)")


class ComplianceItemCreate(BaseModel):
    """정기 갱신 서류 등록 입력"""

    name: str = Field(description="예: 보건증(홍길동), 위생교육 수료증, 임대차계약")
    expiry_date: str = Field(description="만료일 YYYY-MM-DD")
    remind_before_days: int = Field(30, ge=1, le=365)
    memo: Optional[str] = None


class ComplianceItemResponse(BaseModel):
    id: int
    name: str
    expiry_date: str
    remind_before_days: int
    memo: Optional[str] = None
    days_left: int = Field(description="만료까지 남은 일수 (음수면 만료됨)")
    status: Literal["ok", "due_soon", "expired"]


# ---------------------------------------------------------------------------
# 메뉴 개선안 점검 — "이렇게 바꿔봤어요"를 판매·원가로 확인해 본다
# ---------------------------------------------------------------------------

MenuChangeKind = Literal["price", "add", "remove", "cost"]


class MenuChange(BaseModel):
    """개선안 한 줄. 저장을 지시하는 게 아니라 '이렇게 바꾸면 어떻게 되나'를 묻는 단위다."""

    kind: MenuChangeKind = "price"
    name: str = Field(min_length=1, max_length=100, description="메뉴 이름 (등록된 이름과 달라도 찾아준다)")
    price: Optional[int] = Field(default=None, ge=0, le=1_000_000, description="바꿀 판매가 (kind=price/add)")
    delta: Optional[int] = Field(default=None, ge=-1_000_000, le=1_000_000,
                                 description="지금 가격에서의 증감 (price에 값이 없을 때만 쓴다)")
    cost: Optional[int] = Field(default=None, ge=0, le=1_000_000, description="바꿀 재료비 (kind=cost/add)")


class MenuReviewRequest(BaseModel):
    changes: list[MenuChange] = Field(min_length=1, max_length=60)
    days: int = Field(default=30, ge=7, le=180, description="비교 기준이 되는 최근 판매 기간")
    comment: bool = Field(default=True, description="AI 총평을 함께 만들지 (끄면 규칙 문장)")


class MenuChangeApplyRequest(BaseModel):
    """점검을 마친 개선안을 실제 메뉴에 반영 — 사장님이 눌렀을 때만 호출된다."""

    changes: list[MenuChange] = Field(min_length=1, max_length=60)


# ---------------------------------------------------------------------------
# 챗봇 대화 세션 — 사용자별 대화 기록 서버 보관 (프론트 로컬 보관소와 같은 모양)
# ---------------------------------------------------------------------------


class ChatSessionUpsert(BaseModel):
    """세션 저장(신규/갱신) 입력 — 시각은 프론트 기준인 epoch ms 정수"""

    title: str = Field(max_length=100)
    messages: list[dict] = Field(description="말풍선 배열 (프론트 ChatMsg[] 그대로, 문서 카드 포함)")
    created_at: int = Field(description="세션 생성 시각 epoch ms")
    updated_at: int = Field(description="마지막 수정 시각 epoch ms")


class ChatSessionResponse(BaseModel):
    id: str
    title: str
    messages: list[dict]
    created_at: int
    updated_at: int


# ---------------------------------------------------------------------------
# 푸시 알림 (FCM) — 기기 토큰 등록 + 수신 설정 서버 동기화
# ---------------------------------------------------------------------------


class DeviceTokenRegister(BaseModel):
    """기기 푸시 토큰 등록/갱신 입력.

    토큰은 앱 재설치·데이터 삭제·장기 미사용으로 무효화되므로 영구 식별자가 아니다.
    프론트는 로그인 직후와 토큰 갱신 이벤트마다 이 API를 다시 호출한다 (upsert).
    """

    token: str = Field(min_length=10, max_length=255, description="FCM registration token")
    platform: Literal["android", "ios", "web"] = "android"
    device_name: Optional[str] = Field(None, max_length=100, description="관리 화면 표시용 기기 이름")


class NotificationSettingBody(BaseModel):
    """푸시 수신 설정 — 기기 로컬 설정을 서버로 동기화한 사본.

    푸시는 서버가 보내므로 방해금지 구간과 종류별 on/off를 서버가 알아야 한다.
    """

    push_enabled: bool = Field(True, description="푸시 마스터 스위치")
    compliance_alert: bool = Field(True, description="갱신 임박 서류")
    report_alert: bool = Field(True, description="경영 리포트 도착")
    stock_alert: bool = Field(True, description="재고 소진 임박")
    sensor_alert: bool = Field(True, description="설비 이상 (방해금지 무시)")
    nearby_alert: bool = Field(True, description="주변 소식 — 곧 열리는 행사·경쟁 카페 개업/폐업")
    insight_alert: bool = Field(
        True, description="아침 브리핑과 선제 인사이트 — 정산 미입력·뜸해진 단골·POS 연동 끊김 등")
    report_frequency: Literal["daily", "weekly"] = "weekly"
    dnd_enabled: bool = False
    dnd_start: str = Field("22:00", pattern=r"^\d{2}:\d{2}$")
    dnd_end: str = Field("08:00", pattern=r"^\d{2}:\d{2}$")


class NotificationSettingResponse(NotificationSettingBody):
    store_id: str
    push_configured: bool = Field(description="서버에 FCM 자격증명이 설정돼 실제 발송이 가능한지")
    device_count: int = Field(0, description="이 매장에 등록된 기기 수")


# ---------------------------------------------------------------------------
# 할 일 목록 (대시보드 '오늘 할 일' 중 명시적으로 적어둔 항목)
# ---------------------------------------------------------------------------


class TodoCreate(BaseModel):
    """할 일 추가 입력 — 사장님 직접 입력과 챗봇 추가가 같은 규격을 쓴다."""

    title: str = Field(min_length=1, max_length=200, description="할 일 제목")
    note: Optional[str] = Field(None, max_length=255, description="부제 — 왜 추가됐는지")
    due_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="기한 YYYY-MM-DD")


class TodoUpdate(BaseModel):
    """부분 수정 — 보낸 필드만 바뀐다 (done만 토글하는 호출이 가장 흔하다)."""

    title: Optional[str] = Field(None, min_length=1, max_length=200)
    note: Optional[str] = Field(None, max_length=255)
    due_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    done: Optional[bool] = None


class TodoResponse(BaseModel):
    id: int
    title: str
    note: Optional[str] = None
    source: Literal["owner", "ai"] = Field(description="누가 추가했는지 — 대시보드 배지 표시용")
    done: bool
    due_date: Optional[str] = None
    created_at: Optional[str] = None
    # 이번 요청으로 완료 처리되며 적립된 코인. 이미 적립된 할 일을 다시 완료 처리하면 없음.
    # 프론트가 "+10코인" 토스트를 띄울지 판단하는 데 쓴다.
    points_awarded: Optional[int] = Field(default=None, description="이번에 적립된 코인 수")
    # 알바에게 보낸 할 일 — 받은 직원 이름과 그쪽(체크리스트)에서의 완료 여부.
    # forwarded_done이 None이면 아직 미완료이거나 보낸 항목이 삭제된 것.
    forwarded_to: Optional[str] = Field(default=None, description="전달받은 직원 이름 (안 보냈으면 없음)")
    forwarded_done: Optional[bool] = Field(default=None, description="체크리스트 쪽 완료 여부")


class TodoForwardRequest(BaseModel):
    staff_id: int = Field(description="전달받을 직원 계정 id (staff_accounts.id)")


class PhotoCutoutComposeRequest(BaseModel):
    """보관함 누끼로 홍보 이미지 합성 — 촬영·누끼 단계를 건너뛴다."""
    cutout_id: int = Field(description="보관된 누끼 id (promo_cutouts.id)")
    style: str = Field(default="wood", description="배경 스타일 (wood/marble/cozy/studio/season)")
    aspect_ratio: str = Field(default="1:1")
    doc_id: str = Field(default="", description="붙일 홍보 문서 id (없으면 독립 이미지)")


class PointHistoryItem(BaseModel):
    id: int
    delta: int = Field(description="적립은 양수, 사용은 음수")
    reason: str
    reason_label: str
    memo: str
    created_at: Optional[str] = None


class WalletResponse(BaseModel):
    balance: int
    total_earned: int
    history: list[PointHistoryItem]


class ShopItemResponse(BaseModel):
    id: str
    slot: str
    slot_label: str
    name: str
    emoji: str
    price: int
    desc: str
    owned: bool
    equipped: bool
    affordable: bool
    # 포즈 상품일 때만 채워진다 — 프론트 Brew의 mood 값
    mood: Optional[str] = None
    # 레벨 잠금 — 선언이 빠지면 response_model이 응답에서 떨어뜨려 프론트 잠금 UI가 죽는다
    min_level: int = 0
    locked: bool = False


class ShopResponse(BaseModel):
    balance: int
    items: list[ShopItemResponse]


class EquipRequest(BaseModel):
    item_id: str
    equipped: bool = True


class DerivedTodoDoneRequest(BaseModel):
    """자동 도출 할 일(재고·서류·브루 추천) 완료 신고 — 저장된 행이 없어 앱이 직접 알린다."""

    # 인사이트 id_hint가 120자까지 온다 (ai_todo_service가 그 길이로 자른다)
    key: str = Field(min_length=1, max_length=120, description="대시보드가 쓰는 안정적인 항목 id")
    title: str = Field(min_length=1, max_length=200, description="내역에 남길 문구")


class AwardResponse(BaseModel):
    """적립 결과. awarded가 0이면 이미 받은 항목이라 잔액이 그대로다."""

    awarded: int = Field(description="이번에 적립된 코인 수 (이미 적립됐으면 0)")
    balance: int = Field(description="적립 후 잔액")
