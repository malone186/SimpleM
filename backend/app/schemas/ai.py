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
