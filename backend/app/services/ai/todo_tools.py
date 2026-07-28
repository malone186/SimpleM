"""할 일 챗봇 도구 (백엔드 B) — 브루가 대시보드 할 일 목록에 직접 적어 넣는다

사장님이 "내일 원두 발주하는 거 잊지 말라고 해줘"라고 하면 대화로만 답하고 끝나는 게
아니라 홈 화면 할 일에 남아야 한다. 돈이 걸린 액션이 아니라 메모라서 draft_ 없이
바로 추가한다 — 실제 발주는 여전히 발주 승인 플로우를 거친다.

store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.schemas.ai import TodoCreate
from app.services.ai import todo_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def add_todo(store_id: str, title: str, note: str = "", due_date: str = "") -> str:
    """사장님의 할 일 목록(홈 화면)에 항목을 추가한다. 사장님이 '잊지 말라고 해줘',
    '메모해줘', '할 일에 넣어줘'라고 하거나, 대화 중 나중에 해야 할 일이 정해졌을 때 쓴다.
    title은 한눈에 보이게 짧게 쓴다 (예: '원두 발주', '보건증 갱신 예약').
    due_date는 기한이 분명할 때만 YYYY-MM-DD로 넣고, 없으면 비운다.
    같은 제목의 할 일이 이미 있으면 새로 만들지 않고 기존 것을 돌려준다."""
    try:
        req = TodoCreate(title=title, note=note or "브루가 추가함", due_date=due_date or None)
    except Exception as e:
        return f"할 일을 추가할 수 없습니다: {e}"

    try:
        return _dump(todo_service.add_todo(store_id, req, source="ai"))
    except todo_service.TodoError as e:
        return str(e)


@tool
def list_todos(store_id: str) -> str:
    """사장님의 할 일 목록을 조회한다. '할 일 뭐 있어?', '오늘 뭐 해야 해?'처럼 물을 때 쓴다.
    미완료가 먼저 나오고, 기한이 임박한 순서다. 재고 부족·서류 갱신처럼 자동으로 잡히는
    할 일은 여기 안 나온다 — 그건 재고/서류 조회 도구로 따로 확인한다."""
    return _dump(todo_service.list_todos(store_id))


@tool
def complete_todo(store_id: str, title: str) -> str:
    """할 일을 완료 처리한다. 사장님이 '그거 했어', '원두 발주 끝냈어'라고 할 때 쓴다.
    title에는 사장님이 말한 표현을 그대로 넣으면 되고, 목록에서 알아서 찾는다.
    비슷한 항목이 여럿이면 못 찾았다고 답하니 그때는 어느 것인지 되물어야 한다."""
    found = todo_service.find_by_title(store_id, title)
    if found is None:
        return _dump({
            "ok": False,
            "reason": f"'{title}'에 해당하는 미완료 할 일을 찾지 못했습니다. 목록을 보여주고 되물어 주세요.",
            "todos": todo_service.list_todos(store_id, include_done=False),
        })

    try:
        return _dump({"ok": True, "todo": todo_service.complete_todo(store_id, found["id"])})
    except todo_service.TodoError as e:
        return str(e)


TOOLS = [add_todo, list_todos, complete_todo]
