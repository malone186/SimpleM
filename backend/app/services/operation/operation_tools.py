"""매장 운영(급여·정산·운영요약) 챗봇 도구 래퍼 (백엔드 C)"""
from datetime import datetime
from typing import Any, List, Optional
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
def propose_payroll_tool(
    start_time: str,
    end_time: str,
    break_minutes: float = 0.0,
    hourly_rate: int = 9860,
    weekly_work_hours: Optional[float] = None,
    include_weekly_holiday: bool = False,
    deduct_tax: bool = False
) -> dict:
    """근무 시간을 기준으로 알바생의 예상 급여 초안(Draft)을 계산합니다.
    - start_time: 근무 시작 일시 (예: '2026-07-20 09:00:00' 또는 ISO 포맷)
    - end_time: 근무 종료 일시 (예: '2026-07-20 18:00:00' 또는 ISO 포맷)
    - break_minutes: 휴게시간 (분 단위, 기본 0.0)
    - hourly_rate: 적용 시급 (원 단위, 기본 9860)
    - weekly_work_hours: 주당 총 근무시간 (주휴수당 계산 시 사용)
    - include_weekly_holiday: 주휴수당 포함 여부 (기본 False)
    - deduct_tax: 세금 공제(3.3% 사업소득) 여부 (기본 False)
    """
    try:
        # [한글 주석] 문자열 형태의 일시 데이터를 파이썬 datetime 객체로 전환합니다.
        s_dt = datetime.fromisoformat(start_time.replace(" ", "T"))
        e_dt = datetime.fromisoformat(end_time.replace(" ", "T"))

        # [한글 주석] 실제 계산 로직은 OperationService 비즈니스 함수를 호출합니다.
        result = OperationService.calculate_payroll(
            start_time=s_dt,
            end_time=e_dt,
            break_minutes=break_minutes,
            hourly_rate=hourly_rate,
            weekly_work_hours=weekly_work_hours,
            include_weekly_holiday=include_weekly_holiday,
            deduct_tax=deduct_tax
        )

        return {
            "success": True,
            "data": {"payroll_draft": result},
            "documents": [],
            "message": "예상 급여 계산 초안(Propose)이 성공적으로 생성되었습니다."
        }
    except ValueError as e:
        # [한글 주석] 입력값 유효성 검사 실패 시 처리
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"예상 급여 계산 실패 (입력값 오류): {str(e)}"
        }
    except Exception as e:
        # [한글 주석] 예기치 못한 예외 처리
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"예상 급여 계산 중 서버 오류 발생: {str(e)}"
        }


@tool
def propose_settlement_tool(
    revenue: int,
    cost: int,
    labor_cost: int,
    other_expense: int = 0
) -> dict:
    """매출액, 재료비, 인건비, 기타 경비를 입력받아 예상 정산 결과 초안(Draft)을 계산합니다.
    - revenue: 총 매출액 (원)
    - cost: 재료비/원가 (원)
    - labor_cost: 총 인건비 (원)
    - other_expense: 기타 경비/임대료 등 (원, 기본 0)
    """
    try:
        # [한글 주석] 실제 정산 연산은 OperationService 비즈니스 로직을 호출합니다.
        result = OperationService.calculate_settlement(
            revenue=revenue,
            cost=cost,
            labor_cost=labor_cost,
            other_expense=other_expense
        )

        return {
            "success": True,
            "data": {"settlement_draft": result},
            "documents": [],
            "message": "예상 정산 결과 초안(Propose)이 성공적으로 생성되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"예상 정산 계산 실패 (입력값 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"예상 정산 연산 중 서버 오류 발생: {str(e)}"
        }


@tool
def get_operation_summary_tool(period: str = "daily") -> dict:
    """일간, 주간, 월간 매장 운영 상태에 대한 자연어 요약 정보를 조회합니다.
    - period: 조회 대상 기간 ('daily', 'weekly', 'monthly' 중 선택, 기본 'daily')
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
            raise ValueError("period 항목은 'daily', 'weekly', 'monthly' 중 하나여야 합니다.")

        return {
            "success": True,
            "data": {
                "period": period,
                "summary": summary_text
            },
            "documents": [],
            "message": "운영 상태 요약 조회가 완료되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"운영 요약 조회 실패: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"운영 요약 조회 처리 중 서버 오류 발생: {str(e)}"
        }


import json

@tool
def build_operation_rag_documents_tool(schedules: Optional[str] = None) -> dict:
    """근무 스케줄 목록을 AI 챗봇 참조용 RAG 문서 형태로 변환합니다.
    - schedules: 스케줄 JSON 문자열 (선택)
    """
    try:
        target_schedules = []
        if schedules:
            try:
                target_schedules = json.loads(schedules) if isinstance(schedules, str) else schedules
            except Exception:
                target_schedules = []

        rag_docs = OperationService.build_operation_rag_documents(target_schedules)

        return {
            "success": True,
            "data": {},
            "documents": rag_docs,
            "message": "운영 스케줄 RAG 문서가 성공적으로 생성되었습니다."
        }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"운영 RAG 문서 생성 실패: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"운영 RAG 문서 변환 처리 중 서버 오류 발생: {str(e)}"
        }


@tool
def recommend_schedule_tool(target_date: str, store_id: str = "store_gildong") -> dict:
    """매출 및 직원별 기피/불가 시간(Hard/Soft) 제약을 종합 분석하여 지정일의 추천 알바 스케줄을 도출합니다.
    - target_date: 스케줄 추천 대상 날짜 (YYYY-MM-DD 포맷, 예: '2026-07-25')
    - store_id: 매장 고유 식별자 아이디 (예: 'store_gildong')
    """
    try:
        from app.core.database import SessionLocal
        with SessionLocal() as db:
            result = OperationService.recommend_schedule(
                db=db,
                period_start=target_date,
                period_end=target_date,
                store_id=store_id
            )

            # [한글 주석] AI 챗봇 참조용 시간대별 추천 스케줄 RAG 문서 포장
            hourly_docs = []
            for item in result.get("hourly_recommendations", []):
                assigned_names = ", ".join([e["name"] for e in item.get("assigned_employees", [])]) or "없음(인원부족/영업시간 외)"
                content = (
                    f"{target_date} {item['hour']}시 예상 매출은 {item['predicted_sales']:,}원이며, "
                    f"추천 인원수는 {item['recommended_employee_count']}명(혼잡도: {item['busy_level']})입니다. "
                    f"추천 배정 직원: {assigned_names}."
                )
                hourly_docs.append({
                    "title": f"{target_date} {item['hour']}시 알바 추천 스케줄",
                    "content": content,
                    "summary": f"{target_date} {item['hour']}시 추천 스케줄 정보",
                    "category": "schedule_recommendation",
                    "tags": ["schedule", "recommend", target_date],
                    "source_type": "schedule_recommendation",
                    "source_id": item['hour']
                })

            return {
                "success": True,
                "data": result,
                "documents": hourly_docs,
                "message": "직원 기피 시간이 반영된 추천 스케줄 연산이 성공적으로 완료되었습니다."
            }
    except ValueError as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"추천 스케줄 연산 실패 (입력값 오류): {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"추천 스케줄 연산 중 서버 오류 발생: {str(e)}"
        }

