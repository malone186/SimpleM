"""포인트 적립 API 테스트 (백엔드 B) — 게임화 보상

특히 '자동 도출 할 일' 경로를 본다. 재고 부족·서류 갱신·브루 추천은 todo_items에
행이 없어 완료 API를 탈 수 없다 — 앱이 /rewards/todo-done으로 따로 알린다.
같은 항목을 여러 번 체크해도 코인이 한 번만 쌓이는지가 핵심이다.
"""
import pytest
from fastapi.testclient import TestClient

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.auth import get_current_user
from app.main import app
from app.models.user import User

STORE = "reward-api@test.com"
OTHER = "reward-api-other@test.com"


def _as(email: str):
    return lambda: User(id=1, email=email, name="테스트", hashed_password="x")


@pytest.fixture()
def client():
    app.dependency_overrides[get_current_user] = _as(STORE)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _cleanup(email: str):
    from app.models.ai import PointLedger
    from app.services.ai.reward_service import _session

    with _session() as db:
        db.query(PointLedger).filter(PointLedger.store_id == email).delete()
        db.commit()


@pytest.fixture(autouse=True)
def clean():
    _cleanup(STORE)
    _cleanup(OTHER)
    yield
    _cleanup(STORE)
    _cleanup(OTHER)


def test_derived_todo_awards_once(client):
    """재고 발주 같은 자동 도출 항목도 코인이 쌓인다 — 단, 항목당 한 번만."""
    body = {"key": "stock-42", "title": "에티오피아 원두 발주"}

    first = client.post("/api/v1/rewards/todo-done", json=body)
    assert first.status_code == 200
    assert first.json() == {"awarded": 10, "balance": 10}

    # 체크를 껐다 켜면 같은 key가 다시 온다 — 잔액은 그대로여야 한다
    second = client.post("/api/v1/rewards/todo-done", json=body)
    assert second.status_code == 200
    assert second.json() == {"awarded": 0, "balance": 10}


def test_different_items_stack(client):
    """서로 다른 항목은 각각 쌓인다 (재고·서류·브루 추천이 섞여도)."""
    for key, title in [
        ("stock-1", "우유 발주"),
        ("comp-3", "보건증 갱신"),
        ("insight-renewal:3:2026-08-10", "영업신고증 갱신 준비"),
        ("promo-main", "홍보할 메뉴 고르기"),
    ]:
        assert client.post("/api/v1/rewards/todo-done", json={"key": key, "title": title}).json()["awarded"] == 10

    assert client.get("/api/v1/rewards/wallet").json()["balance"] == 40


def test_saved_todo_and_derived_key_do_not_collide(client):
    """저장된 할 일은 ref가 숫자 id, 자동 도출은 'k:' 접두어 — 서로를 막지 않는다."""
    from app.services.ai import reward_service

    assert reward_service.award_todo_done(STORE, 7, "직접 적은 할 일") is True
    assert client.post("/api/v1/rewards/todo-done", json={"key": "7", "title": "우연히 같은 키"}).json()["awarded"] == 10
    assert client.get("/api/v1/rewards/wallet").json()["balance"] == 20


def test_history_labels_todo_done(client):
    """상점 하단 내역에 '할 일 완료'로 뜬다 — 제목이 그대로 남아야 무슨 일이었는지 안다."""
    client.post("/api/v1/rewards/todo-done", json={"key": "stock-9", "title": "우유 발주"})

    entry = client.get("/api/v1/rewards/wallet").json()["history"][0]
    assert entry["reason_label"] == "할 일 완료"
    assert entry["memo"] == "우유 발주"
    assert entry["delta"] == 10


def test_long_insight_keys_stay_distinct(client):
    """긴 인사이트 키는 ref(64자)에 안 들어간다 — 앞부분이 같아도 서로 다른 항목이어야 한다."""
    base = "insight-renewal:" + "x" * 60
    assert client.post("/api/v1/rewards/todo-done", json={"key": base + ":2026-08-10", "title": "서류 A 갱신"}).json()["awarded"] == 10
    assert client.post("/api/v1/rewards/todo-done", json={"key": base + ":2026-09-30", "title": "서류 B 갱신"}).json()["awarded"] == 10
    assert client.get("/api/v1/rewards/wallet").json()["balance"] == 20


def test_blank_key_rejected(client):
    """식별자가 비면 400 — 빈 ref로 원장을 오염시키면 이후 적립이 전부 막힌다."""
    assert client.post("/api/v1/rewards/todo-done", json={"key": "   ", "title": "무언가"}).status_code == 400
    assert client.post("/api/v1/rewards/todo-done", json={"key": "", "title": "무언가"}).status_code == 422


def test_other_store_cannot_see_my_coins(client):
    """매장 격리 — 같은 key라도 매장이 다르면 각자 쌓인다."""
    client.post("/api/v1/rewards/todo-done", json={"key": "stock-1", "title": "우유 발주"})

    app.dependency_overrides[get_current_user] = _as(OTHER)
    other = client.post("/api/v1/rewards/todo-done", json={"key": "stock-1", "title": "우유 발주"})
    assert other.json() == {"awarded": 10, "balance": 10}

    app.dependency_overrides[get_current_user] = _as(STORE)
    assert client.get("/api/v1/rewards/wallet").json()["balance"] == 10
