"""운영 API 스키마 (백엔드 C 최초 작성 → 백엔드 B 인수)"""
from datetime import datetime, date
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, AliasChoices, ConfigDict

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
    """급여 예상 계산 요청 양식 (MVP + 자정넘김 + 주휴수당/세금공제 지원)"""
    employee_name: Optional[str] = Field(None, min_length=1, description="직원 이름 (최소 1글자)", examples=["홍길동"])
    start_time: datetime = Field(..., description="근무 시작 일시 (YYYY-MM-DDTHH:MM:SS)", examples=["2026-07-20T22:00:00"])
    end_time: datetime = Field(..., description="근무 종료 일시 (YYYY-MM-DDTHH:MM:SS)", examples=["2026-07-21T06:00:00"])
    break_minutes: float = Field(0.0, ge=0, description="휴게시간 (분 단위, 0 이상)", examples=[60.0])
    hourly_rate: int = Field(..., gt=0, description="시급 (원 단위, 0보다 커야 함)", examples=[10000])
    weekly_work_hours: Optional[float] = Field(None, ge=0, description="주간 총 예상 근무시간 (15시간 이상 시 주휴수당 계산)", examples=[20.0])
    include_weekly_holiday: bool = Field(False, description="주휴수당 포함 계산 여부", examples=[True])
    deduct_tax: bool = Field(False, description="3.3% 사업소득세 원천징수 공제 여부", examples=[True])

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "employee_name": "홍길동",
                "start_time": "2026-07-20T22:00:00",
                "end_time": "2026-07-21T06:00:00",
                "break_minutes": 60.0,
                "hourly_rate": 10000,
                "weekly_work_hours": 20.0,
                "include_weekly_holiday": True,
                "deduct_tax": True
            }
        }
    )

class PayrollCalculateResponse(BaseModel):
    """급여 예상 계산 응답 양식 (세후 실수령액 및 주휴수당 포함)"""
    total_hours: float = Field(..., description="전체 근무시간 (시간)", examples=[8.0])
    break_hours: float = Field(..., description="휴게시간 (시간)", examples=[1.0])
    actual_work_hours: float = Field(..., description="실근무시간 (시간)", examples=[7.0])
    hourly_rate: int = Field(..., description="시급 (원)", examples=[10000])
    base_payroll: int = Field(..., description="기본 근무 급여액 (원)", examples=[70000])
    estimated_payroll: int = Field(..., description="기본 근무 급여액 (하위 호환)", examples=[70000])
    weekly_holiday_allowance: int = Field(0, description="예상 주휴수당 (원)", examples=[32000])
    gross_payroll: int = Field(..., description="공제 전 총 급여액 (기본급 + 주휴수당)", examples=[102000])
    withholding_tax: int = Field(0, description="예상 3.3% 원천징수 세금 (원)", examples=[3366])
    net_payroll: int = Field(..., description="세후 예상 실수령액 (원)", examples=[98634])
    disclaimer: str = Field(
        "본 급여 계산 결과는 확정 지급액이 아니며 참고용 예상 급여입니다.",
        description="급여 면책 고지"
    )

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "total_hours": 8.0,
                "break_hours": 1.0,
                "actual_work_hours": 7.0,
                "hourly_rate": 10000,
                "base_payroll": 70000,
                "estimated_payroll": 70000,
                "weekly_holiday_allowance": 32000,
                "gross_payroll": 102000,
                "withholding_tax": 3366,
                "net_payroll": 98634,
                "disclaimer": "본 급여 계산 결과는 확정 지급액이 아니며 참고용 예상 급여입니다."
            }
        }
    )

class SettlementCalculateRequest(BaseModel):
    """정산 예상 계산 요청 양식 (MVP 계산용)"""
    revenue: Optional[int] = Field(None, ge=0, description="매출액 (원 단위, 0 이상)", examples=[1000000])
    cost: Optional[int] = Field(None, ge=0, description="원가 및 지출 비용 (원 단위, 0 이상)", examples=[300000])
    labor_cost: Optional[int] = Field(None, ge=0, description="인건비 (원 단위, 0 이상)", examples=[200000])
    other_expense: Optional[int] = Field(0, ge=0, description="기타 비용 (원 단위, 0 이상)", examples=[50000])
    period_start: Optional[str] = Field(None, description="집계 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: Optional[str] = Field(None, description="집계 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "revenue": 1000000,
                "cost": 300000,
                "labor_cost": 200000,
                "other_expense": 50000,
                "period_start": "2026-07-01",
                "period_end": "2026-07-31"
            }
        }
    )

class SettlementCalculateResponse(BaseModel):
    """정산 예상 계산 응답 양식"""
    revenue: int = Field(..., description="매출액 (원)", examples=[1000000])
    cost: int = Field(..., description="원가 및 비용 (원)", examples=[300000])
    labor_cost: int = Field(..., description="인건비 (원)", examples=[200000])
    other_expense: int = Field(..., description="기타 비용 (원)", examples=[50000])
    total_cost: int = Field(..., description="총 비용 (원가 + 인건비 + 기타비용)", examples=[550000])
    estimated_profit: int = Field(..., description="예상 정산 이익 (매출 - 총 비용)", examples=[450000])
    profit_rate: Optional[float] = Field(
        None,
        validation_alias=AliasChoices("profit_rate", "profit_margin"),
        description="이익률 (%, 매출이 0인 경우 null)",
        examples=[45.0]
    )
    profit_margin: Optional[float] = Field(
        None,
        description="이익률 하위 호환 필드 (%, 매출이 0인 경우 null)",
        examples=[45.0]
    )
    disclaimer: str = Field(
        "본 정산 결과는 확정 정산이 아닌 단순 참고용 예상 정산 결과입니다.",
        description="정산 면책 고지"
    )

    model_config = ConfigDict(
        populate_by_name=True,
        json_schema_extra={
            "example": {
                "revenue": 1000000,
                "cost": 300000,
                "labor_cost": 200000,
                "other_expense": 50000,
                "total_cost": 550000,
                "estimated_profit": 450000,
                "profit_rate": 45.0,
                "profit_margin": 45.0,
                "disclaimer": "본 정산 결과는 확정 정산이 아닌 단순 참고용 예상 정산 결과입니다."
            }
        }
    )

class ExpenseCreate(BaseModel):
    """지출(비용) 등록 요청 양식"""
    amount: int = Field(..., ge=0, description="지출 금액 (원, 0 이상)")
    category: str = Field(..., description="지출 카테고리 (예: 원두매입, 소모품비, 임대료 등)")
    description: Optional[str] = Field(None, description="지출 상세 설명")
    expense_date: date = Field(..., description="지출 일자 (YYYY-MM-DD)")

class ExpenseResponse(BaseModel):
    """지출(비용) 반환 양식"""
    id: int = Field(..., description="지출 고유 번호")
    store_id: str = Field(..., description="매장 식별 아이디")
    amount: int = Field(..., description="지출 금액 (원)")
    category: str = Field(..., description="지출 카테고리")
    description: Optional[str] = Field(None, description="지출 상세 설명")
    expense_date: date = Field(..., description="지출 일자")
    created_at: datetime = Field(..., description="등록 일시")

    class Config:
        from_attributes = True

class PayrollResponse(BaseModel):
    """예상 급여 응답 스키마"""
    id: Optional[int] = Field(None, description="저장 기록 고유 번호", examples=[1])
    employee_id: int = Field(..., description="직원 고유 번호", examples=[1])
    employee_name: Optional[str] = Field(None, description="직원 이름", examples=["홍길동"])
    period_start: str = Field(..., description="정산 시작일 (YYYY-MM-DD)", examples=["2026-07-01"])
    period_end: str = Field(..., description="정산 종료일 (YYYY-MM-DD)", examples=["2026-07-31"])
    total_work_hours: float = Field(..., description="총 실근무시간", examples=[120.5])
    base_salary: int = Field(..., description="기본급 (실근무시간 × 시급)", examples=[1205000])
    weekly_holiday_allowance: int = Field(0, description="예상 주휴수당", examples=[0])
    estimated_salary: int = Field(..., description="예상 총 급여액 (기본급 + 주휴수당)", examples=[1205000])
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
    """세무 예상 계산 요청 스키마 (매출·비용 수동 입력용 — 챗봇/일회성)"""
    period: Optional[str] = Field("2026-07", description="대상 기간 (YYYY-MM)")
    total_revenue: int = Field(..., ge=0, description="총 매출액 (0 이상)")
    total_expense: int = Field(..., ge=0, description="총 비용액 (0 이상)")
    tax_type: Optional[str] = Field("general", description="과세유형 (general 일반과세 | simplified 간이과세)")

class TaxLineItem(BaseModel):
    """세목별 계산 상세 한 줄"""
    name: str = Field(..., description="세목명 (부가가치세 / 종합소득세 / 원천징수세)")
    amount: int = Field(..., description="예상 세액 (원)")
    basis: str = Field(..., description="계산 근거 설명")

class TaxFilingItem(BaseModel):
    """세목별 신고 기한 및 D-day"""
    name: str = Field(..., description="세목명")
    due_date: str = Field(..., description="신고 기한 (YYYY-MM-DD)")
    dday: int = Field(..., description="오늘 기준 남은 일수 (음수면 기한 경과)")
    status: str = Field(..., description="상태 (예정 | 임박 | 기한 경과)")
    note: str = Field(..., description="신고 안내 설명")

class TaxEstimateResponse(BaseModel):
    """세무 예상 계산 응답 스키마 (부가세·종소세·원천징수 통합)"""
    period: str = Field(..., description="대상 기간 (YYYY-MM)")
    tax_type: str = Field(..., description="과세유형 (general | simplified)")
    total_revenue: int = Field(..., description="총 매출액")
    total_expense: int = Field(..., description="총 비용액")
    taxable_base: int = Field(..., description="종합소득세 과세표준 (매출 - 경비 - 공제, 최소 0)")
    vat: int = Field(..., description="예상 부가가치세")
    income_tax: int = Field(..., description="예상 종합소득세 (누진 산출)")
    withholding_tax: int = Field(..., description="예상 원천징수세액 합계 (해당 월 인건비 기준)")
    total_tax: int = Field(..., description="예상 세액 총합")
    lines: List[TaxLineItem] = Field(default_factory=list, description="세목별 계산 상세")
    filing_schedule: List[TaxFilingItem] = Field(default_factory=list, description="세목별 신고 기한·D-day (임박순)")
    next_filing: Optional[TaxFilingItem] = Field(None, description="가장 임박한 신고 기한")
    summary: str = Field(..., description="계산 결과 요약 문장")
    disclaimer: str = Field(
        "이 계산은 참고용 예상 근사값이며 실제 신고 금액과 다를 수 있습니다. "
        "공제·과세유형·업종별 세부 규정을 단순화했으므로 정확한 신고는 세무 전문가 또는 관련 기관 확인이 필요합니다.",
        description="법적 면책 고지 문구"
    )

class DailySalesInput(BaseModel):
    """일별 판매 기록 입력 스키마"""
    date: str = Field(..., description="매출 일자 (YYYY-MM-DD)")
    revenue: int = Field(..., description="매출액 (0 이상)")
    quantity: int = Field(..., description="판매량 (0 이상)")

class ForecastRequest(BaseModel):
    """판매 예측 요청 스키마 (sales_data 생략 시 DB에서 자동집계)"""
    target_date: str = Field(..., description="예측 대상 날짜 (YYYY-MM-DD)")
    sales_data: Optional[List[DailySalesInput]] = Field(
        None, description="최근 N일 판매 데이터 (직접 지정용). 생략 시 DB Sale 테이블에서 자동집계"
    )
    store_id: Optional[str] = Field(None, description="매장 식별자 (DB 자동집계 시 필터). 생략 시 전체")
    has_event: Optional[bool] = Field(False, description="이벤트 발생 여부 (예측 상향 보정)")
    engine: Optional[str] = Field("arima", description="예측 엔진 (arima | average)")

class ForecastResponse(BaseModel):
    """판매 예측 응답 스키마"""
    target_date: str = Field(..., description="예측 대상 날짜")
    predicted_sales: int = Field(..., description="예측 매출액")
    predicted_quantity: int = Field(..., description="예측 판매량")
    engine: str = Field("arima", description="사용된 예측 엔진 (arima | average)")
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
    """[한글 주석] 알바 스케줄 추천 요청 스키마 (특정 대상일 기준)"""
    target_date: str = Field(..., description="추천 대상 날짜 (YYYY-MM-DD)", examples=["2026-07-16"])
    store_id: str = Field(..., description="매장 식별 아이디", examples=["store_gildong"])

class HourlyRecommendation(BaseModel):
    """시간대별 추천 상세 스키마"""
    hour: int = Field(..., description="시간대 (0~23)", examples=[12])
    predicted_sales: int = Field(..., description="해당 시간 예상 매출액 (원)", examples=[150000])
    predicted_profit: int = Field(..., description="해당 시간 예상 이익액 (원)", examples=[100000])
    recommended_employee_count: int = Field(..., description="추천 근무 인원수 (명)", examples=[3])
    busy_level: str = Field(..., description="혼잡도 수준 (PEAK | HIGH | NORMAL | LOW)", examples=["PEAK"])
    assigned_employees: List[Dict[str, Any]] = Field(default_factory=list, description="해당 시간대 추천 배정 직원 목록 (id, name, level 등)")
    unassigned_count: int = Field(0, description="인원 부족으로 배정되지 못한 인원수")

class ScheduleRecommendationResponse(BaseModel):
    """[한글 주석] 알바 추천 스케줄 응답 스키마 (특정 대상일 기준)"""
    target_date: str = Field(..., description="추천 대상 날짜", examples=["2026-07-16"])
    hourly_recommendations: List[HourlyRecommendation] = Field(..., description="시간대별 분석 및 추천 내역")
    total_recommended_hours: float = Field(..., description="추천 스케줄에 따른 총 합산 근무 시간 (시간)", examples=[18.5])
    estimated_payroll_cost: int = Field(..., description="추천 스케줄 실행 시 예상 인건비 지출액 (원)", examples=[185000])
    warnings: List[str] = Field(default_factory=list, description="기피 시간 충돌 및 인원 부족 경고 메시지 목록")
    summary: str = Field(..., description="AI 요약 가이드라인 및 조언 문구", examples=["점심 피크타임인 12시~14시에 혼잡도가 높으므로 근무자를 집중 배치하세요."])


# ----------------------------------------------------
# 챗봇 / ERP 신규: 직원별 기피/불가 시간 Pydantic 스키마
# ----------------------------------------------------

class EmployeeUnavailabilityCreate(BaseModel):
    """직원 기피/불가 시간 등록 요청 스키마"""
    employee_id: int = Field(..., description="직원 고유 ID", examples=[1])
    unavailability_type: str = Field("weekly_recurring", description="기피 유형 (weekly_recurring 요일 반복 | specific_date 특정 날짜 지정)", examples=["weekly_recurring"])
    day_of_week: Optional[int] = Field(None, ge=0, le=6, description="요일 번호 (0=월, 1=화, ..., 6=일)", examples=[0])
    specific_date: Optional[str] = Field(None, description="특정 지정 날짜 (YYYY-MM-DD)", examples=["2026-07-25"])
    start_hour: int = Field(0, ge=0, le=23, description="기피 시작 시각 (0~23)", examples=[9])
    end_hour: int = Field(24, ge=1, le=24, description="기피 종료 시각 (1~24)", examples=[12])
    restriction_level: str = Field("hard", description="제약 수준 (hard 절대 불가 | soft 가급적 회피)", examples=["hard"])
    reason: Optional[str] = Field(None, description="기피/불가 사유", examples=["대학 수업"])

class EmployeeUnavailabilityResponse(BaseModel):
    """직원 기피/불가 시간 반환 스키마"""
    id: int = Field(..., description="기피 설정 고유 번호", examples=[1])
    employee_id: int = Field(..., description="직원 고유 ID", examples=[1])
    employee_name: Optional[str] = Field(None, description="직원 이름", examples=["홍길동"])
    unavailability_type: str = Field(..., description="기피 유형")
    day_of_week: Optional[int] = Field(None, description="요일 번호")
    specific_date: Optional[str] = Field(None, description="특정 지정 날짜")
    start_hour: int = Field(..., description="기피 시작 시각")
    end_hour: int = Field(..., description="기피 종료 시각")
    restriction_level: str = Field(..., description="제약 수준 (hard | soft)")
    reason: Optional[str] = Field(None, description="기피 사유")
    created_at: datetime = Field(..., description="등록 일시")

    class Config:
        from_attributes = True




