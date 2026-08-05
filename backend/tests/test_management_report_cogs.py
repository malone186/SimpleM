"""경영 리포트 고도화 검증 — 레시피 기반 원가·영업 리듬 (인메모리 sqlite).

이 리포트의 손익은 원래 '확정한 OCR 문서'로 재료비를 잡았다. 그래서 명세서를 한 장도
안 찍은 기간은 재료비 0원이라 순이익이 매출 전액에 가깝게 부풀었고, 밀린 명세서를 하루에
몰아 찍으면 그날만 대형 적자로 찍혔다 — 촬영 부지런함이 손익을 좌우한 셈이다.
지금은 팔린 메뉴의 레시피로 재료비를 계산한다. 아래 테스트가 그 전환을 고정한다.
"""
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import Ingredient, Menu, Recipe, Sale, Stock
from app.models.operation import Employee, Schedule
from app.services.ai import report_service

STORE = "cafe@test.com"
REF = "2026-07-15"  # 과거 고정일 — '진행 중인 기간' 보정이 끼어들지 않아 결과가 재현된다


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    # 조언 생성은 이 테스트의 관심사가 아니다 — 키를 비워 Gemini 호출 자체를 막는다
    monkeypatch.setattr(report_service, "GEMINI_API_KEY", "")
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _menu_with_recipe(db, name, price, unit_cost, store=STORE):
    """판매가 price, 1잔당 재료비 unit_cost인 메뉴를 만든다 (재료 1종 · 단가 1원)."""
    menu = Menu(name=name, selling_price=price, store_id=store)
    ing = Ingredient(name=f"{name} 재료", unit="g", current_price=1, store_id=store)
    db.add_all([menu, ing])
    db.commit()
    db.add(Stock(ingredient_id=ing.id, current_quantity=10_000.0, safety_quantity=0.0))
    db.add(Recipe(menu_id=menu.id, ingredient_id=ing.id, quantity=float(unit_cost)))
    db.commit()
    return menu


def _menu_without_recipe(db, name, price, store=STORE):
    menu = Menu(name=name, selling_price=price, store_id=store)
    db.add(menu)
    db.commit()
    return menu


def _sell(db, menu, qty, hour, day=REF, store=STORE):
    db.add(Sale(menu_id=menu.id, quantity=qty, total_price=menu.selling_price * qty,
                store_id=store, sold_at=datetime.fromisoformat(f"{day}T{hour:02d}:30:00")))
    db.commit()


def _shift(db, start_hour, end_hour, rate=10_000, day=REF, store=STORE):
    emp = Employee(name="알바", hourly_rate=rate, role="바리스타", store_id=store)
    db.add(emp)
    db.commit()
    db.add(Schedule(employee_id=emp.id, date=day,
                    start_time=datetime.fromisoformat(f"{day}T{start_hour:02d}:00:00"),
                    end_time=datetime.fromisoformat(f"{day}T{end_hour:02d}:00:00")))
    db.commit()
    return emp


def _report(period_type="daily"):
    return report_service.generate_management_report(
        STORE, period_type=period_type, reference_date=REF)["content"]


# ---------------------------------------------------------------------------
# 재료비 — 명세서 촬영 여부와 무관해야 한다
# ---------------------------------------------------------------------------

def test_material_cost_comes_from_recipes_not_scanned_documents(db):
    """확정 명세서가 한 장도 없어도 팔린 만큼 재료비가 잡힌다 (예전엔 0원이었다)."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_500)
    _sell(db, latte, qty=10, hour=10)

    c = _report()

    assert c["purchases"]["document_count"] == 0      # 스캔한 매입 문서 없음
    assert c["profit"]["basis"] == "recipe"
    assert c["cogs"]["theoretical"] == 15_000         # 1,500원 × 10잔
    assert c["cogs"]["cost_ratio"] == 30.0            # 15,000 / 50,000
    assert c["profit"]["material_cost"] == 15_000
    # 매입 기준으로 계산하던 시절이면 재료비 0원 → 순이익이 매출 전액(50,000)이었다
    assert c["profit"]["estimated_profit"] == 35_000


def test_falls_back_to_purchase_basis_when_recipes_barely_registered(db):
    """레시피가 붙은 매출이 적으면 원가율을 믿을 수 없다 — 종전 매입 기준으로 되돌린다."""
    covered = _menu_with_recipe(db, "라떼", price=1_000, unit_cost=300)
    bare = _menu_without_recipe(db, "생과일주스", price=9_000)
    _sell(db, covered, qty=1, hour=10)   # 레시피 있음 — 매출 1,000원
    _sell(db, bare, qty=1, hour=11)      # 레시피 없음 — 매출 9,000원

    c = _report()

    assert c["cogs"]["coverage_pct"] == 10.0
    assert c["cogs"]["reliable"] is False
    assert c["profit"]["basis"] == "purchase"
    assert c["cogs"]["uncovered_count"] == 1
    assert c["cogs"]["uncovered_menus"][0]["menu"] == "생과일주스"
    # 재료비가 빠졌다는 사실을 숫자보다 먼저 알려야 한다
    assert any("레시피가 없어" in h for h in c["highlights"])
    assert "레시피를 등록하면" in c["note"]


def test_cash_balance_kept_alongside_operating_profit(db):
    """손익(레시피 원가)과 현금수지(실매입)를 나란히 둔다 — 둘은 다른 질문에 답한다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_500)
    _sell(db, latte, qty=10, hour=10)

    c = _report()

    assert c["profit"]["estimated_profit"] == 35_000     # 매출 - 레시피 원가
    assert c["profit"]["cash_balance"] == 50_000         # 매입이 0이라 나간 돈이 없다
    assert c["profit"]["cash_total_cost"] == 0


def test_internal_menu_map_is_not_persisted(db):
    """원가 계산용 중간 산출물(_by_menu_id)이 저장 문서로 새지 않는다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_500)
    _sell(db, latte, qty=1, hour=10)

    assert "_by_menu_id" not in _report()["sales"]


def test_stock_adjustment_counts_as_loss(db):
    """실사에서 깎인 재고는 로스로 잡힌다 — 판매 차감(OUT)은 레시피대로라 로스가 아니다."""
    from app.models.inventory import StockTransaction

    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_000)
    _sell(db, latte, qty=10, hour=10)
    ing = db.query(Ingredient).first()
    db.add(StockTransaction(ingredient_id=ing.id, quantity_change=-500.0, type="ADJUST",
                            description="실사 조정", created_at=datetime.fromisoformat(f"{REF}T20:00:00")))
    # 판매 차감은 이론 원가와 같은 값이라 로스에 섞이면 안 된다
    db.add(StockTransaction(ingredient_id=ing.id, quantity_change=-10_000.0, type="OUT",
                            description="판매 차감", created_at=datetime.fromisoformat(f"{REF}T10:00:00")))
    db.commit()

    c = _report()

    assert c["cogs"]["loss_amount"] == 500   # ADJUST 500개 × 단가 1원
    assert c["cogs"]["loss_items"][0]["name"] == ing.name


# ---------------------------------------------------------------------------
# 영업 리듬 — 시간대·요일
# ---------------------------------------------------------------------------

def test_sales_are_bucketed_by_hour(db):
    """매출이 판매 시각의 시간대 칸에 담긴다 — 날짜 합계만으론 인력 배치를 못 정한다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_000)
    _sell(db, latte, qty=3, hour=9)
    _sell(db, latte, qty=1, hour=15)

    hourly = {r["hour"]: r for r in _report()["sales"]["hourly"]}

    assert hourly[9]["total"] == 15_000 and hourly[9]["cups"] == 3
    assert hourly[15]["total"] == 5_000
    assert 12 not in hourly  # 판매 없는 시간은 칸을 만들지 않는다


def test_labor_cost_is_split_across_the_hours_it_covers(db):
    """근무가 정시 경계로 쪼개져 각 시간대에 걸친 만큼만 배분된다."""
    _shift(db, start_hour=9, end_hour=12, rate=10_000)

    by_hour = {r["hour"]: r["cost"] for r in _report()["labor"]["hourly_cost"]}

    assert by_hour == {9: 10_000, 10: 10_000, 11: 10_000}  # 12시 칸은 생기지 않는다


def test_hour_staffed_without_sales_is_flagged(db):
    """사람은 있는데 손님이 없던 시간대를 짚어 준다 — 합계 인건비로는 안 보이는 사실."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_000)
    _sell(db, latte, qty=20, hour=9)     # 오전엔 매출이 인건비를 넉넉히 넘는다
    _shift(db, start_hour=9, end_hour=11, rate=10_000)   # 10시엔 근무만 있고 판매가 없다

    c = _report()
    flagged = {r["hour"]: r for r in c["rhythm"]["negative_hours"]}

    assert 10 in flagged
    assert flagged[10]["sales"] == 0 and flagged[10]["labor"] == 10_000
    assert 9 not in flagged  # 매출이 인건비를 넘긴 시간은 걸리지 않는다
    assert any("10시대" in h for h in c["highlights"])


def test_weekday_comparison_needs_repeat_observations(db):
    """관측이 하루뿐인 요일은 비교하지 않는다 — 그날 사정이지 그 요일의 성격이 아니다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_000)
    _sell(db, latte, qty=1, hour=10, day="2026-07-13")   # 월
    _sell(db, latte, qty=9, hour=10, day="2026-07-14")   # 화

    c = _report(period_type="weekly")

    assert c["rhythm"]["best_weekday"] is None
    assert c["rhythm"]["worst_weekday"] is None


# ---------------------------------------------------------------------------
# 하이라이트 — 중요한 것부터, 상한 안에서
# ---------------------------------------------------------------------------

def test_highlights_are_capped_and_led_by_revenue(db):
    """항목이 늘어도 카드가 넘치지 않고, 첫 줄은 항상 매출이다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=2_500)
    bare = _menu_without_recipe(db, "생과일주스", price=9_000)
    _sell(db, latte, qty=20, hour=9)
    _sell(db, bare, qty=1, hour=10)
    _shift(db, start_hour=9, end_hour=14, rate=10_000)

    highlights = _report()["highlights"]

    assert len(highlights) <= report_service._HIGHLIGHT_LIMIT
    assert highlights[0].startswith("매출 ")


def test_loss_making_hour_outranks_background_facts(db):
    """돈이 새는 사실이 '베스트 메뉴' 같은 배경 정보보다 위에 온다."""
    latte = _menu_with_recipe(db, "라떼", price=5_000, unit_cost=1_000)
    _sell(db, latte, qty=20, hour=9)
    _shift(db, start_hour=9, end_hour=11, rate=10_000)   # 10시 = 매출 없이 인건비만

    highlights = _report()["highlights"]
    ranked = {h: i for i, h in enumerate(highlights)}
    loss_line = next(i for h, i in ranked.items() if "10시대" in h)
    best_line = next((i for h, i in ranked.items() if h.startswith("베스트 메뉴")), None)

    assert best_line is None or loss_line < best_line
