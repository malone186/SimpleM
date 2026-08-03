"""가능 시간 → 달력 반영(apply_availability)의 날짜 가드 테스트 (백엔드 B) — sqlite 인메모리 DB

핵심은 '지난 날짜에 근무를 만들지 않는다'는 약속이다. 과거에 근무가 소급 생성되면
이미 지급한 주급·월 인건비 수치가 조용히 바뀐다.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.ai import EmployeeAvailability
from app.models.operation import Employee, Schedule
from app.services.ai import staff_service as svc

STORE = "owner@test.com"


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


@pytest.fixture()
def employee(db):
    emp = Employee(store_id=STORE, name="김알바", hourly_rate=11000, role="바리스타")
    db.add(emp)
    db.commit()
    # 모든 요일 가능 — 날짜 가드만 보고 싶으므로 요일 필터에 걸리지 않게 한다
    for dow in range(7):
        db.add(EmployeeAvailability(
            employee_id=emp.id, store_id=STORE, day_of_week=dow,
            start_hour=9, end_hour=18,
        ))
    db.commit()
    return emp


def _month_str(d: date) -> str:
    return d.strftime("%Y-%m")


def test_past_month_creates_nothing(db, employee):
    """통째로 지난 달을 요청해도(기본 from_today=True) 근무가 소급 생성되면 안 된다."""
    past = _month_str(date.today().replace(day=1) - timedelta(days=1))
    result = svc.apply_availability(STORE, month=past)

    assert result["created"] == 0
    assert db.query(Schedule).count() == 0


def test_current_month_starts_today(db, employee):
    """이번 달은 오늘부터만 채운다 — 오늘 이전 날짜가 하나라도 있으면 급여가 소급된다."""
    today = date.today()
    result = svc.apply_availability(STORE, month=_month_str(today))

    assert result["created"] >= 1
    dates = [s.date for s in db.query(Schedule).all()]
    assert min(dates) >= today.isoformat()


def test_from_today_false_fills_whole_month(db, employee):
    """데모 시드 경로(from_today=False)는 그 달 1일부터 채우는 게 의도된 동작이다."""
    today = date.today()
    result = svc.apply_availability(STORE, month=_month_str(today), from_today=False)

    assert result["created"] >= today.day  # 1일~오늘 구간도 만들어졌다는 증거
    dates = [s.date for s in db.query(Schedule).all()]
    assert min(dates) == today.replace(day=1).isoformat()
