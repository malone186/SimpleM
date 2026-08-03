"""단골 회원 · 선불 충전 스키마 (백엔드 B)"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from app.services.membership_service import normalize_phone


# --- 회원 ---

class CustomerCreate(BaseModel):
    phone: str = Field(..., description="전화번호 (010-1234-5678 / 01012345678 모두 허용)")
    name: Optional[str] = Field(None, max_length=50, description="이름 (선택)")
    memo: Optional[str] = Field(None, description="사장님 메모")

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        """[한글 주석] 입력 형태가 제각각이면 같은 손님이 두 번 등록된다.
        저장 전에 010-1234-5678 형태로 통일한다."""
        normalized = normalize_phone(v)
        if not normalized:
            raise ValueError("휴대폰 번호 형식이 올바르지 않습니다 (예: 010-1234-5678)")
        return normalized


class CustomerUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=50)
    memo: Optional[str] = None
    is_active: Optional[bool] = None


class CustomerOut(BaseModel):
    id: int
    phone: str
    phone_masked: str          # 010-****-5678 (목록 노출용)
    name: Optional[str]
    balance: int
    memo: Optional[str]
    is_active: bool
    created_at: datetime

    # 방문 지표 (계산값)
    visit_count: int = 0
    last_visit_at: Optional[datetime] = None
    days_since_visit: Optional[int] = None

    class Config:
        from_attributes = True


# --- 충전 상품 ---

class ChargePlanCreate(BaseModel):
    pay_amount: int = Field(..., gt=0, description="손님이 내는 금액")
    credit_amount: int = Field(..., gt=0, description="잔액으로 적립되는 금액")

    @field_validator("credit_amount")
    @classmethod
    def _check_credit(cls, v: int, info) -> int:
        pay = (info.data or {}).get("pay_amount")
        if pay and v < pay:
            raise ValueError("적립액이 결제액보다 적을 수 없습니다")
        return v


class ChargePlanOut(BaseModel):
    id: int
    pay_amount: int
    credit_amount: int
    bonus_amount: int
    discount_rate: float       # 적립액 기준 실질 할인율(%)
    is_active: bool

    class Config:
        from_attributes = True


# --- 거래 ---

class ChargeRequest(BaseModel):
    """충전 — 상품을 고르거나, 상품 없이 금액을 직접 넣는다."""
    charge_plan_id: Optional[int] = None
    pay_amount: Optional[int] = Field(None, gt=0)
    credit_amount: Optional[int] = Field(None, gt=0)
    memo: Optional[str] = None


class UseRequest(BaseModel):
    amount: int = Field(..., gt=0, description="차감할 금액")
    memo: Optional[str] = Field(None, description="예: 아메리카노 1잔")


class AdjustRequest(BaseModel):
    """사장님 수동 보정 — 실수 정정용. 사유를 반드시 남긴다."""
    amount: int = Field(..., description="증감액 (음수 가능)")
    memo: str = Field(..., min_length=2, description="보정 사유 (필수)")


class TransactionOut(BaseModel):
    id: int
    tx_type: str
    tx_label: str              # 충전 / 사용 / 환불 / 보정
    amount: int
    balance_after: int
    paid_amount: Optional[int]
    memo: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class BalanceResult(BaseModel):
    """충전·차감 직후 응답 — 문자 발송 문구까지 함께 준다."""
    customer_id: int
    customer_name: Optional[str]
    phone: str
    balance: int
    transaction: TransactionOut
    sms_text: str              # 사장님 폰 문자앱에 채워 넣을 문구
    balance_url: str           # 손님용 잔액 조회 링크


# --- 손님용 (인증 없이 토큰으로 조회) ---

class PublicBalanceOut(BaseModel):
    store_name: Optional[str]
    name: Optional[str]
    balance: int
    transactions: List[TransactionOut]


# --- 집계 ---

class PrepaidSummary(BaseModel):
    """선수금 현황 — 매출과 반드시 분리해서 본다."""
    customer_count: int
    active_balance_total: int      # 아직 안 쓴 잔액 = 우리가 진 빚
    charged_total: int             # 누적 충전 결제액 (현금 유입)
    credited_total: int            # 누적 적립액
    used_total: int                # 누적 사용액 (매출로 인식된 부분)
    bonus_given: int               # 나간 보너스 (실질 할인 총액)
    period_days: int


class ChurnRiskCustomer(BaseModel):
    """뜸해진 단골 — 평소 주기 대비 오래 안 온 손님"""
    customer_id: int
    name: Optional[str]
    phone: str
    phone_masked: str
    balance: int
    visit_count: int
    median_interval_days: float    # 평소 방문 주기 (중앙값)
    days_since_visit: int
    overdue_ratio: float           # 평소 주기의 몇 배나 지났는지
    sms_text: str
    balance_url: str
