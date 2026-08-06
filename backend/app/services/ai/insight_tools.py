"""선제 인사이트 챗봇 도구 (백엔드 B)

로직은 insight_service에 있고 이 파일은 @tool 래퍼만 둔다.

알림으로 먼저 나가는 것과 같은 데이터를 챗봇도 볼 수 있게 해서,
"놓친 거 있어?" 하고 물으면 알림함을 열지 않고도 바로 답할 수 있다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import insight_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_proactive_insights(store_id: str, category: str = "") -> str:
    """매장 데이터를 훑어 사장님이 놓치고 있거나 곧 해야 할 일을 찾아 돌려준다.

    검사 항목: 재고 소진 예상일, 매입 단가 인상, 잠자는 재고, 확정 안 한 명세서,
    진행 안 된 발주, 갱신 임박 서류(보건증·위생교육·계약), 세무 신고 기한,
    매출 급락, 판매 입력 누락, 주휴수당 발생, 근로계약서 미작성,
    재고실사·월 장부 미생성, 레시피 없는 메뉴.

    '내가 놓친 거 있어?', '오늘 뭐 챙겨야 해?', '문제 있는 거 알려줘' 같은 질문에 쓴다.
    category로 좁힐 수 있다: inventory, order, document, tax, sales, staff, data.

    각 항목의 action 필드에는 사장님이 바로 이어서 요청할 수 있는 문구가 들어 있으니
    보고할 때 함께 제안하면 좋다.
    """
    result = insight_service.scan(store_id)
    if category.strip():
        wanted = category.strip().lower()
        result["insights"] = [i for i in result["insights"] if i["category"] == wanted]
        result["count"] = len(result["insights"])
        # 심각도 집계도 걸러진 목록 기준으로 다시 센다 — 안 맞추면 챗봇이
        # "high 2건"이라 말해 놓고 목록에는 하나도 안 보여주는 답을 만든다.
        for sev in ("high", "medium", "low"):
            if sev in result:
                result[sev] = sum(1 for i in result["insights"] if i.get("severity") == sev)
    if not result["insights"]:
        return _dump({
            "count": 0,
            "message": "지금 특별히 챙기실 만한 건은 없습니다. 재고·서류·신고 기한 모두 여유 있어요.",
        })
    return _dump(result)


TOOLS = [get_proactive_insights]
