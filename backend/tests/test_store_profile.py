"""매장 기본 정보(업종·영업 시간) API 테스트

핵심은 `configured` 플래그다. 조회할 때 행을 기본값으로 만들어 주기 때문에, 이 플래그가
없으면 앱이 '09:00이 사장님이 정한 값인지, 아무도 손 안 댄 기본값인지' 구분할 수 없다.
앱은 이 값이 False일 때만 기기에 남아 있던 값(가입 때 입력한 운영 시간)을 올린다.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import get_current_user, get_password_hash
from app.core.database import Base, get_db
from app.main import app
from app.models.user import User

OWNER = "store-a@cafe.com"
OTHER = "store-b@cafe.com"

_signed_in = {"email": OWNER}


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    with TestSession() as db:
        db.add_all([
            User(email=OWNER, hashed_password=get_password_hash("x"), name="가", store_name="가카페"),
            User(email=OTHER, hashed_password=get_password_hash("x"), name="나", store_name="나카페"),
        ])
        db.commit()

    def current_user():
        with TestSession() as db:
            return db.query(User).filter(User.email == _signed_in["email"]).first()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = current_user
    _signed_in["email"] = OWNER
    yield TestClient(app)
    app.dependency_overrides.clear()
    engine.dispose()


def test_first_read_returns_defaults_marked_unconfigured(client):
    """한 번도 저장한 적 없으면 기본값 + configured=False."""
    body = client.get("/api/v1/store/profile").json()
    assert body == {
        "business_type": "카페",
        "open_hour": "09:00",
        "close_hour": "21:00",
        "configured": False,
    }


def test_save_marks_configured_and_persists(client):
    """저장하면 configured=True가 되고 값이 남는다 — 예전엔 기기에만 남아 재설치하면 사라졌다."""
    res = client.put("/api/v1/store/profile", json={
        "business_type": "베이커리", "open_hour": "07:30", "close_hour": "22:00",
    })
    assert res.status_code == 200
    assert res.json() == {
        "business_type": "베이커리", "open_hour": "07:30",
        "close_hour": "22:00", "configured": True,
    }
    # 다시 읽어도 그대로다
    assert client.get("/api/v1/store/profile").json()["open_hour"] == "07:30"


def test_partial_update_keeps_other_fields(client):
    """보낸 항목만 바뀐다 — 안 보낸 값이 기본값으로 덮이면 안 된다."""
    client.put("/api/v1/store/profile", json={
        "business_type": "베이커리", "open_hour": "07:30", "close_hour": "22:00",
    })
    client.put("/api/v1/store/profile", json={"open_hour": "08:00"})
    body = client.get("/api/v1/store/profile").json()
    assert body["open_hour"] == "08:00"
    assert body["business_type"] == "베이커리"  # 유지
    assert body["close_hour"] == "22:00"        # 유지


def test_overnight_hours_allowed(client):
    """자정을 넘겨 닫는 가게(10:00~02:00)도 저장돼야 한다."""
    res = client.put("/api/v1/store/profile", json={"open_hour": "10:00", "close_hour": "02:00"})
    assert res.status_code == 200
    assert res.json()["close_hour"] == "02:00"


@pytest.mark.parametrize("bad", ["9:00", "25:00", "09:60", "아침", "0900", ""])
def test_invalid_hour_rejected(client, bad):
    assert client.put("/api/v1/store/profile", json={"open_hour": bad}).status_code == 422


def test_blank_business_type_rejected(client):
    assert client.put("/api/v1/store/profile", json={"business_type": "   "}).status_code == 422


def test_profiles_are_per_account(client):
    """다른 사장님 설정이 섞이지 않는다."""
    client.put("/api/v1/store/profile", json={"business_type": "베이커리"})

    _signed_in["email"] = OTHER
    other = client.get("/api/v1/store/profile").json()
    assert other["business_type"] == "카페"   # 남의 값이 보이지 않는다
    assert other["configured"] is False

    _signed_in["email"] = OWNER
    assert client.get("/api/v1/store/profile").json()["business_type"] == "베이커리"
