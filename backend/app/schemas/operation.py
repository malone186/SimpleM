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
    employee_id: int = Field(..., description="직원 고유 ID", examples=[1])
    start_time: datetime = Field(..., description="근무 시작 일시", examples=["2026-07-16T09:00:00"])
    end_time: datetime = Field(..., description="근무 종료 일시", examples=["2026-07-16T18:00:00"])

class ScheduleUpdate(BaseModel):
    """근무 스케줄 수정 요청 양식 (선택 사항)"""
    start_time: Optional[datetime] = Field(None, description="근무 시작 일시 수정", examples=["2026-07-16T10:00:00"])
    end_time: Optional[datetime] = Field(None, description="근무 종료 일시 수정", examples=["2026-07-16T19:00:00"])
    actual_start_time: Optional[datetime] = Field(None, description="실제 출근 일시 등록/수정", examples=["2026-07-16T08:55:00"])
    actual_end_time: Optional[datetime] = Field(None, description="실제 퇴근 일시 등록/수정", examples=["2026-07-16T18:05:00"])

class ScheduleResponse(BaseModel):
    """근무 스케줄 반환 양식"""
    id: int = Field(..., description="스케줄 고유 번호", examples=[1])
    employee_id: int = Field(..., description="근무 직원 ID", examples=[1])
    start_time: datetime = Field(..., description="근무 시작 일시", examples=["2026-07-16T09:00:00"])
    end_time: datetime = Field(..., description="근무 종료 일시", examples=["2026-07-16T18:00:00"])
    date: str = Field(..., description="근무 일자 (YYYY-MM-DD)", examples=["2026-07-16"])
    actual_start_time: Optional[datetime] = Field(None, description="실제 출근 일시", examples=["2026-07-16T08:55:00"])
    actual_end_time: Optional[datetime] = Field(None, description="실제 퇴근 일시", examples=["2026-07-16T18:05:00"])

    class Config:
        from_attributes = True

class PayrollCalculateRequest(BaseModel):
    """급여 예상 계산 요청 양식"""
    employee_id: int = Field(..., description="직원 고유 번호", examples=[1])
    period_start: str = Field(..., description="조회 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="조회 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    deduct_break_time: bool = Field(False, description="법정 휴게시간 공제 적용 여부 (4시간당 30분, 8시간당 1시간)")

class SettlementCalculateRequest(BaseModel):
    """정산 예상 계산 요청 양식"""
    period_start: str = Field(..., description="조회 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="조회 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    other_expense: Optional[int] = Field(0, description="기타 추가 비용", examples=[50000])

class PayrollResponse(BaseModel):
    """예상 급여 응답 스키마"""
    id: Optional[int] = Field(None, description="저장 기록 고유 번호", examples=[1])
    employee_id: int = Field(..., description="직원 고유 번호", examples=[1])
    employee_name: Optional[str] = Field(None, description="직원 이름", examples=["홍길동"])
    period_start: str = Field(..., description="정산 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="정산 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    total_work_hours: float = Field(..., description="총 실근무시간", examples=[120.5])
    estimated_salary: int = Field(..., description="예상 총 급여액", examples=[1205000])
    calculated_at: datetime = Field(..., description="계산 수행 일시")
    disclaimer: str = Field(
        "이 계산은 참고용 예상값이며 실제 신고 및 지급 금액과 다를 수 있습니다.",
        description="급여 면책 고지"
    )

    class Config:
        from_attributes = True

class PayrollListItem(BaseModel):
    """급여 목록 조회 항목 스키마"""
    id: int = Field(..., description="기록 고유 번호", examples=[1])
    employee_id: int = Field(..., description="직원 고유 번호", examples=[1])
    employee_name: str = Field(..., description="직원 이름", examples=["홍길동"])
    period_start: str = Field(..., description="정산 시작일", examples=["2026-07-01"])
    period_end: str = Field(..., description="정산 종료일", examples=["2026-07-31"])
    total_work_hours: float = Field(..., description="총 실근무시간", examples=[120.5])
    estimated_salary: int = Field(..., description="예상 총 급여액", examples=[1205000])

class SettlementResponse(BaseModel):
    """예상 손익 정산 응답 스키마"""
    id: Optional[int] = Field(None, description="저장 기록 고유 번호", examples=[1])
    period_start: str = Field(..., description="정산 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="정산 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    total_sales: int = Field(..., description="예상 총 매출액", examples=[5000000])
    total_expense: int = Field(..., description="예상 총 지출액 (원부자재 및 관리비)", examples=[1500000])
    total_payroll: int = Field(..., description="예상 총 직원 급여액", examples=[1205000])
    other_expense: int = Field(..., description="기타 추가 비용", examples=[50000])
    net_profit: int = Field(..., description="예상 당기 순이익 (매출 - 비용 - 인건비 - 기타)", examples=[2245000])
    calculated_at: datetime = Field(..., description="계산 수행 일시")
    disclaimer: str = Field(
        "이 정산 결과는 예상 시뮬레이션 초안이며 실제 세무/회계 장부와 다를 수 있습니다.",
        description="정산 면책 고지"
    )

    class Config:
        from_attributes = True

class SettlementListItem(BaseModel):
    """정산 내역 목록 조회 항목 스키마"""
    id: int = Field(..., description="기록 고유 번호", examples=[1])
    period_start: str = Field(..., description="정산 시작일", examples=["2026-07-01"])
    period_end: str = Field(..., description="정산 종료일", examples=["2026-07-31"])
    total_sales: int = Field(..., description="예상 총 매출액", examples=[5000000])
    total_expense: int = Field(..., description="예상 총 지출액", examples=[1500000])
    total_payroll: int = Field(..., description="예상 총 직원 급여액", examples=[1205000])
    net_profit: int = Field(..., description="예상 당기 순이익", examples=[2295000])

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

class ScheduleRecommendationRequest(BaseModel):
    """알바 스케줄 추천 요청 스키마"""
    period_start: str = Field(..., description="분석 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="분석 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    store_id: str = Field(..., description="매장 식별 아이디", examples=["store_gildong"])

class HourlyRecommendation(BaseModel):
    """시간대별 추천 상세 스키마"""
    hour: int = Field(..., description="시간대 (0~23)", examples=[12])
    predicted_sales: int = Field(..., description="해당 시간 예상 매출액 (원)", examples=[150000])
    predicted_profit: int = Field(..., description="해당 시간 예상 이익액 (원)", examples=[100000])
    recommended_employee_count: int = Field(..., description="추천 근무 인원수 (명)", examples=[3])
    busy_level: str = Field(..., description="혼잡도 수준 (PEAK | HIGH | NORMAL | LOW)", examples=["PEAK"])

class ScheduleRecommendationResponse(BaseModel):
    """알바 스케줄 추천 응답 스키마"""
    period_start: str = Field(..., description="분석 시작일", examples=["2026-07-01"])
    period_end: str = Field(..., description="분석 종료일", examples=["2026-07-31"])
    hourly_recommendations: List[HourlyRecommendation] = Field(..., description="시간대별 분석 및 추천 내역")
    total_recommended_hours: float = Field(..., description="추천 스케줄에 따른 총 합산 근무 시간 (시간)", examples=[18.5])
    estimated_payroll_cost: int = Field(..., description="추천 스케줄 실행 시 예상 인건비 지출액 (원)", examples=[185000])
    summary: str = Field(..., description="AI 요약 가이드라인 및 조언 문구", examples=["점심 피크타임인 12시~14시에 혼잡도가 높으므로 근무자를 집중 배치하세요."])




