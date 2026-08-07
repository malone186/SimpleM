"""배치 급여 계산(_payroll_rows) — /operation/payroll/all과 같은 숫자를 내는지 검증.

이 함수는 '직원·스케줄 두 목록 → 급여 행'의 순수 계산이라 DB 없이 검증한다.
기존 경로(직원마다 왕복 5번)를 대체하므로, 계산 규칙이 어긋나면 화면 숫자가 바뀐다.
"""

from datetime import datetime
from types import SimpleNamespace

from app.services.ai.staff_service import _payroll_rows


def _emp(id, name="직원", rate=10_000, role="알바"):
    return SimpleNamespace(id=id, name=name, hourly_rate=rate, role=role)


def _shift(emp_id, start, end, actual_start=None, actual_end=None):
    return SimpleNamespace(
        employee_id=emp_id,
        start_time=start, end_time=end,
        actual_start_time=actual_start, actual_end_time=actual_end,
    )


def test_planned_hours_basic():
    emps = [_emp(1, "김하나", rate=10_000)]
    shifts = [
        _shift(1, datetime(2026, 8, 3, 9), datetime(2026, 8, 3, 18)),   # 9h
        _shift(1, datetime(2026, 8, 4, 9), datetime(2026, 8, 4, 13)),   # 4h
    ]
    rows = _payroll_rows(emps, shifts)
    assert len(rows) == 1
    r = rows[0]
    assert r["total_work_hours"] == 13.0
    assert r["base_salary"] == 130_000
    assert r["estimated_salary"] == 130_000
    assert r["based_on_actual"] is False


def test_actual_times_take_precedence():
    emps = [_emp(1)]
    shifts = [_shift(
        1,
        datetime(2026, 8, 3, 9), datetime(2026, 8, 3, 18),
        actual_start=datetime(2026, 8, 3, 9), actual_end=datetime(2026, 8, 3, 15),  # 실제 6h
    )]
    rows = _payroll_rows(emps, shifts)
    assert rows[0]["total_work_hours"] == 6.0
    assert rows[0]["based_on_actual"] is True


def test_zero_rate_or_no_schedule_excluded():
    """기존 /operation/payroll/all과 같은 규칙 — 시급 0이거나 그 달 스케줄이 없으면 목록에서 빠진다."""
    emps = [_emp(1, rate=0), _emp(2, rate=10_000), _emp(3, rate=12_000)]
    shifts = [_shift(1, datetime(2026, 8, 3, 9), datetime(2026, 8, 3, 12)),
              _shift(2, datetime(2026, 8, 3, 9), datetime(2026, 8, 3, 12))]
    rows = _payroll_rows(emps, shifts)
    assert [r["employee_id"] for r in rows] == [2]


def test_overnight_shift_corrected():
    """자정을 넘긴 근무(종료가 시작보다 이른 datetime)는 24시간을 더해 보정한다."""
    emps = [_emp(1)]
    # 22:00 ~ 익일 02:00을 같은 날짜의 datetime으로 저장한 레거시 행
    shifts = [_shift(1, datetime(2026, 8, 3, 22), datetime(2026, 8, 3, 2))]
    rows = _payroll_rows(emps, shifts)
    assert rows[0]["total_work_hours"] == 4.0
