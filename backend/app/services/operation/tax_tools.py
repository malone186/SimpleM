"""세무(부가세·종소세·원천징수) 챗봇 도구 래퍼 (백엔드 C)"""
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
def estimate_tax_tool(
    total_revenue: int,
    total_expense: int,
    period: str = "2026-07",
    tax_type: str = "general"
) -> dict:
    """매출과 비용 금액을 바탕으로 참고용 예상 세금(부가세 + 종합소득세)을 계산합니다.
    - total_revenue: 총 매출액 (원 단위, 0 이상)
    - total_expense: 총 비용/경비액 (원 단위, 0 이상)
    - period: 대상 연월 (기본 '2026-07', 포맷: YYYY-MM)
    - tax_type: 과세 유형 ('general' 일반과세자 | 'simplified' 간이과세자, 기본 'general')
    """
    try:
        # [한글 주석] 세무 시뮬레이션 계산 서비스 호출 (참고용 근사값 반환)
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
            "message": "참고용 예상 세금 계산이 성공적으로 완료되었습니다."
        }
    except ValueError as e:
        # [한글 주석] 입력값 오류 처리 (음수 금액 입력 등)
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"참고용 예상 세금 계산 실패 (입력값 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"참고용 예상 세금 계산 중 서버 오류 발생: {str(e)}"
        }


@tool
def build_tax_rag_documents_tool(
    total_revenue: int,
    total_expense: int,
    period: str = "2026-07",
    tax_type: str = "general"
) -> dict:
    """세무 시뮬레이션 결과를 AI 챗봇 참조용 RAG 문서 형태로 변환합니다.
    - total_revenue: 총 매출액 (원 단위, 0 이상)
    - total_expense: 총 비용/경비액 (원 단위, 0 이상)
    - period: 대상 연월 (예: '2026-07')
    - tax_type: 과세 유형 ('general' | 'simplified')
    """
    try:
        # 1. [한글 주석] 세무 예상 금액 계산 수행
        tax_result = TaxService.estimate_from_amounts(
            total_revenue=total_revenue,
            total_expense=total_expense,
            period=period,
            tax_type=tax_type
        )

        # 2. [한글 주석] 계산 결과를 챗봇 참조용 RAG 문서 포맷으로 변환
        rag_doc = OperationService.build_tax_rag_documents(tax_result)

        return {
            "success": True,
            "data": {},
            "documents": [rag_doc],
            "message": "세무 참고용 RAG 문서가 성공적으로 생성되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"세무 RAG 문서 생성 실패 (입력값 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"세무 RAG 문서 생성 처리 중 서버 오류 발생: {str(e)}"
        }
