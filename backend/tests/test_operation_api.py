"""
운영 API (payroll / settlements calculate) 엔드포인트 통합 테스트 (옵션 A & B 포함)
"""
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_api_payroll_calculate_success_option_a_b():
    """예상 급여 계산 API 옵션 A & B 성공 테스트 (자정넘김 + 주휴수당 + 3.3% 세금공제) (HTTP 200 OK)"""
    payload = {
        "employee_name": "홍길동",
        "start_time": "2026-07-20T22:00:00",
        "end_time": "2026-07-20T06:00:00",  # 익일 퇴근 자동 보정
        "break_minutes": 60.0,  # 7시간 실근무
        "hourly_rate": 10000,
        "weekly_work_hours": 20.0,  # 주휴수당 40,000원
        "include_weekly_holiday": True,
        "deduct_tax": True  # 3.3% 세금 3,630원
    }
    response = client.post("/api/v1/operation/payroll/calculate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["actual_work_hours"] == 7.0
    assert body["data"]["base_payroll"] == 70000
    assert body["data"]["weekly_holiday_allowance"] == 40000
    assert body["data"]["gross_payroll"] == 110000
    assert body["data"]["withholding_tax"] == 3630
    assert body["data"]["net_payroll"] == 106370

def test_api_payroll_calculate_pydantic_error_422():
    """예상 급여 계산 API 스키마 검증 실패 (시급 <= 0) 테스트 (HTTP 422 Unprocessable Entity)"""
    payload = {
        "employee_name": "홍길동",
        "start_time": "2026-07-20T09:00:00",
        "end_time": "2026-07-20T18:00:00",
        "break_minutes": 60,
        "hourly_rate": 0
    }
    response = client.post("/api/v1/operation/payroll/calculate", json=payload)
    assert response.status_code == 422

def test_api_settlement_calculate_success():
    """예상 정산 계산 API 정상 성공 테스트 (HTTP 200 OK)"""
    payload = {
        "revenue": 1000000,
        "cost": 300000,
        "labor_cost": 200000,
        "other_expense": 50000
    }
    response = client.post("/api/v1/operation/settlements/calculate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["total_cost"] == 550000
    assert body["data"]["estimated_profit"] == 450000
    assert body["data"]["profit_rate"] == 45.0

def test_api_settlement_calculate_zero_revenue():
    """예상 정산 계산 API 매출 0일 때 profit_rate가 null(None)인지 테스트 (HTTP 200 OK)"""
    payload = {
        "revenue": 0,
        "cost": 300000,
        "labor_cost": 200000,
        "other_expense": 50000
    }
    response = client.post("/api/v1/operation/settlements/calculate", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["data"]["profit_rate"] is None
