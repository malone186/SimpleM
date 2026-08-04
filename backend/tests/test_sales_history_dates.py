"""판매 원장 조회의 날짜 경계 테스트 (백엔드 B) — 인메모리 sqlite

배경(실제 오동작): 챗봇에게 "어제 매출 얼마야?"라고 물으면 데이터가 멀쩡히 있는데도
"판매 내역이 조회되지 않습니다"라고 답했다. 원인은 두 겹이었다.

1) get_sales_history가 `datetime.now() - timedelta(days=N)`으로 '지금부터 N×24시간 전'을
   잡았다. 달력 하루가 아니라 롤링 윈도우라, 오후 5시에 days=1을 부르면 어제 오후 5시
   이후만 걸려 어제 낮 매출이 통째로 빠졌다 — 같은 질문이 조회 시각에 따라 답이 달라졌다.
2) days는 '오늘부터 거슬러 N일'이라 days=1은 오늘 하루뿐인데, 에이전트는 '어제=1일치'로
   읽어 days=1을 넣었다. 오늘 매출이 아직 0이면 그대로 '판매 없음'이 된다.

그래서 경계를 KST 달력 하루로 바꾸고, 날짜를 직접 지정하는 길(start_date/end_date)을
열었다. 에이전트는 '어제'를 이미 실제 날짜로 풀어서 알고 있으므로 역산시킬 이유가 없다.
"""
from datetime import date, datetime, time, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.inventory import Menu, Sale
from app.services.ai import store_data_service as sds
from app.utils.datetime_kst import KST

STORE = "sales-dates@test.com"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


def _sale(db, menu, when: datetime, qty=1, price=5000):
    db.add(Sale(store_id=STORE, menu_id=menu.id, quantity=qty,
                total_price=price, sold_at=when))
    db.commit()


@pytest.fixture()
def menu(db):
    m = Menu(name="아메리카노", selling_price=5000, store_id=STORE)
    db.add(m)
    db.commit()
    return m


def _today() -> date:
    return datetime.now(KST).date()


def _at(day: date, hour: int) -> datetime:
    return datetime.combine(day, time(hour, 0), tzinfo=KST)


def test_yesterday_morning_sale_is_found_regardless_of_current_time(db, menu):
    """어제 아침 매출은 지금이 몇 시든 잡혀야 한다 — 롤링 24시간이면 오후엔 놓친다."""
    yesterday = _today() - timedelta(days=1)
    _sale(db, menu, _at(yesterday, 9), qty=3, price=15000)

    r = sds.get_sales_history(STORE, days=2)
    assert r["total_revenue"] == 15000, "어제 오전 매출이 조회 시각 때문에 누락됐다"
    assert [d["date"] for d in r["daily"]] == [yesterday.isoformat()]


def test_days_counts_calendar_days_from_today(db, menu):
    """days는 '오늘 포함 거슬러 N일'이다 — days=1은 오늘 하루뿐."""
    today, yesterday = _today(), _today() - timedelta(days=1)
    _sale(db, menu, _at(yesterday, 14), qty=2, price=10000)

    one = sds.get_sales_history(STORE, days=1)
    assert one["start_date"] == one["end_date"] == today.isoformat()
    assert one["total_revenue"] == 0

    two = sds.get_sales_history(STORE, days=2)
    assert two["start_date"] == yesterday.isoformat()
    assert two["total_revenue"] == 10000


def test_explicit_single_day_range(db, menu):
    """어제 하루만 보고 싶으면 start=end=어제로 직접 지정할 수 있다."""
    today, yesterday = _today(), _today() - timedelta(days=1)
    _sale(db, menu, _at(yesterday, 11), qty=4, price=20000)
    _sale(db, menu, _at(today, 11), qty=1, price=5000)

    r = sds.get_sales_history(STORE, start_date=yesterday.isoformat(),
                              end_date=yesterday.isoformat())
    assert r["total_revenue"] == 20000, "지정한 날짜 밖의 매출이 섞였다"
    assert r["period_days"] == 1


def test_range_boundaries_are_inclusive(db, menu):
    """구간의 양 끝날은 모두 포함된다."""
    end = _today() - timedelta(days=1)
    start = end - timedelta(days=2)
    for d in (start, start + timedelta(days=1), end):
        _sale(db, menu, _at(d, 12), qty=1, price=1000)

    r = sds.get_sales_history(STORE, start_date=start.isoformat(), end_date=end.isoformat())
    assert r["total_revenue"] == 3000
    assert r["period_days"] == 3


def test_late_night_sale_belongs_to_its_own_kst_day(db, menu):
    """자정 직전 매출은 그날 것이다 — UTC로 새면 다음 날로 밀린다."""
    yesterday = _today() - timedelta(days=1)
    _sale(db, menu, _at(yesterday, 23), qty=1, price=7000)

    r = sds.get_sales_history(STORE, start_date=yesterday.isoformat(),
                              end_date=yesterday.isoformat())
    assert r["total_revenue"] == 7000


def test_response_reports_the_window_it_used(db, menu):
    """어느 구간을 봤는지 응답에 있어야 한다 — 모델이 기간을 밝혀 보고할 근거."""
    r = sds.get_sales_history(STORE, days=7)
    assert r["end_date"] == _today().isoformat()
    assert r["start_date"] == (_today() - timedelta(days=6)).isoformat()
    assert r["period_days"] == 7


def test_invalid_date_string_falls_back_instead_of_crashing(db, menu):
    """모델이 이상한 날짜를 넣어도 도구가 죽으면 안 된다 — 기본 구간으로 물러난다."""
    r = sds.get_sales_history(STORE, days=3, start_date="어제", end_date="")
    assert r["end_date"] == _today().isoformat()
    assert r["period_days"] == 3
