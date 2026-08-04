"""오늘 브리핑 챗봇 도구 (백엔드 B)

로직은 briefing_service에 있고 여기는 @tool 래퍼만 둔다.

아침 푸시로 나가는 것과 **같은 브리핑**을 챗봇도 볼 수 있게 한다 —
"오늘 뭐부터 해야 해?"라고 물으면 알림을 다시 찾지 않아도 같은 답이 나온다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import briefing_service


@tool
def get_today_briefing(store_id: str) -> str:
    """오늘 아침 브리핑을 돌려준다 — 어제 매출·오늘 근무·오늘 입금 예정과
    지금 가장 급한 일 3가지를 한 장으로 정리한 것.

    '오늘 뭐부터 해야 해?', '브리핑 해줘', '오늘 상황 정리해줘', '지금 급한 거 뭐야?'
    같은 질문에 쓴다. 매장 데이터로 계산된 사실만 들어 있으니 숫자는 그대로 전하고,
    priorities의 action 문구는 사장님에게 다음 행동으로 제안하면 좋다.
    """
    data = briefing_service.build(store_id)
    return json.dumps(data, ensure_ascii=False, default=str)


TOOLS = [get_today_briefing]
