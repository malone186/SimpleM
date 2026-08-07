# -*- coding: utf-8 -*-
"""메뉴 개선안 점검 테스트

여기서 지키려는 것:
  1. 가격 인상의 중심 숫자 — '판매량이 몇 %까지 줄어도 본전인가'가 산수로 정확해야 한다
  2. 원가(레시피)를 모르는 메뉴는 마진을 지어내지 않는다 (0원으로 잡으면 결론이 뒤집힌다)
  3. 사람이 적은 대로 받는다 — "아메리카노 4500", "-바닐라라떼", "+흑임자라떼 6000"
  4. 사진 대조는 '메뉴판에 없다=뺐다'를 단정하지 않는다
"""
import asyncio

import pytest

from app.services.ai import menu_review_service as svc


# ---------------------------------------------------------------------------
# 가짜 매장 — menu_contribution이 주는 모양 그대로
# ---------------------------------------------------------------------------

def _menu(mid, name, price, cost, qty, *, recipe_missing=False, active=True):
    margin = price - cost
    return {
        "menu_id": mid, "name": name, "selling_price": price, "cost_price": cost,
        "cost_ratio": round(cost / price * 100, 1) if price else None,
        "margin_per_cup": margin, "sold_qty": qty, "revenue": price * qty,
        "total_margin": margin * qty, "recipe_missing": recipe_missing,
        "is_active": active, "margin_share": 0.0,
    }


STORE = [
    _menu(1, "아메리카노", 4000, 900, 500),
    _menu(2, "카페라떼", 4500, 1400, 300),
    _menu(3, "바닐라라떼", 5000, 1800, 40),
    _menu(4, "수제청에이드", 6000, 6500, 20),          # 팔수록 손해
    _menu(5, "시즌한정브륄레", 6500, 0, 10, recipe_missing=True),
]


@pytest.fixture
def store(monkeypatch):
    """판매·원가 조회와 AI 총평을 고정한다 — 계산만 검증한다."""
    from app.services.ai import sales_service

    def fake_contribution(store_id, days=30):
        rows = [dict(m) for m in STORE]
        return {"days": days, "menus": rows,
                "total_margin": sum(r["total_margin"] for r in rows),
                "total_revenue": sum(r["revenue"] for r in rows),
                "total_qty": sum(r["sold_qty"] for r in rows)}

    monkeypatch.setattr(sales_service, "menu_contribution", fake_contribution)
    monkeypatch.setattr(svc, "_store_ingredients", lambda store_id: [])
    monkeypatch.setattr(svc, "_ai_comment", lambda s, i: (svc._rule_comment(s, i), "rule"))
    return "s@gmail.com"


# ---------------------------------------------------------------------------
# 1. 가격 인상 — 버틸 수 있는 판매 감소폭
# ---------------------------------------------------------------------------

def test_인상은_버틸_수_있는_판매_감소폭을_준다(store):
    """4,000(원가 900) → 4,500. 마진 3,100 → 3,600이므로 1-3100/3600 = 13.9%."""
    out = svc.review(store, [{"kind": "price", "name": "아메리카노", "price": 4500}])
    item = out["changes"][0]

    assert item["breakeven_drop_pct"] == 13.9
    assert item["breakeven_drop_cups"] == 69          # 500잔 × 13.9%
    assert item["monthly_delta"] == 250_000           # 500원 × 500잔
    assert item["verdict"] == "good"


def test_인상폭이_크면_경고한다(store):
    """4,000 → 5,000은 25% 인상 — 계산상 이득이어도 그냥 넘기면 안 된다."""
    out = svc.review(store, [{"kind": "price", "name": "아메리카노", "price": 5000}])
    item = out["changes"][0]
    assert item["verdict"] == "risk"
    assert item["change_pct"] == 25.0
    assert any("천원대" in n for n in item["notes"])   # 4천원대 → 5천원대


def test_인하는_얼마나_더_팔아야_본전인지_말한다(store):
    """마진 3,100 → 2,600. 3100/2600-1 = 19.2%를 더 팔아야 같아진다."""
    out = svc.review(store, [{"kind": "price", "name": "아메리카노", "price": 3500}])
    item = out["changes"][0]
    assert item["breakeven_gain_pct"] == 19.2
    assert item["monthly_delta"] == -250_000


def test_증감액만_말해도_된다(store):
    """'500원 인상'은 지금 가격을 읽어서 계산한다."""
    out = svc.review(store, [{"kind": "price", "name": "아메리카노", "delta": 500}])
    assert out["changes"][0]["after"]["price"] == 4500


# ---------------------------------------------------------------------------
# 2. 모르는 것은 모른다고 한다
# ---------------------------------------------------------------------------

def test_원가를_모르는_메뉴는_마진을_지어내지_않는다(store):
    """레시피가 없으면 원가 0원 → '3,000원 남는다'는 거짓 결론이 나온다."""
    out = svc.review(store, [{"kind": "price", "name": "시즌한정브륄레", "price": 7000}])
    item = out["changes"][0]
    assert item["before"]["margin"] is None
    assert item["monthly_delta"] is None
    assert "원가" in item["headline"]


def test_없는_메뉴는_조용히_빠지지_않는다(store):
    """개선안 한 줄이 말없이 사라지면 사장님은 반영된 줄 안다."""
    out = svc.review(store, [
        {"kind": "price", "name": "아메리카노", "price": 4500},
        {"kind": "price", "name": "없는메뉴", "price": 3000},
    ])
    assert "없는메뉴" in out["unmatched"]
    assert len(out["changes"]) == 1


def test_같은_메뉴에_지시가_두_번_오면_한_번만_센다(store):
    out = svc.review(store, [
        {"kind": "price", "name": "아메리카노", "price": 4500},
        {"kind": "remove", "name": "아메리카노"},
    ])
    assert len(out["changes"]) == 1
    assert any("두 번" in u for u in out["unmatched"])


# ---------------------------------------------------------------------------
# 3. 빼기 · 새 메뉴
# ---------------------------------------------------------------------------

def test_손해_보던_메뉴를_빼면_잘한_일로_본다(store):
    out = svc.review(store, [{"kind": "remove", "name": "수제청에이드"}])
    item = out["changes"][0]
    assert item["verdict"] == "good"
    assert item["monthly_delta"] > 0                  # 손해가 사라지니 이익이 는다
    assert out["summary"]["monthly_delta"] > 0


def test_이익_기둥을_빼면_위험으로_본다(store):
    """아메리카노는 이 매장 이익의 절반이 넘는다."""
    out = svc.review(store, [{"kind": "remove", "name": "아메리카노"}])
    item = out["changes"][0]
    assert item["verdict"] == "risk"
    assert item["monthly_delta"] == -1_550_000        # 3,100 × 500잔
    assert out["verdict"] == "risky"


def test_새_메뉴는_월수익_합계에_넣지_않는다(store):
    """얼마나 팔릴지 아무도 모른다 — 넣는 순간 총합이 소설이 된다."""
    out = svc.review(store, [{"kind": "add", "name": "흑임자라떼", "price": 6000, "cost": 2000}])
    item = out["changes"][0]
    assert item["monthly_delta"] is None
    assert item["after"]["cost_ratio"] == 33.3
    assert item["target_qty_30d"] > 0                 # 대신 '몇 잔 팔면 되는지'로 답한다
    assert out["summary"]["menu_count_after"] == len(STORE) + 1


def test_이미_있는_메뉴를_새로_넣으면_알려준다(store):
    out = svc.review(store, [{"kind": "add", "name": "아메리카노", "price": 4500}])
    assert out["changes"][0]["headline"] == "이미 있는 메뉴예요"


# ---------------------------------------------------------------------------
# 4. 사람이 적은 대로 받는다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("아메리카노 4500", {"kind": "price", "name": "아메리카노", "price": 4500}),
    ("아메리카노 4000 -> 4500", {"kind": "price", "name": "아메리카노", "price": 4500}),
    ("아메리카노 4.5", {"kind": "price", "name": "아메리카노", "price": 4500}),
    ("-바닐라라떼", {"kind": "remove", "name": "바닐라라떼"}),
    ("바닐라라떼 단종", {"kind": "remove", "name": "바닐라라떼"}),
    ("+흑임자라떼 6000", {"kind": "add", "name": "흑임자라떼", "price": 6000}),
    ("신메뉴 흑임자라떼 6000원", {"kind": "add", "name": "흑임자라떼", "price": 6000}),
    ("아메리카노 원가 800", {"kind": "cost", "name": "아메리카노", "cost": 800}),
    ("아메리카노 500원 인상", {"kind": "price", "name": "아메리카노", "delta": 500}),
    ("아메리카노 500원 인하", {"kind": "price", "name": "아메리카노", "delta": -500}),
])
def test_개선안_표기_해석(text, expected):
    got, unparsed = svc.parse_change_spec(text)
    assert not unparsed
    assert got == [expected]


def test_여러_줄을_한_번에_읽는다():
    got, unparsed = svc.parse_change_spec("아메리카노 4500, -바닐라라떼, +흑임자라떼 6000")
    assert [c["kind"] for c in got] == ["price", "remove", "add"]
    assert not unparsed


def test_못_읽은_줄은_그대로_돌려준다():
    got, unparsed = svc.parse_change_spec("아메리카노 4500, 뭔가 이상한 말")
    assert len(got) == 1
    assert unparsed == ["뭔가 이상한 말"]


# ---------------------------------------------------------------------------
# 5. 사진 대조 — 단정하지 않는다
# ---------------------------------------------------------------------------

def test_사진_대조는_뺀_것을_단정하지_않는다(store, monkeypatch):
    """새 메뉴판에 바닐라라떼가 안 보인다고 정말 뺀 건 아니다 (사진이 잘렸을 수 있다)."""
    from app.services.ai import menu_ocr_service

    async def fake_read(image_bytes, mime_type="image/jpeg"):
        return [
            {"name": "아메리카노", "price": 4500},     # 인상
            {"name": "카페라떼", "price": 4500},       # 그대로
            {"name": "흑임자라떼", "price": 6000},     # 신메뉴
            {"name": "수제청에이드", "price": 6000},
            {"name": "시즌한정브륄레", "price": 6500},
        ]

    monkeypatch.setattr(menu_ocr_service, "read_menu_board", fake_read)
    out = asyncio.run(svc.review_menu_board(None, store, b"fake"))

    kinds = {(c["kind"], c["name"]) for c in out["changes"]}
    assert ("price", "아메리카노") in kinds
    assert ("add", "흑임자라떼") in kinds
    assert "카페라떼" in out["unchanged"]

    removed = [c for c in out["changes"] if c["kind"] == "remove"]
    assert [c["name"] for c in removed] == ["바닐라라떼"]
    assert removed[0]["uncertain"] is True
    assert any("사진" in n for n in removed[0]["notes"])


def test_사진이_지금과_같으면_바뀐_게_없다고_한다(store, monkeypatch):
    from app.services.ai import menu_ocr_service

    async def fake_read(image_bytes, mime_type="image/jpeg"):
        return [{"name": m["name"], "price": m["selling_price"]} for m in STORE]

    monkeypatch.setattr(menu_ocr_service, "read_menu_board", fake_read)
    out = asyncio.run(svc.review_menu_board(None, store, b"fake"))
    assert out["changes"] == []
    assert out["verdict_label"] == "바뀐 게 없어요"


# ---------------------------------------------------------------------------
# 6. 전체 요약
# ---------------------------------------------------------------------------

def test_요약은_판매량_유지_가정을_밝힌다(store):
    out = svc.review(store, [{"kind": "price", "name": "아메리카노", "price": 4500}])
    assert any("유지" in a for a in out["assumptions"])
    s = out["summary"]
    assert s["monthly_margin_after"] - s["monthly_margin_before"] == 250_000
    assert s["avg_ticket_after"] > s["avg_ticket_before"]


def test_점검할_게_없으면_막는다(store):
    with pytest.raises(svc.MenuReviewError):
        svc.review(store, [])


# ---------------------------------------------------------------------------
# 7. 반영 — 눌렀을 때만, 그리고 지우지 않는다
# ---------------------------------------------------------------------------

class _FakeMenu:
    def __init__(self, mid, name, price, active=True):
        self.id, self.name, self.selling_price, self.is_active = mid, name, price, active


class _FakeDB:
    """apply_changes가 쓰는 만큼만 흉내 낸다 (query→filter→all, add/flush/commit)."""

    def __init__(self, rows):
        self.rows = rows
        self.added = []
        self.committed = False

    def query(self, *a):
        return self

    def filter(self, *a):
        return self

    def all(self):
        return list(self.rows)

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        for i, o in enumerate(self.added, start=100):
            o.id = getattr(o, "id", None) or i

    def commit(self):
        self.committed = True

    def rollback(self):
        pass


@pytest.fixture
def fake_db(monkeypatch):
    from app.services.ai import forecast_service

    monkeypatch.setattr(forecast_service, "invalidate_forecast_cache", lambda store_id: None)
    return _FakeDB([_FakeMenu(1, "아메리카노", 4000), _FakeMenu(3, "바닐라라떼", 5000)])


def test_반영은_가격을_바꾸고_뺀_메뉴는_숨긴다(fake_db):
    """빼기를 삭제로 처리하면 지난달 리포트의 메뉴 이름까지 사라진다."""
    out = svc.apply_changes(fake_db, "s@gmail.com", [
        {"kind": "price", "name": "아메리카노", "price": 4500},
        {"kind": "remove", "name": "바닐라라떼"},
    ])
    assert fake_db.rows[0].selling_price == 4500
    assert fake_db.rows[1].is_active is False
    assert out["updated"] == ["아메리카노 4,500원"]
    assert out["hidden"] == ["바닐라라떼"]
    assert fake_db.committed


def test_반영에서_새_메뉴는_레시피가_없다고_알린다(fake_db):
    out = svc.apply_changes(fake_db, "s@gmail.com",
                            [{"kind": "add", "name": "흑임자라떼", "price": 6000}])
    assert out["created"] == ["흑임자라떼"]
    assert any("레시피" in w for w in out["warnings"])


def test_반영에서_없는_메뉴는_조용히_넘어가지_않는다(fake_db):
    out = svc.apply_changes(fake_db, "s@gmail.com",
                            [{"kind": "price", "name": "없는메뉴", "price": 3000}])
    assert out["updated"] == []
    assert any("찾지 못했" in w for w in out["warnings"])
