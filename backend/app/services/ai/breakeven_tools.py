"""손익분기점 챗봇 도구 (백엔드 B) — "얼마 팔아야 본전이야?"에 답한다

사장님이 매달 궁금해하는 건 '매출이 얼마냐'가 아니라 '이 정도 팔면 남는 거냐'다.
고정비만 한 번 적어 두면 재료비율·카드 수수료는 실제 판매에서 자동으로 잡히므로,
그 뒤로는 물어볼 때마다 바로 답할 수 있다.

고정비 저장은 돈이 나가는 액션이 아니라 사실 기록이라 draft_ 없이 바로 저장한다
(발주·지급처럼 되돌리기 어려운 행위가 아니다).
store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import breakeven_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_breakeven_point(store_id: str, target_profit: int = 0) -> str:
    """손익분기점을 계산해 준다. '얼마 팔아야 본전이야?', '손익분기점 알려줘',
    '한 달에 얼마 벌어야 해?', '지금 남는 장사야?'처럼 물을 때 쓴다.
    월 손익분기 매출과 하루 목표 매출·잔 수, 최근 실적 대비 달성률을 함께 준다.
    target_profit을 넣으면 '이만큼 남기려면 얼마를 팔아야 하는지'로 바뀐다
    (예: 월 300만원 남기고 싶다 → target_profit=3000000).
    computed가 false면 needs에 적힌 값(고정비·변동비율)을 먼저 받아야 한다 —
    그때는 message를 그대로 전하고 무엇을 입력해야 하는지 안내한다."""
    return _dump(breakeven_service.compute_breakeven(store_id, target_profit=target_profit))


@tool
def get_fixed_costs(store_id: str) -> str:
    """저장된 월 고정비(임대료·인건비·공과금·기타)를 조회한다.
    '내 고정비 얼마로 돼 있어?', '고정비 확인해줘'처럼 물을 때 쓴다.
    configured가 false면 아직 한 번도 입력하지 않은 매장이다."""
    return _dump(breakeven_service.get_fixed_costs(store_id))


@tool
def save_fixed_costs(store_id: str, rent: int = -1, labor: int = -1,
                     utilities: int = -1, other: int = -1,
                     open_days_per_month: int = -1) -> str:
    """월 고정비를 저장한다. 사장님이 '임대료 200만원이고 인건비 300만원이야'처럼
    말하면 쓴다. 말하지 않은 항목은 -1로 두면 기존 값이 그대로 유지된다.
    rent=임대료·관리비, labor=고정 인건비(사장 급여 포함), utilities=전기·가스·수도·통신,
    other=보험·리스·구독료 등. open_days_per_month는 한 달 영업일수(주 6일이면 26).
    저장 뒤 바뀐 손익분기점을 함께 돌려주므로 그대로 알려 주면 된다."""
    patch = {k: v for k, v in
             {"rent": rent, "labor": labor, "utilities": utilities,
              "other": other, "open_days_per_month": open_days_per_month}.items()
             if v is not None and v >= 0}
    if not patch:
        return "저장할 고정비 항목이 없습니다. 임대료·인건비·공과금 중 무엇을 얼마로 할지 물어보세요."
    try:
        saved = breakeven_service.save_fixed_costs(store_id, **patch)
    except breakeven_service.BreakevenError as e:
        return str(e)
    return _dump({
        "saved": saved,
        "breakeven": breakeven_service.compute_breakeven(store_id),
    })


@tool
def simulate_breakeven(store_id: str, variable_cost_ratio: float = -1.0,
                       target_profit: int = 0) -> str:
    """'만약에' 계산 — 저장된 값을 바꾸지 않고 가정만 넣어 본다.
    '재료비를 25%로 낮추면 어떻게 돼?', '월 500만원 남기려면 얼마 팔아야 해?'처럼
    물을 때 쓴다. variable_cost_ratio는 변동비율(%)이고, 안 물었으면 -1로 두면
    지금 값이 그대로 쓰인다."""
    return _dump(breakeven_service.compute_breakeven(
        store_id,
        variable_cost_ratio=variable_cost_ratio if variable_cost_ratio >= 0 else None,
        target_profit=target_profit,
    ))


TOOLS = [get_breakeven_point, get_fixed_costs, save_fixed_costs, simulate_breakeven]
