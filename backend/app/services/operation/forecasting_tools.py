"""판매 예측 챗봇 도구 래퍼 (백엔드 C)"""
from app.services.operation.forecasting_service import ForecastingService
from app.services.operation.operation_service import OperationService

# LangChain @tool 데코레이터 안전 로드 구조
try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func

@tool
def forecast_sales_tool(sales_data: list, target_date: str, has_event: bool = False) -> dict:
    """최근 판매 데이터를 기반으로 지정일의 예상 매출 및 판매량을 시뮬레이션 예측합니다.
    - sales_data: 최근 판매 데이터 리스트 (최소 7일치 이상, 예: [{'date': '...', 'revenue': 100, 'quantity': 1}])
    - target_date: 예측 대상 일자 (YYYY-MM-DD)
    - has_event: 이벤트 적용 여부 (기본값 False)
    """
    try:
        result = ForecastingService.forecast_sales(
            sales_data=sales_data,
            target_date=target_date,
            has_event=has_event
        )
        return {
            "success": True,
            "data": result,
            "documents": [],
            "message": "판매 예측 계산이 완료되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"예측 실패: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"판매 예측 처리 중 서버 오류가 발생했습니다: {str(e)}"
        }

@tool
def get_forecast_rag_documents_tool(sales_data: list, target_date: str, has_event: bool = False) -> dict:
    """판매 예측 결과를 챗봇이 읽을 수 있는 RAG 문서 리스트 형태로 반환합니다.
    - sales_data: 최근 판매 데이터 리스트 (최소 7일치 이상)
    - target_date: 예측 대상 일자
    - has_event: 이벤트 적용 여부
    """
    try:
        # 1. 판매 예측 수행
        forecast_result = ForecastingService.forecast_sales(
            sales_data=sales_data,
            target_date=target_date,
            has_event=has_event
        )
        # 2. RAG 문서로 패키징
        rag_doc = OperationService.build_forecast_rag_documents(forecast_result)
        return {
            "success": True,
            "data": {},
            "documents": [rag_doc],
            "message": "예측 RAG 문서 변환이 완료되었습니다."
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"예측 RAG 문서 변환 실패: {str(e)}"
        }
