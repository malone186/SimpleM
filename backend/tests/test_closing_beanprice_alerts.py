"""마감 리포트(규칙 5)·원두 시세 하락(규칙 6) 알림 테스트.

FCM은 실제로 쏘지 않는다 — push_service.send_to_store를 가로채 payload만 검증한다.
"""
import os
from datetime import datetime, timedelta

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./_test_alerts.db")
os.environ.setdefault("ALLOW_SQLITE_FALLBACK", "1")

from app.core.database import Base, engine, SessionLocal  # noqa: E402
import app.models  # noqa: E402,F401
from app.models.inventory import Ingredient, Menu, Sale, Stock  # noqa: E402
from app.models.roastery import RoasteryBean, Roastery  # noqa: E402
from app.services.ai import bean_price_watch_service as W  # noqa: E402
from app.services.ai import notification_service as N  # noqa: E402
from app.services.ai import push_service  # noqa: E402

STORE = "closing@test.com"
STORE_EMPTY = "closing_empty@test.com"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    Base.metadata.create_all(bind=engine)
    sent: list[dict] = []

    def fake_send(db, store_id, title, body, payload, urgent=False):
        sent.append({"store_id": store_id, "title": title, "body": body, "payload": payload})
        return 1  # 1대 발송 성공으로 취급 — _dispatch가 이력을 유지한다

    monkeypatch.setattr(push_service, "send_to_store", fake_send)
    monkeypatch.setattr(push_service, "is_configured", lambda: True)
    W._cache.update({"day": None, "drops": []})  # 하루 캐시 초기화
    yield sent


def _seed_sales(db, store_id: str):
    m = Menu(name="아메리카노", selling_price=4000, store_id=store_id)
    db.add(m); db.flush()
    db.add(Sale(menu_id=m.id, quantity=3, total_price=12000,
                store_id=store_id, sold_at=datetime.now()))
    ing = Ingredient(name="원두", unit="g", current_price=30000, store_id=store_id)
    db.add(ing); db.flush()
    db.add(Stock(ingredient_id=ing.id, current_quantity=1.0, safety_quantity=100.0))
    db.commit()
    return m


def test_closing_report_sends_once(_setup):
    sent = _setup
    db = SessionLocal()
    try:
        _seed_sales(db, STORE)
        settings = N.get_settings(db, STORE)
        late = datetime.now(N.KST).replace(hour=23, minute=0)

        assert N.check_closing(db, STORE, settings, late), "마감 후에는 발송돼야 한다"
        assert sent and sent[-1]["title"].startswith("🌙")
        assert "아메리카노" in sent[-1]["body"]          # 베스트 메뉴
        assert "재고 주의" in sent[-1]["body"]           # 안전재고 미달 재료
        # 같은 날 재실행 → dedupe로 침묵
        assert N.check_closing(db, STORE, settings, late) == []
        # 마감 전 시각이면 발송 안 함 (이력도 안 남김)
        early = late.replace(hour=8)
        assert N.check_closing(db, STORE_EMPTY, N.get_settings(db, STORE_EMPTY), early) == []
    finally:
        db.close()


def test_closing_report_reminds_on_empty_day(_setup):
    sent = _setup
    db = SessionLocal()
    try:
        settings = N.get_settings(db, STORE_EMPTY)
        late = datetime.now(N.KST).replace(hour=23, minute=0)
        assert N.check_closing(db, STORE_EMPTY, settings, late)
        assert "입력되지 않았어요" in sent[-1]["body"]   # 빈 날엔 리마인더
    finally:
        db.close()


def test_bean_price_drop_alert(_setup, monkeypatch):
    sent = _setup
    db = SessionLocal()
    try:
        r = Roastery(name="테스트로스터리")
        db.add(r); db.flush()
        b = RoasteryBean(name="에스메랄다 아길라 내추럴", price=100000,
                         roastery_id=r.id, product_url="https://example.com/1")
        db.add(b); db.commit()

        # 크롤 대신 12% 내린 현재가를 주입
        monkeypatch.setattr(W, "fetch_current_prices",
                            lambda: {W._norm(b.name): 88000})

        settings = N.get_settings(db, "beans@test.com")
        noon = datetime.now(N.KST).replace(hour=12, minute=0)
        assert N.check_bean_price(db, "beans@test.com", settings, noon)
        assert "−12" in sent[-1]["body"] and "88,000" in sent[-1]["body"]
        db.refresh(b)
        assert b.price == 88000                          # DB 가격도 갱신됨
        # 같은 날 재실행 → dedupe
        assert N.check_bean_price(db, "beans@test.com", settings, noon) == []
        # 오전 10시 전엔 안 봄
        assert N.check_bean_price(db, "early@test.com",
                                  N.get_settings(db, "early@test.com"),
                                  noon.replace(hour=9)) == []
    finally:
        db.close()


def test_bean_price_silent_without_drops(_setup, monkeypatch):
    sent = _setup
    db = SessionLocal()
    try:
        monkeypatch.setattr(W, "fetch_current_prices", lambda: {})
        W._cache.update({"day": None, "drops": []})
        settings = N.get_settings(db, "nodrop@test.com")
        noon = datetime.now(N.KST).replace(hour=12, minute=0)
        before = len(sent)
        assert N.check_bean_price(db, "nodrop@test.com", settings, noon) == []
        assert len(sent) == before                       # 하락 없으면 침묵
    finally:
        db.close()
