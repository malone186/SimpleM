"""
운영 서비스(OperationService) 급여·정산 계산 단위 테스트 (옵션 A & B 포함)
"""
from datetime import datetime
import pytest
from app.services.operation.operation_service import OperationService

def test_calculate_work_hours_success():
    """정상 근무시간 및 휴게시간 계산 검증 (9시~18시, 휴게시간 60분 -> 실근무 8.0시간)"""
    start_time = datetime(2026, 7, 20, 9, 0, 0)
    end_time = datetime(2026, 7, 20, 18, 0, 0)
    break_minutes = 60.0

    actual_work_hours = OperationService.calculate_work_hours(start_time, end_time, break_minutes)
    assert actual_work_hours == 8.0

def test_calculate_work_hours_option_a_overnight_shift():
    """[옵션 A] 자정 넘김(익일 퇴근) 근무시간 자동 보정 검증 (22시 출근 ~ 06시 퇴근, 휴게 60분 -> 실근무 7.0시간)"""
    start_time = datetime(2026, 7, 20, 22, 0, 0)
    end_time = datetime(2026, 7, 20, 6, 0, 0)  # 동일 일자 입력 시 익일 06:00으로 보정
    break_minutes = 60.0

    actual_work_hours = OperationService.calculate_work_hours(start_time, end_time, break_minutes)
    assert actual_work_hours == 7.0

def test_calculate_work_hours_invalid_same_time():
    """시작 시각과 종료 시각이 완전히 같은 경우 ValueError 검증"""
    start_time = datetime(2026, 7, 20, 9, 0, 0)
    end_time = datetime(2026, 7, 20, 9, 0, 0)

    with pytest.raises(ValueError) as exc_info:
        OperationService.calculate_work_hours(start_time, end_time, 0.0)
    assert "올바르지 않습니다" in str(exc_info.value)

def test_calculate_work_hours_break_time_exceeded():
    """휴게시간이 전체 근무시간 이상일 때 ValueError 발생 검증"""
    start_time = datetime(2026, 7, 20, 9, 0, 0)
    end_time = datetime(2026, 7, 20, 13, 0, 0)  # 4시간 근무
    break_minutes = 240.0  # 4시간 휴게

    with pytest.raises(ValueError) as exc_info:
        OperationService.calculate_work_hours(start_time, end_time, break_minutes)
    assert "휴게시간은 전체 근무시간보다 적어야 합니다." in str(exc_info.value)

def test_calculate_payroll_option_b_weekly_holiday_and_tax():
    """[옵션 B] 주휴수당 및 3.3% 세금 공제 급여 연산 검증 (주 20시간 근무, 7시간 알바, 시급 10,000원)"""
    start_time = datetime(2026, 7, 20, 9, 0, 0)
    end_time = datetime(2026, 7, 20, 17, 0, 0)
    break_minutes = 60.0  # 실근무 7시간
    hourly_rate = 10000

    # 주간 20시간 근무 ➡️ 주휴수당 = (20/40)*8*10000 = 40,000원
    # 기본급 = 70,000원 ➡️ 총급여(gross) = 110,000원
    # 3.3% 원천징수 세금 = 110,000 * 0.033 = 3,630원
    # 세후 실수령액(net) = 110,000 - 3,630 = 106,370원
    result = OperationService.calculate_payroll(
        start_time=start_time,
        end_time=end_time,
        break_minutes=break_minutes,
        hourly_rate=hourly_rate,
        weekly_work_hours=20.0,
        deduct_tax=True
    )
    
    assert result["actual_work_hours"] == 7.0
    assert result["base_payroll"] == 70000
    assert result["weekly_holiday_allowance"] == 40000
    assert result["gross_payroll"] == 110000
    assert result["withholding_tax"] == 3630
    assert result["net_payroll"] == 106370

def test_calculate_payroll_invalid_hourly_rate():
    """시급이 0 이하일 때 ValueError 발생 검증"""
    start_time = datetime(2026, 7, 20, 9, 0, 0)
    end_time = datetime(2026, 7, 20, 18, 0, 0)

    with pytest.raises(ValueError) as exc_info:
        OperationService.calculate_payroll(start_time, end_time, 60.0, 0)
    assert "시급은 0보다 커야 합니다." in str(exc_info.value)

def test_calculate_settlement_success():
    """정상 손익 정산 계산 검증 (매출 1,000,000원, 원가 300,000원, 인건비 200,000원, 기타 50,000원 -> 이익 450,000원, 이익률 45.0%)"""
    revenue = 1000000
    cost = 300000
    labor_cost = 200000
    other_expense = 50000

    result = OperationService.calculate_settlement(revenue, cost, labor_cost, other_expense)

    assert result["revenue"] == 1000000
    assert result["total_cost"] == 550000
    assert result["estimated_profit"] == 450000
    assert result["profit_rate"] == 45.0

def test_calculate_settlement_zero_revenue():
    """매출이 0인 경우 이익률(profit_rate)은 None(null) 반환 검증"""
    revenue = 0
    cost = 100000
    labor_cost = 50000
    other_expense = 10000

    result = OperationService.calculate_settlement(revenue, cost, labor_cost, other_expense)

    assert result["revenue"] == 0
    assert result["total_cost"] == 160000
    assert result["estimated_profit"] == -160000
    assert result["profit_rate"] is None
