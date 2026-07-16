"""운영 API (백엔드 C)"""
from typing import List, Optional
from fastapi import APIRouter, Query, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.operation import Employee, Schedule, EstimatedPayroll, EstimatedSettlement
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleUpdate, ScheduleResponse,
    PayrollResponse, PayrollListItem, SettlementResponse, SettlementListItem,
    TaxEstimateRequest, TaxEstimateResponse, ForecastRequest, ForecastResponse,
    RAGDocumentResponse, ReportSourceResponse, PayrollCalculateRequest, SettlementCalculateRequest,
    ScheduleRecommendationRequest, ScheduleRecommendationResponse
)
from app.services.operation.operation_service import OperationService
from app.services.operation.tax_service import TaxService
from app.services.operation.forecasting_service import ForecastingService

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
    """실제 과거 매출 데이터를 기간별로 집계하고 분석하여 시간대별 알바 근무 인원 스케줄 추천안을 도출합니다."""
    try:
        recommendation_result = OperationService.recommend_schedule(
            db=db,
            period_start=payload.period_start,
            period_end=payload.period_end,
            store_id=payload.store_id
        )
        return CommonResponse(
            success=True,
            data=ScheduleRecommendationResponse.model_validate(recommendation_result),
            message="스케줄 추천 연산이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.post("/payroll/calculate", response_model=CommonResponse)
def calculate_payroll_api(payload: PayrollCalculateRequest, db: Session = Depends(get_db)):
    """특정 직원의 지정 기간 내 스케줄을 조회하여 실근무시간(휴게시간 공제 적용 가능) 기반의 예상 급여를 자동 계산하고 저장합니다."""
    try:
        payroll_result = OperationService.calculate_payroll(
            db=db,
            employee_id=payload.employee_id,
            period_start=payload.period_start,
            period_end=payload.period_end,
            deduct_break_time=payload.deduct_break_time
        )
        data = PayrollResponse.model_validate(payroll_result)
        return CommonResponse(success=True, data=data, message="예상 급여 계산 및 저장이 완료되었습니다.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.get("/payroll", response_model=CommonResponse)
def get_payroll_api(
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)"),
    employee_id: Optional[int] = Query(None, description="직원 고유 번호 필터"),
    db: Session = Depends(get_db)
):
    """지정 연월에 대한 직원들의 예상 급여 목록을 조회합니다."""
    try:
        from app.models.operation import Employee
        
        if employee_id is not None:
            employees = db.query(Employee).filter(Employee.id == employee_id).all()
            if not employees:
                raise HTTPException(status_code=404, detail=f"존재하지 않는 직원 ID입니다: {employee_id}")
        else:
            employees = db.query(Employee).all()
        
        payroll_list = []
        for emp in employees:
            try:
                payroll = OperationService.calculate_payroll(db, emp.id, year_month)
                if payroll["total_work_hours"] > 0:
                    payroll_list.append(
                        PayrollListItem(
                            employee_id=emp.id,
                            employee_name=emp.name,
                            year_month=year_month,
                            total_work_hours=payroll["total_work_hours"],
                            estimated_payroll=payroll["total_salary"]
                        )
                    )
            except ValueError:
                # 시급이 <= 0 이거나 스케줄이 아예 없는 경우 리스트에서 스킵
                continue
                
        return CommonResponse(success=True, data=payroll_list, message="예상 급여 목록 조회가 완료되었습니다.")
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.post("/settlements/calculate", response_model=CommonResponse)
def calculate_settlement_api(payload: SettlementCalculateRequest, db: Session = Depends(get_db)):
    """지정 기간에 대한 매장의 실제 매출, 지출 비용 및 총 인건비를 연동하여 예상 손익 정산을 계산하고 저장합니다."""
    try:
        settlement_result = OperationService.calculate_settlement(
            db=db,
            period_start=payload.period_start,
            period_end=payload.period_end,
            other_expense=payload.other_expense or 0
        )
        data = SettlementResponse.model_validate(settlement_result)
        return CommonResponse(success=True, data=data, message="예상 정산 계산 및 저장이 완료되었습니다.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.get("/settlements", response_model=CommonResponse)
def get_settlements_api(
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)"),
    db: Session = Depends(get_db)
):
    """지정 연월에 대한 매장의 정산 내역 요약 정보를 목록 형태로 조회합니다."""
    try:
        settlement_result = OperationService.calculate_settlement(db, year_month)
        data = [
            SettlementListItem(
                year_month=settlement_result["year_month"],
                total_sales=settlement_result["total_sales"],
                total_expense=settlement_result["total_expense"],
                total_payroll=settlement_result["total_payroll"],
                net_profit=settlement_result["net_profit"]
            )
        ]
        return CommonResponse(success=True, data=data, message="정산 내역 조회가 완료되었습니다.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# --- [신규 GET API: 저장된 예상 결과 조회] ---

@router.get("/payroll/estimated", response_model=CommonResponse)
def get_estimated_payrolls_api(
    employee_id: Optional[int] = Query(None, description="직원 고유 ID 필터"),
    period_start: Optional[str] = Query(None, description="조회 시작일 (YYYY-MM-DD)"),
    period_end: Optional[str] = Query(None, description="조회 종료일 (YYYY-MM-DD)"),
    db: Session = Depends(get_db)
):
    """데이터베이스에 저장되어 있는 직원들의 기간별 예상 급여 결과를 조회합니다."""
    try:
        query = db.query(EstimatedPayroll)
        if employee_id is not None:
            query = query.filter(EstimatedPayroll.employee_id == employee_id)
        if period_start:
            query = query.filter(EstimatedPayroll.period_start >= period_start)
        if period_end:
            query = query.filter(EstimatedPayroll.period_end <= period_end)
            
        results = query.all()
        
        # [한글 주석] 직원 이름을 매핑하여 응답 스펙을 채워줍니다.
        data_list = []
        for r in results:
            emp = db.query(Employee).filter(Employee.id == r.employee_id).first()
            emp_name = emp.name if emp else "알 수 없음"
            
            data_list.append(
                PayrollListItem(
                    id=r.id,
                    employee_id=r.employee_id,
                    employee_name=emp_name,
                    period_start=r.period_start,
                    period_end=r.period_end,
                    total_work_hours=r.total_work_hours,
                    estimated_salary=r.estimated_salary
                )
            )
        return CommonResponse(success=True, data=data_list, message="저장된 예상 급여 목록 조회가 완료되었습니다.")
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

@router.post("/forecast/sales", response_model=CommonResponse)
def get_sales_forecast_api(payload: ForecastRequest):
    """최근 N일의 판매 기록을 토대로 미래 일자의 판매량 및 매출액을 예측합니다."""
    try:
        result = ForecastingService.forecast_sales(
            sales_data=payload.sales_data,
            target_date=payload.target_date,
            has_event=payload.has_event
        )
        data = ForecastResponse(
            target_date=result["target_date"],
            predicted_sales=result["predicted_sales"],
            predicted_quantity=result["predicted_quantity"],
            evidence_summary=result["evidence_summary"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="판매 예측 계산이 완료되었습니다."
        )

    except ValueError as e:
        return CommonResponse(
            success=False,
            data=None,
            message=str(e)
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"서버 오류: {str(e)}"
        )

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





