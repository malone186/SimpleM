"""주변 상권 변화 감시 테스트 (백엔드 B) — sqlite 인메모리

네이버 지역검색은 스텁으로 가로채고, '언제 신규/폐업이라고 부르는가'만 본다.
핵심은 한 번의 검색 흔들림으로 개업·폐업을 단정하지 않는다는 점이다.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.ai import DeviceToken, NearbyCafeWatch, NotificationSetting
from app.models.user import User
from app.services.ai import nearby_cafe_service as ncs
from app.services.ai import nearby_watch_service as nws
from app.services.ai import notification_service as ns
from app.services.ai import push_service as ps

KST = timezone(timedelta(hours=9))
STORE = "owner@test.com"
LAT, LON = 37.5, 127.0

DAY1 = date(2026, 8, 1)
DAY2 = date(2026, 8, 2)
DAY3 = date(2026, 8, 3)
DAY4 = date(2026, 8, 4)


def _cafe(name: str, dist: int) -> dict:
    return {"name": name, "category": "카페", "address": f"서울시 어딘가 {name}로",
            "telephone": "", "link": "", "lat": LAT, "lon": LON, "distance_m": dist}


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)

    session = TestSession()
    session.add(User(email=STORE, hashed_password="x", name="사장", store_name="내카페",
                     store_lat=LAT, store_lon=LON))
    session.add(DeviceToken(store_id=STORE, token="tok-" + "x" * 20))
    session.commit()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def naver(monkeypatch):
    """find_nearby_cafes 스텁 — 테스트가 '오늘 검색에 잡힌 카페'를 직접 정한다."""
    state = {"cafes": []}

    def fake(lat, lon, radius_m=1000, limit=20, exclude_name="", **kwargs):
        return {"region": "서울특별시 강남구 역삼동", "radius_m": radius_m,
                "count": len(state["cafes"]), "cafes": list(state["cafes"]), "cached": False}

    monkeypatch.setattr(ncs, "find_nearby_cafes", fake)
    return state


BASE = [_cafe("가카페", 100), _cafe("나카페", 200), _cafe("다카페", 300), _cafe("라카페", 400)]


# ---------------------------------------------------------------------------
# 첫 스캔 = 기준선
# ---------------------------------------------------------------------------

def test_first_scan_is_baseline_not_new_openings(db, naver):
    """처음 훑은 날 잡힌 가게들은 '원래 있던 가게'다 — 개업으로 알리면 전부 오보다."""
    naver["cafes"] = BASE
    result = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)

    assert result["baseline"] is True
    assert result["opened"] == [] and result["closed"] == []
    assert db.query(NearbyCafeWatch).filter(NearbyCafeWatch.store_id == STORE).count() == 4
    # 기준선 가게는 '알림 완료'로 표시돼 나중에도 신규로 올라오지 않는다
    assert all(r.open_notified for r in db.query(NearbyCafeWatch).all())


# ---------------------------------------------------------------------------
# 신규 개업 — 두 번 연속 관측돼야 인정
# ---------------------------------------------------------------------------

def test_new_cafe_needs_two_scans(db, naver):
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)

    # 둘째 날 처음 등장 — 아직 아무 말도 하지 않는다 (검색 흔들림일 수 있다)
    naver["cafes"] = BASE + [_cafe("새로생긴카페", 150)]
    day2 = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)
    assert day2["opened"] == []

    # 셋째 날에도 보이면 그때 '새로 생겼다'고 말한다
    day3 = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY3)
    assert [c["name"] for c in day3["opened"]] == ["새로생긴카페"]
    assert day3["opened"][0]["distance_m"] == 150


def test_new_cafe_reported_once(db, naver):
    """알림이 나간 뒤에는 같은 가게가 다시 신규로 올라오지 않는다."""
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE + [_cafe("새로생긴카페", 150)]
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)
    day3 = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY3)

    nws.mark_notified(db, STORE, [c["place_key"] for c in day3["opened"]], "opened")
    day4 = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY4)
    assert day4["opened"] == []


# ---------------------------------------------------------------------------
# 폐업 — 연속 3회 사라져야 인정
# ---------------------------------------------------------------------------

def test_closed_needs_three_consecutive_misses(db, naver):
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)

    naver["cafes"] = BASE[:-1]  # '라카페'가 사라졌다
    assert nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)["closed"] == []
    assert nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY3)["closed"] == []
    day4 = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY4)
    assert [c["name"] for c in day4["closed"]] == ["라카페"]


def test_reappearing_cafe_cancels_closure_silently(db, naver):
    """폐업으로 봤던 가게가 다시 잡히면 조용히 되돌린다 (알림을 왕복시키지 않는다)."""
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE[:-1]
    for day in (DAY2, DAY3, DAY4):
        nws.scan_cafe_changes(db, STORE, LAT, LON, today=day)

    naver["cafes"] = BASE
    back = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY4 + timedelta(days=1))
    assert back["opened"] == [] and back["closed"] == []

    row = (db.query(NearbyCafeWatch)
           .filter(NearbyCafeWatch.store_id == STORE, NearbyCafeWatch.name == "라카페").one())
    assert row.status == "open" and row.closed_on is None


def test_unreliable_scan_is_skipped(db, naver):
    """수집이 반 토막 나면(429 등) 비교 자체를 건너뛴다 — 멀쩡한 가게를 폐업 처리하지 않게."""
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)

    naver["cafes"] = BASE[:1]  # 4곳 중 1곳만 걷힘
    result = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)
    assert result["skipped"] == "unreliable_scan"
    assert all((r.miss_count or 0) == 0 for r in db.query(NearbyCafeWatch).all())


def test_same_day_rescan_does_not_double_count(db, naver):
    """하루에 두 번 훑어도 관측 횟수는 하루 한 번만 오른다."""
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE + [_cafe("새로생긴카페", 150)]
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)

    row = (db.query(NearbyCafeWatch)
           .filter(NearbyCafeWatch.store_id == STORE, NearbyCafeWatch.name == "새로생긴카페").one())
    assert row.seen_count == 1


def test_recent_changes_lists_confirmed_only(db, naver):
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=date.today() - timedelta(days=3))
    naver["cafes"] = BASE + [_cafe("새로생긴카페", 150)]
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=date.today() - timedelta(days=2))
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=date.today() - timedelta(days=1))

    changes = nws.recent_changes(db, STORE, days=30)
    assert [c["name"] for c in changes["opened"]] == ["새로생긴카페"]
    assert changes["tracked"] == 5


# ---------------------------------------------------------------------------
# 알림 규칙 — 실제로 무엇이 발송되는가
# ---------------------------------------------------------------------------

@pytest.fixture()
def sent(monkeypatch):
    log: list[dict] = []
    monkeypatch.setattr(
        ps, "send_to_store",
        lambda db, sid, title, body, data=None, urgent=False: (
            log.append({"title": title, "body": body, "data": data}) or 1))
    return log


def _settings(db):
    row = NotificationSetting(store_id=STORE)
    db.add(row)
    db.commit()
    return row


@pytest.fixture(autouse=True)
def no_events(monkeypatch):
    """행사 수집은 기본으로 '없음' — 카페 쪽만 보는 테스트가 네트워크를 타지 않게.

    행사가 필요한 테스트는 pick_alert_events를 다시 스텁해 덮어쓴다.
    """
    monkeypatch.setattr(nws, "pick_alert_events", lambda *a, **kw: [])


def test_cafe_change_push_is_sent_once_per_day(db, naver, sent):
    settings = _settings(db)
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE + [_cafe("새로생긴카페", 150)]
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)

    now = datetime(2026, 8, 3, 11, 0, tzinfo=KST)
    ns.check_nearby(db, STORE, settings, now)

    assert len(sent) == 1
    assert "새로 생겼어요" in sent[0]["title"]
    assert "새로생긴카페" in sent[0]["body"]
    assert sent[0]["data"]["screen"] == "StoreMap"

    # 같은 날 다시 돌아도 스캔·발송이 반복되지 않는다
    ns.check_nearby(db, STORE, settings, now.replace(hour=15))
    assert len(sent) == 1


def test_push_goes_out_even_if_map_screen_scanned_first(db, naver, sent):
    """지도 화면의 백그라운드 스캔이 변화를 먼저 확정해도 알림은 나가야 한다.

    예전엔 '이번 스캔에서 발견한 변화'만 보내서, 사장님이 아침에 지도를 한 번 열면
    그날의 개업·폐업 알림이 통째로 증발했다.
    """
    settings = _settings(db)
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE[:-1] + [_cafe("새로생긴카페", 150)]
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY2)
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY3)
    # 오늘(DAY4)의 스캔을 알림 규칙보다 먼저 끝내 버린다 — 신규·폐업이 여기서 확정된다
    early = nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY4)
    assert early["opened"] and early["closed"]

    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 4, 11, 0, tzinfo=KST))

    assert len(sent) == 1
    body = sent[0]["body"]
    assert "새로생긴카페" in body and "라카페" in body


def test_nearby_news_is_bundled_into_one_push(db, naver, monkeypatch, sent):
    """행사·개업·폐업이 다 있어도 알림은 한 건이어야 한다.

    따로 쏘던 시절엔 몇 초 사이에 세 건이 몰려 폰에서 서로 묻혔다 —
    FCM은 3건 다 수락했는데 사장님 폰에는 마지막 하나만 떴다(실측).
    """
    settings = _settings(db)
    naver["cafes"] = BASE
    nws.scan_cafe_changes(db, STORE, LAT, LON, today=DAY1)
    naver["cafes"] = BASE[:-1] + [_cafe("새로생긴카페", 150)]
    for day in (DAY2, DAY3, DAY4):
        nws.scan_cafe_changes(db, STORE, LAT, LON, today=day)

    event = {"name": "한강 여름축제", "place": "한강공원", "source": "네이버 검색",
             "start_date": "2026-08-05", "end_date": "2026-08-07", "dates": [],
             "day_count": 3, "distance_km": 1.2, "lat": LAT, "lon": LON,
             "boost_pct": 12, "d_day": 1, "ongoing": False}
    monkeypatch.setattr(nws, "pick_alert_events", lambda *a, **kw: [event])
    monkeypatch.setattr(nws, "plan_for_store", lambda db_, sid, ev: None)

    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 4, 11, 0, tzinfo=KST))

    assert len(sent) == 1, f"주변 소식은 한 건으로 묶여야 한다 (실제 {len(sent)}건)"
    # 한 건 안에 세 소식이 다 들어 있다 — 제목은 가장 시급한 행사가 가져간다
    assert "한강 여름축제" in sent[0]["title"]
    body = sent[0]["body"]
    assert "새로생긴카페" in body and "라카페" in body

    # 세 사건 모두 '보냈다'고 기록돼야 다음 실행에서 중복으로 나가지 않는다
    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 4, 15, 0, tzinfo=KST))
    assert len(sent) == 1


def test_nearby_alert_off_sends_nothing(db, naver, sent):
    settings = _settings(db)
    settings.nearby_alert = False
    naver["cafes"] = BASE
    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 3, 11, 0, tzinfo=KST))
    assert sent == []
    assert db.query(NearbyCafeWatch).count() == 0


def test_nearby_alert_waits_for_morning(db, naver, sent):
    """새벽에 '근처에 카페가 생겼어요'는 아무 쓸모가 없다."""
    settings = _settings(db)
    naver["cafes"] = BASE
    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 3, 6, 0, tzinfo=KST))
    assert sent == []


def test_event_push_includes_ai_plan(db, monkeypatch, sent):
    settings = _settings(db)
    event = {"name": "한강 여름축제", "place": "한강공원", "source": "네이버 검색",
             "start_date": "2026-08-05", "end_date": "2026-08-07", "dates": [],
             "day_count": 3, "distance_km": 1.2, "lat": LAT, "lon": LON,
             "boost_pct": 12, "d_day": 2, "ongoing": False}
    monkeypatch.setattr(nws, "pick_alert_events", lambda lat, lon, horizon_days=7: [event])
    monkeypatch.setattr(nws, "plan_for_store", lambda db, sid, ev: {
        "headline": "토요일 오후 나들이 손님 몰림",
        "promotions": [{"title": "축제 팔찌 할인", "detail": "팔찌 보여주면 500원 할인", "why": "재방문"}],
        "prep_actions": ["우유 2배 발주하기"],
    })

    now = datetime(2026, 8, 3, 11, 0, tzinfo=KST)
    ns.check_nearby(db, STORE, settings, now)

    assert len(sent) == 1
    assert "한강 여름축제" in sent[0]["title"]
    assert "축제 팔찌 할인" in sent[0]["body"]

    # 같은 행사·같은 구간은 두 번 나가지 않는다
    ns.check_nearby(db, STORE, settings, now.replace(hour=16))
    assert len(sent) == 1


def test_event_push_without_plan_still_goes_out(db, monkeypatch, sent):
    """AI가 실패해도 '행사가 열린다'는 사실은 알린다."""
    settings = _settings(db)
    event = {"name": "동네 플리마켓", "place": "역삼공원", "source": "네이버 검색",
             "start_date": "2026-08-04", "end_date": "2026-08-04", "dates": [],
             "day_count": 1, "distance_km": 0.4, "lat": LAT, "lon": LON,
             "boost_pct": 5, "d_day": 1, "ongoing": False}
    monkeypatch.setattr(nws, "pick_alert_events", lambda lat, lon, horizon_days=7: [event])
    monkeypatch.setattr(nws, "plan_for_store", lambda db, sid, ev: None)

    ns.check_nearby(db, STORE, settings, datetime(2026, 8, 3, 11, 0, tzinfo=KST))
    assert len(sent) == 1
    assert "역삼공원" in sent[0]["body"]
