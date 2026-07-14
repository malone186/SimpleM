"""운영 API 스키마 (백엔드 C)"""
from datetime import datetime
from typing import Any, List, Optional
from pydantic import BaseModel, Field

class CommonResponse(BaseModel):
    """API 공통 응답 포맷 규격"""
    success: bool = Field(..., description="요청 성공 여부")
    data: Optional[Any] = Field(None, description="응답 데이터 페이로드")
    message: str = Field("처리가 완료되었습니다.", description="결과 설명 메시지")

class ScheduleCreate(BaseModel):
    """근무 스케줄 등록 요청 양식"""
    employee_id: int = Field(..., description="직원 고유 ID")
    start_time: datetime = Field(..., description="근무 시작 일시")
    end_time: datetime = Field(..., description="근무 종료 일시")

class ScheduleResponse(BaseModel):
    """근무 스케줄 반환 양식"""
    id: int = Field(..., description="스케줄 고유 번호")
    employee_id: int = Field(..., description="근무 직원 ID")
    start_time: datetime = Field(..., description="근무 시작 일시")
    end_time: datetime = Field(..., description="근무 종료 일시")
    date: str = Field(..., description="근무 일자 (YYYY-MM-DD)")

    class Config:
        from_attributes = True

class PayrollResponse(BaseModel):
    """예상 급여 응답 스키마"""
    employee_id: int = Field(..., description="직원 고유 번호")
    year_month: str = Field(..., description="정산 년월 (YYYY-MM)")
    total_work_hours: float = Field(..., description="총 실근무시간")
    estimated_payroll: int = Field(..., description="예상 총 급여액")
    weekly_holiday_allowance: int = Field(..., description="예상 주휴수당")
    calculated_at: datetime = Field(..., description="계산 수행 일시")
    disclaimer: str = Field(
        "이 계산은 참고용 예상값이며 실제 신고 및 지급 금액과 다를 수 있습니다.",
        description="급여 면책 고지"
    )

class SettlementResponse(BaseModel):
    """예상 손익 정산 응답 스키마"""
    year_month: str = Field(..., description="정산 년월 (YYYY-MM)")
    total_sales: int = Field(..., description="예상 총 매출액")
    total_expense: int = Field(..., description="예상 총 지출액")
    total_payroll: int = Field(..., description="예상 총 직원 급여액")
    net_profit: int = Field(..., description="예상 당기 순이익")
    calculated_at: datetime = Field(..., description="계산 수행 일시")
    disclaimer: str = Field(
        "이 정산 결과는 예상 시뮬레이션 초안이며 실제 세무/회계 장부와 다를 수 있습니다.",
        description="정산 면책 고지"
    )

class TaxEstimateRequest(BaseModel):
    """세무 예상 계산 요청 스키마"""
    period: Optional[str] = Field("2026-07", description="대상 기간 (YYYY-MM)")
    total_revenue: int = Field(..., description="총 매출액 (0 이상)")
    total_expense: int = Field(..., description="총 비용액 (0 이상)")
    tax_rate: Optional[float] = Field(0.1, description="세율 (0.0 ~ 1.0, 기본값 0.1)")

class TaxEstimateResponse(BaseModel):
    """세무 예상 계산 응답 스키마"""
    period: str = Field(..., description="대상 기간")
    total_revenue: int = Field(..., description="총 매출액")
    total_expense: int = Field(..., description="총 비용액")
    taxable_amount: int = Field(..., description="과세 표준 금액 (매출 - 비용, 최소 0)")
    tax_rate: float = Field(..., description="적용 세율")
    estimated_tax: int = Field(..., description="예상 세액")
    summary: str = Field(..., description="계산 결과 요약 문장")
    disclaimer: str = Field(
        "이 계산은 참고용 예상값이며 실제 신고 금액과 다를 수 있습니다. 정확한 신고는 세무 전문가 또는 관련 기관 확인이 필요합니다.",
        description="법적 면책 고지 문구"
    )

class DailySalesInput(BaseModel):
    """일별 판매 기록 입력 스키마"""
    date: str = Field(..., description="매출 일자 (YYYY-MM-DD)")
    revenue: int = Field(..., description="매출액 (0 이상)")
    quantity: int = Field(..., description="판매량 (0 이상)")

class ForecastRequest(BaseModel):
    """판매 예측 요청 스키마"""
    sales_data: List[DailySalesInput] = Field(..., description="최근 N일 판매 데이터 리스트 (최소 7일치)")
    target_date: str = Field(..., description="예측 대상 날짜 (YYYY-MM-DD)")
    has_event: Optional[bool] = Field(False, description="이벤트 발생 여부")

class ForecastResponse(BaseModel):
    """판매 예측 응답 스키마"""
    target_date: str = Field(..., description="예측 대상 날짜")
    predicted_sales: int = Field(..., description="예측 매출액")
    predicted_quantity: int = Field(..., description="예측 판매량")
    evidence_summary: str = Field(..., description="예측 연산 근거 요약 설명")

class RAGDocumentResponse(BaseModel):
    """RAG 공통 문서 구조 스키마"""
    title: str = Field(..., description="문서 제목")
    content: str = Field(..., description="문서 본문 자연어")
    summary: str = Field(..., description="문서 요약")
    category: str = Field(..., description="카테고리 (예: tax, forecast, schedule 등)")
    tags: List[str] = Field(..., description="검색 태그 리스트")
    source_type: str = Field(..., description="출처 데이터 도메인 종류")
    source_id: int = Field(..., description="출처 데이터 식별자 고유 번호")

class ReportSourceResponse(BaseModel):
    """리포트 취합 데이터 소스 스키마"""
    period: str = Field(..., description="리포트 대상 기간 (daily, weekly, monthly 등)")
    sales_summary: str = Field(..., description="자연어로 작성된 매출 동향 리포트")
    payroll_summary: str = Field(..., description="자연어로 작성된 인건비 동향 리포트")
    tax_summary: str = Field(..., description="자연어로 작성된 세금 분석 리포트")
    forecast_summary: str = Field(..., description="자연어로 작성된 판매 예측 리포트")




