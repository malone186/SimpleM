"""근무 체크리스트 HTTP 계약 — 직원·사장 공유, 매일 초기화, 권한 분리.

검증하는 것:
  · 사장님이 항목을 만들고 직원이 그걸 본다(같은 매장 공유).
  · 직원이 체크하면 사장님도 '오늘 됐음 + 누가 했는지'를 본다(연동).
  · 항목 추가는 직원도 하고(현장에서 발견한 할 일), 수정·삭제는 사장님만(require_owner).
  · 체크 상태는 날짜로 관리돼 다음 날 초기화된다.
"""
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 — create_all이 모든 테이블을 만들게
from app.api.v1.checklist import router as checklist_router
from app.api.v1.staff_account import router as staff_router
from app.core.auth import create_access_token, get_password_hash
from app.core.database import Base, get_db
from app.core.staff_guard import staff_scope_middleware
from app.models.user import User
from app.services import checklist_service

engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                       poolclass=StaticPool)
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
OWNER = "owner@test.com"


@pytest.fixture()
def client():
    Base.metadata.create_all(bind=engine)
    session = TestingSession()
    session.add(User(email=OWNER, name="사장님", store_name="테스트카페",
                     hashed_password=get_password_hash("pw")))
    session.commit()

    app = FastAPI()
    app.middleware("http")(staff_scope_middleware)
    app.include_router(checklist_router, prefix="/api/v1")
    app.include_router(staff_router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: session
    with TestClient(app) as c:
        c.owner_token = create_access_token({"sub": OWNER})
        yield c
    session.close()
    Base.metadata.drop_all(bind=engine)


def _auth(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture()
def owner(client):
    return _auth(client.owner_token)


@pytest.fixture()
def staff(client, owner):
    r = client.post("/api/v1/staff-accounts",
                    json={"name": "박알바", "login_id": "alba01"}, headers=owner)
    pw = r.json()["initial_password"]
    login = client.post("/api/v1/staff-accounts/login",
                        json={"login_id": "alba01", "password": pw})
    return _auth(login.json()["access_token"])


def test_사장이_만든_항목을_직원이_본다(client, owner, staff):
    """같은 매장을 공유하므로 사장님이 등록한 루틴이 직원 화면에 그대로 뜬다."""
    client.post("/api/v1/checklist/items", json={"label": "마감 · 기계 청소"}, headers=owner)
    client.post("/api/v1/checklist/items", json={"label": "오픈 · 머신 예열"}, headers=owner)

    rows = client.get("/api/v1/checklist", headers=staff).json()

    assert [r["label"] for r in rows] == ["마감 · 기계 청소", "오픈 · 머신 예열"]
    assert all(r["done"] is False for r in rows)  # 아직 아무도 체크 안 함


def test_직원이_체크하면_사장에게_보인다(client, owner, staff):
    """연동의 핵심 — 직원이 체크하면 사장님이 '오늘 됐음 + 누가'를 본다."""
    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "화장실 점검"}, headers=owner).json()["id"]

    toggled = client.post(f"/api/v1/checklist/{item_id}/toggle", headers=staff)
    assert toggled.status_code == 200
    assert toggled.json()["done"] is True

    owner_view = client.get("/api/v1/checklist", headers=owner).json()[0]
    assert owner_view["done"] is True
    assert owner_view["done_by"] == "박알바"  # 누가 했는지까지 보인다


def test_체크는_토글이다(client, owner, staff):
    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "쓰레기 배출"}, headers=owner).json()["id"]

    client.post(f"/api/v1/checklist/{item_id}/toggle", headers=staff)
    off = client.post(f"/api/v1/checklist/{item_id}/toggle", headers=staff)
    assert off.json()["done"] is False
    assert client.get("/api/v1/checklist", headers=owner).json()[0]["done"] is False


def test_항목_수정_삭제는_사장만(client, owner, staff):
    """수정·삭제는 사장님 몫 — 직원이 기존 루틴을 바꾸거나 지우면 안 된다.
    (추가는 직원도 한다 — 아래 test_직원도_항목을_추가할_수_있다)"""
    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "정상 항목"}, headers=owner).json()["id"]
    assert client.patch(f"/api/v1/checklist/items/{item_id}",
                        json={"label": "바꿔치기"}, headers=staff).status_code == 403
    assert client.delete(f"/api/v1/checklist/items/{item_id}",
                         headers=staff).status_code == 403


def test_직원도_항목을_추가할_수_있다(client, owner, staff):
    """근무 중 발견한 할 일(가스 점검 등)을 그 자리에서 올린다 — 사장님 목록에도 보인다."""
    r = client.post("/api/v1/checklist/items",
                    json={"label": "제빙기 필터 점검"}, headers=staff)
    assert r.status_code == 201
    labels = [row["label"] for row in client.get("/api/v1/checklist", headers=owner).json()]
    assert "제빙기 필터 점검" in labels


def test_특정_직원에게_업무를_지정한다(client, owner, staff):
    """사장님이 담당 직원을 지정하면 응답·목록에 담당 이름이 실린다 (직원 화면에도 동일)."""
    staff_id = client.get("/api/v1/staff-accounts", headers=owner).json()[0]["id"]
    r = client.post("/api/v1/checklist/items",
                    json={"label": "우유 발주 확인", "assigned_staff_id": staff_id}, headers=owner)
    assert r.status_code == 201
    assert r.json()["assigned_staff_name"] == "박알바"

    rows = client.get("/api/v1/checklist", headers=staff).json()
    mine = next(row for row in rows if row["label"] == "우유 발주 확인")
    assert mine["assigned_staff_id"] == staff_id
    assert mine["assigned_staff_name"] == "박알바"


def test_남의_매장_직원은_담당으로_지정할_수_없다(client, owner, staff):
    """존재하지 않거나 우리 매장이 아닌 staff id는 400 — 임의 id 꽂기 방지."""
    r = client.post("/api/v1/checklist/items",
                    json={"label": "이상한 지정", "assigned_staff_id": 999999}, headers=owner)
    assert r.status_code == 400


def test_직원은_체크만_할_수_있다(client, owner, staff):
    """관리는 막지만 체크 자체는 직원의 일이라 열려 있어야 한다."""
    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "오픈 준비"}, headers=owner).json()["id"]
    assert client.post(f"/api/v1/checklist/{item_id}/toggle", headers=staff).status_code == 200


def test_다음날은_초기화된다(client, owner, staff, monkeypatch):
    """체크 상태는 날짜로 관리된다 — 어제 체크가 오늘로 넘어오면 안 된다."""
    from datetime import datetime, timezone

    base = datetime(2026, 8, 7, 10, 0, tzinfo=timezone(timedelta(hours=9)))
    monkeypatch.setattr(checklist_service, "_today", lambda: base.date())

    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "마감 청소"}, headers=owner).json()["id"]
    client.post(f"/api/v1/checklist/{item_id}/toggle", headers=staff)
    assert client.get("/api/v1/checklist", headers=owner).json()[0]["done"] is True

    # 하루 뒤 — 어제 체크는 딸려 오지 않는다
    monkeypatch.setattr(checklist_service, "_today", lambda: (base + timedelta(days=1)).date())
    assert client.get("/api/v1/checklist", headers=owner).json()[0]["done"] is False


def test_비활성_항목은_숨는다(client, owner):
    """지우는 대신 끄면 목록에서 빠지되 기록은 남는다."""
    item_id = client.post("/api/v1/checklist/items",
                          json={"label": "겨울 한정 루틴"}, headers=owner).json()["id"]
    client.patch(f"/api/v1/checklist/items/{item_id}",
                 json={"active": False}, headers=owner)
    assert client.get("/api/v1/checklist", headers=owner).json() == []
