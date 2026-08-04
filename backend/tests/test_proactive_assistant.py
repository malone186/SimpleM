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


def test_이미_재고_할_일이_있는_재료는_두_줄로_만들지_않는다(monkeypatch, db):
    monkeypatch.setattr(insight_service, "scan", lambda store_id, **kw: _fake_scan([
        insight_service._insight("stock_runout:7:2026-07-30", "inventory", "high",
                                 "원두 소진 예상", "본문", "액션", todo="원두 발주"),
    ]))
    assert ai_todo_service._insight_todos(STORE, {"stock-7"}) == []


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
