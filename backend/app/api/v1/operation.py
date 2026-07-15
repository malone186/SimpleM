"""운영 API (백엔드 C)"""
from fastapi import APIRouter, Query, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleUpdate, ScheduleResponse,
    SettlementResponse, TaxEstimateRequest, TaxEstimateResponse,
    ForecastRequest, ForecastResponse, RAGDocumentResponse, ReportSourceResponse,
    PayrollCalculateRequest, SettlementCalculateRequest
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
    except ValueError:
        return CommonResponse(
            success=False,
            data=None,
            message="매출, 비용, 세율은 올바른 범위의 값이어야 합니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"서버 오류: {str(e)}"
        )

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




