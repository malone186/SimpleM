"""내 카페 리뷰 — '내 가게 직접 지정(link)' 흐름 테스트 (백엔드 B). 인메모리 sqlite.

상호만으로 검색하면 이름이 같은 남의 카페 후기가 내 것처럼 나올 수 있어, 사장님이 후보에서
자기 가게를 지정(link)한 뒤에만 그 장소로 후기를 조회한다. 그 계약을 잠근다.
네트워크(네이버·역지오코딩)는 가짜로 갈아끼운다.
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.api.v1 import chatbot as cb
from app.models.user import User


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    # _get_cafe_link/link/unlink는 document_service._session() → core_db.SessionLocal을 호출 시점에 읽는다
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    yield
    engine.dispose()


def _user(store_name="행복카페", name="사장", lat=37.5, lon=127.0, email="owner@test.com"):
    u = User(id=1, email=email, name=name, hashed_password="x")
    u.store_name = store_name
    u.store_lat = lat
    u.store_lon = lon
    u.store_address = ""
    return u


def test_analysis_not_linked_returns_flag(db, monkeypatch):
    """지정 전에는 후기를 찾지 않고 linked=False로 알린다 (프론트가 '내 카페 연결' 안내)."""
    called = {"n": 0}
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe",
                        lambda *a, **k: called.__setitem__("n", called["n"] + 1) or {})
    out = cb.get_my_cafe_analysis_api(current_user=_user())
    assert out["linked"] is False
    assert out["review_count"] == 0
    assert called["n"] == 0  # 지정 전엔 분석 자체를 안 한다


def test_link_then_analysis_uses_linked_place(db, monkeypatch):
    """지정하면 그 장소(이름+주소)로만 후기를 조회한다 — 상호가 아니라 지정값 기준."""
    seen = {}

    def fake_analyze(name, address="", category="", distance_m=0, region=""):
        seen["name"] = name
        seen["address"] = address
        return {"name": name, "address": address, "review_count": 3, "reviews": [], "analysis": None}

    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe", fake_analyze)
    user = _user()
    cb.link_my_cafe_api(
        cb.CafeLinkRequest(place_name="행복카페 역삼점", place_address="서울 강남구 역삼동 1"),
        current_user=user)
    out = cb.get_my_cafe_analysis_api(current_user=user)

    assert out["linked"] is True
    assert seen["name"] == "행복카페 역삼점"          # 지정한 장소로만
    assert seen["address"] == "서울 강남구 역삼동 1"
    assert out["review_count"] == 3


def test_relink_overwrites(db, monkeypatch):
    """재지정은 덮어쓴다 (매장당 한 곳)."""
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe",
                        lambda name, **k: {"name": name, "review_count": 0, "reviews": [], "analysis": None})
    user = _user()
    cb.link_my_cafe_api(cb.CafeLinkRequest(place_name="A카페", place_address="주소A"), current_user=user)
    cb.link_my_cafe_api(cb.CafeLinkRequest(place_name="B카페", place_address="주소B"), current_user=user)
    out = cb.get_my_cafe_analysis_api(current_user=user)
    assert out["place_name"] == "B카페"


def test_unlink_resets(db, monkeypatch):
    """지정 해제하면 다시 linked=False."""
    monkeypatch.setattr(cb.nearby_cafe_service, "analyze_cafe",
                        lambda name, **k: {"name": name, "review_count": 0, "reviews": [], "analysis": None})
    user = _user()
    cb.link_my_cafe_api(cb.CafeLinkRequest(place_name="A카페", place_address=""), current_user=user)
    cb.unlink_my_cafe_api(current_user=user)
    assert cb.get_my_cafe_analysis_api(current_user=user)["linked"] is False


def test_candidates_uses_store_name(db, monkeypatch):
    """후보 검색은 등록 상호로 네이버를 친다."""
    seen = {}
    monkeypatch.setattr(
        cb.nearby_cafe_service, "search_cafe_candidates",
        lambda q, lat=None, lon=None, **k: seen.__setitem__("q", q) or [
            {"name": "행복카페", "address": "서울 강남구", "category": "카페",
             "telephone": "", "lat": None, "lon": None, "distance_m": None}])
    out = cb.get_my_cafe_candidates_api(current_user=_user(store_name="행복카페"))
    assert seen["q"] == "행복카페"
    assert len(out["candidates"]) == 1


def test_candidates_requires_name(db):
    """검색할 상호가 없으면 409."""
    with pytest.raises(HTTPException) as ei:
        cb.get_my_cafe_candidates_api(current_user=_user(store_name=None, name=""))
    assert ei.value.status_code == 409


def test_link_rejects_empty_name(db):
    """빈 상호로는 지정할 수 없다 (400)."""
    with pytest.raises(HTTPException) as ei:
        cb.link_my_cafe_api(cb.CafeLinkRequest(place_name="   ", place_address=""), current_user=_user())
    assert ei.value.status_code == 400
