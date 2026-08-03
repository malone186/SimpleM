"""매출 CSV 임포트 → 재고 자동 차감 종합 테스트 (백엔드 B) — 인메모리 sqlite.

재고 차감은 '레시피(Recipe)'가 있어야만 일어난다. 그래서 이 테스트는
  · 메뉴가 등록됐는지 (매칭 여부)
  · 등록된 메뉴에 레시피가 있는지 (차감 여부)
  · 레시피 재료에 Stock 행이 있는지 (실수량 반영 여부)
세 축을 모두 교차해서, 파일→미리보기→확정저장→(Sale·Stock·StockTransaction) 연동을 검증한다.

pandas 없이 CSV 경로만 쓰므로 결정론적이다(LLM 매핑은 키워드 휴리스틱으로 폴백).
DB는 테스트마다 새 인메모리 엔진 + core_db.SessionLocal monkeypatch로 격리한다
(공유 Neon DB를 건드리지 않는다).
"""
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import (
    Ingredient, Menu, Recipe, Sale, Stock, StockTransaction,
)
from app.services.ai import sales_import_service as S

STORE = "cafe@test.com"
OTHER = "other@test.com"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    # 서비스는 호출 시점에 core_db.SessionLocal을 읽으므로(document_service._session)
    # 여기만 갈아 끼우면 build_preview·save_import 내부 세션까지 전부 이 DB로 온다.
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


# ---------------------------------------------------------------------------
# 헬퍼: 메뉴/재료/레시피/재고 만들기
# ---------------------------------------------------------------------------

def _menu(db, name, price=4000, store=STORE):
    m = Menu(name=name, selling_price=price, store_id=store)
    db.add(m)
    db.commit()
    return m


def _ingredient(db, name, unit="g", store=STORE, qty=None, safety=0.0):
    ing = Ingredient(name=name, unit=unit, current_price=100, store_id=store)
    db.add(ing)
    db.commit()
    if qty is not None:
        db.add(Stock(ingredient_id=ing.id, current_quantity=qty, safety_quantity=safety))
        db.commit()
    return ing


def _recipe(db, menu, ingredient, qty):
    db.add(Recipe(menu_id=menu.id, ingredient_id=ingredient.id, quantity=qty))
    db.commit()


def _stock_qty(db, ing_id):
    s = db.query(Stock).filter(Stock.ingredient_id == ing_id).first()
    return s.current_quantity if s else None


def _txns(db, ing_id):
    return db.query(StockTransaction).filter(StockTransaction.ingredient_id == ing_id).all()


# ---------------------------------------------------------------------------
# A. 파싱 & 매핑 (파일 → 그리드 → 열 매핑)
# ---------------------------------------------------------------------------

CSV_STD = (
    "○○카페 매출내역,,,\n"
    "기간: 2026-07-30,,,\n"
    "판매일시,상품명,판매수량,판매금액\n"
    "2026-07-30 09:12,아메리카노,2,8000\n"
    "2026-07-30 10:05,카페라떼,1,5000\n"
    ",,,\n"  # 빈 합계행
)


def test_parse_grid_strips_junk_and_empty_rows():
    grid = S.parse_grid(CSV_STD.encode("utf-8"), "sales.csv")
    # 잡정보 2행 + 헤더 1 + 데이터 2 = 5 (완전 빈 행은 제거)
    assert len(grid) == 5
    assert grid[2] == ["판매일시", "상품명", "판매수량", "판매금액"]


def test_parse_grid_cp949_encoding():
    """한국 POS는 cp949(euc-kr) 인코딩이 흔하다 — 깨지지 않고 읽혀야 한다."""
    grid = S.parse_grid(CSV_STD.encode("cp949"), "sales.csv")
    assert grid[3][1] == "아메리카노"


def test_parse_grid_empty_file_errors():
    with pytest.raises(S.SalesImportError):
        S.parse_grid(b"", "empty.csv")
    with pytest.raises(S.SalesImportError):
        S.parse_grid("\n\n,,\n".encode("utf-8"), "blank.csv")


def test_heuristic_mapping_finds_columns():
    grid = S.parse_grid(CSV_STD.encode("utf-8"), "sales.csv")
    mp = S._heuristic_mapping(grid)
    assert mp["header_row"] == 2
    assert (mp["date_col"], mp["item_col"], mp["qty_col"], mp["amount_col"]) == (0, 1, 2, 3)


# ---------------------------------------------------------------------------
# B. 미리보기 — 메뉴 매칭 (등록/미등록, 변형 표기)
# ---------------------------------------------------------------------------

def test_preview_registered_vs_unregistered(db):
    _menu(db, "아메리카노")
    grid = S.parse_grid(CSV_STD.encode("utf-8"), "sales.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))

    assert pv["summary"]["total_rows"] == 2
    assert pv["summary"]["matched"] == 1
    assert pv["summary"]["unmatched"] == 1

    am = next(r for r in pv["rows"] if r["menu_name"] == "아메리카노")
    assert am["menu_id"] is not None and am["total_price"] == 8000
    la = next(r for r in pv["rows"] if r["menu_name"] == "카페라떼")
    assert la["menu_id"] is None
    assert "메뉴 매칭 안 됨" in la["warnings"]


def test_preview_ice_hot_variant_match(db):
    """POS 상품명 '아메리카노(ICE)'는 매장 메뉴 '아메리카노'에 매칭돼야 한다."""
    _menu(db, "아메리카노")
    csv = (
        "일시,상품명,수량,금액\n"
        "2026-07-30 09:00,아메리카노(ICE),1,4000\n"
        "2026-07-30 09:10,아메리카노 HOT,1,4000\n"
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    assert pv["summary"]["matched"] == 2
    for r in pv["rows"]:
        assert r["menu_id"] is not None
        assert "온도·사이즈 표기 무시하고 매칭" in r["warnings"]


def test_preview_ambiguous_variant_excluded(db):
    """'아메리카노(ICE)'와 '아메리카노(HOT)'가 둘 다 메뉴면 꼬리표 뗀 키가 겹친다 —
    모호하므로 변형 매칭에서 제외해 오매칭을 막아야 한다(정확 일치만 허용)."""
    _menu(db, "아메리카노(ICE)", price=4000)
    _menu(db, "아메리카노(HOT)", price=4500)
    csv = (
        "일시,상품명,수량,금액\n"
        "2026-07-30 09:00,아메리카노,1,4000\n"          # 정확히 일치하는 메뉴 없음
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    assert pv["rows"][0]["menu_id"] is None  # 모호 매칭 회피


def test_preview_missing_amount_uses_menu_price(db):
    """금액 열이 비었으면 매칭된 메뉴 판매가 × 수량으로 보정한다."""
    _menu(db, "아메리카노", price=4000)
    csv = (
        "일시,상품명,수량,금액\n"
        "2026-07-30 09:00,아메리카노,3,\n"       # 금액 없음
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    r = pv["rows"][0]
    assert r["total_price"] == 12000  # 4000 × 3
    assert "금액 없음 → 메뉴 판매가로 추정" in r["warnings"]


def test_preview_bad_date_flagged(db):
    _menu(db, "아메리카노")
    csv = (
        "일시,상품명,수량,금액\n"
        "날짜아님,아메리카노,1,4000\n"
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    assert "날짜 파싱 실패" in pv["rows"][0]["warnings"]


# ---------------------------------------------------------------------------
# C. 확정 저장 → 재고 차감 (핵심)
# ---------------------------------------------------------------------------

def test_save_registered_menu_with_recipe_deducts_stock(db):
    """등록 메뉴 + 레시피 + 재고 → Sale 저장 & 재고 차감 & 출고 이력 기록."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=1000.0)   # 1000g 보유
    _recipe(db, m, bean, 20.0)                    # 1잔당 20g

    rows = [{"menu_id": m.id, "quantity": 2, "total_price": 8000,
             "sold_at": "2026-07-30T09:12:00"}]
    result = S.save_import(STORE, rows)

    assert result == {"created": 1, "total": 8000}
    assert db.query(Sale).filter(Sale.store_id == STORE).count() == 1
    # 20g × 2잔 = 40g 차감
    assert _stock_qty(db, bean.id) == 960.0
    txns = _txns(db, bean.id)
    assert len(txns) == 1
    assert txns[0].type == "OUT" and txns[0].quantity_change == -40.0


def test_save_registered_menu_without_recipe_no_deduction(db):
    """등록 메뉴지만 레시피 없음 → 매출만 저장, 재고 차감/이력 없음."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=1000.0)  # 재고는 있지만 레시피에 안 묶임

    rows = [{"menu_id": m.id, "quantity": 5, "total_price": 20000, "sold_at": None}]
    result = S.save_import(STORE, rows)

    assert result["created"] == 1
    assert db.query(Sale).count() == 1
    assert _stock_qty(db, bean.id) == 1000.0        # 그대로
    assert db.query(StockTransaction).count() == 0  # 이력 없음


def test_save_recipe_without_stock_row_logs_txn_no_crash(db):
    """레시피는 있는데 재료에 Stock 행이 없음 → 크래시 없이 출고 이력만 남는다."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=None)  # Stock 행 없음
    _recipe(db, m, bean, 20.0)

    rows = [{"menu_id": m.id, "quantity": 1, "total_price": 4000, "sold_at": None}]
    result = S.save_import(STORE, rows)

    assert result["created"] == 1
    assert _stock_qty(db, bean.id) is None          # 여전히 Stock 행 없음
    txns = _txns(db, bean.id)
    assert len(txns) == 1 and txns[0].quantity_change == -20.0  # 장부엔 기록됨


def test_save_multi_ingredient_recipe_deducts_all(db):
    """한 메뉴에 재료 여러 개 → 전부 각자 소요량 × 수량만큼 차감."""
    m = _menu(db, "카페라떼")
    bean = _ingredient(db, "원두", qty=500.0)
    milk = _ingredient(db, "우유", unit="ml", qty=2000.0)
    _recipe(db, m, bean, 18.0)
    _recipe(db, m, milk, 150.0)

    rows = [{"menu_id": m.id, "quantity": 3, "total_price": 15000, "sold_at": None}]
    S.save_import(STORE, rows)

    assert _stock_qty(db, bean.id) == 500.0 - 18.0 * 3   # 446
    assert _stock_qty(db, milk.id) == 2000.0 - 150.0 * 3  # 1550


def test_save_multiple_rows_same_menu_cumulative(db):
    """같은 메뉴가 여러 행 → 차감이 누적된다."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=100.0)
    _recipe(db, m, bean, 20.0)

    rows = [
        {"menu_id": m.id, "quantity": 1, "total_price": 4000, "sold_at": None},
        {"menu_id": m.id, "quantity": 2, "total_price": 8000, "sold_at": None},
    ]
    result = S.save_import(STORE, rows)

    assert result == {"created": 2, "total": 12000}
    assert _stock_qty(db, bean.id) == 100.0 - 20.0 * 3  # 40
    assert len(_txns(db, bean.id)) == 2


def test_save_stock_floors_at_zero(db):
    """소요량이 재고보다 커도 음수로 내려가지 않는다(0에서 멈춤)."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=30.0)  # 30g뿐
    _recipe(db, m, bean, 20.0)

    rows = [{"menu_id": m.id, "quantity": 5, "total_price": 20000, "sold_at": None}]  # 100g 필요
    S.save_import(STORE, rows)

    assert _stock_qty(db, bean.id) == 0.0
    # 장부는 실제 소요량(-100)을 기록 (재고는 0에서 멈추지만 이력은 정직하게)
    assert _txns(db, bean.id)[0].quantity_change == -100.0


def test_save_skips_unmatched_rows(db):
    """menu_id 없는 행(미매칭)은 저장에서 제외된다."""
    m = _menu(db, "아메리카노")
    rows = [
        {"menu_id": m.id, "quantity": 1, "total_price": 4000, "sold_at": None},
        {"menu_id": None, "quantity": 1, "total_price": 5000, "sold_at": None},
    ]
    result = S.save_import(STORE, rows)
    assert result == {"created": 1, "total": 4000}
    assert db.query(Sale).count() == 1


def test_save_rejects_cross_store_menu(db):
    """다른 매장의 menu_id를 넘겨도 저장/차감되지 않는다(클라이언트 값 방어).

    menu_id 자체는 truthy라 첫 valid 필터는 통과하지만, 저장 루프에서 '내 매장 메뉴'
    집합에 없어 건너뛴다. 그래서 에러가 아니라 created:0으로 조용히 반환된다 —
    보안상 핵심(남의 매장 매출·재고 미반영)은 지켜진다."""
    other_menu = _menu(db, "아메리카노", store=OTHER)
    other_bean = _ingredient(db, "원두", store=OTHER, qty=1000.0)
    _recipe(db, other_menu, other_bean, 20.0)

    rows = [{"menu_id": other_menu.id, "quantity": 1, "total_price": 4000, "sold_at": None}]
    result = S.save_import(STORE, rows)

    assert result == {"created": 0, "total": 0}       # 조용한 무저장
    assert db.query(Sale).filter(Sale.store_id == STORE).count() == 0
    assert _stock_qty(db, other_bean.id) == 1000.0    # 남의 재고 안 건드림
    assert db.query(StockTransaction).count() == 0    # 남의 재고 이력도 안 남김


def test_save_no_valid_rows_errors(db):
    with pytest.raises(S.SalesImportError):
        S.save_import(STORE, [{"menu_id": None, "quantity": 1, "total_price": 0}])


def test_save_quantity_and_date_coercion(db):
    """수량 0/음수는 최소 1로, 잘못된 날짜 문자열은 현재시각으로 보정된다."""
    m = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=100.0)
    _recipe(db, m, bean, 10.0)

    rows = [{"menu_id": m.id, "quantity": 0, "total_price": 4000, "sold_at": "이상한값"}]
    S.save_import(STORE, rows)

    sale = db.query(Sale).first()
    assert sale.quantity == 1                       # 0 → 1로 방어
    assert isinstance(sale.sold_at, datetime)       # 파싱 실패 → now()
    assert _stock_qty(db, bean.id) == 90.0          # 10 × 1


# ---------------------------------------------------------------------------
# D. 미등록 메뉴 등록 → 재매칭 (미매칭 행 구제 흐름)
# ---------------------------------------------------------------------------

def test_register_then_match(db):
    """미등록 메뉴를 register_menus로 만들면 다음 미리보기에서 매칭된다."""
    reg = S.register_menus(STORE, [{"name": "바닐라라떼", "selling_price": 5500}])
    assert reg["menus"][0]["created"] is True

    csv = (
        "일시,상품명,수량,금액\n"
        "2026-07-30 09:00,바닐라라떼,1,5500\n"
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    assert pv["rows"][0]["menu_id"] is not None


def test_register_no_duplicate(db):
    """이미 있는 이름(정규화 동일)은 새로 만들지 않고 기존 것을 재사용한다."""
    _menu(db, "아메리카노")
    reg = S.register_menus(STORE, [{"name": " 아메리카노 ", "selling_price": 9999}])
    assert reg["menus"][0]["created"] is False
    assert db.query(Menu).filter(Menu.store_id == STORE).count() == 1


def test_registered_menu_has_no_recipe_so_no_deduction(db):
    """register_menus는 레시피를 만들지 않는다 → 저장해도 재고는 안 빠진다(문서화된 동작)."""
    reg = S.register_menus(STORE, [{"name": "바닐라라떼", "selling_price": 5500}])
    mid = reg["menus"][0]["menu_id"]
    # 재료·재고는 있지만 이 메뉴와 레시피로 연결돼 있지 않다
    bean = _ingredient(db, "원두", qty=100.0)

    S.save_import(STORE, [{"menu_id": mid, "quantity": 1, "total_price": 5500, "sold_at": None}])
    assert db.query(Sale).count() == 1
    assert _stock_qty(db, bean.id) == 100.0
    assert db.query(StockTransaction).count() == 0


# ---------------------------------------------------------------------------
# E. 엔드투엔드 (파일 → 미리보기 → 저장 → 재고)
# ---------------------------------------------------------------------------

def test_end_to_end_file_to_stock(db):
    """실제 흐름 그대로: CSV 업로드 → 미리보기 매칭 → 확정 → 재고 차감."""
    am = _menu(db, "아메리카노")
    bean = _ingredient(db, "원두", qty=1000.0)
    _recipe(db, am, bean, 20.0)
    # 카페라떼는 미등록 → 저장에서 빠져야 함

    grid = S.parse_grid(CSV_STD.encode("utf-8"), "sales.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    result = S.save_import(STORE, pv["rows"])

    # 아메리카노 2잔만 저장(8000), 카페라떼는 미매칭 제외
    assert result == {"created": 1, "total": 8000}
    assert db.query(Sale).count() == 1
    assert _stock_qty(db, bean.id) == 960.0  # 20 × 2


# ---------------------------------------------------------------------------
# F. 미등록 메뉴 → 매출 누락 경고 (미리보기 summary)
# ---------------------------------------------------------------------------

def test_preview_reports_unmatched_amount_and_candidates(db):
    """미등록 메뉴 때문에 빠질 매출 총액과 '등록 후보' 목록을 summary가 알려준다."""
    _menu(db, "아메리카노")  # 카페라떼는 미등록
    grid = S.parse_grid(CSV_STD.encode("utf-8"), "sales.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))

    s = pv["summary"]
    assert s["unmatched"] == 1
    assert s["unmatched_amount"] == 5000        # 카페라떼 1건 5000원이 빠진다
    assert len(s["unmatched_menus"]) == 1
    cand = s["unmatched_menus"][0]
    assert cand["name"] == "카페라떼"
    assert cand["quantity"] == 1 and cand["amount"] == 5000
    assert cand["suggested_price"] == 5000       # 5000 ÷ 1잔


def test_preview_unmatched_aggregates_and_sorts_by_amount(db):
    """같은 미등록 메뉴 여러 행은 합산되고, 누락액 큰 순으로 정렬된다."""
    csv = (
        "일시,상품명,수량,금액\n"
        "2026-07-30 09:00,카페라떼,1,5000\n"
        "2026-07-30 10:00,카페라떼,2,10000\n"
        "2026-07-30 11:00,콜드브루,1,6000\n"
    )
    grid = S.parse_grid(csv.encode("utf-8"), "s.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    s = pv["summary"]
    assert s["unmatched_amount"] == 21000
    names = [m["name"] for m in s["unmatched_menus"]]
    assert names == ["카페라떼", "콜드브루"]        # 15000 > 6000 순
    latte = s["unmatched_menus"][0]
    assert latte["rows"] == 2 and latte["quantity"] == 3 and latte["amount"] == 15000
    assert latte["suggested_price"] == 5000          # 15000 ÷ 3잔


# ---------------------------------------------------------------------------
# G. 미등록 메뉴 + 레시피 동시 등록 → 재고 차감 즉시 연결
# ---------------------------------------------------------------------------

def test_register_with_recipe_enables_deduction(db):
    """메뉴를 레시피와 함께 등록하면, 바로 이어지는 저장에서 재고가 차감된다."""
    bean = _ingredient(db, "원두", qty=1000.0)
    milk = _ingredient(db, "우유", unit="ml", qty=2000.0)

    reg = S.register_menus(STORE, [{
        "name": "카페라떼", "selling_price": 5000,
        "recipe": [{"ingredient_id": bean.id, "quantity": 18.0},
                   {"ingredient_id": milk.id, "quantity": 150.0}],
    }])
    m = reg["menus"][0]
    assert m["created"] is True and m["recipe_added"] == 2 and m["has_recipe"] is True

    S.save_import(STORE, [{"menu_id": m["menu_id"], "quantity": 2,
                           "total_price": 10000, "sold_at": None}])
    assert _stock_qty(db, bean.id) == 1000.0 - 18.0 * 2   # 964
    assert _stock_qty(db, milk.id) == 2000.0 - 150.0 * 2  # 1700


def test_register_recipe_rejects_cross_store_ingredient(db):
    """다른 매장 재료 id는 레시피에 걸리지 않는다(교차 매장 방어)."""
    other_bean = _ingredient(db, "원두", store=OTHER, qty=1000.0)
    reg = S.register_menus(STORE, [{
        "name": "카페라떼", "selling_price": 5000,
        "recipe": [{"ingredient_id": other_bean.id, "quantity": 18.0}],
    }])
    m = reg["menus"][0]
    assert m["recipe_added"] == 0
    assert other_bean.id in m["recipe_skipped"]
    assert m["has_recipe"] is False
    assert db.query(Recipe).count() == 0


def test_register_recipe_skips_duplicate_ingredient(db):
    """이미 그 재료가 레시피에 있으면 다시 등록해도 중복으로 쌓이지 않는다."""
    m = _menu(db, "카페라떼")
    bean = _ingredient(db, "원두", qty=1000.0)
    _recipe(db, m, bean, 18.0)

    reg = S.register_menus(STORE, [{
        "name": "카페라떼", "selling_price": 5000,
        "recipe": [{"ingredient_id": bean.id, "quantity": 99.0}],  # 이미 있는 재료
    }])
    r = reg["menus"][0]
    assert r["created"] is False and r["recipe_added"] == 0 and r["has_recipe"] is True
    # 기존 레시피가 그대로(99로 덮어쓰지 않음)
    rc = db.query(Recipe).filter(Recipe.menu_id == m.id).all()
    assert len(rc) == 1 and rc[0].quantity == 18.0


def test_register_recipe_ignores_bad_quantity(db):
    """수량 0/음수는 무시된다(레시피에 안 걸림)."""
    bean = _ingredient(db, "원두", qty=1000.0)
    reg = S.register_menus(STORE, [{
        "name": "카페라떼", "selling_price": 5000,
        "recipe": [{"ingredient_id": bean.id, "quantity": 0}],
    }])
    m = reg["menus"][0]
    assert m["recipe_added"] == 0 and m["has_recipe"] is False


def test_register_without_recipe_still_no_deduction(db):
    """레시피를 안 주면 종전대로 이름·판매가만 — 재고는 안 빠진다(하위호환)."""
    bean = _ingredient(db, "원두", qty=1000.0)
    reg = S.register_menus(STORE, [{"name": "바닐라라떼", "selling_price": 5500}])
    m = reg["menus"][0]
    assert m["created"] is True and m["recipe_added"] == 0 and m["has_recipe"] is False

    S.save_import(STORE, [{"menu_id": m["menu_id"], "quantity": 1,
                           "total_price": 5500, "sold_at": None}])
    assert _stock_qty(db, bean.id) == 1000.0  # 그대로
