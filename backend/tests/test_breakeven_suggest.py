"""손익분기 고정비 자동 제안 — 지난 지출·급여에서 4칸을 미리 채운다 (온보딩 벽 낮추기).

검증:
  · 지출을 임대료/공과금/기타 버킷으로 분류·합산한다.
  · 인건비는 지출이 아니라 급여 추정에서 온다(이중 계상 방지).
  · 31일 밖의 지출은 제외한다.
  · 끌어올 게 없으면 has_any=False (정직하게 빈 칸).

_session을 인메모리로 바꿔 격리한다 — Neon을 건드리지 않는다.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.database import Base
from app.models.operation import Expense
from app.services.ai import breakeven_service as bes

STORE = "suggest-test@test.com"


@pytest.fixture()
def db(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)
    session = Session()
    # breakeven_service._session()이 이 세션을 쓰게 한다
    monkeypatch.setattr(bes, "_session", lambda: Session())
    yield session
    session.close()
    eng.dispose()


def _expense(db, category, amount, days_ago=3):
    db.add(Expense(store_id=STORE, category=category, amount=amount,
                   expense_date=date.today() - timedelta(days=days_ago)))
    db.commit()


def _no_payroll(monkeypatch):
    from app.services.operation.operation_service import OperationService
    monkeypatch.setattr(OperationService, "list_employees_payroll",
                        classmethod(lambda cls, db, ym, store_id=None: []))


def test_지출을_버킷으로_분류한다(db, monkeypatch):
    _no_payroll(monkeypatch)
    _expense(db, "임대료", 1_500_000)
    _expense(db, "건물 관리비", 200_000)      # 임대 버킷
    _expense(db, "전기요금", 300_000)
    _expense(db, "수도세", 80_000)            # 공과 버킷
    _expense(db, "화재보험", 120_000)          # 기타
    _expense(db, "원두매입", 500_000)          # 고정비 아님 — 제외

    r = bes.suggest_fixed_costs(STORE)
    s = r["suggested"]
    assert s["rent"] == 1_700_000
    assert s["utilities"] == 380_000
    assert s["other"] == 120_000
    assert s["labor"] == 0                      # 급여 없음
    assert r["has_any"] is True
    assert "임대" in r["sources"]["rent"]


def test_인건비는_급여추정에서_온다_지출아님(db, monkeypatch):
    """인건비 지출을 적어도, 손익분기 인건비 칸은 급여 추정을 쓴다(이중 계상 방지)."""
    from app.services.operation.operation_service import OperationService
    monkeypatch.setattr(OperationService, "list_employees_payroll",
                        classmethod(lambda cls, db, ym, store_id=None:
                                    [{"estimated_salary": 1_800_000}, {"estimated_salary": 1_600_000}]))
    _expense(db, "직원 급여", 9_999_999)   # 이건 labor 버킷이라 지출 합산에서 빠진다

    r = bes.suggest_fixed_costs(STORE)
    assert r["suggested"]["labor"] == 3_400_000   # 급여 추정 합, 지출값 아님
    assert "급여 추정" in r["sources"]["labor"]


def test_31일_밖_지출은_제외(db, monkeypatch):
    _no_payroll(monkeypatch)
    _expense(db, "임대료", 1_000_000, days_ago=40)   # 오래된 것
    _expense(db, "전기요금", 100_000, days_ago=5)     # 최근

    r = bes.suggest_fixed_costs(STORE)
    assert r["suggested"]["rent"] == 0
    assert r["suggested"]["utilities"] == 100_000


def test_끌어올게_없으면_비운다(db, monkeypatch):
    _no_payroll(monkeypatch)
    r = bes.suggest_fixed_costs(STORE)
    assert r["has_any"] is False
    assert all(v == 0 for v in r["suggested"].values())
