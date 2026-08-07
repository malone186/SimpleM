"""선제 비서 계층 테스트 (백엔드 B) — 발동 조건 → 알림·할 일

인사이트 스캐너(모든 기능의 발동 조건), 그것을 할 일로 바꾸는 층, 아침 브리핑,
그리고 '전용 규칙이 없는 영역'을 담당하는 인사이트 푸시 규칙을 sqlite로 검증한다.
외부 호출(Gemini·FCM)은 전부 스텁으로 가로챈다.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.ai import DailySalesEntry, DeviceToken, GeneratedDocument, PosConnection
from app.models.inventory import Order
from app.services.ai import ai_todo_service, briefing_service, insight_service
from app.services.ai import notification_service as ns
from app.services.ai import push_service as ps

KST = timezone(timedelta(hours=9))
STORE = "owner@test.com"
TODAY = date(2026, 7, 28)  # 화요일


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)

    # 스캐너·브리핑 캐시는 프로세스 전역이라 테스트마다 비운다
    insight_service._scan_cache.clear()
    insight_service._deep_cache.clear()
    ai_todo_service._cache.clear()
    briefing_service._cache.clear()

    session = TestSession()
    session.add(DeviceToken(store_id=STORE, token="tok-" + "x" * 20))
    session.commit()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def sent(monkeypatch):
    log: list[dict] = []
    monkeypatch.setattr(
        ps, "send_to_store",
        lambda db, sid, title, body, data=None, urgent=False: (
            log.append({"title": title, "body": body, "data": data}) or 1),
    )
    return log


# ---------------------------------------------------------------------------
# 스캐너 — 발동 조건
# ---------------------------------------------------------------------------

def test_어제_매출이_비어_있으면_정산_인사이트가_뜬다(db):
    found = insight_service._scan_settlement(db, STORE, TODAY)
    keys = [i["key"] for i in found]
    assert f"settlement_missing:{(TODAY - timedelta(days=1)).isoformat()}" in keys


def test_어제_매출을_입력했으면_조용하다(db):
    db.add(DailySalesEntry(store_id=STORE, entry_date=(TODAY - timedelta(days=1)).isoformat(),
                           method="cash", issuer="", amount=120_000))
    db.commit()
    found = insight_service._scan_settlement(db, STORE, TODAY)
    assert not [i for i in found if i["key"].startswith("settlement_missing")]


def test_POS_연동_오류는_지금_조치_등급이다(db):
    db.add(PosConnection(store_id=STORE, access_token_enc="x", last_status="error",
                         last_error="401 Unauthorized"))
    db.commit()
    found = insight_service._scan_pos_health(db, STORE, TODAY)
    assert len(found) == 1
    assert found[0]["severity"] == "high"
    assert found[0]["category"] == "system"
    # 알림 제목은 상황 문장, 할 일은 짧은 라벨 — 둘은 다른 문구여야 한다
    assert found[0]["todo"] == "POS 연동 점검"


def test_POS를_연결한_적_없으면_아무_말도_안_한다(db):
    assert insight_service._scan_pos_health(db, STORE, TODAY) == []


def test_초안으로_멈춰_있는_발주서를_찾아낸다(db):
    old = datetime.now(timezone.utc) - timedelta(days=5)
    db.add(Order(store_id=STORE, status="DRAFT", total_amount=88_000, created_at=old))
    db.commit()
    found = insight_service._scan_stale_orders(db, STORE, TODAY)
    assert len(found) == 1
    assert found[0]["category"] == "order"
    assert "88,000원" in found[0]["body"]


def test_홍보물이_없으면_홍보를_권한다(db):
    found = insight_service._scan_marketing(db, STORE, TODAY)
    assert len(found) == 1
    assert found[0]["category"] == "marketing"
    # 주 단위 키 — 한 번 넘겨도 매일 다시 조르지 않는다
    assert found[0]["key"].startswith(f"marketing_quiet:{TODAY.isocalendar()[0]}-W")


def test_최근에_홍보물을_만들었으면_조용하다(db):
    db.add(GeneratedDocument(id="m1", store_id=STORE, kind="marketing_content",
                             title="여름 신메뉴", content="{}",
                             created_at=datetime.now(timezone.utc) - timedelta(days=2)))
    db.commit()
    assert insight_service._scan_marketing(db, STORE, TODAY) == []


# ---------------------------------------------------------------------------
# 메뉴 개선 — '점검해 보세요'가 아니라 '얼마로 올리세요'까지
# ---------------------------------------------------------------------------

def _fake_recommend(suggestions):
    return {"days": 30, "suggestions": suggestions, "headline": "", "expected_gain": 0,
            "comment": "", "assumptions": []}


def test_메뉴_인사이트는_받아야_할_가격까지_말한다(monkeypatch, db):
    """'원가율 45%예요, 점검하세요'는 숙제만 넘기는 말이다 — 얼마로 올릴지가 있어야 한다."""
    from app.services.ai import menu_review_service

    monkeypatch.setattr(menu_review_service, "recommend", lambda store_id, **kw: _fake_recommend([{
        "kind": "price", "menu_id": 7, "name": "수제청에이드",
        "before": {"price": 6000, "cost": 6500, "margin": -500, "sold_qty_30d": 20},
        "after": {"price": 6900, "cost": 6500, "margin": 400},
        "monthly_delta": 18000, "breakeven_drop_pct": None, "verdict": "risk",
        "headline": "", "reason": "", "notes": [], "why": "", "priority": 0, "actionable": True,
    }]))
    found = insight_service._scan_menu_margin(db, STORE, TODAY)

    assert found[0]["category"] == "menu"
    assert found[0]["severity"] == "high"          # 팔수록 손해는 지금 조치
    assert "6,900원" in found[0]["body"]           # 얼마로 올려야 하는지
    assert found[0]["todo"] == "수제청에이드 가격 올리기"
    assert "6900원으로 올리면" in found[0]["action"]  # 챗봇이 그대로 다시 계산해 준다


def test_인상_추천은_버틸_수_있는_감소폭을_함께_말한다(monkeypatch, db):
    from app.services.ai import menu_review_service

    monkeypatch.setattr(menu_review_service, "recommend", lambda store_id, **kw: _fake_recommend([{
        "kind": "price", "menu_id": 1, "name": "아메리카노",
        "before": {"price": 4000, "cost": 2000, "margin": 2000, "sold_qty_30d": 500},
        "after": {"price": 4600, "cost": 2000, "margin": 2600},
        "monthly_delta": 300000, "breakeven_drop_pct": 23.1, "breakeven_drop_cups": 115,
        "verdict": "good", "headline": "", "reason": "", "notes": [],
        "why": "", "priority": 1, "actionable": True,
    }]))
    body = insight_service._scan_menu_margin(db, STORE, TODAY)[0]["body"]
    assert "23.1%(115잔)" in body
    assert "300,000원" in body


def test_안_나가는_메뉴가_쌓이면_정리를_할_일로_올린다(monkeypatch, db):
    from app.services.ai import menu_review_service

    def dead(mid, name):
        return {"kind": "remove", "menu_id": mid, "name": name,
                "before": {"price": 5000, "cost": 1000, "margin": 4000, "sold_qty_30d": 0},
                "after": None, "monthly_delta": 0, "verdict": "good",
                "headline": "", "reason": "", "notes": [], "why": "", "priority": 2,
                "actionable": True}

    monkeypatch.setattr(menu_review_service, "recommend", lambda store_id, **kw: _fake_recommend(
        [dead(1, "티라미수"), dead(2, "크로플"), dead(3, "마카롱")]))
    found = insight_service._scan_menu_margin(db, STORE, TODAY)
    assert found[0]["severity"] == "medium"        # 3개부터 할 일 (low는 투두가 되지 않는다)
    assert found[0]["todo"] == "안 팔리는 메뉴 정리"
    assert "티라미수" in found[0]["body"]


def test_안_나가는_메뉴가_하나뿐이면_할_일로_올리지_않는다(monkeypatch, db):
    """시즌 메뉴일 수 있다 — 알림으로만 남기고 할 일 칸은 비워 둔다."""
    from app.services.ai import menu_review_service

    monkeypatch.setattr(menu_review_service, "recommend", lambda store_id, **kw: _fake_recommend([{
        "kind": "remove", "menu_id": 9, "name": "장미라떼",
        "before": {"price": 6000, "cost": 1500, "margin": 4500, "sold_qty_30d": 0},
        "after": None, "monthly_delta": 0, "verdict": "good",
        "headline": "", "reason": "", "notes": [], "why": "", "priority": 2, "actionable": True,
    }]))
    assert insight_service._scan_menu_margin(db, STORE, TODAY)[0]["severity"] == "low"


def test_메뉴가_없는_매장에서는_조용하다(monkeypatch, db):
    from app.services.ai import menu_review_service

    def boom(store_id, **kw):
        raise menu_review_service.MenuReviewError("등록된 메뉴가 없어요")

    monkeypatch.setattr(menu_review_service, "recommend", boom)
    assert insight_service._scan_menu_margin(db, STORE, TODAY) == []


def test_추천이_터져도_나머지_인사이트는_살아남는다(monkeypatch, db):
    from app.services.ai import menu_review_service

    def boom(store_id, **kw):
        raise RuntimeError("DB 끊김")

    monkeypatch.setattr(menu_review_service, "recommend", boom)
    assert insight_service._scan_menu_margin(db, STORE, TODAY) == []


# ---------------------------------------------------------------------------
# 인사이트 → 할 일
# ---------------------------------------------------------------------------

def _fake_scan(insights):
    return {"insights": insights, "count": len(insights), "high": 0, "medium": 0, "low": 0}


def test_인사이트가_짧은_라벨_할_일로_바뀐다(monkeypatch, db):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("settlement_missing:2026-07-27", "settlement", "medium",
                                 "어제 매출이 아직 입력되지 않았어요",
                                 "2026-07-27의 현금·카드 매출 기록이 비어 있습니다. 30초면 끝나요.",
                                 "어제 매출 입력하는 법 알려줘", todo="어제 매출 입력"),
    ]))
    todos = ai_todo_service._insight_todos(STORE, set())
    assert len(todos) == 1
    assert todos[0]["title"] == "어제 매출 입력"          # 라벨은 todo 값 그대로
    assert todos[0]["id_hint"].startswith("insight-")   # 상황이 같으면 매일 같은 id
    assert todos[0]["kind"] == "insight"


def test_알림_전용_인사이트는_할_일이_되지_않는다(monkeypatch, db):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("settlement_deposit:2026-07-28", "settlement", "medium",
                                 "오늘 카드 대금 40만원 입금 예정", "본문", "액션", todo=""),
    ]))
    assert ai_todo_service._insight_todos(STORE, set()) == []


def test_한_영역이_할_일_칸을_독차지하지_않는다(monkeypatch, db):
    many = [
        insight_service._insight(f"stock_runout:{i}:2026-07-30", "inventory", "high",
                                 f"재료{i} 소진 예상", "본문", "액션", todo=f"재료{i} 발주")
        for i in range(5)
    ] + [
        insight_service._insight("renewal:1:2026-08-01", "document", "high",
                                 "보건증 만료 임박", "본문", "액션", todo="보건증 갱신"),
    ]
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan(many))
    todos = ai_todo_service._insight_todos(STORE, set())
    assert [t["category"] for t in todos] == ["inventory", "document"]


def test_다_떨어진_재료가_많아도_상위_4개는_재료_id_순으로_고정된다(monkeypatch, db):
    """동점(전부 0개)일 때 순서가 흔들리면 앱이 고른 4개와 어긋나 중복 줄이 생긴다.

    앱(DashboardScreen.buildDashboard)도 (남은양/필요량, 재료id) 순으로 4개를 고른다.
    여기서 순서가 DB가 주는 대로 흘러가면 두 목록이 달라지고, 한쪽에만 남은 재료를
    소진 예측 인사이트가 다시 집어 와 '<재료명> 발주'가 두 줄로 뜬다.
    """
    from app.models.inventory import Ingredient, Stock

    for i in (73, 64, 67, 65, 66):   # 일부러 뒤섞어 넣는다
        db.add(Ingredient(id=i, name=f"재료{i}", unit="kg", current_price=0, store_id=STORE))
        db.add(Stock(ingredient_id=i, current_quantity=0.0, safety_quantity=2.0))
    db.commit()

    stocks, _ = ai_todo_service._gather(STORE)
    assert [s["id"] for s in stocks] == [64, 65, 66, 67]

    # 그 4개 중 하나(67)의 소진 예측은 접히고, 밀려난 73은 그대로 남는다
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("stock_runout:67:2026-07-30", "inventory", "high",
                                 "재료67 소진 예상", "본문", "액션", todo="재료67 발주"),
    ]))
    todos = ai_todo_service.suggest_todos(STORE)["todos"]
    titles = [t["title"] for t in todos]
    assert titles.count("재료67 발주") == 1
    assert len(set(t["id_hint"] for t in todos)) == len(todos)


def test_이미_재고_할_일이_있는_재료는_두_줄로_만들지_않는다(monkeypatch, db):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("stock_runout:7:2026-07-30", "inventory", "high",
                                 "원두 소진 예상", "본문", "액션", todo="원두 발주"),
    ]))
    # 재료 id로 판정한다 (예전엔 'stock-7' 문자열이었다)
    assert ai_todo_service._insight_todos(STORE, {7}) == []


# ---------------------------------------------------------------------------
# 아침 브리핑
# ---------------------------------------------------------------------------

def test_Gemini가_없어도_브리핑은_나간다(monkeypatch, db):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("renewal:1:2026-08-01", "document", "high",
                                 "보건증 만료 3일 전", "만료일 2026-08-01.", "액션"),
    ]))
    monkeypatch.setattr(briefing_service, "_ai_text", lambda *a, **kw: None)  # 키 없음/실패
    result = briefing_service.build(STORE)
    assert result["engine"] == "rule"
    assert "보건증 만료 3일 전" in result["message"]
    assert result["priorities"][0]["severity"] == "high"


def test_브리핑_푸시는_하루에_한_번만(monkeypatch, db, sent):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("pos_error:401", "system", "high",
                                 "POS 연동에 오류가 났어요", "401 Unauthorized", "액션"),
    ]))
    monkeypatch.setattr(briefing_service, "_ai_text", lambda *a, **kw: None)

    settings = ns.get_settings(db, STORE)
    now = datetime(2026, 7, 28, 9, 0, tzinfo=KST)
    assert ns.check_briefing(db, STORE, settings, now) != []
    assert ns.check_briefing(db, STORE, settings, now.replace(hour=11)) == []
    assert len(sent) == 1
    assert sent[0]["title"].startswith("☕ 오늘의 브리핑")


def test_브리핑은_오픈_시각_전에는_안_나간다(monkeypatch, db, sent):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([]))
    settings = ns.get_settings(db, STORE)
    assert ns.check_briefing(db, STORE, settings, datetime(2026, 7, 28, 5, 0, tzinfo=KST)) == []
    assert sent == []


# ---------------------------------------------------------------------------
# 인사이트 푸시 규칙
# ---------------------------------------------------------------------------

def test_전용_규칙이_있는_영역은_인사이트_푸시로_중복되지_않는다(monkeypatch, db, sent):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("stock_runout:1:2026-07-30", "inventory", "high",
                                 "원두 소진 예상", "본문", "액션"),      # 규칙 3이 담당
        insight_service._insight("renewal:1:2026-08-01", "document", "high",
                                 "보건증 만료", "본문", "액션"),          # 규칙 1이 담당
        insight_service._insight("pos_error:401", "system", "high",
                                 "POS 연동에 오류가 났어요", "401", "액션"),
    ]))
    settings = ns.get_settings(db, STORE)
    now = datetime(2026, 7, 28, 10, 0, tzinfo=KST)
    ns.check_insights(db, STORE, settings, now)

    assert len(sent) == 1
    assert "POS" in sent[0]["title"]
    assert sent[0]["data"]["screen"] == "Settings"   # 탭하면 연동 설정으로 간다


def test_지금_조치가_아니면_푸시하지_않는다(monkeypatch, db, sent):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("churn_risk:3:1", "customer", "medium",
                                 "뜸해진 단골 3명", "본문", "액션"),
    ]))
    settings = ns.get_settings(db, STORE)
    ns.check_insights(db, STORE, settings, datetime(2026, 7, 28, 10, 0, tzinfo=KST))
    assert sent == []


def test_같은_인사이트는_두_번_울리지_않는다(monkeypatch, db, sent):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("checkin_waiting:1:9", "customer", "high",
                                 "김손님이 5분째 기다리고 있어요", "본문", "액션"),
    ]))
    settings = ns.get_settings(db, STORE)
    now = datetime(2026, 7, 28, 10, 0, tzinfo=KST)
    ns.check_insights(db, STORE, settings, now)
    ns.check_insights(db, STORE, settings, now + timedelta(hours=1))
    assert len(sent) == 1
