"""관리자 로그인 DB(admin_accounts) 기반 검증 테스트 — sqlite 인메모리 + get_db 오버라이드"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import get_password_hash
from app.core.database import Base, get_db
from app.main import app
from app.models.ai import AdminAccount

ADMIN = "admin@simplem.com"


@pytest.fixture()
def client():
    # TestClient는 별도 스레드에서 앱을 돌리므로, 인메모리 DB를 스레드 간 공유하려면 StaticPool 필수
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app), TestSession
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def test_login_with_db_account(client):
    """DB에 저장된 계정이면 env와 무관하게 어느 컴퓨터에서든 로그인된다."""
    c, TestSession = client
    with TestSession() as db:
        db.add(AdminAccount(email=ADMIN, password_hash=get_password_hash("db-pass-123")))
        db.commit()

    res = c.post("/api/v1/admin/login", json={"email": ADMIN, "password": "db-pass-123"})
    assert res.status_code == 200
    assert res.json()["email"] == ADMIN
    assert res.json()["access_token"]


def test_login_wrong_password_401(client):
    c, TestSession = client
    with TestSession() as db:
        db.add(AdminAccount(email=ADMIN, password_hash=get_password_hash("db-pass-123")))
        db.commit()

    res = c.post("/api/v1/admin/login", json={"email": ADMIN, "password": "wrong"})
    assert res.status_code == 401


def test_login_env_fallback_migrates_to_db(client, monkeypatch):
    """DB 계정이 없으면 env 자격증명으로 1회 검증 후 DB 계정이 자동 생성된다."""
    import app.api.v1.admin as admin_api

    c, TestSession = client
    monkeypatch.setattr(admin_api, "ADMIN_PASSWORD", "env-secret-1")
    monkeypatch.setattr(admin_api, "ADMIN_EMAILS", [ADMIN])

    res = c.post("/api/v1/admin/login", json={"email": ADMIN, "password": "env-secret-1"})
    assert res.status_code == 200
    with TestSession() as db:
        assert db.query(AdminAccount).filter(AdminAccount.email == ADMIN).count() == 1

    # 이행 후에는 DB 해시로 검증된다 (env를 바꿔도 로그인 유지)
    monkeypatch.setattr(admin_api, "ADMIN_PASSWORD", "changed-env")
    res2 = c.post("/api/v1/admin/login", json={"email": ADMIN, "password": "env-secret-1"})
    assert res2.status_code == 200


def test_login_unconfigured_503(client, monkeypatch):
    import app.api.v1.admin as admin_api

    c, _ = client
    monkeypatch.setattr(admin_api, "ADMIN_PASSWORD", "")
    res = c.post("/api/v1/admin/login", json={"email": ADMIN, "password": "anything"})
    assert res.status_code == 503
