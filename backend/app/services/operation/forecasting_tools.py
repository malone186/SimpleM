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


import json

@tool
def forecast_sales_tool(
    target_date: str,
    store_id: str = "",
    sales_data: Optional[str] = None,
    has_event: bool = False
) -> dict:
    """최근 일별 판매/매출 데이터를 기반으로 지정일의 예상 매출액과 판매량을 예측합니다.
    - target_date: 예측 대상 날짜 (포맷: YYYY-MM-DD)
    - store_id: 로그인 매장이 자동으로 채워진다 (직접 넣지 말 것)
    - sales_data: 최근 일별 판매 데이터 JSON 문자열 (없으면 매장 판매 기록에서 자동 집계)
    - has_event: 이벤트/행사 적용 여부 (기본 False)
    """
    db = None
    try:
        parsed_sales = None
        if sales_data:
            try:
                parsed_sales = json.loads(sales_data) if isinstance(sales_data, str) else sales_data
            except Exception:
                parsed_sales = None

        # sales_data도 db도 없으면 서비스가 곧장 ValueError를 던진다. docstring이
        # sales_data를 '선택'이라 해 놨는데 세션을 아무도 안 넘겨서, 모델이 이 도구를
        # 고르면 턴 하나를 통째로 버리고 "서버 오류"를 보고했다 (실측: 항상 실패).
        if not parsed_sales:
            from app.core.database import SessionLocal

            db = SessionLocal()

        result = ForecastingService.forecast_sales(
            target_date=target_date,
            sales_data=parsed_sales,
            has_event=has_event,
            db=db,
            store_id=store_id or None,
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
    finally:
        if db is not None:
            db.close()


@tool
def build_forecast_rag_documents_tool(
    target_date: str,
    store_id: str = "",
    sales_data: Optional[str] = None,
    has_event: bool = False
) -> dict:
    """판매 예측 결과를 AI 챗봇 참조용 RAG 문서 형태로 변환합니다.
    - target_date: 예측 대상 날짜 (포맷: YYYY-MM-DD)
    - store_id: 로그인 매장이 자동으로 채워진다 (직접 넣지 말 것)
    - sales_data: 최근 일별 판매 데이터 JSON 문자열 (없으면 매장 판매 기록에서 자동 집계)
    - has_event: 이벤트/행사 적용 여부
    """
    db = None
    try:
        parsed_sales = None
        if sales_data:
            try:
                parsed_sales = json.loads(sales_data) if isinstance(sales_data, str) else sales_data
            except Exception:
                parsed_sales = None

        # forecast_sales_tool과 같은 이유 — 세션을 안 넘기면 항상 실패했다
        if not parsed_sales:
            from app.core.database import SessionLocal

            db = SessionLocal()

        forecast_result = ForecastingService.forecast_sales(
            target_date=target_date,
            sales_data=parsed_sales,
            has_event=has_event,
            db=db,
            store_id=store_id or None,
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
    finally:
        if db is not None:
            db.close()
