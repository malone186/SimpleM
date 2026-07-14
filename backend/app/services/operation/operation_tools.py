"""매장 운영 챗봇 도구 래퍼 (백엔드 C)"""
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
def get_report_source_tool(period: str) -> dict:
    """지정 기간(daily, weekly, monthly)에 대한 자연어 요약 리포트 소스들을 취합하여 조회합니다.
    - period: 조회 대상 기간 단위 (daily, weekly, monthly 중 선택)
    """
    try:
        result = OperationService.build_report_source_documents(period)
        return {
            "success": True,
            "data": result,
            "documents": [],
            "message": "리포트 소스 조회가 완료되었습니다."
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"리포트 소스 조회 실패: {str(e)}"
        }

@tool
def get_operation_summary_tool(period: str) -> dict:
    """일간, 주간, 월간 운영 상태에 관한 자연어 줄글 요약 텍스트를 반환합니다.
    - period: 조회 기간 구분 (daily, weekly, monthly 중 선택)
    """
    try:
        period_lower = period.lower()
        if period_lower == "daily":
            summary_text = OperationService.get_daily_operation_summary()
        elif period_lower == "weekly":
            summary_text = OperationService.get_weekly_operation_summary()
        elif period_lower == "monthly":
            summary_text = OperationService.get_monthly_operation_summary()
        else:
            raise ValueError("period는 daily, weekly, monthly 중 하나여야 합니다.")

        return {
            "success": True,
            "data": {
                "period": period,
                "summary": summary_text
            },
            "documents": [],
            "message": "운영 요약 조회가 완료되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"운영 요약 조회 실패: {str(e)}"
        }
