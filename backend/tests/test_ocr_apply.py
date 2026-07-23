"""OCR 확정 반영(_apply_expense/_apply_sales) 단위 테스트 — sqlite 인메모리 DB 사용"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.core.database as core_db
from app.models.inventory import Ingredient, Menu, Recipe, Sale, Stock
from app.models.operation import Expense
from app.schemas.ai import OcrItem, OcrResult
from app.services.ai import ocr_service

STORE = "test@store.com"


@pytest.fixture()
def db_session(monkeypatch):
    """인메모리 sqlite로 SessionLocal을 바꿔치기해 실제 DB 없이 반영 로직을 검증한다."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    yield TestSession
    engine.dispose()


def _draft(result: OcrResult) -> dict:
    return {"id": "testdoc", "result": result}


def test_parse_issued_date_formats():
    assert str(ocr_service._parse_issued_date("2026-07-21")) == "2026-07-21"
    assert str(ocr_service._parse_issued_date("2026.7.3")) == "2026-07-03"
    assert str(ocr_service._parse_issued_date("2026년 7월 21일")) == "2026-07-21"
    assert ocr_service._parse_issued_date("날짜없음") is None
    assert ocr_service._parse_issued_date(None) is None


def test_document_total_mixed_items():
    """일부 품목은 amount, 일부는 수량×단가만 있어도 전체가 합산돼야 한다."""
    r = OcrResult(items=[
        OcrItem(name="컵", quantity=2, unit_price=500),   # 1000
        OcrItem(name="빨대", amount=1000),                # 1000
    ])
    assert ocr_service._document_total(r) == 2000
    assert ocr_service._document_total(OcrResult(total=15000)) == 15000


def test_apply_expense_creates_row(db_session):
    r = OcrResult(doc_type="receipt", issued_date="2026-07-20", total=42000)
    r.vendor.name = "동네마트"
    ok, msg = ocr_service._apply_expense(_draft(r), STORE)
    assert ok and "42,000" in msg
    with db_session() as db:
        row = db.query(Expense).one()
        assert row.store_id == STORE
        assert row.amount == 42000
        assert row.category == "기타 지출"
        assert str(row.expense_date) == "2026-07-20"
        assert "동네마트" in row.description


def test_apply_expense_purchase_doc_category(db_session):
    r = OcrResult(doc_type="tax_invoice", items=[OcrItem(name="원두", quantity=2, unit_price=30000)])
    ok, _ = ocr_service._apply_expense(_draft(r), STORE)
    assert ok
    with db_session() as db:
        assert db.query(Expense).one().category == "원자재 매입"


def test_apply_expense_no_amount(db_session):
    ok, msg = ocr_service._apply_expense(_draft(OcrResult(doc_type="receipt")), STORE)
    assert not ok and "금액" in msg


def test_apply_sales_matches_menu_and_deducts_stock(db_session):
    with db_session() as db:
        ing = Ingredient(name="원두", unit="g", current_price=50, store_id=STORE)
        db.add(ing)
        db.flush()
        db.add(Stock(ingredient_id=ing.id, current_quantity=100.0))
        menu = Menu(name="아메리카노", selling_price=4000, store_id=STORE)
        db.add(menu)
        db.flush()
        db.add(Recipe(menu_id=menu.id, ingredient_id=ing.id, quantity=20.0))
        db.commit()

    r = OcrResult(doc_type="sales_summary", issued_date="2026-07-21", items=[
        OcrItem(name="아메리카노", quantity=3, amount=12000),
        OcrItem(name="없는메뉴한정판", quantity=1, amount=5000),
    ])
    ok, msg = ocr_service._apply_sales(_draft(r), STORE)
    assert ok and "1개 품목" in msg and "12,000" in msg and "없는메뉴한정판" in msg

    with db_session() as db:
        sale = db.query(Sale).one()
        assert sale.quantity == 3 and sale.total_price == 12000 and sale.store_id == STORE
        assert db.query(Stock).one().current_quantity == 100.0 - 20.0 * 3  # 레시피 차감


def test_apply_sales_no_match_rolls_back(db_session):
    r = OcrResult(doc_type="sales_summary", items=[OcrItem(name="유령메뉴", quantity=1)])
    ok, msg = ocr_service._apply_sales(_draft(r), STORE)
    assert not ok and "메뉴" in msg
    with db_session() as db:
        assert db.query(Sale).count() == 0
