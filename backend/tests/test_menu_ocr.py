# -*- coding: utf-8 -*-
"""메뉴판 OCR · 표준 레시피 사전 테스트

여기서 지키려는 것:
  1. 메뉴명 표기가 제각각이어도 같은 레시피를 찾는다 (아이스/핫/용량/괄호)
  2. 재료 후보가 여럿이면 자동으로 고르지 않는다 — 원가가 조용히 틀리는 걸 막는 핵심
  3. 확정은 사람이 부를 때만 저장하고, 두 번 찍어도 중복이 생기지 않는다
"""
import asyncio

import pytest

from app.services.ai import menu_ocr_service as svc
from app.services.ai import recipe_presets as rp


# ---------------------------------------------------------------------------
# 표준 레시피 사전
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "아메리카노", "아이스 아메리카노", "ICE 아메리카노", "아메리카노(HOT)",
    "디카페인 아메리카노", "아메리카노 12oz", "따뜻한 아메리카노",
])
def test_같은_음료는_표기가_달라도_같은_레시피(name):
    """메뉴판 표기는 매장마다 다르다 — 수식어 때문에 못 찾으면 사전이 무용지물이다."""
    assert rp.lookup(name) == [("원두", 18.0, "g")]


def test_긴_이름이_짧은_이름을_이긴다():
    """'바닐라라떼'가 '라떼'로 매칭되면 시럽이 빠져 원가가 낮게 나온다."""
    got = rp.lookup("시그니처 바닐라라떼")
    assert ("바닐라시럽", 15, "ml") in got


def test_모르는_메뉴는_None():
    """지어내지 않는다 — 없는 재료를 넣으면 원가가 조용히 틀린다.

    '흑임자크림브륄레라떼'는 라떼 계열이지만 시그니처 재료(흑임자)가 사전에 없다.
    카페라떼로 잡아 버리면 가장 비싼 재료가 빠진 원가가 나오고, 아무도 틀린 줄 모른다.
    이럴 땐 None을 돌려줘야 호출자가 AI에게 물어보는 다음 단계로 넘어간다.
    """
    assert rp.lookup("흑임자크림브륄레라떼") is None
    assert rp.lookup("") is None


def test_별칭도_찾는다():
    assert rp.lookup("핫초코") == rp.lookup("초코라떼")
    assert rp.lookup("latte") == rp.lookup("카페라떼")


def test_별칭은_수식어만_붙어도_찾는다():
    """'아이스 라떼'는 수식어를 떼면 별칭 '라떼'와 정확히 같아진다."""
    assert rp.lookup("아이스 라떼") == rp.lookup("카페라떼")
    assert rp.lookup("ICE LATTE") == rp.lookup("카페라떼")


# ---------------------------------------------------------------------------
# 재료 매칭 — 자동 선택 금지가 핵심
# ---------------------------------------------------------------------------

def test_구체적인_이름도_같은_재료로_본다():
    """매장은 '원두'를 '에티오피아 원두'라고 부른다."""
    assert rp.match_ingredient("우유", ["서울우유 1L", "종이컵"]) == ["서울우유 1L"]


def test_후보가_여럿이면_모두_돌려준다():
    """원두를 두 종류 쓰는 매장 — 아메리카노에 뭘 쓰는지는 사장님만 안다.
    여기서 하나를 골라 버리면 원가가 틀려도 알 방법이 없다."""
    got = rp.match_ingredient("원두", ["에티오피아 원두", "콜롬비아 원두"])
    assert len(got) == 2
    assert set(got) == {"에티오피아 원두", "콜롬비아 원두"}


def test_없는_재료는_빈_목록():
    assert rp.match_ingredient("생크림", ["원두", "우유"]) == []


def test_이름이_숫자뿐인_재료는_후보에서_뺀다():
    """실제 DB에 '27,720'이라는 재료가 있었다(가격이 이름 칸에 들어간 것으로 보인다).

    정규화하면 숫자·쉼표가 걷혀 빈 문자열이 되는데, 빈 문자열은 모든 문자열의
    부분문자열이라 그냥 두면 '모든 재료의 후보'가 된다. 게다가 후보가 그것 하나뿐이면
    자동 연결까지 돼서 엉뚱한 재료로 원가가 조용히 틀린다.
    """
    store = ["27,720", "에티오피아 원두"]
    assert rp.match_ingredient("원두", store) == ["에티오피아 원두"]
    # 원두와 아무 상관 없는 재료를 찾을 때도 딸려 나오면 안 된다
    assert rp.match_ingredient("설탕", store) == []


# ---------------------------------------------------------------------------
# 단위 환산 — 틀리면 원가가 1000배가 되는데 화면엔 그냥 큰 숫자로만 보인다
# ---------------------------------------------------------------------------

def test_그램을_킬로그램으로():
    """표준 레시피는 원두 18g, 매장은 kg으로 등록한다.
    18을 그대로 저장하면 18kg → 28,000원/kg 기준 504,000원짜리 아메리카노가 된다."""
    assert rp.convert_quantity(18, "g", "kg", "에티오피아 원두") == pytest.approx(0.018)


def test_밀리리터를_리터로():
    assert rp.convert_quantity(200, "ml", "L", "우유") == pytest.approx(0.2)


def test_같은_단위면_그대로():
    assert rp.convert_quantity(15, "ml", "ml", "바닐라시럽") == 15


def test_셈_단위는_이름의_용량으로_환산():
    """'서울우유 1L'은 단위가 '팩'이다 — 1팩이 몇 ml인지는 이름에만 있다."""
    assert rp.convert_quantity(200, "ml", "팩", "서울우유 1L") == pytest.approx(0.2)
    assert rp.convert_quantity(200, "ml", "개", "P코모닝우유 900ML") == pytest.approx(200 / 900)


def test_환산_근거가_없으면_None():
    """'개'인데 이름에 용량이 없다 — 1개가 몇 ml인지 알 수 없다.
    여기서 아무 숫자나 넣으면 원가가 조용히 틀리므로 None을 주고 사장님이 넣게 한다."""
    assert rp.convert_quantity(200, "ml", "개", "우유") is None
    assert rp.convert_quantity(18, "g", "줄(50개)", "종이컵") is None


def test_잘못된_양은_None():
    assert rp.convert_quantity(0, "g", "kg", "원두") is None
    assert rp.convert_quantity(-5, "g", "kg", "원두") is None


# ---------------------------------------------------------------------------
# 가격 표기 — 카페 메뉴판은 천원 단위를 소수로 줄여 적는 일이 많다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    (4.5, 4500),      # "4.5" — 실제 메뉴판에서 가장 흔한 표기
    (5.0, 5000),
    (10.0, 10000),
    (13.0, 13000),
    (3500, 3500),     # 이미 원 단위면 그대로
    (4500, 4500),
    (12000, 12000),
])
def test_천원_단위_축약을_원_단위로(raw, expected):
    """4.5를 그대로 두면 아메리카노가 4원이 되고 원가율이 100000%로 뜬다."""
    assert svc._normalize_price(raw) == expected


@pytest.mark.parametrize("raw", [None, "4500", 0, -1, True, False])
def test_가격이_아니면_None(raw):
    """문자열·0·음수·불리언은 가격이 아니다. bool은 int의 하위형이라 따로 막아야 한다."""
    assert svc._normalize_price(raw) is None


# ---------------------------------------------------------------------------
# 초안 → 확정
# ---------------------------------------------------------------------------

@pytest.fixture
def db(tmp_path):
    """메뉴·레시피만 쓰는 가벼운 SQLite 세션.

    SAVEPOINT가 동작하도록 손을 봐 둔다. 파이썬 sqlite3 드라이버는 트랜잭션을
    제멋대로 열고 닫아서, 그대로 두면 begin_nested()를 써도 바깥 rollback이 먹지 않는다
    (실측: savepoint 안에서 넣은 행이 rollback 뒤에도 남았다).
    운영 DB는 Postgres라 문제가 없지만, 그러면 테스트가 롤백을 검증하지 못한다.
    아래 두 줄은 SQLAlchemy 문서가 안내하는 pysqlite 우회다.
    """
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base
    import app.models.inventory  # noqa: F401  테이블 등록

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _no_implicit_begin(dbapi_conn, _rec):
        dbapi_conn.isolation_level = None   # 드라이버가 알아서 BEGIN 하지 않게

    @event.listens_for(engine, "begin")
    def _explicit_begin(conn):
        conn.exec_driver_sql("BEGIN")       # 우리가 직접 연다

    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _ingredient(db, name, unit="g"):
    from app.models.inventory import Ingredient
    row = Ingredient(store_id="s@t.com", name=name, unit=unit, current_price=100)
    db.add(row)
    db.commit()
    return row


def test_확정하면_메뉴와_레시피가_저장된다(db):
    ing = _ingredient(db, "원두")
    out = svc.confirm_menu_board(db, "s@t.com", [{
        "name": "아메리카노", "price": 3500,
        "recipes": [{"ingredient_id": ing.id, "quantity": 18}],
    }])

    from app.models.inventory import Menu, Recipe
    assert out["created"] == ["아메리카노"]
    menu = db.query(Menu).filter(Menu.name == "아메리카노").one()
    assert menu.selling_price == 3500
    assert db.query(Recipe).filter(Recipe.menu_id == menu.id).count() == 1


def test_같은_메뉴판을_두_번_찍어도_중복되지_않는다(db):
    """사장님이 잘 찍혔는지 몰라 두 번 찍는 건 흔한 일이다."""
    ing = _ingredient(db, "원두")
    payload = [{"name": "아메리카노", "price": 3500,
                "recipes": [{"ingredient_id": ing.id, "quantity": 18}]}]

    svc.confirm_menu_board(db, "s@t.com", payload)
    second = svc.confirm_menu_board(db, "s@t.com", payload)

    from app.models.inventory import Menu
    assert second["created"] == []
    assert second["skipped"] == ["아메리카노"]
    assert db.query(Menu).filter(Menu.store_id == "s@t.com").count() == 1


def test_재료가_연결_안_된_줄은_버린다(db):
    """ingredient_id 없이 저장하면 원가 계산에서 터진다 — 아예 넣지 않는다."""
    ing = _ingredient(db, "원두")
    svc.confirm_menu_board(db, "s@t.com", [{
        "name": "카페라떼", "price": 4000,
        "recipes": [
            {"ingredient_id": ing.id, "quantity": 18},
            {"ingredient_id": None, "quantity": 200},   # 매장에 우유가 없다
        ],
    }])

    from app.models.inventory import Menu, Recipe
    menu = db.query(Menu).filter(Menu.name == "카페라떼").one()
    assert db.query(Recipe).filter(Recipe.menu_id == menu.id).count() == 1


def test_띄어쓰기만_다른_메뉴는_중복으로_본다(db):
    """OCR은 "카페라떼"로 읽고 DB엔 "카페 라떼"가 있는 일이 흔하다.

    analyze는 정규화해서 '이미 있음'으로 표시하는데 confirm만 이름 완전 일치로
    판정하면, 사장님이 그 줄을 체크했을 때 같은 메뉴가 두 개가 된다.
    """
    from app.models.inventory import Menu
    db.add(Menu(store_id="s@t.com", name="카페 라떼", selling_price=5000))
    db.commit()

    out = svc.confirm_menu_board(db, "s@t.com", [{"name": "카페라떼", "price": 5000, "recipes": []}])
    assert out["created"] == []
    assert out["skipped"] == ["카페라떼"]
    assert db.query(Menu).filter(Menu.store_id == "s@t.com").count() == 1


def test_레시피가_없으면_경고한다(db):
    """원가 0원 → 원가율 0%는 화면에서 '엄청 남는 메뉴'로 보인다. 막지는 않되 알린다."""
    out = svc.confirm_menu_board(db, "s@t.com", [{"name": "팥빙수", "price": 10000, "recipes": []}])
    assert out["created"] == ["팥빙수"]
    assert any("레시피가 없어" in w for w in out["warnings"])


def test_재료비가_판매가를_넘으면_경고한다(db):
    """18g을 18kg으로 넣는 단위 실수가 여기서 잡힌다 (0.018이 맞다)."""
    ing = _ingredient(db, "원두", unit="kg")
    ing.current_price = 28000
    db.commit()

    out = svc.confirm_menu_board(db, "s@t.com", [{
        "name": "아메리카노", "price": 4500,
        "recipes": [{"ingredient_id": ing.id, "quantity": 18}],   # kg인데 18 → 504,000원
    }])
    assert out["created"] == ["아메리카노"]
    assert any("판매가" in w and "큽니다" in w for w in out["warnings"])


def test_정상_수량이면_경고가_없다(db):
    ing = _ingredient(db, "원두", unit="kg")
    ing.current_price = 28000
    db.commit()

    out = svc.confirm_menu_board(db, "s@t.com", [{
        "name": "아메리카노", "price": 4500,
        "recipes": [{"ingredient_id": ing.id, "quantity": 0.018}],  # 504원
    }])
    assert out["warnings"] == []


def test_한_요청에_같은_메뉴가_두_번_있어도_하나만(db):
    """메뉴판에 ICE/HOT이 나뉘어 적혀 있으면 같은 이름이 두 번 올라올 수 있다."""
    from app.models.inventory import Menu
    payload = [{"name": "아메리카노", "price": 4500, "recipes": []},
               {"name": "아메리카노", "price": 5000, "recipes": []}]
    out = svc.confirm_menu_board(db, "s@t.com", payload)
    assert out["created"] == ["아메리카노"]
    assert db.query(Menu).filter(Menu.name == "아메리카노").count() == 1


def test_동시_등록으로_유니크_제약에_걸려도_나머지는_등록된다(db, monkeypatch):
    """다른 요청이 먼저 같은 메뉴를 넣어 DB가 거부하는 상황.

    '있는지 확인 → 없으면 넣기'는 두 단계 사이에 틈이 있어 DB 제약이 최종 방어선이다.
    그때 통째로 rollback하면 앞서 만든 메뉴까지 날아가므로, 그 한 건만 건너뛰어야 한다.
    """
    from sqlalchemy.exc import IntegrityError
    from app.models.inventory import Menu

    real_flush = db.flush

    def flaky_flush(*a, **kw):
        # '카페라떼'를 넣으려는 순간에만 유니크 충돌이 난 것처럼 만든다.
        # 호출 횟수로 세면 SQLAlchemy가 내부적으로 부르는 flush까지 세어 엉뚱한 데서 터진다.
        if any(isinstance(o, Menu) and o.name == "카페라떼" for o in db.new):
            raise IntegrityError("dup", None, Exception("uq_menu_store_name"))
        return real_flush(*a, **kw)

    monkeypatch.setattr(db, "flush", flaky_flush)
    out = svc.confirm_menu_board(db, "s@t.com", [
        {"name": "아메리카노", "price": 4500, "recipes": []},
        {"name": "카페라떼", "price": 5000, "recipes": []},   # 여기서 충돌
        {"name": "카푸치노", "price": 5500, "recipes": []},
    ])

    assert "카페라떼" in out["skipped"]
    assert set(out["created"]) == {"아메리카노", "카푸치노"}   # 나머지는 살아남는다
    monkeypatch.undo()
    assert db.query(Menu).filter(Menu.store_id == "s@t.com").count() == 2


def test_중간에_터지면_전부_되돌린다(db):
    """반쯤 등록된 상태로 남으면 사장님이 뭘 지워야 할지 알 수 없다."""
    from app.models.inventory import Menu

    class Boom(dict):
        def get(self, k, default=None):
            if k == "name":
                raise RuntimeError("의도된 실패")
            return super().get(k, default)

    with pytest.raises(RuntimeError):
        svc.confirm_menu_board(db, "s@t.com", [
            {"name": "정상메뉴", "price": 4000, "recipes": []},
            Boom(),
        ])
    assert db.query(Menu).filter(Menu.store_id == "s@t.com").count() == 0


def test_숫자만_다른_메뉴는_다른_메뉴다(db):
    """예전엔 정규화가 맨 숫자까지 지워 '아메리카노 1샷'과 '2샷'이 한 메뉴가 됐다.
    실측으로 메뉴 100개를 넣었더니 1개만 등록되고 99개가 말없이 사라졌다."""
    from app.models.inventory import Menu
    out = svc.confirm_menu_board(db, "s@t.com", [
        {"name": "아메리카노 1샷", "price": 3500, "recipes": []},
        {"name": "아메리카노 2샷", "price": 4500, "recipes": []},
        {"name": "세트1", "price": 8000, "recipes": []},
        {"name": "세트2", "price": 9000, "recipes": []},
    ])
    assert len(out["created"]) == 4
    assert db.query(Menu).filter(Menu.store_id == "s@t.com").count() == 4


def test_용량_표기는_여전히_지운다():
    """숫자를 살리되 '12oz'·'500ml' 같은 용량은 계속 걷어내야 한다."""
    assert rp.lookup("아메리카노 12oz") == rp.lookup("아메리카노")
    assert rp.lookup("카페라떼 500ml") == rp.lookup("카페라떼")


def test_이름이_같은_재료가_둘이면_둘_다_후보에_남는다(db):
    """'우유'를 팩·개로 따로 등록한 매장 — 하나가 사라지면 그 재료를 아예 못 고른다."""
    a = _ingredient(db, "우유", unit="팩")
    b = _ingredient(db, "우유", unit="개")
    got = svc._store_ingredients(db, "s@t.com")
    assert len(got) == 2
    assert {g["id"] for g in got} == {a.id, b.id}


def test_음수_판매가는_0으로_막는다(db):
    """음수 판매가는 원가율이 음수로 나와 화면이 깨진다.

    레시피는 넣어 둔다 — 레시피가 없으면 '레시피 없음' 경고가 먼저 나가고
    가격 경고까지 가지 않는다(그게 더 근본적인 문제라 의도한 순서다).
    """
    from app.models.inventory import Menu
    ing = _ingredient(db, "원두", unit="kg")
    out = svc.confirm_menu_board(db, "s@t.com", [{
        "name": "이상메뉴", "price": -5000,
        "recipes": [{"ingredient_id": ing.id, "quantity": 0.018}],
    }])
    assert db.query(Menu).filter(Menu.name == "이상메뉴").one().selling_price == 0
    assert any("판매가가 없어" in w for w in out["warnings"])


def test_경고가_너무_많으면_줄여서_알린다(db):
    """경고 100건이면 알림창이 화면을 넘어가 아무도 안 읽는다."""
    out = svc.confirm_menu_board(db, "s@t.com",
                                 [{"name": f"메뉴{i}", "price": 4000, "recipes": []} for i in range(30)])
    assert len(out["created"]) == 30
    assert len(out["warnings"]) <= 6           # 5건 + '더 있습니다' 한 줄
    assert "더 있습니다" in out["warnings"][-1]


def test_매장이_다르면_같은_이름도_따로_등록된다(db):
    ing = _ingredient(db, "원두")
    payload = [{"name": "아메리카노", "price": 3500,
                "recipes": [{"ingredient_id": ing.id, "quantity": 18}]}]
    svc.confirm_menu_board(db, "a@t.com", payload)
    svc.confirm_menu_board(db, "b@t.com", payload)

    from app.models.inventory import Menu
    assert db.query(Menu).count() == 2


# ---------------------------------------------------------------------------
# analyze_menu_board — 사진을 받아 초안을 조립하는 본체
#
# Gemini는 가짜로 바꿔치기한다(목킹). 진짜로 부르면 테스트마다 돈·쿼터·인터넷이 필요하고,
# 무엇보다 AI라 답이 매번 달라져서 테스트를 믿을 수 없게 된다.
# 여기서 보려는 것은 'AI가 잘 읽는가'가 아니라 '읽어 온 것을 우리가 제대로 조립하는가'다.
# ---------------------------------------------------------------------------

def _fake_gemini(menus, recipes=None):
    """_ask_gemini를 대신할 가짜. 스키마를 보고 메뉴/레시피 응답을 골라 돌려준다."""
    async def fake(parts, schema):
        if "menus" in (schema.get("properties") or {}):
            return {"menus": menus}
        return {"items": recipes or []}
    return fake


def _analyze(db, monkeypatch, menus, recipes=None, store="s@t.com"):
    monkeypatch.setattr(svc, "_ask_gemini", _fake_gemini(menus, recipes))
    return asyncio.run(svc.analyze_menu_board(db, store, b"fake-image", "image/png"))


def test_초안_조립_기본(db, monkeypatch):
    _ingredient(db, "에티오피아 원두", unit="kg")
    out = _analyze(db, monkeypatch, [{"name": "아메리카노", "price": 4500}])

    assert len(out["menus"]) == 1
    m = out["menus"][0]
    assert m["name"] == "아메리카노"
    assert m["price"] == 4500
    assert m["recipe_source"] == "preset"
    assert m["exists"] is False
    assert out["estimated"] is True


def test_천원_단위_가격이_원_단위가_된다(db, monkeypatch):
    """메뉴판에 '4.5'로 적힌 것 — 그대로 두면 4원짜리 아메리카노가 된다."""
    out = _analyze(db, monkeypatch, [{"name": "아메리카노", "price": 4.5}])
    assert out["menus"][0]["price"] == 4500


def test_같은_메뉴가_두_번_오면_하나로_합친다(db, monkeypatch):
    """메뉴판에 ICE/HOT이 따로 적혀 있으면 AI가 두 줄로 읽어 온다."""
    out = _analyze(db, monkeypatch, [
        {"name": "아이스 아메리카노", "price": 4500},
        {"name": "아메리카노", "price": 4000},
    ])
    assert len(out["menus"]) == 1


def test_이미_등록된_메뉴는_표시된다(db, monkeypatch):
    """띄어쓰기가 달라도 같은 메뉴로 봐야 중복 등록을 막을 수 있다."""
    from app.models.inventory import Menu
    db.add(Menu(store_id="s@t.com", name="카페 라떼", selling_price=5000))
    db.commit()

    out = _analyze(db, monkeypatch, [{"name": "카페라떼", "price": 5000}])
    assert out["menus"][0]["exists"] is True


def test_재료_후보가_여럿이면_자동_선택하지_않는다(db, monkeypatch):
    """원두를 두 종류 쓰는 매장 — 임의로 고르면 원가가 조용히 틀린다."""
    _ingredient(db, "에티오피아 원두", unit="kg")
    _ingredient(db, "콜롬비아 원두", unit="kg")

    out = _analyze(db, monkeypatch, [{"name": "아메리카노", "price": 4500}])
    r = out["menus"][0]["recipes"][0]
    assert r["ingredient_id"] is None
    assert len(r["candidates"]) == 2


def test_후보가_하나면_자동으로_연결하고_단위까지_환산한다(db, monkeypatch):
    """표준 18g → 매장은 kg으로 센다 → 0.018kg으로 저장돼야 한다."""
    ing = _ingredient(db, "원두", unit="kg")

    out = _analyze(db, monkeypatch, [{"name": "아메리카노", "price": 4500}])
    r = out["menus"][0]["recipes"][0]
    assert r["ingredient_id"] == ing.id
    assert r["preset_quantity"] == 18      # 표준값은 근거로 남는다
    assert r["preset_unit"] == "g"
    assert r["quantity"] == pytest.approx(0.018)   # 실제 저장될 값
    assert r["unit"] == "kg"


def test_매장에_없는_재료는_따로_알려준다(db, monkeypatch):
    """없는 재료를 멋대로 만들지 않는다 — 사장님이 재고에 먼저 등록해야 한다."""
    _ingredient(db, "원두", unit="kg")
    out = _analyze(db, monkeypatch, [{"name": "카페라떼", "price": 5000}])

    assert "우유" in out["unknown_ingredients"]
    milk = next(r for r in out["menus"][0]["recipes"] if r["ingredient"] == "우유")
    assert milk["candidates"] == []


def test_사전에_없는_메뉴는_AI에게_물어본다(db, monkeypatch):
    """흑임자라떼처럼 사전에 없는 메뉴 — 지어내지 말고 AI에게 묻는다."""
    _ingredient(db, "흑임자", unit="g")
    out = _analyze(
        db, monkeypatch,
        menus=[{"name": "흑임자라떼", "price": 6000}],
        recipes=[{"menu": "흑임자라떼", "recipes": [
            {"ingredient": "흑임자", "quantity": 20, "unit": "g"}]}],
    )
    m = out["menus"][0]
    assert m["recipe_source"] == "ai"
    assert m["recipes"][0]["ingredient"] == "흑임자"


def test_AI도_모르면_레시피_없이_메뉴만(db, monkeypatch):
    """이름과 가격만 있어도 매출 입력에는 쓸 수 있다 — 등록 자체를 막지는 않는다."""
    out = _analyze(db, monkeypatch, [{"name": "알수없는특별메뉴", "price": 7000}], recipes=[])
    m = out["menus"][0]
    assert m["recipe_source"] == "none"
    assert m["recipes"] == []


def test_이름이_빈_메뉴는_버린다(db, monkeypatch):
    out = _analyze(db, monkeypatch, [
        {"name": "", "price": 4000},
        {"name": "   ", "price": 4000},
        {"name": "아메리카노", "price": 4500},
    ])
    assert [m["name"] for m in out["menus"]] == ["아메리카노"]


def test_메뉴를_하나도_못_읽으면_알려준다(db, monkeypatch):
    """빈 화면을 보여주는 대신 무엇을 하면 되는지 말해 준다."""
    with pytest.raises(svc.MenuOcrError) as e:
        _analyze(db, monkeypatch, [])
    assert "다시 찍어" in str(e.value)


def test_가격을_못_읽어도_메뉴는_살린다(db, monkeypatch):
    """가격은 나중에 넣을 수 있다 — 메뉴명까지 버리면 다시 찍어야 한다."""
    out = _analyze(db, monkeypatch, [{"name": "아메리카노", "price": None}])
    assert out["menus"][0]["price"] is None
