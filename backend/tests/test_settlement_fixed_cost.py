"""정산 API가 고정비 누락을 표시하는지 — 인메모리 sqlite.

정산 카드는 매출·비용·인건비를 빼고 '순이익'을 크게 띄운다. 그런데 지출(Expense)은
사장님이 손으로 넣는 표라 임대료가 대개 없다. 그 상태의 금액을 순이익이라 부르면
월세 200만원 매장은 200만원을 벌고 있다고 믿게 된다.

경영 리포트와 같은 규칙(cost_basis)을 써야 한다 — 두 화면이 다르게 말하면 안 된다.
"""
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.auth import get_current_user_optional
from app.core.database import Base, get_db
from app.main import app
from app.models.inventory import Sale, Menu
from app.models.operation import Expense
from app.models.user import User

PERIOD = {"period_start": "2026-07-01", "period_end": "2026-07-31"}
STORE = "cafe@test.com"  # menus.store_id가 NOT NULL이라 실제 값이 필요하다
# 기간 집계는 이제 로그인 필수(2026-08-06 보안 수정) — 로그인 매장 몫만 집계된다


@pytest.fixture()
def client():
    # StaticPool이 없으면 인메모리 sqlite는 스레드마다 별도 DB가 된다 —
    # TestClient는 동기 엔드포인트를 워커 스레드에서 돌리므로 빈 DB를 보게 된다.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()

    def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    # 기간 정산은 로그인 필수 — STORE 매장 사장님으로 로그인한 것으로 친다
    app.dependency_overrides[get_current_user_optional] = lambda: User(
        id=1, email=STORE, name="테스트", hashed_password="x")
    yield TestClient(app), session
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user_optional, None)
    session.close()
    engine.dispose()


def _seed(db, categories):
    menu = Menu(name="라떼", selling_price=5_000, store_id=STORE)
    db.add(menu)
    db.commit()
    db.add(Sale(menu_id=menu.id, quantity=10, total_price=50_000, store_id=STORE,
                sold_at=datetime(2026, 7, 10, 10, 0)))
    for c in categories:
        db.add(Expense(store_id=STORE, amount=10_000, category=c,
                       expense_date=date(2026, 7, 10)))
    db.commit()


def _calc(client, payload):
    r = client.post("/api/v1/operation/settlements/calculate", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_variable_cost_only_flags_missing_fixed_cost(client):
    """원두매입·소모품만 있으면 임대료가 없는 것이다 — 화면이 '순이익'이라 쓰면 안 된다."""
    c, db = client
    _seed(db, ["원두매입", "소모품"])

    assert _calc(c, PERIOD)["fixed_cost_missing"] is True


def test_rent_clears_the_flag(client):
    """임대료가 하나라도 들어오면 순이익이라 불러도 된다."""
    c, db = client
    _seed(db, ["원두매입", "임대료"])

    assert _calc(c, PERIOD)["fixed_cost_missing"] is False


def test_manual_input_is_not_flagged(client):
    """수동 입력은 사장님이 직접 넣은 숫자라 무엇이 들었는지 알 수 없다 — 경고하지 않는다."""
    c, _ = client

    data = _calc(c, {"revenue": 5_000_000, "cost": 1_500_000, "labor_cost": 1_200_000})

    assert data["fixed_cost_missing"] is False
    assert data["net_profit"] == 2_300_000


def test_no_expenses_at_all_is_flagged(client):
    """지출이 아예 비어 있어도 당연히 고정비 미등록이다."""
    c, db = client
    _seed(db, [])

    assert _calc(c, PERIOD)["fixed_cost_missing"] is True
