"""operation API 인증 관문 회귀 테스트 (2026-08-06 보안 수정).

그동안 비로그인 요청이 ① 전 매장 직원·스케줄·급여를 통째로 받고 ② 연번 id만 알면
남의 매장 직원/근무를 수정·삭제할 수 있었다. 이 테스트는 그 구멍이 다시 열리면
바로 빨간불이 들어오게 한다. 인메모리 sqlite라 공유 DB를 건드리지 않는다.
"""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base, get_db
from app.main import app
from app.models.operation import Employee, EmployeeUnavailability, Schedule


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()

    emp = Employee(name="옆매장직원", hourly_rate=10_000, role="알바", store_id="other@cafe.com")
    session.add(emp)
    session.commit()
    session.add(Schedule(employee_id=emp.id, date="2026-08-03",
                         start_time=datetime(2026, 8, 3, 9), end_time=datetime(2026, 8, 3, 18)))
    session.add(EmployeeUnavailability(employee_id=emp.id, unavailability_type="weekly_recurring",
                                       day_of_week=0, start_hour=9, end_hour=12,
                                       restriction_level="hard"))
    session.commit()

    def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    session.close()
    engine.dispose()


def test_anonymous_reads_get_empty_lists(client):
    """비로그인 조회는 남의 데이터 대신 빈 목록 — 구버전 앱이 깨지지 않게 200을 유지한다."""
    for path in ("/api/v1/operation/employees",
                 "/api/v1/operation/schedules",
                 "/api/v1/operation/unavailability",
                 "/api/v1/operation/payroll/all?year_month=2026-08"):
        r = client.get(path)
        assert r.status_code == 200, f"{path}: {r.text}"
        assert r.json()["data"] == [], f"{path}가 비로그인에게 데이터를 내줬다"


def test_anonymous_mutations_rejected(client):
    """비로그인 수정·삭제는 401 — 예전엔 '무검사 통과'로 남의 직원을 지울 수 있었다."""
    assert client.delete("/api/v1/operation/employees/1").status_code == 401
    assert client.patch("/api/v1/operation/employees/1", json={"name": "탈취"}).status_code == 401
    assert client.patch("/api/v1/operation/schedules/1",
                        json={"start_time": "2026-08-03T10:00:00"}).status_code == 401
    assert client.delete("/api/v1/operation/schedules/1").status_code == 401
    assert client.post("/api/v1/operation/unavailability",
                       json={"employee_id": 1, "unavailability_type": "weekly_recurring",
                             "day_of_week": 0, "start_hour": 9, "end_hour": 12,
                             "restriction_level": "hard"}).status_code == 401
    assert client.delete("/api/v1/operation/unavailability/1").status_code == 401


def test_anonymous_db_backed_computations_rejected(client):
    """DB를 읽는 계산(정산·예측·추천)은 로그인 필수 — 임의 store_id 매출 노출 차단."""
    r = client.post("/api/v1/operation/settlements/calculate",
                    json={"period_start": "2026-08-01", "period_end": "2026-08-31"})
    assert r.status_code == 401
    r = client.post("/api/v1/operation/forecast/sales",
                    json={"target_date": "2026-08-07", "store_id": "other@cafe.com"})
    assert r.status_code == 401
    r = client.post("/api/v1/operation/schedules/recommend",
                    json={"target_date": "2026-08-07", "store_id": "other@cafe.com"})
    assert r.status_code == 401


def test_manual_calculators_stay_open(client):
    """DB를 안 보는 순수 계산(수동 정산·수동 예측)은 그대로 열려 있어야 한다."""
    r = client.post("/api/v1/operation/settlements/calculate",
                    json={"revenue": 5_000_000, "cost": 1_500_000, "labor_cost": 1_200_000})
    assert r.status_code == 200, r.text


def test_maintenance_endpoints_hidden_without_secret(client, monkeypatch):
    """수집·색인·시드 파이프라인은 크론 시크릿 없이는 404/403 — 비용 DoS 차단."""
    from app.api.v1 import operation as op

    # 시크릿 미설정 → 존재 자체를 숨긴다
    monkeypatch.setattr(op, "_MAINTENANCE_SECRET", "")
    for path in ("/api/v1/operation/beans/seed-import", "/api/v1/operation/beans/collect",
                 "/api/v1/operation/rag/reindex", "/api/v1/operation/products/prefetch"):
        assert client.post(path).status_code == 404, path

    # 시크릿 설정 → 틀린 값은 403
    monkeypatch.setattr(op, "_MAINTENANCE_SECRET", "topsecret")
    assert client.post("/api/v1/operation/beans/collect",
                       headers={"x-cron-secret": "wrong"}).status_code == 403
