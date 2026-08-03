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


TOOLS = [list_nearby_events]
