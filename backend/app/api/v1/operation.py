"""운영 API (백엔드 C 최초 작성 → 백엔드 B 인수)"""
from typing import List, Optional
from fastapi import APIRouter, Query, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.user import User
from app.models.operation import Employee, Schedule, EstimatedPayroll, EstimatedSettlement
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleUpdate, ScheduleResponse,
    PayrollResponse, PayrollListItem, SettlementResponse, SettlementListItem,
    TaxEstimateRequest, TaxEstimateResponse, ForecastRequest, ForecastResponse,
    RAGDocumentResponse, ReportSourceResponse, PayrollCalculateRequest, PayrollCalculateResponse,
    SettlementCalculateRequest, SettlementCalculateResponse,
    ScheduleRecommendationRequest, ScheduleRecommendationResponse,
    ExpenseCreate, ExpenseResponse,
    EmployeeUnavailabilityCreate, EmployeeUnavailabilityResponse
)
from app.schemas.bean_rag import BeanRAGChatRequest, BeanSearchRequest, BeanRAGChatResponse, BeanSearchResponse, ReindexResponse
from app.services.operation.operation_service import OperationService, EmployeeUnavailabilityService
from app.services.operation.tax_service import TaxService
from app.services.operation.forecasting_service import ForecastingService
from app.models.user import User

router = APIRouter(prefix="/operation", tags=["Operation"])

@router.post("/schedules", response_model=CommonResponse)
def create_schedule_api(payload: ScheduleCreate, db: Session = Depends(get_db)):
    """새로운 근무 계획 스케줄을 등록합니다."""
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="근무 시작 시간은 종료 시간보다 빨라야 합니다.")
    try:
        schedule = OperationService.create_schedule(
            db=db,
            employee_id=payload.employee_id,
            start_time=payload.start_time,
            end_time=payload.end_time
        )
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 등록이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.get("/schedules", response_model=CommonResponse)
def get_all_schedules_api(db: Session = Depends(get_db)):
    """등록된 모든 스케줄 일정을 조회합니다."""
    try:
        schedules = OperationService.get_schedules(db)
        data = [ScheduleResponse.model_validate(s) for s in schedules]
        return CommonResponse(success=True, data=data, message="스케줄 조회가 완료되었습니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/schedules/{schedule_id}", response_model=CommonResponse)
def get_schedule_api(schedule_id: int, db: Session = Depends(get_db)):
    """지정한 ID에 해당하는 특정 스케줄 일정을 단건 조회합니다."""
    try:
        schedule = OperationService.get_schedule_by_id(db, schedule_id)
        if not schedule:
            raise HTTPException(status_code=404, detail="존재하지 않는 스케줄 번호입니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 조회가 완료되었습니다."
        )
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/schedules/{schedule_id}", response_model=CommonResponse)
def update_schedule_api(schedule_id: int, payload: ScheduleUpdate, db: Session = Depends(get_db)):
    """스케줄 근무 시각 및 실제 출퇴근 시각을 수정(PATCH)합니다."""
    try:
        schedule = OperationService.update_schedule(db, schedule_id, payload)
        if not schedule:
            raise HTTPException(status_code=404, detail="수정할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 정보 수정이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.delete("/schedules/{schedule_id}", response_model=CommonResponse)
def delete_schedule_api(schedule_id: int, db: Session = Depends(get_db)):
    """특정 근무 스케줄 일정을 영구 삭제(Hard Delete)합니다."""
    try:
        success = OperationService.delete_schedule(db, schedule_id)
        if not success:
            raise HTTPException(status_code=404, detail="삭제할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(success=True, data=None, message="스케줄 정보가 성공적으로 삭제되었습니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/schedules/recommend", response_model=CommonResponse)
def recommend_schedule_api(payload: ScheduleRecommendationRequest, db: Session = Depends(get_db)):
    """실제 과거 매출 데이터를 시간대별로 분석하여 최적의 알바 근무 스케줄 추천안을 도출합니다."""
    try:
        recommendation_result = OperationService.recommend_schedule(
            db=db,
            period_start=payload.target_date,
            period_end=payload.target_date,
            store_id=payload.store_id
        )
        data = ScheduleRecommendationResponse(
            target_date=recommendation_result["target_date"],
            hourly_recommendations=recommendation_result["hourly_recommendations"],
            total_recommended_hours=recommendation_result["total_recommended_hours"],
            estimated_payroll_cost=recommendation_result["estimated_payroll_cost"],
            warnings=recommendation_result.get("warnings", []),
            summary=recommendation_result["summary"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="스케줄 추천 연산이 완료되었습니다."
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# ----------------------------------------------------
# 챗봇 / ERP 신규: 직원별 기피/불가 시간 API 엔드포인트
# ----------------------------------------------------

@router.post("/unavailability", response_model=CommonResponse)
def create_unavailability_api(payload: EmployeeUnavailabilityCreate, db: Session = Depends(get_db)):
    """직원의 기피/불가 시간(Hard/Soft)을 신규 등록합니다."""
    try:
        unav = EmployeeUnavailabilityService.create_unavailability(db, payload)
        return CommonResponse(
            success=True,
            data=EmployeeUnavailabilityResponse.model_validate(unav),
            message="직원 기피/불가 시간 등록이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.get("/unavailability", response_model=CommonResponse)
def list_unavailabilities_api(
    employee_id: Optional[int] = Query(None, description="특정 직원만 조회할 직원 ID (생략 시 전체)"),
    db: Session = Depends(get_db)
):
    """등록된 직원 기피/불가 시간 목록을 조회합니다."""
    try:
        rows = EmployeeUnavailabilityService.get_unavailabilities(db, employee_id)
        name_map = {e.id: e.name for e in db.query(Employee).all()}
        data = []
        for unav in rows:
            item = EmployeeUnavailabilityResponse.model_validate(unav)
            item.employee_name = name_map.get(unav.employee_id)
            data.append(item)
        return CommonResponse(
            success=True,
            data=data,
            message="직원 기피/불가 시간 목록 조회가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.delete("/unavailability/{unavailability_id}", response_model=CommonResponse)
def delete_unavailability_api(unavailability_id: int, db: Session = Depends(get_db)):
    """등록된 직원 기피/불가 시간 설정을 삭제합니다."""
    try:
        deleted = EmployeeUnavailabilityService.delete_unavailability(db, unavailability_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"존재하지 않는 기피 시간 ID입니다: {unavailability_id}")
        return CommonResponse(
            success=True,
            data=None,
            message="직원 기피/불가 시간 삭제가 완료되었습니다."
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.get("/settlements/estimated", response_model=CommonResponse)
def get_estimated_settlements_api(
    period_start: Optional[str] = Query(None, description="조회 시작일 (YYYY-MM-DD)"),
    period_end: Optional[str] = Query(None, description="조회 종료일 (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
):
    """데이터베이스에 저장되어 있는 매장의 기간별 예상 정산 결과들을 조회합니다."""
    try:
        query = db.query(EstimatedSettlement)
        if period_start:
            query = query.filter(EstimatedSettlement.period_start >= period_start)
        if period_end:
            query = query.filter(EstimatedSettlement.period_end <= period_end)
            
        results = query.all()
        data_list = []
        for r in results:
            data_list.append(
                SettlementListItem(
                    id=r.id,
                    period_start=r.period_start,
                    period_end=r.period_end,
                    total_sales=r.total_sales,
                    total_expense=r.total_expense,
                    total_payroll=r.total_payroll,
                    net_profit=r.net_profit
                )
            )
        return CommonResponse(success=True, data=data_list, message="저장된 예상 정산 목록 조회가 완료되었습니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# --- [지출(Expense) 관리] ---

@router.post("/expenses", response_model=CommonResponse)
def create_expense_api(
    payload: ExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """새 지출(비용) 내역을 등록합니다. (정산·세무의 비용 데이터 소스)"""
    try:
        expense = OperationService.create_expense(
            db=db,
            store_id=current_user.email,
            amount=payload.amount,
            category=payload.category,
            expense_date=payload.expense_date,
            description=payload.description,
        )
        return CommonResponse(
            success=True,
            data=ExpenseResponse.model_validate(expense),
            message="지출 내역 등록이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/expenses", response_model=CommonResponse)
def get_expenses_api(
    year_month: Optional[str] = Query(None, description="조회 대상 연월 (YYYY-MM). 생략 시 전체"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """등록된 지출(비용) 내역을 조회합니다. (해당 매장 기준)"""
    try:
        expenses = OperationService.get_expenses(db, year_month=year_month, store_id=current_user.email)
        data = [ExpenseResponse.model_validate(e) for e in expenses]
        return CommonResponse(success=True, data=data, message="지출 내역 조회가 완료되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")


# --- [세무 계산] ---

@router.get("/tax/estimate", response_model=CommonResponse)
def estimate_tax_api(
    year_month: str = Query(..., description="대상 연월 (YYYY-MM)"),
    tax_type: str = Query("general", description="과세유형 (general 일반 | simplified 간이)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """DB의 매출·비용·인건비를 자동집계해 부가세+종소세+원천징수 예상 세금을 계산합니다."""
    try:
        result = TaxService.estimate_taxes(db, year_month, tax_type=tax_type, store_id=None)
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/tax/estimate", response_model=CommonResponse)
def estimate_tax_manual_api(payload: TaxEstimateRequest):
    """매출·비용을 직접 입력받아 부가세+종소세를 계산합니다. (수동/일회성)"""
    try:
        result = TaxService.estimate_from_amounts(
            total_revenue=payload.total_revenue,
            total_expense=payload.total_expense,
            period=payload.period,
            tax_type=payload.tax_type,
        )
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/forecast/sales", response_model=CommonResponse)
def get_sales_forecast_api(payload: ForecastRequest, db: Session = Depends(get_db)):
    """미래 일자의 판매량·매출액을 예측합니다. (sales_data 생략 시 DB 자동집계, ARIMA 기본)"""
    try:
        result = ForecastingService.forecast_sales(
            target_date=payload.target_date,
            sales_data=payload.sales_data,
            db=db,
            store_id=payload.store_id,
            has_event=payload.has_event,
            engine=payload.engine or "arima",
        )
        data = ForecastResponse(**result)
        return CommonResponse(
            success=True,
            data=data,
            message="판매 예측 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/rag/documents", response_model=CommonResponse)
def get_rag_documents_api(payload: dict):
    """세무 계산 결과 및 판매 예측 데이터를 RAG 탐색기가 해독하기 쉬운 문서 형식으로 일괄 변환합니다."""
    try:
        rag_documents = []
        
        # 세무 결과 파싱 및 RAG 문서화
        tax_data = payload.get("tax_result")
        if tax_data:
            tax_doc = OperationService.build_tax_rag_documents(tax_data)
            rag_documents.append(RAGDocumentResponse(**tax_doc))
            
        # 판매 예측 결과 파싱 및 RAG 문서화
        forecast_data = payload.get("forecast_result")
        if forecast_data:
            forecast_doc = OperationService.build_forecast_rag_documents(forecast_data)
            rag_documents.append(RAGDocumentResponse(**forecast_doc))
            
        return CommonResponse(
            success=True,
            data=rag_documents,
            message="RAG 문서 변환이 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"RAG 문서 가공 실패: {str(e)}"
        )

@router.get("/report-source", response_model=CommonResponse)
def get_report_source_api(period: str = Query("weekly", description="리포트 기준 기간 (daily, weekly, monthly)")):
    """백엔드 B 및 챗봇 리포트엔진을 위해 자연어로 작성된 운영 요약 리포트 원천을 조회합니다."""
    try:
        report_data = OperationService.build_report_source_documents(period)
        data = ReportSourceResponse(
            period=report_data["period"],
            hourly_rate=payload.hourly_rate,
            weekly_work_hours=payload.weekly_work_hours,
            include_weekly_holiday=payload.include_weekly_holiday,
            deduct_tax=payload.deduct_tax
        )
        response_payload = PayrollCalculateResponse(**result)
        return CommonResponse(
            success=True,
            data=response_payload.model_dump(),
            message="예상 급여 계산이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/tax/estimate", response_model=CommonResponse)
def estimate_tax_api(
    year_month: str = Query(..., description="대상 연월 (YYYY-MM)"),
    tax_type: str = Query("general", description="과세유형 (general 일반 | simplified 간이)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # DB의 매출 비용 인건비를 자동집계해 부가세 종소세 원천징수 예상 세금을 계산합니다.
    try:
        result = TaxService.estimate_taxes(db, year_month, tax_type=tax_type, store_id=None)
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/tax/estimate", response_model=CommonResponse)
def estimate_tax_manual_api(payload: TaxEstimateRequest):
    # 매출 비용을 직접 입력받아 부가세 종소세를 계산합니다.

    try:
        result = TaxService.estimate_from_amounts(
            total_revenue=payload.total_revenue,
            total_expense=payload.total_expense,
            period=payload.period,
            tax_type=payload.tax_type,
        )
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/forecast/sales", response_model=CommonResponse)
def get_sales_forecast_api(payload: ForecastRequest, db: Session = Depends(get_db)):
    # 미래 일자의 판매량·매출액을 예측합니다. (sales_data 생략 시 DB 자동집계, ARIMA 기본)

    try:
        result = ForecastingService.forecast_sales(
            target_date=payload.target_date,
            sales_data=payload.sales_data,
            db=db,
            store_id=payload.store_id,
            has_event=payload.has_event,
            engine=payload.engine or "arima",
        )
        data = ForecastResponse(**result)
        return CommonResponse(
            success=True,
            data=data,
            message="판매 예측 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/rag/documents", response_model=CommonResponse)
def get_rag_documents_api(payload: dict):
    """세무 계산 결과 및 판매 예측 데이터를 RAG 탐색기가 해독하기 쉬운 문서 형식으로 일괄 변환합니다."""
    try:
        rag_documents = []
        
        # 세무 결과 파싱 및 RAG 문서화
        tax_data = payload.get("tax_result")
        if tax_data:
            tax_doc = OperationService.build_tax_rag_documents(tax_data)
            rag_documents.append(RAGDocumentResponse(**tax_doc))
            
        # 판매 예측 결과 파싱 및 RAG 문서화
        forecast_data = payload.get("forecast_result")
        if forecast_data:
            forecast_doc = OperationService.build_forecast_rag_documents(forecast_data)
            rag_documents.append(RAGDocumentResponse(**forecast_doc))
            
        return CommonResponse(
            success=True,
            data=rag_documents,
            message="RAG 문서 변환이 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"RAG 문서 가공 실패: {str(e)}"
        )

@router.get("/report-source", response_model=CommonResponse)
def get_report_source_api(period: str = Query("weekly", description="리포트 기준 기간 (daily, weekly, monthly)")):
    # 백엔드 B 및 챗봇 리포트엔진을 위해 자연어로 작성된 운영 요약 리포트 원천을 조회합니다.

    try:
        report_data = OperationService.build_report_source_documents(period)
        data = ReportSourceResponse(
            period=report_data["period"],
            sales_summary=report_data["sales_summary"],
            payroll_summary=report_data["payroll_summary"],
            tax_summary=report_data["tax_summary"],
            forecast_summary=report_data["forecast_summary"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="리포트 소스 조회가 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=str(e)
        )


# --- [5. Square POS 연동 및 재고 자동 차감 API] ---

@router.post("/pos/sync", response_model=CommonResponse)
async def sync_pos_data_api(
    hours: int = Query(24, description="동기화할 최근 시간 범위 (기본 24시간)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # [Square POS 데이터 동기화 및 실시간 재고 차감]

    try:
        from app.services._pos import sync_pos_to_sales
        result = await sync_pos_to_sales(db=db, store_id=current_user.email, hours=hours)
        return CommonResponse(
            success=True,
            data=result,
            message="POS 데이터 및 실시간 재고 차감 동기화가 정상 완료되었습니다!"
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"POS 동기화 실패: {str(e)}"
        )


# --- [6. 예상 급여 및 예상 손익 정산 계산 API (MVP)] ---

@router.post("/payroll/calculate", response_model=CommonResponse, summary="예상 급여 계산 (MVP + 옵션 A/B)")
def calculate_payroll_api(payload: PayrollCalculateRequest):
    # [예상 급여 계산 API]

    try:
        result = OperationService.calculate_payroll(
            start_time=payload.start_time,
            end_time=payload.end_time,
            break_minutes=payload.break_minutes,
            hourly_rate=payload.hourly_rate,
            weekly_work_hours=payload.weekly_work_hours,
            include_weekly_holiday=payload.include_weekly_holiday,
            deduct_tax=payload.deduct_tax
        )
        response_payload = PayrollCalculateResponse(**result)
        return CommonResponse(
            success=True,
            data=response_payload.model_dump(),
            message="예상 급여 계산이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류가 발생했습니다: {str(e)}")


@router.get("/payroll/all", response_model=CommonResponse, summary="전체 직원 월별 예상 급여 목록")
def list_all_payroll_api(
    year_month: str = Query(..., description="조회 대상 연월 (YYYY-MM)"),
    db: Session = Depends(get_db)
):
    """등록된 모든 직원의 해당 월 예상 급여 목록을 조회합니다. (해당 월 스케줄이 없는 직원은 제외)"""
    import re
    if not re.fullmatch(r"\d{4}-\d{2}", year_month):
        raise HTTPException(status_code=400, detail="year_month는 YYYY-MM 형식이어야 합니다.")
    try:
        results = OperationService.list_employees_payroll(db, year_month)
        return CommonResponse(
            success=True,
            data=results,
            message="전체 직원 예상 급여 목록 조회가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.post("/settlements/calculate", response_model=CommonResponse, summary="예상 손익 정산 계산 (MVP)")
def calculate_settlement_api(payload: SettlementCalculateRequest, db: Session = Depends(get_db)):
    # [예상 손익 정산 계산 API]

    try:
        revenue = payload.revenue
        cost = payload.cost
        labor_cost = payload.labor_cost
        other_expense = payload.other_expense or 0

        # [한글 주석: 프론트엔드 모바일 앱이 기간 정보를 꽂아 보냈다면, DB에서 일체 실시간 집계를 수행합니다]
        if payload.period_start and payload.period_end:
            from datetime import datetime, timedelta
            from sqlalchemy import func
            from app.models.inventory import Sale
            from app.models.operation import Expense
            
            # 1. 날짜 경계선 파싱 (마지막 날 23:59:59 누락을 막기 위해 종료일의 익일 0시 미만으로 안전하게 검색)
            try:
                p_start_dt = datetime.strptime(payload.period_start, "%Y-%m-%d")
                p_end_dt = datetime.strptime(payload.period_end, "%Y-%m-%d") + timedelta(days=1)
            except ValueError:
                raise HTTPException(status_code=400, detail="날짜 포맷은 YYYY-MM-DD 형식이어야 합니다.")

            # 2. 지정 기간 총 매출(Sale) 자동 집계
            sales_sum = db.query(func.sum(Sale.total_price)).filter(
                Sale.sold_at >= p_start_dt,
                Sale.sold_at < p_end_dt
            ).scalar()
            revenue = int(sales_sum or 0)

            # 3. 지정 기간 총 지출 비용(Expense) 자동 집계
            expense_sum = db.query(func.sum(Expense.amount)).filter(
                Expense.expense_date >= payload.period_start,
                Expense.expense_date <= payload.period_end
            ).scalar()
            cost = int(expense_sum or 0)

            # 4. 지정 월 총 인건비(labor_cost) 자동 집계 (소속 직원들의 예상 급여 연산액 합산)
            # period_start 문자열로부터 해당 연월(YYYY-MM)을 추출하여 급여 집계를 돌립니다.
            year_month = payload.period_start[:7]
            employees_payroll = OperationService.list_employees_payroll(db, year_month)
            labor_cost = sum(payroll.get("estimated_salary", 0) for payroll in employees_payroll)

        # [한글 주석: 두 경로 모두 유효 데이터가 확보되지 않았다면 에러를 리턴합니다]
        if revenue is None or cost is None or labor_cost is None:
            raise HTTPException(
                status_code=422,
                detail="수동 정산용 매출/비용/인건비 정보 또는 실시간 집계용 기간 정보(period_start/end)를 입력해 주세요."
            )

        result = OperationService.calculate_settlement(
            revenue=revenue,
            cost=cost,
            labor_cost=labor_cost,
            other_expense=other_expense
        )
        response_payload = SettlementCalculateResponse(**result)
        data = response_payload.model_dump()
        # 프론트 정산 카드가 쓰는 total_* 네이밍 호환 필드 (settlements/estimated 목록과 동일 규격)
        data.update({
            "total_sales": data["revenue"],
            "total_expense": data["cost"],
            "total_payroll": data["labor_cost"],
            "net_profit": data["estimated_profit"],
            "year_month": (payload.period_start or "")[:7] or None,
            "period_start": payload.period_start,
            "period_end": payload.period_end,
        })
        return CommonResponse(
            success=True,
            data=data,
            message="예상 정산 결과 계산이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류가 발생했습니다: {str(e)}")


# --- [7. 법령 검색 RAG (Law RAG) 실서비스 API] ---

@router.get("/law-rag/search", response_model=CommonResponse, summary="법령 RAG 의미 기반 하이브리드 검색 API")
def search_law_rag_api(
    keyword: str = Query(..., description="검색 키워드 또는 사용자 질문 (예: '알바 휴게시간 몇 분 줘야 해?')"),
    category: Optional[str] = Query(None, description="법령 카테고리 필터 (예: '근로기준', '최저임금', '임대차')"),
    top_k: int = Query(5, description="반환할 조문 최대 개수")
):
    # [법령 RAG 하이브리드 검색 API]
    try:
        from app.services.operation.law_rag_service import LawRAGService
        results = LawRAGService.search_law_documents(
            query=keyword,
            category=category,
            top_k=top_k
        )
        message = f"'{keyword}' 관련 법령 조문 {len(results)}건 조회가 완료되었습니다." if results else f"'{keyword}'에 대한 관련 법령 정보가 부족합니다."
        return CommonResponse(
            success=True,
            data=results,
            message=message
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"법령 RAG 검색 중 오류 발생: {str(e)}")


@router.post("/law-rag/index", response_model=CommonResponse, summary="법령 원문 조문 정제 및 ChromaDB 인덱싱/동기화 API")
def index_law_rag_api(raw_data: Optional[List[dict]] = None):
    # [법령 데이터 적재 및 동기화 API]

    try:
        from app.services.operation.law_rag_service import LawRAGService
        
        # 입력 데이터가 없으면 샘플 데이터 활용
        if not raw_data:
            raw_data = [
                {
                    "law_name": "근로기준법",
                    "article_no": "제54조(휴게)",
                    "category": "근로기준",
                    "content": "사용자는 근로시간이 4시간인 경우에는 30분 이상, 8시간인 경우에는 1시간 이상의 휴게시간을 근로시간 도중에 주어야 한다.",
                    "summary": "근로시간 4시간당 30분, 8시간당 1시간 휴게시간 부여 의무",
                    "source": "국가법령정보센터 (https://www.law.go.kr)",
                    "effective_date": "2026-01-01"
                },
                {
                    "law_name": "근로기준법",
                    "article_no": "제56조(연장·야간 및 휴일 가산수당)",
                    "category": "근로기준",
                    "content": "사용자는 야간근로(오후 10시부터 다음 날 오전 6시 사이의 근로)에 대하여는 통상임금의 100분의 50 이상을 가산하여 근로자에게 지급하여야 한다.",
                    "summary": "오후 10시~오전 6시 야간근로 시 50% 가산수당 지급",
                    "source": "국가법령정보센터 (https://www.law.go.kr)",
                    "effective_date": "2026-01-01"
                },
                {
                    "law_name": "최저임금법",
                    "article_no": "제6조(최저임금의 효력)",
                    "category": "최저임금",
                    "content": "사용자는 최저임금의 적용을 받는 근로자에게 최저임금액 이상의 임금을 지급하여야 한다.",
                    "summary": "최저임금액 이상 지급 의무 및 미달 계약 부분 무효",
                    "source": "국가법령정보센터 (https://www.law.go.kr)",
                    "effective_date": "2026-01-01"
                },
                {
                    "law_name": "상가건물 임대차보호법",
                    "article_no": "제10조(계약갱신 요구 등)",
                    "category": "임대차",
                    "content": "임대인은 임차인이 임대차기간 만료 6개월 전부터 1개월 전까지 사이에 계약갱신을 요구할 경우 정당한 사유 없이 거절하지 못한다. 계약갱신요구권은 10년을 초과하지 아니하는 범위에서 행사할 수 있다.",
                    "summary": "상가 임차인의 10년 범위 내 계약갱신요구권 보장",
                    "source": "국가법령정보센터 (https://www.law.go.kr)",
                    "effective_date": "2026-01-01"
                }
            ]

        result = LawRAGService.sync_law_documents(raw_data)
        return CommonResponse(
            success=True,
            data=result,
            message="법령 데이터 적재 및 ChromaDB 동기화가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"법령 데이터 적재 중 오류 발생: {str(e)}")


@router.get("/law-rag/status", response_model=CommonResponse, summary="ChromaDB 법령 컬렉션 상태 및 통계 조회 API")
def get_law_rag_status_api():
    # [ChromaDB 컬렉션 상태 조회 API]

    try:
        from app.services.operation.law_rag_service import LawRAGService
        stats = LawRAGService.get_collection_stats()
        return CommonResponse(
            success=True,
            data=stats,
            message="법령 RAG 컬렉션 상태 조회가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"컬렉션 상태 조회 중 오류 발생: {str(e)}")


# ----------------------------------------------------
# 원두 추천/리뷰 실데이터 파이프라인 & RAG 고도화 API 엔드포인트
# ----------------------------------------------------

@router.post("/beans/seed-import", response_model=CommonResponse, summary="원두 시드 데이터(JSON/CSV) 일괄 적재 API")
def import_bean_seed_api(
    beans_file: Optional[str] = Query(None, description="원두 시드 파일 경로 (.json 또는 .csv)"),
    db: Session = Depends(get_db)
):
    # [원두 시드 일괄 적재 API]
    try:
        from app.services.operation.seed_service import import_seed_roasteries_and_beans
        res = import_seed_roasteries_and_beans(db, beans_file=beans_file)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "원두 시드 데이터 적재 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"시드 적재 중 오류 발생: {str(e)}")


@router.post("/beans/collect", response_model=CommonResponse, summary="원두 판매처·가격 및 리뷰 외부 수집 파이프라인 API")
def collect_beans_data_api(db: Session = Depends(get_db)):
    # [원두 실데이터 수집 파이프라인 API]
    try:
        from app.services.operation.bean_collection_service import run_collection_pipeline_for_all_beans
        res = run_collection_pipeline_for_all_beans(db)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "원두 데이터 수집 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"데이터 수집 파이프라인 실행 중 오류 발생: {str(e)}")


@router.post("/beans/aggregate-reviews", response_model=CommonResponse, summary="원두 리뷰 평점/감성/키워드 집계 스냅샷 갱신 API")
def aggregate_bean_reviews_api(db: Session = Depends(get_db)):
    # [원두 리뷰 집계 스냅샷 갱신 API]
    try:
        from app.services.operation.bean_review_service import update_all_bean_review_summaries
        res = update_all_bean_review_summaries(db)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "리뷰 집계 스냅샷 갱신 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"리뷰 집계 스냅샷 갱신 중 오류 발생: {str(e)}")


@router.post("/beans/index-vectorstore", response_model=CommonResponse, summary="ChromaDB 벡터스토어 리뷰/속성 전체/증분 색인 API")
def index_beans_vectorstore_api(
    full_reindex: bool = Query(False, description="True 설정 시 전체 초기 색인, False 설정 시 증분 색인"),
    db: Session = Depends(get_db)
):
    # [ChromaDB 벡터스토어 색인 API] 쌓인 리뷰 및 원두 속성을 ChromaDB에 색인합니다.

    try:
        from app.services.operation.bean_review_service import index_reviews_to_chromadb
        res = index_reviews_to_chromadb(db, full_reindex=full_reindex)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "ChromaDB 색인 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ChromaDB 색인 중 오류 발생: {str(e)}")


# ----------------------------------------------------
# 원두 챗봇 RAG 고도화 신규 API 엔드포인트
# ----------------------------------------------------

@router.post("/beans/chat", response_model=CommonResponse, summary="원두 챗봇 RAG 자연어 질의응답 (Grounded 답변+근거+신뢰도) API")
def bean_rag_chat_api(
    payload: BeanRAGChatRequest,
    db: Session = Depends(get_db)
):
    # [원두 챗봇 RAG 자연어 답변 API] 하이브리드 검색 및 Gemini LLM 근거 기반 답변, Grounding, Confidence 반환
    try:
        from app.services.operation.bean_rag_service import generate_grounded_answer_service
        res = generate_grounded_answer_service(db, payload)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message="원두 RAG 답변 생성이 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 RAG 답변 생성 실패: {str(e)}")


@router.post("/beans/search", response_model=CommonResponse, summary="원두 하이브리드 검색 Top-K 결과 반환 API")
def bean_hybrid_search_api(
    payload: BeanSearchRequest,
    db: Session = Depends(get_db)
):
    # [원두 하이브리드 검색 API] 가중합 점수(유사도 50% + 속성 30% + 신뢰도 20%) 하이브리드 검색
    try:
        from app.services.operation.bean_rag_service import hybrid_bean_search_service
        res = hybrid_bean_search_service(db, payload)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"원두 하이브리드 검색 완료 ({res.total_count}건)"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 하이브리드 검색 실패: {str(e)}")




@router.post("/rag/reindex", response_model=CommonResponse, summary="collected_at 시각 기준 원두 리뷰 증분 색인 API")
def trigger_incremental_reindex_api(
    full_reindex: bool = Query(False, description="True 설정 시 전체 재색인, False 설정 시 증분 색인"),
    db: Session = Depends(get_db)
):
    # [증분 색인 트리거 API] collected_at 기준 신규 수집된 리뷰만 선택하여 고정된 임베딩 모델로 벡터스토어에 증분 임베딩 수행
    try:
        from app.services.operation.bean_rag_service import incremental_reindex_service
        res = incremental_reindex_service(db, full_reindex=full_reindex)
        return CommonResponse(
            success=res.success,
            data=res.model_dump(),
            message=res.message
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"증분 색인 실행 실패: {str(e)}")


# ----------------------------------------------------
# 상품 검색·정렬·오퍼·사전수집 신규 API 엔드포인트
# ----------------------------------------------------

@router.get("/products/search", response_model=CommonResponse, summary="상품 검색·정렬·필터·대체추천 통합 API")
def search_products_api(
    q: Optional[str] = Query(None, description="검색 키워드"),
    sort: str = Query("price_asc", description="정렬 방식 (price_asc 최저가 | price_desc | review_count | relevance)"),
    order: str = Query("asc", description="정렬 차순"),
    min_price: Optional[int] = Query(None, description="최소 가격"),
    max_price: Optional[int] = Query(None, description="최대 가격"),
    in_stock: Optional[bool] = Query(None, description="재고 보유 상품만 조회"),
    source_site: Optional[str] = Query(None, description="판매처 필터"),
    min_rating: Optional[float] = Query(None, description="최소 평점"),
    page: int = Query(1, ge=1, description="페이지 번호"),
    page_size: int = Query(10, ge=1, le=100, description="페이지 당 개수"),
    db: Session = Depends(get_db)
):
    # [상품 검색·정렬·대체추천 API]
    try:
        from app.schemas.product_search import ProductSearchQuery
        from app.services.operation.product_search_service import search_products_service

        query_params = ProductSearchQuery(
            q=q,
            sort=sort,
            order=order,
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock,
            source_site=source_site,
            min_rating=min_rating,
            page=page,
            page_size=page_size
        )
        res = search_products_service(db, query_params)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"상품 검색 완료 ({res.total_count}건)"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"상품 검색 실패: {str(e)}")


@router.get("/beans/{id}/offers", response_model=CommonResponse, summary="특정 원두 판매처별 오퍼 및 최저가 조회 API")
def get_bean_offers_api(
    id: int,
    sort: str = Query("price", description="정렬 방식 (price 최저가 | review 리뷰순)"),
    db: Session = Depends(get_db)
):
    # [원두 오퍼/최저가 조회 API]
    try:
        from app.services.operation.product_search_service import get_bean_offers_service
        res = get_bean_offers_service(db, bean_id=id, sort=sort)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"'{res.bean_name}' 오퍼 조회가 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 오퍼 조회 실패: {str(e)}")


@router.post("/products/prefetch", response_model=CommonResponse, summary="사전 수집 큐 등록 및 오래된 시세 캐시 갱신 API")
def prefetch_products_api(
    payload: Optional[dict] = None,
    db: Session = Depends(get_db)
):
    # [사전 수집 및 캐시 갱신 API]
    try:
        from app.schemas.product_search import PrefetchRequest
        from app.services.operation.product_search_service import prefetch_and_refresh_cache_service

        req = PrefetchRequest(**payload) if payload else PrefetchRequest()
        res = prefetch_and_refresh_cache_service(db, req)
        return CommonResponse(
            success=res.success,
            data=res.model_dump(),
            message=res.message
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"사전 수집 처리 실패: {str(e)}")



