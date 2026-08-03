"""기존 메뉴에 레시피 설정(set_menu_recipes) 테스트 — 인메모리 sqlite.

매출 파일에서 이름만 등록된 메뉴에 나중에 레시피를 붙여 재고 차감을 켜는 흐름을 검증한다.
저장(재고 차감)까지 실제로 이어지는지 sales_import_service.save_import로 확인한다.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import Ingredient, Menu, Recipe, Stock
from app.schemas.inventory import RecipeCreate
from app.services import inventory_service as inv
from app.services.ai import sales_import_service as S
from fastapi import HTTPException

STORE = "cafe@test.com"
OTHER = "other@test.com"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _menu(db, name="아메리카노", store=STORE):
    m = Menu(name=name, selling_price=4000, store_id=store)
    db.add(m); db.commit()
    return m


def _ingredient(db, name="원두", store=STORE, qty=1000.0):
    ing = Ingredient(name=name, unit="g", current_price=100, store_id=store)
    db.add(ing); db.commit()
    db.add(Stock(ingredient_id=ing.id, current_quantity=qty, safety_quantity=0.0)); db.commit()
    return ing


def test_set_recipes_then_deduction_works(db):
    """이름만 있던 메뉴에 레시피를 설정하면, 이후 매출 저장에서 재고가 차감된다."""
    m = _menu(db)
    bean = _ingredient(db, "원두", qty=1000.0)
    assert db.query(Recipe).count() == 0  # 처음엔 레시피 없음

    inv.set_menu_recipes(db, STORE, m.id, [RecipeCreate(ingredient_id=bean.id, quantity=20.0)])
    assert db.query(Recipe).filter(Recipe.menu_id == m.id).count() == 1

    # 이제 저장하면 20g × 2잔 = 40g 차감
    S.save_import(STORE, [{"menu_id": m.id, "quantity": 2, "total_price": 8000, "sold_at": None}])
    stock = db.query(Stock).filter(Stock.ingredient_id == bean.id).first()
    assert stock.current_quantity == 960.0


def test_set_recipes_replaces_existing(db):
    """레시피 설정은 교체다 — 기존 레시피를 지우고 새 구성으로 바꾼다."""
    m = _menu(db)
    bean = _ingredient(db, "원두", qty=1000.0)
    milk = _ingredient(db, "우유", qty=1000.0)
    db.add(Recipe(menu_id=m.id, ingredient_id=bean.id, quantity=20.0)); db.commit()

    inv.set_menu_recipes(db, STORE, m.id, [RecipeCreate(ingredient_id=milk.id, quantity=150.0)])
    rows = db.query(Recipe).filter(Recipe.menu_id == m.id).all()
    assert len(rows) == 1 and rows[0].ingredient_id == milk.id and rows[0].quantity == 150.0


def test_set_recipes_rejects_cross_store_menu(db):
    """다른 매장 메뉴에는 설정할 수 없다(404)."""
    other = _menu(db, store=OTHER)
    bean = _ingredient(db, "원두")
    with pytest.raises(HTTPException) as ei:
        inv.set_menu_recipes(db, STORE, other.id, [RecipeCreate(ingredient_id=bean.id, quantity=20.0)])
    assert ei.value.status_code == 404


def test_set_recipes_rejects_cross_store_ingredient(db):
    """다른 매장 재료로는 레시피를 걸 수 없다(400), 그리고 아무것도 안 바뀐다."""
    m = _menu(db)
    other_bean = _ingredient(db, "원두", store=OTHER)
    with pytest.raises(HTTPException) as ei:
        inv.set_menu_recipes(db, STORE, m.id, [RecipeCreate(ingredient_id=other_bean.id, quantity=20.0)])
    assert ei.value.status_code == 400
    assert db.query(Recipe).count() == 0


def test_set_empty_recipes_clears(db):
    """빈 목록으로 설정하면 레시피가 비워진다(차감 꺼짐)."""
    m = _menu(db)
    bean = _ingredient(db, "원두")
    db.add(Recipe(menu_id=m.id, ingredient_id=bean.id, quantity=20.0)); db.commit()

    inv.set_menu_recipes(db, STORE, m.id, [])
    assert db.query(Recipe).filter(Recipe.menu_id == m.id).count() == 0
