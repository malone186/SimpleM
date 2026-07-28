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
