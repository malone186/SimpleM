# -*- coding: utf-8 -*-
"""POS 실시간 연동 테스트 (백엔드 B)

외부(Square) 호출은 전부 monkeypatch — 여기서 검증하는 건 우리 쪽 계약이다:
  · 연결 저장 시 토큰 검증·암호화·마스킹
  · 주문 → 매출 기록 + 레시피 재고 차감 + 온도 꼬리표 매칭
  · 웹훅 서명 검증(정상/위조)과 중복 주문 방지(웹훅+폴링 이중 수신)
"""
import base64
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

import app.models  # noqa: F401
from app.core.auth import get_current_user
from app.core.database import SessionLocal
from app.main import app
from app.models.ai import PosConnection, PosSyncedOrder
from app.models.inventory import Ingredient, Menu, Recipe, Sale, Stock, StockTransaction
from app.models.user import User
from app.services import pos_service

STORE = "pos-test@test.com"


def _as(email: str):
    return lambda: User(id=1, email=email, name="포스테스트", hashed_password="x")


@pytest.fixture()
def client():
    app.dependency_overrides[get_current_user] = _as(STORE)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _cleanup():
    with SessionLocal() as db:
        ing_ids = [i.id for i in db.query(Ingredient).filter(Ingredient.store_id == STORE).all()]
        menu_ids = [m.id for m in db.query(Menu).filter(Menu.store_id == STORE).all()]
        if ing_ids:
            db.query(StockTransaction).filter(StockTransaction.ingredient_id.in_(ing_ids)).delete(synchronize_session=False)
            db.query(Stock).filter(Stock.ingredient_id.in_(ing_ids)).delete(synchronize_session=False)
        if menu_ids:
            db.query(Recipe).filter(Recipe.menu_id.in_(menu_ids)).delete(synchronize_session=False)
        db.query(Sale).filter(Sale.store_id == STORE).delete(synchronize_session=False)
        if menu_ids:
            db.query(Menu).filter(Menu.id.in_(menu_ids)).delete(synchronize_session=False)
        if ing_ids:
            db.query(Ingredient).filter(Ingredient.id.in_(ing_ids)).delete(synchronize_session=False)
        db.query(PosSyncedOrder).filter(PosSyncedOrder.store_id == STORE).delete(synchronize_session=False)
        db.query(PosConnection).filter(PosConnection.store_id == STORE).delete(synchronize_session=False)
        db.commit()


@pytest.fixture(autouse=True)
def clean():
    _cleanup()
    yield
    _cleanup()


def _seed_menu_with_recipe() -> tuple[int, int]:
    """아메리카노 메뉴 + 원두 0.02kg 레시피 + 재고 10kg을 심는다."""
    with SessionLocal() as db:
        ing = Ingredient(name="POS원두", unit="kg", current_price=20000, store_id=STORE)
        db.add(ing)
        db.flush()
        db.add(Stock(ingredient_id=ing.id, current_quantity=10.0))
        menu = Menu(name="아메리카노", selling_price=4000, store_id=STORE, is_active=True)
        db.add(menu)
        db.flush()
        db.add(Recipe(menu_id=menu.id, ingredient_id=ing.id, quantity=0.02))
        db.commit()
        return menu.id, ing.id


def _order(order_id: str, name: str = "아메리카노(ICE)", qty: int = 2, amount: int = 8000, state: str = "COMPLETED") -> dict:
    return {
        "id": order_id,
        "state": state,
        "created_at": "2026-07-30T09:12:00Z",
        "line_items": [{"name": name, "quantity": str(qty), "total_money": {"amount": amount, "currency": "KRW"}}],
    }


# ---------------------------------------------------------------------------
# 1) 연결 저장 — 토큰 검증(모의) · 마스킹 · merchant_id 저장
# ---------------------------------------------------------------------------

def test_connection_put_get_masking(client, monkeypatch):
    async def fake_merchant(token, env):
        assert token == "sq-test-token-abcdef"
        return "MERCH_1"

    monkeypatch.setattr(pos_service, "fetch_merchant_id", fake_merchant)

    r = client.put("/api/v1/pos/connection", json={
        "provider": "square", "environment": "sandbox",
        "access_token": "sq-test-token-abcdef",
        "webhook_signature_key": "whsec_123456",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["connected"] is True
    assert body["merchant_id"] == "MERCH_1"
    assert body["webhook_configured"] is True
    assert "sq-t" in body["access_token_masked"] and "cdef" in body["access_token_masked"]
    assert "sq-test-token-abcdef" not in json.dumps(body)  # 원문 토큰은 절대 응답에 없다
    assert body["webhook_url"].endswith("/api/v1/pos/webhook/square")

    r2 = client.get("/api/v1/pos/connection")
    assert r2.status_code == 200 and r2.json()["connected"] is True


def test_connection_put_rejects_bad_token(client, monkeypatch):
    async def bad_merchant(token, env):
        raise pos_service.PosError("Square 토큰이 유효하지 않습니다 (401).")

    monkeypatch.setattr(pos_service, "fetch_merchant_id", bad_merchant)
    r = client.put("/api/v1/pos/connection", json={
        "provider": "square", "environment": "sandbox", "access_token": "wrong-token-xxxx",
    })
    assert r.status_code == 400
    with SessionLocal() as db:  # 잘못된 토큰은 저장되지 않는다
        assert db.query(PosConnection).filter(PosConnection.store_id == STORE).first() is None


# ---------------------------------------------------------------------------
# 2) 동기화 — 매출 기록·재고 차감·온도 꼬리표 매칭·중복 방지
# ---------------------------------------------------------------------------

def test_sync_now_records_sales_and_dedups(client, monkeypatch):
    menu_id, ing_id = _seed_menu_with_recipe()

    async def fake_merchant(token, env):
        return "MERCH_2"

    async def fake_orders(token, env, start_at, end_at):
        return [_order("ORDER_A"), _order("ORDER_B", name="미등록라떼", qty=1, amount=5000)]

    monkeypatch.setattr(pos_service, "fetch_merchant_id", fake_merchant)
    monkeypatch.setattr(pos_service, "_fetch_orders", fake_orders)

    client.put("/api/v1/pos/connection", json={
        "provider": "square", "environment": "sandbox", "access_token": "sq-tok-11112222",
    })
    r = client.post("/api/v1/pos/sync-now")
    assert r.status_code == 200, r.text
    res = r.json()
    # ORDER_A: '아메리카노(ICE)' → 온도 꼬리표 무시 매칭 / ORDER_B: 미등록 메뉴라 매출 미기록
    assert res["orders_seen"] == 2 and res["orders_synced"] == 1
    assert res["sales_created"] == 1 and res["total_amount"] == 8000
    assert res["unmatched_items"] == [{"name": "미등록라떼", "quantity": 1}]

    with SessionLocal() as db:
        sale = db.query(Sale).filter(Sale.store_id == STORE).one()
        assert sale.menu_id == menu_id and sale.quantity == 2 and sale.total_price == 8000
        stock = db.query(Stock).filter(Stock.ingredient_id == ing_id).one()
        assert abs(stock.current_quantity - (10.0 - 0.02 * 2)) < 1e-9  # 레시피 차감
        # 미등록 주문도 '본 주문'으로 대장에 남아 재유입돼도 다시 안 돈다
        assert db.query(PosSyncedOrder).filter(PosSyncedOrder.store_id == STORE).count() == 2

    # 같은 주문이 다시 와도(폴링 겹침) 매출이 늘지 않는다
    r2 = client.post("/api/v1/pos/sync-now", params={"hours": 24})
    assert r2.status_code == 200
    assert r2.json()["orders_skipped_duplicate"] == 2 and r2.json()["sales_created"] == 0
    with SessionLocal() as db:
        assert db.query(Sale).filter(Sale.store_id == STORE).count() == 1


def test_sync_now_without_connection_409(client):
    r = client.post("/api/v1/pos/sync-now")
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# 3) 웹훅 — 서명 검증과 즉시 반영, 위조 거부
# ---------------------------------------------------------------------------

def _sign(key: str, url: str, body: bytes) -> str:
    return base64.b64encode(hmac.new(key.encode(), url.encode() + body, hashlib.sha256).digest()).decode()


def test_webhook_signature_roundtrip():
    key, url, body = "whsec_abc", "https://api.example.com/api/v1/pos/webhook/square", b'{"x":1}'
    sig = _sign(key, url, body)
    assert pos_service.verify_square_signature(key, url, body, sig) is True
    assert pos_service.verify_square_signature(key, url, body, "forged") is False
    assert pos_service.verify_square_signature("other", url, body, sig) is False


def test_webhook_records_order_once(client, monkeypatch):
    _seed_menu_with_recipe()

    async def fake_merchant(token, env):
        return "MERCH_HOOK"

    async def fake_order(token, env, order_id):
        assert order_id == "HOOK_ORDER_1"
        return _order(order_id, state="OPEN")  # sandbox는 OPEN도 반영 대상

    monkeypatch.setattr(pos_service, "fetch_merchant_id", fake_merchant)
    monkeypatch.setattr(pos_service, "_fetch_order", fake_order)

    put = client.put("/api/v1/pos/connection", json={
        "provider": "square", "environment": "sandbox",
        "access_token": "sq-tok-hookhook", "webhook_signature_key": "whsec_hook",
    })
    hook_url = put.json()["webhook_url"]

    event = json.dumps({
        "merchant_id": "MERCH_HOOK", "type": "order.created",
        "data": {"type": "order_created", "object": {"order_created": {"order_id": "HOOK_ORDER_1"}}},
    }).encode()
    sig = _sign("whsec_hook", hook_url, event)

    r = client.post("/api/v1/pos/webhook/square", content=event,
                    headers={"x-square-hmacsha256-signature": sig, "content-type": "application/json"})
    assert r.status_code == 200, r.text
    assert r.json()["handled"] is True and r.json()["sales_created"] == 1

    # 같은 주문 웹훅 재전송(Square 재시도) → 중복 기록 없음
    r2 = client.post("/api/v1/pos/webhook/square", content=event,
                     headers={"x-square-hmacsha256-signature": sig, "content-type": "application/json"})
    assert r2.status_code == 200 and r2.json()["sales_created"] == 0
    with SessionLocal() as db:
        assert db.query(Sale).filter(Sale.store_id == STORE).count() == 1

    # 위조 서명은 400으로 거부
    r3 = client.post("/api/v1/pos/webhook/square", content=event,
                     headers={"x-square-hmacsha256-signature": "forged", "content-type": "application/json"})
    assert r3.status_code == 400
