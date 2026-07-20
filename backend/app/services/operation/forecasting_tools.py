"""판매 예측(시계열/이동평균) 챗봇 도구 래퍼 (백엔드 C)"""
from typing import Any, List, Optional
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
def forecast_sales_tool(
    target_date: str,
    sales_data: Optional[List[Any]] = None,
    has_event: bool = False
) -> dict:
    """최근 일별 판매/매출 데이터를 기반으로 지정일의 예상 매출액과 판매량을 예측합니다.
    - target_date: 예측 대상 날짜 (포맷: YYYY-MM-DD)
    - sales_data: 최근 일별 판매 데이터 리스트 (예: [{'date': '2026-07-01', 'revenue': 500000, 'quantity': 100}, ...])
    - has_event: 이벤트/행사 적용 여부 (기본 False)
    """
    try:
        # [한글 주석] 데이터가 부족하거나 비어있는 경우 억지로 예측하지 않고 실패 응답 처리
        if not sales_data or len(sales_data) == 0:
            raise ValueError("판매 예측에 필요한 최근 일별 매출 데이터(sales_data)가 없거나 부족합니다.")

        # [한글 주석] 시계열/이동평균 기반 예측 서비스 호출
        result = ForecastingService.forecast_sales(
            target_date=target_date,
            sales_data=sales_data,
            has_event=has_event
        )

        return {
            "success": True,
            "data": result,
            "documents": [],
            "message": "판매 예측 계산이 성공적으로 완료되었습니다."
        }
    except ValueError as e:
        # [한글 주석] 데이터 부족 등 유효성 실패 처리
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"판매 예측 실패 (입력값/데이터 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"판매 예측 연산 중 서버 오류 발생: {str(e)}"
        }


@tool
def build_forecast_rag_documents_tool(
    target_date: str,
    sales_data: Optional[List[Any]] = None,
    has_event: bool = False
) -> dict:
    """판매 예측 결과를 AI 챗봇 참조용 RAG 문서 형태로 변환합니다.
    - target_date: 예측 대상 날짜 (포맷: YYYY-MM-DD)
    - sales_data: 최근 일별 판매 데이터 리스트
    - has_event: 이벤트/행사 적용 여부
    """
    try:
        # 1. [한글 주석] 판매 데이터 유효성 검증
        if not sales_data or len(sales_data) == 0:
            raise ValueError("판매 예측 RAG 생성에 필요한 일별 매출 데이터(sales_data)가 부족합니다.")

        # 2. [한글 주석] 판매 예측 연산 수행
        forecast_result = ForecastingService.forecast_sales(
            target_date=target_date,
            sales_data=sales_data,
            has_event=has_event
        )

        # 3. [한글 주석] 예측 결과를 RAG 문서 포맷으로 변환
        rag_doc = OperationService.build_forecast_rag_documents(forecast_result)

        return {
            "success": True,
            "data": {},
            "documents": [rag_doc],
            "message": "판매 예측 RAG 문서가 성공적으로 생성되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"판매 예측 RAG 문서 생성 실패 (입력값/데이터 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"판매 예측 RAG 문서 생성 처리 중 서버 오류 발생: {str(e)}"
        }
