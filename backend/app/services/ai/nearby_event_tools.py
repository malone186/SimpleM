"""주변 행사 챗봇 도구 (백엔드 B)

브루(챗봇)가 "이번 주말에 근처에 뭐 있어?", "축제 있으면 재료 더 시켜야 하나?" 같은
질문에 답할 수 있게 한다. 좌표는 계정에 등록된 매장 고정 위치(users.store_lat/lon)를 쓴다.

수집 소스는 예측과 동일하다 — 한국관광공사 축제, 서울 문화행사, 네이버 검색 + AI 정리.
"""

import json

from langchain_core.tools import tool

from app.services.ai import nearby_event_service
from app.services.ai.nearby_cafe_tools import _store_location


@tool
def list_nearby_events(store_id: str, days: int = 14) -> str:
    """등록된 매장 위치 반경 3km에서 앞으로 며칠 안에 열리는 행사(축제·팝업·플리마켓·문화행사)를
    조회하고, 손님이 몰릴 날짜와 미리 준비할 일까지 정리해 준다.
    "이번 주말에 근처에 행사 있어?", "축제 때문에 재료 더 시켜야 할까?" 같은 질문에 쓴다.
    days: 오늘부터 며칠까지 볼지 (기본 14일, 최대 30일)."""
    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, store_name, biz_type = loc
    result = nearby_event_service.analyze_nearby_events(
        lat, lon, store_name=store_name, biz_type=biz_type, days=days)
    if not result["count"]:
        return (f"앞으로 {result['days']}일 안에 매장 반경 {result['radius_km']}km에서 "
                "확인된 행사가 없습니다. (공공 데이터·뉴스/블로그 검색 기준이라 소규모 행사는 빠질 수 있어요.)")
    return json.dumps(result, ensure_ascii=False)


@tool
def plan_nearby_event(store_id: str, event_name: str) -> str:
    """다가오는 주변 행사 하나에 맞춰 **무슨 이벤트를 하고 무엇을 준비할지** 계획을 짜 준다 —
    이벤트 아이디어(할인·세트), 한정 메뉴, 미리 할 일, 넉넉히 확보할 재료, 인력 배치, 홍보 문구.
    "이번 축제 때 뭐 하면 좋을까?", "그 행사 대비 뭐 준비해?" 같은 질문에 쓴다.
    event_name은 list_nearby_events가 알려준 행사 이름 그대로 넣는다."""
    from app.core.database import SessionLocal
    from app.services.ai import nearby_watch_service
    from app.services.ai.nearby_event_service import _norm

    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, _store_name, _biz = loc

    events = nearby_event_service.find_nearby_events(lat, lon).get("events", [])
    if not events:
        return "지금 매장 주변에서 확인되는 행사가 없습니다."

    target = _norm(event_name)
    # 이름이 정확히 안 맞아도 부분 일치까지는 받아 준다 (사장님은 줄여서 말한다)
    event = next((e for e in events if _norm(e["name"]) == target), None) \
        or next((e for e in events if target and target in _norm(e["name"])), None)
    if event is None:
        names = ", ".join(e["name"] for e in events[:5])
        return f"'{event_name}' 행사를 찾지 못했습니다. 확인된 행사: {names}"

    db = SessionLocal()
    try:
        plan = nearby_watch_service.plan_for_store(db, store_id, event)
    finally:
        db.close()
    if not plan:
        return f"'{event['name']}' 행사 계획을 지금은 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
    return json.dumps({"event": event, "plan": plan}, ensure_ascii=False)


@tool
def add_event_prep_todos(store_id: str, event_name: str) -> str:
    """행사 준비 계획의 '미리 해 둘 일'을 사장님의 할 일 목록에 담는다 (기한은 행사 전날).
    "그거 할 일에 넣어줘", "축제 준비할 것들 잊지 않게 적어줘" 같은 요청에 쓴다.
    event_name은 list_nearby_events가 알려준 행사 이름 그대로 넣는다.
    이미 같은 할 일이 있으면 새로 만들지 않는다."""
    from datetime import date, timedelta

    from app.core.database import SessionLocal
    from app.schemas.ai import TodoCreate
    from app.services.ai import nearby_watch_service, todo_service
    from app.services.ai.nearby_event_service import _norm

    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, _store_name, _biz = loc

    events = nearby_event_service.find_nearby_events(lat, lon).get("events", [])
    target = _norm(event_name)
    event = next((e for e in events if _norm(e["name"]) == target), None) \
        or next((e for e in events if target and target in _norm(e["name"])), None)
    if event is None:
        names = ", ".join(e["name"] for e in events[:5]) or "없음"
        return f"'{event_name}' 행사를 찾지 못했습니다. 확인된 행사: {names}"

    db = SessionLocal()
    try:
        plan = nearby_watch_service.plan_for_store(db, store_id, event)
    finally:
        db.close()
    actions = [a for a in (plan or {}).get("prep_actions", []) if a and a.strip()]
    if not actions:
        return f"'{event['name']}' 행사의 준비 항목을 지금은 만들지 못했습니다. 잠시 후 다시 시도해 주세요."

    # 기한은 화면(POST /nearby-events/plan/todos)과 같은 규칙 — 행사 전날, 이미 지났으면 오늘
    today = nearby_watch_service._today_kst()
    try:
        due = max(date.fromisoformat(event["start_date"]) - timedelta(days=1), today).isoformat()
    except (KeyError, ValueError):
        due = today.isoformat()

    result = todo_service.add_todos_bulk(
        store_id,
        [TodoCreate(title=a.strip()[:200], note=f"{event['name']} 준비"[:255], due_date=due)
         for a in actions],
        source="ai",
    )
    return json.dumps({
        "event": event["name"],
        "due_date": due,
        "added": [t["title"] for t in result["added"]],
        "already_there": result["skipped"],
    }, ensure_ascii=False)


TOOLS = [list_nearby_events, plan_nearby_event, add_event_prep_todos]
