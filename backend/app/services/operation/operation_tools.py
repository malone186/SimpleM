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

@tool
def recommend_schedule_tool(target_date: str, store_id: str) -> dict:
    """과거 매출 및 이익 데이터를 시간대별로 분석하여 최적의 알바 근무 인원 스케줄을 추천합니다.
    - target_date: 스케줄 추천 대상 날짜 (YYYY-MM-DD 포맷, 예: '2026-07-16')
    - store_id: 매장 고유 식별자 아이디 (예: 'store_gildong')
    """
    try:
        from app.core.database import SessionLocal
        # [한글 주석] 안전한 데이터베이스 작업 처리를 위해 세션을 열고 사용 후 자동으로 닫습니다.
        db = SessionLocal()
        try:
            result = OperationService.recommend_schedule(
                db=db,
                target_date=target_date,
                store_id=store_id
            )
            
            # [한글 주석] AI 챗봇이 필요시 참조할 수 있도록 시간대별 스케줄 추천 결과 문서를 RAG 포맷으로 포장합니다.
            hourly_docs = []
            for item in result.get("hourly_recommendations", []):
                content = (
                    f"{target_date} {item['hour']}시 예상 매출은 {item['predicted_sales']:,}원, "
                    f"예상 이익은 {item['predicted_profit']:,}원입니다. "
                    f"추천 근무자 수는 {item['recommended_employee_count']}명(혼잡도: {item['busy_level']})입니다."
                )
                hourly_docs.append({
                    "title": f"{target_date} {item['hour']}시 알바 스케줄 분석 및 추천",
                    "content": content,
                    "summary": f"{target_date} {item['hour']}시 노무 추천 가이드",
                    "category": "schedule_recommendation",
                    "tags": ["schedule", "recommend", "profit", target_date],
                    "source_type": "schedule_recommendation",
                    "source_id": item['hour']
                })
            
            return {
                "success": True,
                "data": result,
                "documents": hourly_docs,
                "message": "스케줄 추천 연산이 완료되었습니다."
            }
        finally:
            db.close()
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"스케줄 추천 연산 중 서버 오류 발생: {str(e)}"
        }
