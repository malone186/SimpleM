"""운영 API (백엔드 C)"""
from fastapi import APIRouter, Query, Depends
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.user import User
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleResponse,
    SettlementResponse, TaxEstimateRequest, TaxEstimateResponse,
    ForecastRequest, ForecastResponse, RAGDocumentResponse, ReportSourceResponse
)
from app.services.operation.operation_service import OperationService
from app.services.operation.tax_service import TaxService
from app.services.operation.forecasting_service import ForecastingService

router = APIRouter(prefix="/operation", tags=["Operation"])

@router.post("/schedules", response_model=CommonResponse)
def create_schedule_api(payload: ScheduleCreate):
    """새로운 근무 스케줄을 등록합니다."""
    try:
        schedule = OperationService.create_schedule(
            employee_id=payload.employee_id,
            start_time=payload.start_time,
            end_time=payload.end_time
        )
        return CommonResponse(
            success=True,
            data=ScheduleResponse.from_orm(schedule),
            message="스케줄 등록이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/schedules", response_model=CommonResponse)
def get_all_schedules_api():
    """전체 스케줄 일정을 조회합니다."""
    try:
        schedules = OperationService.get_all_schedules()
        data = [ScheduleResponse.from_orm(s) for s in schedules]
        return CommonResponse(success=True, data=data, message="스케줄 조회가 완료되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.get("/payroll/estimate", response_model=CommonResponse)
def get_payroll_estimate_api(
    employee_id: int = Query(..., description="직원 고유 번호"),
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)")
):
    """특정 직원의 해당 월 예상 급여(주휴수당 포함)를 시뮬레이션 계산합니다."""
    try:
        payroll_result = OperationService.calculate_payroll(employee_id, year_month)
        return CommonResponse(success=True, data=payroll_result, message="예상 급여 계산이 완료되었습니다.")
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.get("/settlement/estimate", response_model=CommonResponse)
def get_settlement_estimate_api(
    year_month: str = Query(..., description="정산 연월 (YYYY-MM)")
):
    """지정 연월에 대한 매장의 예상 손익 정산 분석안을 조회합니다."""
    try:
        settlement_result = OperationService.calculate_settlement(year_month)
        data = SettlementResponse(
            year_month=settlement_result["year_month"],
            total_sales=settlement_result["total_sales"],
            total_expense=settlement_result["total_expense"],
            total_payroll=settlement_result["total_payroll"],
            net_profit=settlement_result["net_profit"],
            calculated_at=settlement_result["calculated_at"]
        )
        return CommonResponse(success=True, data=data, message="예상 정산 계산이 완료되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=str(e))

@router.post("/tax/estimate", response_model=CommonResponse)
def get_tax_estimate_api(payload: TaxEstimateRequest):
    """매출과 비용을 기반으로 한 참고용 예상 세금 계산을 수행합니다."""
    try:
        result = TaxService.calculate_estimated_tax(
            total_revenue=payload.total_revenue,
            total_expense=payload.total_expense,
            tax_rate=payload.tax_rate,
            period=payload.period
        )
        data = TaxEstimateResponse(
            period=result["period"],
            total_revenue=result["total_revenue"],
            total_expense=result["total_expense"],
            taxable_amount=result["taxable_amount"],
            tax_rate=result["tax_rate"],
            estimated_tax=result["estimated_tax"],
            summary=result["summary"],
            disclaimer=result["disclaimer"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="세무 예상 계산이 완료되었습니다."
        )
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





