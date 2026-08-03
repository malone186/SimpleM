"""마감 리포트(규칙 5)·원두 시세 하락(규칙 6) 알림 테스트 — sqlite 인메모리 DB.

FCM은 실제로 쏘지 않는다 — push_service.send_to_store를 가로채 payload만 검증한다.

DB는 테스트마다 새 인메모리 sqlite를 만들고 SessionLocal을 갈아 끼운다.
(과거에는 os.environ.setdefault로 sqlite 파일을 지정했지만, 전체 스위트에서는
다른 테스트가 .env를 먼저 로드해 무력화됐다 — 그 결과 공유 DB에 발송 이력이 남아
같은 날 두 번째 실행부터 dedupe에 걸려 실패하는 테스트였다.)
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import Ingredient, Menu, Sale, Stock
from app.models.roastery import RoasteryBean, Roastery
from app.services.ai import bean_price_watch_service as W
from app.services.ai import notification_service as N
from app.services.ai import push_service

STORE = "closing@test.com"
STORE_EMPTY = "closing_empty@test.com"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    # 서비스들은 호출 시점에 core_db.SessionLocal을 읽으므로(각자의 _session())
    # 여기만 갈아 끼우면 내부에서 여는 세션까지 전부 이 인메모리 DB로 온다.
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    sent: list[dict] = []

    def fake_send(db, store_id, title, body, payload, urgent=False):
        sent.append({"store_id": store_id, "title": title, "body": body, "payload": payload})
        return 1  # 1대 발송 성공으로 취급 — _dispatch가 이력을 유지한다

    monkeypatch.setattr(push_service, "send_to_store", fake_send)
    monkeypatch.setattr(push_service, "is_configured", lambda: True)
    W._cache.update({"day": None, "drops": []})  # 하루 캐시 초기화
    yield sent
    engine.dispose()


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
    db = core_db.SessionLocal()
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
    db = core_db.SessionLocal()
    try:
        settings = N.get_settings(db, STORE_EMPTY)
        late = datetime.now(N.KST).replace(hour=23, minute=0)
        assert N.check_closing(db, STORE_EMPTY, settings, late)
        assert "입력되지 않았어요" in sent[-1]["body"]   # 빈 날엔 리마인더
    finally:
        db.close()


def test_bean_price_drop_alert(_setup, monkeypatch):
    sent = _setup
    db = core_db.SessionLocal()
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
    db = core_db.SessionLocal()
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
