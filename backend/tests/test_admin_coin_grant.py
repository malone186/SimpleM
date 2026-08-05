"""관리자 콘솔 코인 지급 테스트 (백엔드 B)

코인은 원래 '할 일을 실제로 끝냈을 때'만 쌓인다. 관리자 지급은 CS 보상·이벤트·오지급
회수를 위한 예외 창구라, 여기서 보는 건 두 가지다 — 잔액이 원장과 어긋나지 않는가,
그리고 사장님 상점 내역에 출처가 '관리자 지급/회수'로 남는가.
"""
import pytest
from fastapi.testclient import TestClient

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.auth import get_current_admin
from app.main import app
from app.models.user import User

TEST_EMAIL = "admin-coin@test.com"


@pytest.fixture()
def user_id():
    """지급 대상 임시 회원 — 실제 사장님 계정 원장을 건드리지 않는다."""
    from app.models.ai import PointLedger
    from app.services.ai.reward_service import _session

    def _wipe(db):
        db.query(PointLedger).filter(PointLedger.store_id == TEST_EMAIL).delete()
        db.query(User).filter(User.email == TEST_EMAIL).delete()
        db.commit()

    with _session() as db:
        _wipe(db)
        row = User(email=TEST_EMAIL, name="테스트", store_name="테스트 카페", hashed_password="x")
        db.add(row)
        db.commit()
        db.refresh(row)
        uid = row.id

    yield uid

    with _session() as db:
        _wipe(db)


@pytest.fixture()
def client():
    app.dependency_overrides[get_current_admin] = lambda: User(
        id=0, email="admin@simplem.com", name="관리자", hashed_password="x"
    )
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _grant(client, uid, amount, memo=""):
    return client.post(f"/api/v1/admin/users/{uid}/coins", json={"amount": amount, "memo": memo})


def test_grant_adds_coins_with_source_label(client, user_id):
    """지급하면 잔액이 늘고, 내역에 '관리자 지급 · 사유'로 남는다."""
    res = _grant(client, user_id, 500, "CS 보상")
    assert res.status_code == 200
    body = res.json()
    assert body["granted"] == 500
    assert body["balance"] == 500
    assert body["history"][0]["reason_label"] == "관리자 지급"
    assert body["history"][0]["memo"] == "CS 보상"


def test_revoke_uses_its_own_label(client, user_id):
    """음수는 회수다 — 잔액이 줄고 내역 라벨이 지급과 구분된다."""
    _grant(client, user_id, 500, "이벤트 당첨")
    body = _grant(client, user_id, -200, "오지급 회수").json()
    assert body["balance"] == 300
    assert body["history"][0]["reason_label"] == "관리자 회수"


def test_same_amount_can_be_granted_twice(client, user_id):
    """할 일 완료와 달리 멱등이 아니다 — 같은 금액을 두 번 주면 두 번 다 들어간다."""
    _grant(client, user_id, 100, "1회차")
    assert _grant(client, user_id, 100, "2회차").json()["balance"] == 200


def test_cannot_revoke_below_zero(client, user_id):
    """잔액보다 많이 회수하면 400 — 원장 합이 음수면 상점의 '부족한 코인'이 이상해진다."""
    _grant(client, user_id, 100, "지급")
    res = _grant(client, user_id, -500)
    assert res.status_code == 400
    assert client.get(f"/api/v1/admin/users/{user_id}/coins").json()["balance"] == 100


def test_zero_and_oversized_amounts_rejected(client, user_id):
    """0은 의미가 없고, 한도 초과는 오타로 잔액이 터무니없어지는 걸 막는다."""
    assert _grant(client, user_id, 0).status_code == 400
    assert _grant(client, user_id, 1_000_000).status_code == 400
    assert client.get(f"/api/v1/admin/users/{user_id}/coins").json()["balance"] == 0


def test_unknown_user_is_404(client):
    assert _grant(client, 99_999_999, 100).status_code == 404


def test_granted_coins_show_up_in_owner_wallet(client, user_id):
    """관리자가 넣은 코인을 사장님 앱(상점 지갑)이 그대로 본다 — 같은 원장이어야 한다."""
    from app.services.ai import reward_service

    _grant(client, user_id, 250, "이벤트 보상")
    wallet = reward_service.get_wallet(TEST_EMAIL)
    assert wallet["balance"] == 250
    assert wallet["history"][0]["memo"] == "이벤트 보상"


def test_user_list_reports_balance(client, user_id):
    """회원 목록의 '보유 코인' 열도 같은 값을 본다."""
    _grant(client, user_id, 700, "지급")
    row = next(u for u in client.get("/api/v1/admin/users").json() if u["email"] == TEST_EMAIL)
    assert row["coins"] == 700
