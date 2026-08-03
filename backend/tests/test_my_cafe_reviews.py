"""내 카페 리뷰 엔드포인트 테스트 (백엔드 B).

analyze_cafe(네이버 후기 수집)는 이미 test로 검증돼 있고, 여기서는 '내 카페' 엔드포인트가
로그인 매장 상호로 분석을 부르는지, 후기 0건이어도 404 없이 돌려주는지, 상호가 없으면
409를 내는지만 본다. 네트워크(네이버·역지오코딩)는 타지 않도록 가짜로 갈아끼운다.
"""
import pytest
from fastapi import HTTPException

from app.api.v1 import chatbot as cb
from app.models.user import User


def _user(store_name=None, name="사장", lat=37.5, lon=127.0):
    u = User(id=1, email="owner@test.com", name=name, hashed_password="x")
    u.store_name = store_name
    u.store_lat = lat
    u.store_lon = lon
    u.store_address = ""
    return u


def test_my_cafe_uses_store_name(monkeypatch):
    called = {}
    def fake_analyze(name, address="", category="", distance_m=0, region=""):
        called["name"] = name
        called["region"] = region
        return {"name": name, "review_count": 2, "reviews": [], "analysis": None}
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe", fake_analyze)
    monkeypatch.setattr(cb.nearby_cafe_service, "_region_names",
                        lambda lat, lon: {"full": "서울특별시 강남구 역삼동"})

    out = cb.get_my_cafe_analysis_api(current_user=_user(store_name="행복카페"))
    assert called["name"] == "행복카페"
    assert called["region"] == "서울특별시 강남구 역삼동"   # 위치로 지역 힌트를 붙인다
    assert out["review_count"] == 2


def test_my_cafe_returns_empty_without_404(monkeypatch):
    """후기 0건이어도 경쟁 카페와 달리 404를 던지지 않고 그대로 돌려준다."""
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe",
                        lambda name, **kw: {"name": name, "review_count": 0, "reviews": [], "analysis": None})
    monkeypatch.setattr(cb.nearby_cafe_service, "_region_names",
                        lambda lat, lon: {"full": ""})
    out = cb.get_my_cafe_analysis_api(current_user=_user(store_name="신상카페"))
    assert out["review_count"] == 0   # 예외 없이 빈 결과


def test_my_cafe_requires_store_name():
    """상호가 없으면 409로 안내한다 (검색할 이름이 없으므로)."""
    with pytest.raises(HTTPException) as ei:
        cb.get_my_cafe_analysis_api(current_user=_user(store_name=None, name=""))
    assert ei.value.status_code == 409


def test_my_cafe_works_without_location(monkeypatch):
    """매장 위치가 없어도 상호만 있으면 조회된다(지역 힌트만 생략)."""
    seen = {}
    def fake_analyze(name, address="", category="", distance_m=0, region=""):
        seen["region"] = region
        return {"name": name, "review_count": 1, "reviews": [], "analysis": None}
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe", fake_analyze)
    out = cb.get_my_cafe_analysis_api(
        current_user=_user(store_name="행복카페", lat=None, lon=None))
    assert out["review_count"] == 1
    assert seen["region"] == ""   # 위치 없으면 지역 힌트 없이 이름만으로
