"""할 일 API 통합 테스트 (백엔드 B) — 엔드포인트가 실제로 붙는지 확인

서비스 로직은 test_todo_service.py가 본다. 여기서는 인증·상태코드·매장 격리처럼
엔드포인트를 거쳐야만 드러나는 것만 확인한다.
"""
import pytest
from fastapi.testclient import TestClient

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.auth import get_current_user
from app.main import app
from app.models.user import User

STORE = "todo-api@test.com"
OTHER = "todo-api-other@test.com"


def _as(email: str):
    """로그인 사용자를 갈아끼운다 — 실제 토큰 발급 없이 매장 격리만 본다."""
    return lambda: User(id=1, email=email, name="테스트", hashed_password="x")


@pytest.fixture()
def client():
    app.dependency_overrides[get_current_user] = _as(STORE)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _cleanup(email: str):
    from app.services.ai import todo_service

    for t in todo_service.list_todos(email):
        todo_service.delete_todo(email, t["id"])


@pytest.fixture(autouse=True)
def clean():
    _cleanup(STORE)
    _cleanup(OTHER)
    yield
    _cleanup(STORE)
    _cleanup(OTHER)


def test_crud_roundtrip(client):
    created = client.post("/api/v1/chatbot/todos", json={"title": "원두 발주"})
    assert created.status_code == 201
    todo = created.json()
    assert todo["source"] == "owner"      # API로 들어온 건 사장님 직접 입력
    assert todo["done"] is False

    listed = client.get("/api/v1/chatbot/todos")
    assert listed.status_code == 200
    assert [t["title"] for t in listed.json()] == ["원두 발주"]

    patched = client.patch(f"/api/v1/chatbot/todos/{todo['id']}", json={"done": True})
    assert patched.status_code == 200
    assert patched.json()["done"] is True
    assert patched.json()["title"] == "원두 발주"   # 안 보낸 필드는 그대로

    assert client.delete(f"/api/v1/chatbot/todos/{todo['id']}").status_code == 204
    assert client.get("/api/v1/chatbot/todos").json() == []


def test_empty_title_rejected(client):
    assert client.post("/api/v1/chatbot/todos", json={"title": "   "}).status_code == 400
    # 스키마 단계에서 걸리는 경우 (빈 문자열)
    assert client.post("/api/v1/chatbot/todos", json={"title": ""}).status_code == 422


def test_bad_due_date_rejected(client):
    r = client.post("/api/v1/chatbot/todos", json={"title": "발주", "due_date": "2026/07/29"})
    assert r.status_code == 422


def test_missing_todo_is_404(client):
    assert client.patch("/api/v1/chatbot/todos/999999", json={"done": True}).status_code == 404
    assert client.delete("/api/v1/chatbot/todos/999999").status_code == 404


def test_other_store_cannot_touch_my_todo(client):
    mine = client.post("/api/v1/chatbot/todos", json={"title": "내 할 일"}).json()

    # 다른 계정으로 로그인한 상태로 같은 id를 건드려 본다
    app.dependency_overrides[get_current_user] = _as(OTHER)
    assert client.get("/api/v1/chatbot/todos").json() == []          # 남의 할 일은 안 보이고
    assert client.patch(f"/api/v1/chatbot/todos/{mine['id']}", json={"done": True}).status_code == 404
    assert client.delete(f"/api/v1/chatbot/todos/{mine['id']}").status_code == 404

    app.dependency_overrides[get_current_user] = _as(STORE)
    assert client.get("/api/v1/chatbot/todos").json()[0]["done"] is False   # 그대로 살아 있다
