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
    ocr_backend: Optional[str] = Field(None, description="사용된 OCR 백엔드 (clova_gemini/paddle_gemini/ollama_vlm)")
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
