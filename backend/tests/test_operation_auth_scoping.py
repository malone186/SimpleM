"""운영 API 매장 격리 회귀 테스트 — 인메모리 sqlite.

공유 DB에서 employee_id·schedule_id가 연번이라, 확인 없이 두면 옆 매장의 직원·근무를
연번만 알고 수정·삭제할 수 있었다. 로그인 시 소유권 검사(_assert_*_owned)로 막고,
비로그인(데모)은 기존 동작(무검사)을 유지한다 — 그 규칙을 잠근다.
"""
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.operation import Employee, Schedule
from app.models.user import User
from app.api.v1.operation import _assert_employee_owned, _assert_schedule_owned

STORE = "store-a@test.com"
OTHER = "store-b@test.com"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    s = Session()
    yield s
    s.close()
    engine.dispose()


def _user(email: str) -> User:
    return User(id=1, email=email, name="사장", hashed_password="x")


def _employee(db, store=STORE) -> Employee:
    e = Employee(store_id=store, name="김알바", hourly_rate=11000, role="바리스타")
    db.add(e)
    db.commit()
    return e


def test_employee_ownership(db):
    e = _employee(db)
    # 같은 매장 → 통과
    _assert_employee_owned(db, e.id, _user(STORE))
    # 다른 매장 → 404 (남의 직원 못 건드림)
    with pytest.raises(HTTPException) as ei:
        _assert_employee_owned(db, e.id, _user(OTHER))
    assert ei.value.status_code == 404
    # 비로그인(데모) → 무검사 통과 (기존 동작 유지)
    _assert_employee_owned(db, e.id, None)


def test_schedule_ownership(db):
    e = _employee(db)
    sch = Schedule(
        employee_id=e.id,
        start_time=datetime(2026, 8, 1, 9, 0),
        end_time=datetime(2026, 8, 1, 18, 0),
        date="2026-08-01",
    )
    db.add(sch)
    db.commit()

    _assert_schedule_owned(db, sch.id, _user(STORE))
    with pytest.raises(HTTPException) as ei:
        _assert_schedule_owned(db, sch.id, _user(OTHER))
    assert ei.value.status_code == 404
    _assert_schedule_owned(db, sch.id, None)
