"""세무 챗봇 도구 래퍼 (백엔드 C)"""
from app.services.operation.tax_service import TaxService
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
def estimate_tax_tool(total_revenue: int, total_expense: int, tax_type: str = "general", period: str = "2026-07") -> dict:
    """매출과 비용을 전달받아 참고용 예상 세금(부가세+종합소득세)을 계산합니다.
    - total_revenue: 총 매출액 (0 이상)
    - total_expense: 총 비용액 (0 이상)
    - tax_type: 과세유형 ('general' 일반과세 | 'simplified' 간이과세, 기본 general)
    - period: 대상 연월 (예: '2026-07')
    """
    try:
        result = TaxService.estimate_from_amounts(
            total_revenue=total_revenue,
            total_expense=total_expense,
            period=period,
            tax_type=tax_type
        )
        return {
            "success": True,
            "data": result,
            "documents": [],
            "message": "세무 예상 계산이 완료되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"입력값 오류: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"세무 계산 중 서버 오류가 발생했습니다: {str(e)}"
        }

@tool
def get_tax_rag_documents_tool(total_revenue: int, total_expense: int, tax_type: str = "general", period: str = "2026-07") -> dict:
    """세무 계산 결과를 챗봇이 읽을 수 있는 RAG 문서 리스트 형태로 반환합니다.
    - total_revenue: 총 매출 (0 이상)
    - total_expense: 총 비용 (0 이상)
    - tax_type: 과세유형 ('general' | 'simplified', 기본 general)
    - period: 대상 연월
    """
    try:
        # 1. 세무 계산 수행
        tax_result = TaxService.estimate_from_amounts(
            total_revenue=total_revenue,
            total_expense=total_expense,
            period=period,
            tax_type=tax_type
        )
        # 2. RAG 문서로 패키징
        rag_doc = OperationService.build_tax_rag_documents(tax_result)
        return {
            "success": True,
            "data": {},
            "documents": [rag_doc],
            "message": "세무 RAG 문서 변환이 완료되었습니다."
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"세무 RAG 문서 변환 실패: {str(e)}"
        }
