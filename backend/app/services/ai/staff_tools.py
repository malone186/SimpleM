"""직원 인건비 챗봇 도구 (백엔드 B) — "이 알바 쓰면 실제로 얼마 나가?"에 답한다

사장님이 시급만 보고 판단하면 주휴수당과 4대보험 사업주 부담을 빼먹는다. 주 15시간을
넘기느냐에 따라 월 부담이 20% 넘게 달라지므로, 채용·시간 조정 전에 계산해 볼 수 있어야 한다.

계산만 하는 도구(simulate_labor_cost)와 실제 저장된 직원을 읽는 도구를 나눠 둔다 —
"주 20시간으로 늘리면 얼마 더 나가?" 같은 가정 질문에 데이터를 건드리지 않고 답하기 위해서다.
store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import staff_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_staff_costs(store_id: str) -> str:
    """매장 직원별 고용형태·보험·월 인건비와 매장 합계를 조회한다.
    '인건비 얼마 나가?', '직원 몇 명이야?', '이번 달 급여 얼마야?'에 쓴다.
    각 직원의 total_cost는 직원 지급액에 사업주 보험 부담까지 더한 '실제 나가는 돈'이다."""
    return _dump(staff_service.list_staff(store_id))


@tool
def get_weekly_payroll(store_id: str, week_start: str = "") -> str:
    """이번 주 직원별 근무시간과 줄 돈(주급)을 계산한다. '이번 주 얼마 줘야 해?',
    '주급 계산해줘'에 쓴다. 스케줄이 등록된 직원은 실제 근무시간, 없으면 소정근로시간
    기준 추정이다. week_start는 YYYY-MM-DD(월요일), 비우면 이번 주다."""
    try:
        return _dump(staff_service.weekly_payroll(store_id, week_start=week_start or None))
    except ValueError as e:
        return str(e)


@tool
def simulate_labor_cost(hourly_rate: int, weekly_hours: float,
                        insurance: str = "two", pay_type: str = "hourly",
                        monthly_salary: int = 0) -> str:
    """가정 조건으로 월 인건비를 계산해 본다 — 저장은 하지 않는다.
    '시급 11000에 주 20시간이면 얼마 나가?', '주 15시간 넘기면 얼마나 더 들어?'처럼
    채용·시간 조정을 고민할 때 쓴다.
    insurance는 four(4대보험) / two(고용·산재만) / none(3.3% 원천징수) 중 하나.
    주 15시간 이상이면 주휴수당이 자동으로 붙는다."""
    profile = {
        "weekly_hours": weekly_hours,
        "pay_type": pay_type,
        "monthly_salary": monthly_salary,
        "insurance": insurance,
        "weekly_holiday_pay": True,
    }
    return _dump(staff_service.estimate_labor_cost(int(hourly_rate), profile))


TOOLS = [get_staff_costs, get_weekly_payroll, simulate_labor_cost]
