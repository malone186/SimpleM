"""푸시 알림 규칙 엔진 단위 테스트 (백엔드 B) — sqlite 인메모리 DB 사용

실제 FCM 발송은 스텁으로 가로채고, '무엇을 언제 보낼지'와 '두 번 보내지 않는지'만 본다.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록 (create_all 대상)
from app.core.database import Base
from app.models.ai import ComplianceItem, DeviceToken, SentNotification
from app.services.ai import notification_service as ns
from app.services.ai import push_service as ps

KST = timezone(timedelta(hours=9))
STORE = "owner@test.com"


@pytest.fixture()
def db(monkeypatch):
    """인메모리 sqlite로 SessionLocal을 바꿔치기한다.

    규칙 함수들은 document_service._session()으로 자기 세션을 따로 여므로
    (예: 갱신 서류 조회) SessionLocal 자체를 갈아끼워야 같은 DB를 보게 된다.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)

    session = TestSession()
    # 이 매장에 기기가 하나 있어야 발송 경로를 탄다
    session.add(DeviceToken(store_id=STORE, token="tok-" + "x" * 20))
    session.commit()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def sent(monkeypatch):
    """실제 FCM 호출을 가로채 발송 내역을 모은다."""
    log: list[dict] = []
    monkeypatch.setattr(
        ps, "send_to_store",
        lambda db, sid, title, body, data=None, urgent=False: (
            log.append({"title": title, "body": body, "data": data, "urgent": urgent}) or 1),
    )
    return log


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 28, hour, minute, tzinfo=KST)


# ---------------------------------------------------------------------------
# 방해금지 판정 — 프론트 AlertsWatcher.isInDndWindow와 같은 규칙이어야 한다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("hour,start,end,expected", [
    (23, "22:00", "08:00", True),    # 자정 넘김 구간 안 (밤)
    (3, "22:00", "08:00", True),     # 자정 넘김 구간 안 (새벽)
    (12, "22:00", "08:00", False),   # 구간 밖
    (22, "22:00", "08:00", True),    # 시작 경계는 포함
    (8, "22:00", "08:00", False),    # 끝 경계는 제외
    (12, "09:00", "18:00", True),    # 자정을 넘지 않는 구간
    (12, "bad", "08:00", False),     # 형식 오류는 항상 False
    (23, "22:00", "22:00", False),   # start == end는 항상 False
])
def test_dnd_window(hour, start, end, expected):
    assert ns.in_dnd_window(_at(hour), start, end) is expected


# ---------------------------------------------------------------------------
# 리포트 푸시 본문 — 열기 전에 이미 정보가 돼야 한다
# ---------------------------------------------------------------------------

def test_report_body_has_numbers_and_first_advice_sentence():
    body = ns._report_body({
        "sales": {"total": 3_420_000, "change_pct": 12.0},
        "profit": {"estimated_profit": 780_000},
        "ai_advice": "라떼가 잘 나가면서 우유값이 12만 원 늘었어요. 납품 단가를 확인해 보세요.",
    })
    assert "3,420,000원" in body
    assert "▲12.0%" in body
    assert "순이익 780,000원" in body
    # 알림은 두 줄을 넘으면 잘리므로 조언은 첫 문장만
    assert "우유값이 12만 원 늘었어요." in body
    assert "납품 단가" not in body


def test_report_body_marks_loss_and_survives_empty_content():
    loss = ns._report_body({"sales": {"total": 100, "change_pct": -8.0},
                            "profit": {"estimated_profit": -5000}})
    assert "적자 5,000원" in loss and "▼8.0%" in loss
    assert isinstance(ns._report_body({}), str)  # 데이터가 없어도 터지지 않는다


# ---------------------------------------------------------------------------
# 갱신 서류 — 구간마다 한 번씩, 같은 구간은 두 번 보내지 않는다
# ---------------------------------------------------------------------------

def test_compliance_notifies_due_and_expired(db, sent):
    today = datetime.now(KST).date()
    db.add(ComplianceItem(store_id=STORE, name="보건증(홍길동)",
                          expiry_date=(today + timedelta(days=7)).isoformat()))
    db.add(ComplianceItem(store_id=STORE, name="위생교육 수료증",
                          expiry_date=(today - timedelta(days=3)).isoformat()))
    db.commit()

    settings = ns.get_settings(db, STORE)
    keys = ns.check_compliance(db, STORE, settings)

    assert len(keys) == 2
    # 라벨이 실제 구간과 맞아야 한다 — D-7이 D-30으로 찍히면 D-30을 이미 보낸 서류는
    # 정작 급한 D-7·D-1 알림이 영영 나가지 않는다
    assert any(k.endswith(":D-7") for k in keys), keys
    assert any(k.endswith(":expired") for k in keys), keys
    assert any("7일 남았어요" in s["title"] for s in sent)
    assert any("만료됨" in s["title"] for s in sent)

    # 같은 구간 재실행은 무발송 (스케줄러가 하루 여러 번 돌아도 안전)
    before = len(sent)
    assert ns.check_compliance(db, STORE, settings) == []
    assert len(sent) == before


def test_compliance_fires_once_per_milestone_as_deadline_nears(db, sent):
    """D-30 → D-7 → D-1로 좁혀지며 세 번 나가야 한다 (D-0은 D-1과 같은 구간)."""
    today = datetime.now(KST).date()
    row = ComplianceItem(store_id=STORE, name="영업신고증",
                         expiry_date=(today + timedelta(days=30)).isoformat())
    db.add(row)
    db.commit()

    settings = ns.get_settings(db, STORE)
    fired = []
    for days_left in (30, 15, 7, 3, 1, 0):
        row.expiry_date = (today + timedelta(days=days_left)).isoformat()
        db.commit()
        fired += [k.rsplit(":", 1)[1] for k in ns.check_compliance(db, STORE, settings)]

    assert fired == ["D-30", "D-7", "D-1"]


# ---------------------------------------------------------------------------
# 설정 존중 · 방해금지
# ---------------------------------------------------------------------------

def test_category_and_master_switches(db, sent):
    today = datetime.now(KST).date()
    db.add(ComplianceItem(store_id=STORE, name="임대차계약",
                          expiry_date=(today + timedelta(days=1)).isoformat()))
    db.commit()
    settings = ns.get_settings(db, STORE)

    settings.compliance_alert = False
    db.commit()
    assert ns.check_compliance(db, STORE, settings) == []

    settings.push_enabled = False
    db.commit()
    assert ns.run_for_store(db, STORE, _at(9))["skipped"] == "push_disabled"


def test_dnd_defers_without_consuming_the_event(db, sent):
    """방해금지는 '보류'지 '소실'이 아니다 — 이력을 남기지 않아야 구간이 끝난 뒤 나간다."""
    today = datetime.now(KST).date()
    db.add(ComplianceItem(store_id=STORE, name="임대차계약",
                          expiry_date=(today + timedelta(days=1)).isoformat()))
    db.commit()
    settings = ns.get_settings(db, STORE)
    settings.dnd_enabled = True
    settings.dnd_start, settings.dnd_end = "22:00", "08:00"
    db.commit()

    assert ns.run_for_store(db, STORE, _at(23))["skipped"] == "dnd"
    assert db.query(SentNotification).count() == 0

    # 구간이 끝나면 밀린 알림이 그대로 나간다
    ns.check_compliance(db, STORE, settings)
    assert db.query(SentNotification).count() == 1


# ---------------------------------------------------------------------------
# 토큰 수명 관리
# ---------------------------------------------------------------------------

def test_token_upsert_moves_owner_on_reuse(db):
    """한 기기에서 로그아웃 후 다른 계정으로 로그인하면 소유자가 옮겨가야 한다 —
    행을 새로 만들면 이전 사장님 알림이 이 기기로 계속 간다."""
    ps.register_token(db, STORE, "tok-shared-device-1", device_name="갤럭시")
    assert "tok-shared-device-1" in ps.list_tokens(db, STORE)

    ps.register_token(db, "other@test.com", "tok-shared-device-1")
    assert "tok-shared-device-1" not in ps.list_tokens(db, STORE)
    assert ps.list_tokens(db, "other@test.com") == ["tok-shared-device-1"]

    ps.unregister_token(db, "tok-shared-device-1")
    assert ps.list_tokens(db, "other@test.com") == []


def test_push_disabled_when_unconfigured(monkeypatch):
    """FCM 자격증명이 없으면 조용히 건너뛴다 — 푸시 미설정이 서버를 막으면 안 된다."""
    monkeypatch.delenv("FCM_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.setattr(ps, "_credentials", None)
    monkeypatch.setattr(ps, "_project_id", None)
    assert ps.is_configured() is False


def test_unregister_token_only_removes_own_device(db):
    """토큰 문자열을 안다고 남의 기기 등록을 해제할 수 있으면 안 된다."""
    ps.register_token(db, STORE, "tok-mine-1234567890")
    ps.register_token(db, "other@test.com", "tok-theirs-1234567890")

    # 남의 토큰을 내 store_id로 지우려 해도 남아 있어야 한다
    ps.unregister_token(db, "tok-theirs-1234567890", store_id=STORE)
    assert ps.list_tokens(db, "other@test.com") == ["tok-theirs-1234567890"]

    ps.unregister_token(db, "tok-mine-1234567890", store_id=STORE)
    assert "tok-mine-1234567890" not in ps.list_tokens(db, STORE)


def test_send_to_store_drops_tokens_fcm_rejected(db, monkeypatch):
    """FCM이 UNREGISTERED로 거절한 토큰은 그 자리에서 지워야 한다 —
    쌓아두면 발송량만 늘고 '발송 0건' 판정이 계속 어긋난다."""
    ps.register_token(db, STORE, "tok-dead-000000000000")
    ps.register_token(db, STORE, "tok-live-000000000000")

    monkeypatch.setattr(ps, "_load_credentials", lambda: ("creds", "proj"))
    monkeypatch.setattr(ps, "_access_token", lambda: "at")
    monkeypatch.setattr(
        ps, "_send_one",
        lambda at, pid, token, title, body, data, urgent: (
            (False, "UNREGISTERED") if "dead" in token else (True, None)),
    )

    # db 픽스처가 이미 살아있는 토큰 하나를 넣어 두므로 성공은 2건이 된다
    live_before = [t for t in ps.list_tokens(db, STORE) if "dead" not in t]
    assert ps.send_to_store(db, STORE, "제목", "본문") == len(live_before)

    remaining = ps.list_tokens(db, STORE)
    assert "tok-dead-000000000000" not in remaining
    assert "tok-live-000000000000" in remaining


# ---------------------------------------------------------------------------
# 발송 실패 — 이력을 남기면 그 사건은 영영 안 나간다
# ---------------------------------------------------------------------------

def test_dispatch_retries_when_nothing_was_sent(db, monkeypatch):
    """0건 발송이면 예약을 취소해 다음 실행에서 다시 시도해야 한다."""
    calls = []
    monkeypatch.setattr(
        ps, "send_to_store",
        lambda db_, sid, title, body, data=None, urgent=False: (calls.append(title) or 0))

    today = datetime.now(KST).date()
    db.add(ComplianceItem(store_id=STORE, name="보건증(실패)",
                          expiry_date=(today + timedelta(days=7)).isoformat()))
    db.commit()
    settings = ns.get_settings(db, STORE)

    assert ns.check_compliance(db, STORE, settings) == []      # 보냈다고 보고하지 않는다
    assert db.query(SentNotification).count() == 0             # 이력도 남지 않는다

    # 다음 실행에서 FCM이 살아나면 그대로 나간다
    monkeypatch.setattr(
        ps, "send_to_store",
        lambda db_, sid, title, body, data=None, urgent=False: (calls.append(title) or 1))
    assert len(ns.check_compliance(db, STORE, settings)) == 1
    assert db.query(SentNotification).count() == 1
    assert len(calls) == 2                                     # 재시도가 실제로 일어났다


def test_run_all_skips_everything_when_push_unconfigured(db, monkeypatch):
    """미설정 상태에서 돌면 발송은 0건인데 리포트·예측 비용만 반복해서 치르게 된다."""
    monkeypatch.setattr(ps, "is_configured", lambda: False)
    called = []
    monkeypatch.setattr(ns, "run_for_store", lambda *a, **k: called.append(1))

    result = ns.run_all(_at(9))
    assert result["skipped"] == "push_unconfigured"
    assert called == []


# ---------------------------------------------------------------------------
# 리포트 — '끝난 기간'을, 이른 새벽이 아닌 때에
# ---------------------------------------------------------------------------

def test_report_waits_for_report_hour(db, sent, monkeypatch):
    """매시간 스케줄러의 그날 첫 실행은 00:00이다 — 자정에 리포트가 나가면 안 된다."""
    monkeypatch.setattr(ns, "_already_sent", lambda *a: False)
    settings = ns.get_settings(db, STORE)
    settings.report_frequency = "daily"
    db.commit()

    assert ns.check_report(db, STORE, settings, _at(0)) == []
    assert ns.check_report(db, STORE, settings, _at(8)) == []
    assert sent == []


def test_report_covers_the_completed_period(db, sent, monkeypatch):
    """기준일을 오늘로 두면 월요일 아침 '지난주 리포트'가 매출 0원짜리 이번 주가 된다."""
    captured = {}

    def fake_report(store_id, period_type="weekly", reference_date=None, force_refresh=True):
        captured["ref"] = reference_date
        captured["period_type"] = period_type
        return {"content": {"period": "2026-07-20 ~ 2026-07-26",
                            "sales": {"total": 1_234_000, "change_pct": 5}}}

    from app.services.ai import report_service
    monkeypatch.setattr(report_service, "generate_management_report", fake_report)

    settings = ns.get_settings(db, STORE)
    settings.report_frequency = "weekly"
    db.commit()

    monday = datetime(2026, 7, 27, 9, tzinfo=KST)
    assert monday.weekday() == 0
    keys = ns.check_report(db, STORE, settings, monday)

    assert len(keys) == 1
    # 기준일이 하루 앞(일요일)이라야 '지난주(7/20~7/26)'가 잡힌다
    assert captured["ref"] == "2026-07-26"
    assert "지난주" in sent[0]["title"]
    assert "1,234,000원" in sent[0]["body"]


def test_report_skips_generation_when_already_sent(db, sent, monkeypatch):
    """중복 판정이 생성보다 뒤에 있으면 매 틱마다 집계·문서 갱신이 반복된다."""
    calls = []

    def fake_report(store_id, period_type="weekly", reference_date=None, force_refresh=True):
        calls.append(reference_date)
        return {"content": {"period": "2026-07-27", "sales": {"total": 100}}}

    from app.services.ai import report_service
    monkeypatch.setattr(report_service, "generate_management_report", fake_report)

    settings = ns.get_settings(db, STORE)
    settings.report_frequency = "daily"
    db.commit()

    assert len(ns.check_report(db, STORE, settings, _at(9))) == 1
    assert len(calls) == 1

    # 같은 날 재실행 — 생성 자체가 일어나면 안 된다
    assert ns.check_report(db, STORE, settings, _at(10)) == []
    assert ns.check_report(db, STORE, settings, _at(11)) == []
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# 재고 소진 — 예측은 비싸다
# ---------------------------------------------------------------------------

def test_stock_bundles_urgent_items(db, sent, monkeypatch):
    from app.services.ai import forecast_service
    monkeypatch.setattr(forecast_service, "forecast", lambda sid: {"order_recommendations": [
        {"ingredient": "원두", "days_until_stockout": 1.0},
        {"ingredient": "우유", "days_until_stockout": 2.0},
        {"ingredient": "시럽", "days_until_stockout": 10.0},   # 리드타임 밖 — 제외
    ]})

    settings = ns.get_settings(db, STORE)
    keys = ns.check_stock(db, STORE, settings, _at(9))

    assert keys == ["stock:2종"]                 # 품목별로 쪼개 보내지 않는다
    assert "원두" in sent[0]["title"]             # 가장 급한 품목이 제목
    assert "시럽" not in sent[0]["body"]
    assert sent[0]["data"]["screen"] == "Inventory"   # 발주 화면은 앱에서 빠졌다


def test_stock_skips_forecast_when_already_sent(db, sent, monkeypatch):
    """forecast()는 SARIMAX 적합 + 외부 HTTP다 — 이미 보낸 날엔 부르면 안 된다."""
    calls = []

    def fake_forecast(sid):
        calls.append(sid)
        return {"order_recommendations": [{"ingredient": "원두", "days_until_stockout": 1.0}]}

    from app.services.ai import forecast_service
    monkeypatch.setattr(forecast_service, "forecast", fake_forecast)

    settings = ns.get_settings(db, STORE)
    assert ns.check_stock(db, STORE, settings, _at(9)) == ["stock:1종"]
    assert len(calls) == 1

    assert ns.check_stock(db, STORE, settings, _at(10)) == []
    assert ns.check_stock(db, STORE, settings, _at(23)) == []
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# 설비 이상 — 방해금지를 뚫되 쿨다운은 지킨다
# ---------------------------------------------------------------------------

def _stub_sensor(monkeypatch, items):
    from app.services.ai import sensor_service
    monkeypatch.setattr(sensor_service, "is_feature_enabled", lambda sid: True)
    monkeypatch.setattr(sensor_service, "get_recommendations", lambda sid: {"items": items})


def test_sensor_fires_through_dnd_then_cools_down(db, sent, monkeypatch):
    _stub_sensor(monkeypatch, [{
        "priority": "urgent", "source": "온도센서",
        "title": "냉장고 온도 이탈", "reason": "8.5도까지 올랐어요.", "action": "문 닫힘을 확인해 주세요.",
    }])

    settings = ns.get_settings(db, STORE)
    settings.dnd_enabled = True
    settings.dnd_start, settings.dnd_end = "22:00", "08:00"
    db.commit()

    # 방해금지 한복판(새벽 3시)에도 나가야 한다 — 식자재 폐기로 직결된다
    result = ns.run_for_store(db, STORE, _at(3))
    assert result["skipped"] == "dnd"          # 나머지 종류는 보류되지만
    assert len(result["sent"]) == 1            # 설비 이상은 뚫고 나갔다
    assert sent[0]["urgent"] is True

    # 같은 쿨다운 구간(6시간) 안에서는 다시 울리지 않는다
    assert ns.check_sensor(db, STORE, settings, _at(4)) == []
    assert len(sent) == 1

    # 구간이 넘어가면 상황이 계속되고 있으므로 다시 알린다
    assert len(ns.check_sensor(db, STORE, settings, _at(9))) == 1
    assert len(sent) == 2


def test_sensor_ignores_non_equipment_urgent(db, sent, monkeypatch):
    """호퍼 재장전 같은 건 영업 중 화면에서 보면 되는 일이라 푸시 대상이 아니다."""
    _stub_sensor(monkeypatch, [
        {"priority": "urgent", "source": "재고", "title": "호퍼 재장전", "reason": "", "action": ""},
        {"priority": "normal", "source": "온도센서", "title": "정상", "reason": "", "action": ""},
    ])
    settings = ns.get_settings(db, STORE)
    assert ns.check_sensor(db, STORE, settings, _at(9)) == []
    assert sent == []


# ---------------------------------------------------------------------------
# 정리 — 안 지우면 무한히 쌓인다
# ---------------------------------------------------------------------------

def test_purge_removes_only_old_rows(db):
    from datetime import datetime as dt

    old = dt.now(timezone.utc) - timedelta(days=200)
    fresh = dt.now(timezone.utc) - timedelta(days=1)

    db.add(DeviceToken(store_id=STORE, token="tok-old-00000000000", last_seen_at=old))
    db.add(DeviceToken(store_id=STORE, token="tok-fresh-000000000", last_seen_at=fresh))
    db.add(SentNotification(store_id=STORE, dedupe_key="old:1", category="report",
                            title="옛날", body="", sent_at=old))
    db.add(SentNotification(store_id=STORE, dedupe_key="new:1", category="report",
                            title="최근", body="", sent_at=fresh))
    db.commit()

    assert ps.purge_stale_tokens(db) == 1
    assert ns.purge_old_history(db) == 1

    assert "tok-old-00000000000" not in ps.list_tokens(db, STORE)
    assert "tok-fresh-000000000" in ps.list_tokens(db, STORE)
    assert [r.dedupe_key for r in db.query(SentNotification).all()] == ["new:1"]
