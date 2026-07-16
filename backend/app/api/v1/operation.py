"""운영 API (백엔드 C 최초 작성 → 백엔드 B 인수)"""
from typing import Optional
from fastapi import APIRouter, Query, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.user import User
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleUpdate, ScheduleResponse,
    SettlementResponse, TaxEstimateRequest, TaxEstimateResponse,
    ForecastRequest, ForecastResponse, RAGDocumentResponse, ReportSourceResponse,
    PayrollCalculateRequest, SettlementCalculateRequest,
    ExpenseCreate, ExpenseResponse
)
from app.services.operation.operation_service import OperationService
from app.services.operation.tax_service import TaxService
from app.services.operation.forecasting_service import ForecastingService

router = APIRouter(prefix="/operation", tags=["Operation"])

@router.post("/schedules", response_model=CommonResponse)
def create_schedule_api(payload: ScheduleCreate, db: Session = Depends(get_db)):
    """새로운 근무 계획 스케줄을 등록합니다."""
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
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/schedules", response_model=CommonResponse)
def get_all_schedules_api(db: Session = Depends(get_db)):
    """등록된 모든 스케줄 일정을 조회합니다."""
    try:
        schedules = OperationService.get_all_schedules(db)
        data = [ScheduleResponse.model_validate(s) for s in schedules]
        return CommonResponse(success=True, data=data, message="스케줄 조회가 완료되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.get("/schedules/{schedule_id}", response_model=CommonResponse)
def get_schedule_api(schedule_id: int, db: Session = Depends(get_db)):
    """지정한 ID에 해당하는 특정 스케줄 일정을 단건 조회합니다."""
    try:
        schedule = OperationService.get_schedule(db, schedule_id)
        if not schedule:
            return CommonResponse(success=False, data=None, message="존재하지 않는 스케줄 번호입니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 조회가 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.patch("/schedules/{schedule_id}", response_model=CommonResponse)
def update_schedule_api(schedule_id: int, payload: ScheduleUpdate, db: Session = Depends(get_db)):
    """스케줄 근무 시각 및 실제 출퇴근 시각을 수정(PATCH)합니다."""
    try:
        schedule = OperationService.update_schedule(db, schedule_id, payload)
        if not schedule:
            return CommonResponse(success=False, data=None, message="수정할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 정보 수정이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.delete("/schedules/{schedule_id}", response_model=CommonResponse)
def delete_schedule_api(schedule_id: int, db: Session = Depends(get_db)):
    """특정 근무 스케줄 일정을 영구 삭제(Hard Delete)합니다."""
    try:
        success = OperationService.delete_schedule(db, schedule_id)
        if not success:
            return CommonResponse(success=False, data=None, message="삭제할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(success=True, data=None, message="스케줄 정보가 성공적으로 삭제되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.post("/payroll/calculate", response_model=CommonResponse)
def calculate_payroll_api(payload: PayrollCalculateRequest, db: Session = Depends(get_db)):
    """특정 직원의 지정 연월에 대한 예상 급여(주휴수당 포함)를 계산합니다."""
    try:
        payroll_result = OperationService.calculate_payroll(db, payload.employee_id, payload.year_month)
        return CommonResponse(success=True, data=payroll_result, message="예상 급여 계산이 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/payroll", response_model=CommonResponse)
def get_payroll_api(
    employee_id: int = Query(..., description="직원 고유 번호"),
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)"),
    db: Session = Depends(get_db)
):
    """지정 연월에 대한 특정 직원의 예상 급여 조회 결과를 불러옵니다."""
    try:
        payroll_result = OperationService.calculate_payroll(db, employee_id, year_month)
        return CommonResponse(success=True, data=payroll_result, message="예상 급여 조회가 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/payroll/all", response_model=CommonResponse)
def get_all_payroll_api(
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)"),
    db: Session = Depends(get_db)
):
    """등록된 모든 직원의 해당 월 예상 급여 목록을 조회합니다."""
    try:
        results = OperationService.list_employees_payroll(db, year_month)
        return CommonResponse(success=True, data=results, message="직원별 예상 급여 조회가 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/settlements/calculate", response_model=CommonResponse)
def calculate_settlement_api(payload: SettlementCalculateRequest, db: Session = Depends(get_db)):
    """지정 연월에 대한 매장의 예상 손익 정산을 계산합니다."""
    try:
        settlement_result = OperationService.calculate_settlement(db, payload.year_month)
        data = SettlementResponse(
            year_month=settlement_result["year_month"],
            total_sales=settlement_result["total_sales"],
            total_expense=settlement_result["total_expense"],
            total_payroll=settlement_result["total_payroll"],
            net_profit=settlement_result["net_profit"],
            calculated_at=settlement_result["calculated_at"]
        )
        return CommonResponse(success=True, data=data, message="예상 정산 계산이 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/settlements", response_model=CommonResponse)
def get_settlements_api(
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)"),
    db: Session = Depends(get_db)
):
    """지정 연월에 대한 매장의 정산 내역 분석안을 조회합니다."""
    try:
        settlement_result = OperationService.calculate_settlement(db, year_month)
        data = SettlementResponse(
            year_month=settlement_result["year_month"],
            total_sales=settlement_result["total_sales"],
            total_expense=settlement_result["total_expense"],
            total_payroll=settlement_result["total_payroll"],
            net_profit=settlement_result["net_profit"],
            calculated_at=settlement_result["calculated_at"]
        )
        return CommonResponse(success=True, data=data, message="정산 내역 조회가 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

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
        # store_id=None → 정산(settlement)과 동일하게 전체 매장 기준 집계
        # (매장별 스코프가 필요하면 store_id=current_user.email 로 교체)
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

# --- [판매 예측] ---

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
    """
    [Square POS 데이터 동기화 및 실시간 재고 차감]
    최근 N시간 동안 발생한 Square POS 주문을 수집하여 매출 기록을 생성하고,
    등록된 메뉴 레시피 소요량만큼 실시간 재고에서 자동차감 및 이력을 남깁니다.
    """
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





