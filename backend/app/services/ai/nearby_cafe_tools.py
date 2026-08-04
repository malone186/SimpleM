"""주변 카페 상권 분석 챗봇 도구 (백엔드 B)

브루(챗봇)가 "우리 주변에 카페 몇 개나 있어?", "옆 건물 스타벅스 리뷰 어때?",
"이 동네에서 우리가 뭘 하면 좋을까?" 같은 질문에 답할 수 있게 한다.

좌표는 사장님이 회원가입 때 지도 핀으로 등록한 매장 고정 위치(users.store_lat/lon)를 쓴다.
등록이 안 된 계정은 등록을 안내한다 (기기 GPS로 추측하지 않는다 — 매장이 움직이면 안 되므로).
"""

import json

from langchain_core.tools import tool

from app.services.ai import nearby_cafe_service


def _store_location(store_id: str) -> tuple[float, float, str, str] | str:
    """store_id(이메일) → (lat, lon, store_name, biz_type). 등록 안 됐으면 안내 문자열."""
    from app.core.database import SessionLocal
    from app.models.user import User

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == store_id).first()
        if not user:
            return f"'{store_id}' 계정을 찾을 수 없습니다."
        if user.store_lat is None or user.store_lon is None:
            return ("매장 위치가 아직 등록되지 않았습니다. 앱의 매장 지도 화면에서 "
                    "'매장 위치 등록'으로 지도 핀을 찍어 주시면 주변 카페를 분석해 드릴 수 있어요.")
        return (user.store_lat, user.store_lon,
                user.store_name or user.name or "내 매장",
                user.store_biz_type or "")
    finally:
        db.close()


@tool
def list_nearby_cafes(store_id: str, radius_m: int = 1000, limit: int = 15) -> str:
    """등록된 매장 위치를 기준으로 반경 안의 경쟁 카페 목록을 네이버 지역정보로 조회한다.
    각 카페의 이름·분류(프랜차이즈/로스터리/디저트 등)·주소·직선거리(m)를 가까운 순으로 돌려준다.
    "주변에 카페 몇 개야?", "가장 가까운 경쟁 카페는?" 같은 질문에 쓴다.
    radius_m: 반경(기본 1000m, 최대 3000m 권장)."""
    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, store_name, _ = loc
    try:
        found = nearby_cafe_service.find_nearby_cafes(
            lat, lon, radius_m=radius_m, limit=limit, exclude_name=store_name)
    except nearby_cafe_service.NearbyCafeError as e:
        return str(e)
    return json.dumps(found, ensure_ascii=False)


@tool
def analyze_nearby_cafe(cafe_name: str, address: str = "", category: str = "") -> str:
    """경쟁 카페 한 곳의 네이버 블로그 후기를 모아 강점·약점·대표 메뉴·가격대·주 고객층·
    분위기·여론(긍/부정)과 우리 매장의 대응 전략을 분석한다.
    "○○카페 어때?", "그 집 왜 잘돼?" 같은 질문에 쓴다. cafe_name은 정확한 상호로 넣는다."""
    result = nearby_cafe_service.analyze_cafe(cafe_name, address=address, category=category)
    if not result["review_count"]:
        return f"'{cafe_name}'에 대한 네이버 블로그 후기를 찾지 못했습니다."
    return json.dumps(result, ensure_ascii=False)


@tool
def analyze_neighborhood_competition(store_id: str, radius_m: int = 1000) -> str:
    """매장 주변 상권 전체를 분석한다 — 경쟁 밀도, 동네 카페 트렌드, 빈 자리(기회),
    위협, 이번 주 실행안, 주시할 경쟁 카페까지 정리해 준다.
    "우리 동네 상권 어때?", "뭘 하면 손님이 늘까?" 같은 질문에 쓴다."""
    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, store_name, biz_type = loc
    try:
        result = nearby_cafe_service.analyze_neighborhood(
            lat, lon, store_name=store_name, biz_type=biz_type, radius_m=radius_m)
    except nearby_cafe_service.NearbyCafeError as e:
        return str(e)
    return json.dumps(result, ensure_ascii=False)


@tool
def list_nearby_cafe_changes(store_id: str, days: int = 30) -> str:
    """최근 주변 상권의 '변화'를 조회한다 — 새로 생긴 카페와 문을 닫은 것으로 보이는 카페.
    "요즘 근처에 새로 생긴 카페 있어?", "옆에 있던 카페 없어졌지?" 같은 질문에 쓴다.
    매일 한 번 반경 1km를 훑어 쌓아 둔 관측 기록을 읽는다(폐업은 검색에서 사라진 것에 근거한 추정).
    days: 며칠 안의 변화를 볼지 (기본 30일)."""
    from app.core.database import SessionLocal
    from app.services.ai import nearby_watch_service

    loc = _store_location(store_id)
    if isinstance(loc, str):
        return loc
    lat, lon, store_name, _ = loc

    db = SessionLocal()
    try:
        result = nearby_watch_service.recent_changes(db, store_id, days=days)
        if not result["count"]:
            # 관측을 시작한 적이 없으면 지금 한 번 훑어 기준선을 만든다 — 변화는 내일부터 잡힌다
            if not result["last_scan"]:
                nearby_watch_service.scan_if_stale(db, store_id, lat, lon, exclude_name=store_name)
                return ("주변 카페 관측을 이제 막 시작했습니다. 지금 있는 가게들을 기준으로 잡아 두었고, "
                        "새로 생기거나 없어지는 곳은 내일부터 알려드릴 수 있어요.")
            return (f"최근 {days}일 안에는 반경 1km에서 새로 생기거나 없어진 카페가 확인되지 않았습니다 "
                    f"(관측 중인 카페 {result['tracked']}곳, 마지막 확인 {result['last_scan']}).")
        return json.dumps(result, ensure_ascii=False)
    finally:
        db.close()


TOOLS = [list_nearby_cafes, analyze_nearby_cafe, analyze_neighborhood_competition,
         list_nearby_cafe_changes]
