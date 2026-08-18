"""주변 카페 수집 회귀 테스트."""

from app.services.ai import forecast_service
from app.services.ai import nearby_cafe_service as ncs


def _local_item(name: str, lat: float, lon: float) -> dict[str, str]:
    return {
        "title": name,
        "category": "카페,디저트>카페",
        "roadAddress": "경기도 화성시 효행구 봉담읍 테스트로 1",
        "mapx": str(round(lon * 1e7)),
        "mapy": str(round(lat * 1e7)),
    }


def test_region_names_keeps_compound_sigungu_and_uses_leaf_area(monkeypatch):
    """공백이 든 area2에서도 실제 읍면동을 검색 기준으로 사용한다."""
    monkeypatch.setattr(
        forecast_service,
        "_reverse_geocode",
        lambda lat, lon: "경기도 화성시 효행구 봉담읍",
    )

    assert ncs._region_names(37.2132877, 126.9526872) == {
        "sido": "경기도",
        "sigungu": "화성시 효행구",
        "dong": "봉담읍",
        "full": "경기도 화성시 효행구 봉담읍",
    }


def test_nearby_search_adds_chain_queries_missed_by_generic_top_five(monkeypatch):
    """일반 카페 검색 상위 5건에 없어도 가까운 체인 지점을 포함한다."""
    lat, lon = 37.2132877, 126.9526872
    queries: list[str] = []

    monkeypatch.setattr(ncs, "_naver_headers", lambda: {"x": "configured"})
    monkeypatch.setattr(
        ncs,
        "_region_names",
        lambda *_: {
            "sido": "경기도",
            "sigungu": "화성시 효행구",
            "dong": "봉담읍",
            "full": "경기도 화성시 효행구 봉담읍",
        },
    )

    def fake_search(query: str, display: int = 5, sort: str = "comment"):
        queries.append(query)
        if query == "봉담읍 메가MGC커피":
            return [_local_item("메가MGC커피 협성대점", lat + 0.003, lon)]
        return []

    monkeypatch.setattr(ncs, "_search_local", fake_search)
    ncs._cafe_cache.clear()

    result = ncs.find_nearby_cafes(lat, lon, radius_m=1000, limit=20)

    assert "봉담읍 카페" in queries
    assert "봉담읍 메가MGC커피" in queries
    assert [cafe["name"] for cafe in result["cafes"]] == ["메가MGC커피 협성대점"]


def test_neighborhood_insight_cache_tracks_the_actual_cafe_list(monkeypatch):
    """같은 좌표라도 표시 목록이 바뀌면 예전 목록의 AI 분석을 재사용하지 않는다."""
    state = {"name": "가카페"}
    gemini_calls: list[str] = []

    def fake_find(*args, **kwargs):
        cafe = {
            "name": state["name"], "category": "카페", "address": "테스트로 1",
            "distance_m": 100, "lat": 37.0, "lon": 127.0,
        }
        return {
            "region": "서울특별시 강남구 역삼동", "radius_m": 1000,
            "count": 1, "cafes": [cafe], "cached": False,
        }

    def fake_gemini(prompt, schema):
        gemini_calls.append(prompt)
        return {"headline": state["name"]}

    monkeypatch.setattr(ncs, "find_nearby_cafes", fake_find)
    monkeypatch.setattr(ncs, "_search_blog", lambda *args, **kwargs: [])
    monkeypatch.setattr(ncs, "_gemini_json", fake_gemini)
    ncs._analysis_cache.clear()

    first = ncs.analyze_neighborhood(37.0, 127.0)
    state["name"] = "나카페"
    second = ncs.analyze_neighborhood(37.0, 127.0)

    assert first["insight"]["headline"] == "가카페"
    assert second["insight"]["headline"] == "나카페"
    assert len(gemini_calls) == 2
