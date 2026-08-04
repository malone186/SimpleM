"""발주서 초안 생성 테스트 (백엔드 B) — 인메모리 sqlite

배경(실제 사고): 서류 화면에 '발주서 초안' 버튼이 있고, 챗봇 document_expert 설명과
chatbot.py 모듈 docstring도 발주서를 기능으로 광고하는데, 정작 만드는 코드가 어디에도
없었다. 프론트는 POST /chatbot/documents/purchase-order를 부르고 서버엔 그 라우트가
없어 405가 났다 — 버튼을 누르면 그냥 실패했다.

문서 content의 키(total_estimated·suggested_quantity·estimated_amount 등)는 프론트
documentLabels.ts가 이미 한글 라벨을 갖고 있는 이름이라, 그 이름을 그대로 써야
화면에 영문 키가 노출되지 않는다. 그 계약도 여기서 함께 고정한다.

DB는 테스트마다 새 인메모리 엔진 + SessionLocal monkeypatch로 격리한다
(공유 Neon DB를 건드리지 않는다).
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import Ingredient, Stock
from app.services.ai import document_service as ds

STORE = "po@test.com"
OTHER = "po-other@test.com"

# 프론트 documentLabels.ts가 한글 라벨을 갖고 있는 품목 키 — 바뀌면 화면에 영문이 뜬다
ITEM_KEYS = {
    "name", "unit", "current_quantity", "safety_quantity",
    "suggested_quantity", "unit_price", "estimated_amount",
}


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    # document_service._session()이 호출 시점에 core_db.SessionLocal을 읽는다
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _ingredient(db, name, unit="개", price=1000, store=STORE):
    ing = Ingredient(name=name, unit=unit, current_price=price, store_id=store)
    db.add(ing)
    db.commit()
    return ing


def _stock(db, ing, current, safety):
    db.add(Stock(ingredient_id=ing.id, current_quantity=current, safety_quantity=safety))
    db.commit()


def test_only_low_stock_items_are_included(db):
    """최소 보유량 이하만 담고, 넉넉한 재료는 빼야 한다."""
    low = _ingredient(db, "서울우유 1L", unit="팩", price=2580)
    plenty = _ingredient(db, "설탕", unit="kg", price=3000)
    _stock(db, low, current=2, safety=10)
    _stock(db, plenty, current=50, safety=5)

    content = ds.generate_purchase_order(STORE)["content"]
    names = [i["name"] for i in content["items"]]
    assert names == ["서울우유 1L"], "넉넉한 재료까지 발주서에 들어갔다"


def test_suggested_quantity_fills_up_to_safety(db):
    """제안 수량은 최소 보유량까지 채우는 부족분이고, 예상 금액은 수량×단가다."""
    ing = _ingredient(db, "에티오피아 원두", unit="kg", price=28000)
    _stock(db, ing, current=1, safety=4)

    item = ds.generate_purchase_order(STORE)["content"]["items"][0]
    assert item["suggested_quantity"] == 3       # 4 - 1
    assert item["estimated_amount"] == 84000     # 3 × 28,000
    assert item["current_quantity"] == 1
    assert item["safety_quantity"] == 4


def test_zero_safety_uses_default_threshold(db):
    """최소 보유량을 안 잡은 재료는 기본값으로 판정한다 — 홈 화면 재고 부족 규칙과 같은 값."""
    ing = _ingredient(db, "냅킨", unit="팩", price=1000)
    _stock(db, ing, current=0, safety=0)

    item = ds.generate_purchase_order(STORE)["content"]["items"][0]
    assert item["safety_quantity"] == ds.DEFAULT_SAFETY_QUANTITY
    assert item["suggested_quantity"] == ds.DEFAULT_SAFETY_QUANTITY


def test_item_at_threshold_still_gets_one_unit(db):
    """딱 기준선에 걸친 재료도 한 단위는 발주한다 — 0을 제안하면 문서에 있으나 마나다."""
    ing = _ingredient(db, "빨대", unit="봉", price=500)
    _stock(db, ing, current=5, safety=5)

    item = ds.generate_purchase_order(STORE)["content"]["items"][0]
    assert item["suggested_quantity"] == 1


def test_ingredient_without_stock_row_counts_as_empty(db):
    """Stock 행이 없는 재료는 0으로 본다 — 등록만 하고 입고를 안 한 재료가 누락되면 안 된다."""
    _ingredient(db, "휘핑크림", unit="개", price=4000)

    names = [i["name"] for i in ds.generate_purchase_order(STORE)["content"]["items"]]
    assert names == ["휘핑크림"]


def test_total_is_sum_of_items(db):
    """예상 총액은 품목 예상 금액의 합이다."""
    a = _ingredient(db, "원두", unit="kg", price=20000)
    b = _ingredient(db, "우유", unit="팩", price=3000)
    _stock(db, a, current=0, safety=2)   # 2 × 20,000 = 40,000
    _stock(db, b, current=1, safety=5)   # 4 ×  3,000 = 12,000

    content = ds.generate_purchase_order(STORE)["content"]
    assert content["total_estimated"] == 52000
    assert content["total_estimated"] == sum(i["estimated_amount"] for i in content["items"])


def test_missing_unit_price_is_disclosed_in_note(db):
    """단가가 없는 재료가 섞이면 총액이 실제보다 적다 — 그 사실을 문서에 밝혀야 한다."""
    ing = _ingredient(db, "종이컵", unit="개", price=0)
    _stock(db, ing, current=0, safety=100)

    note = ds.generate_purchase_order(STORE)["content"]["note"]
    assert "단가가 등록되지 않은" in note


def test_no_low_stock_raises_with_readable_reason(db):
    """담을 게 없으면 빈 문서를 만들지 말고 이유를 문장으로 알려야 한다 (API는 409로 전달)."""
    ing = _ingredient(db, "설탕", unit="kg", price=3000)
    _stock(db, ing, current=99, safety=5)

    with pytest.raises(ds.DocumentError) as e:
        ds.generate_purchase_order(STORE)
    assert "발주서에 담을 품목이 없습니다" in str(e.value)


def test_other_store_items_are_never_included(db):
    """다른 매장 재료가 섞이면 안 된다 (매장 격리)."""
    mine = _ingredient(db, "우리 원두", unit="kg", price=1000, store=STORE)
    theirs = _ingredient(db, "남의 원두", unit="kg", price=1000, store=OTHER)
    _stock(db, mine, current=0, safety=5)
    _stock(db, theirs, current=0, safety=5)

    names = [i["name"] for i in ds.generate_purchase_order(STORE)["content"]["items"]]
    assert names == ["우리 원두"]


def test_document_shape_matches_frontend_labels(db):
    """문서 kind와 품목 키가 프론트가 아는 이름이어야 한다 — 아니면 화면에 영문 키가 뜬다."""
    ing = _ingredient(db, "원두", unit="kg", price=20000)
    _stock(db, ing, current=0, safety=2)

    doc = ds.generate_purchase_order(STORE)
    assert doc["kind"] == "purchase_order"
    assert doc["status"] == "draft", "돈이 걸린 문서는 초안으로만 만든다"
    content = doc["content"]
    assert {"date", "items", "total_estimated", "note"} <= content.keys()
    assert set(content["items"][0].keys()) == ITEM_KEYS
