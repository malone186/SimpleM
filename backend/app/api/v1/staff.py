"""직원 인건비 상세 API (백엔드 B)

기존 직원 등록(operation의 /employees)은 이름·시급·직책만 다룬다. 여기서는 그 위에
고용형태(주 15시간 미만/이상·정규·매니저), 급여형태(시급/월급), 보험(4대/2대/미가입)을
붙여 '실제로 매장에서 나가는 돈'을 계산한다.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import get_current_user, require_owner
from app.models.user import User
from app.services.ai import staff_service

router = APIRouter(prefix="/staff", tags=["staff"])


class AvailabilityWindow(BaseModel):
    """근무 가능 시간 한 칸 — 요일(0=월 … 6=일)과 시작·종료 시각(정시 단위)"""

    day_of_week: int = Field(..., ge=0, le=6)
    start_hour: int = Field(9, ge=0, le=23)
    end_hour: int = Field(18, ge=1, le=24)


class ProfileUpdate(BaseModel):
    """직원 상세 화면에서 고칠 수 있는 모든 값 — 이름·시급(employees)과 고용 상세를 함께 받는다.

    등록 화면과 상세 화면이 같은 항목을 다뤄야 사장님이 "추가할 때 못 고른 걸 나중에
    또 찾아 들어가는" 일이 없다.
    """

    # 보낸 경우에만 통째로 교체된다 (빈 배열 = 가능 시간 전부 삭제)
    availability: Optional[List[AvailabilityWindow]] = None
    name: Optional[str] = None
    hourly_rate: Optional[int] = Field(None, ge=0)
    role: Optional[str] = None
    # 직원 대표 색 (#RRGGBB) — 근무 달력의 점·선과 아바타를 같은 색으로 맞추는 데 쓴다
    color: Optional[str] = Field(None, max_length=9)
    employment_type: Optional[str] = Field(None, description="part_time | part_time_15 | full_time | manager")
    pay_type: Optional[str] = Field(None, description="hourly | monthly")
    monthly_salary: Optional[int] = Field(None, ge=0)
    weekly_hours: Optional[float] = Field(None, ge=0, le=80)
    insurance: Optional[str] = Field(None, description="four | two | none")
    weekly_holiday_pay: Optional[bool] = None
    hired_on: Optional[str] = None
    memo: Optional[str] = None


class StaffCreate(ProfileUpdate):
    """직원 등록 — 이름만 필수, 나머지는 상세 화면과 같은 항목이며 생략하면 기본값."""

    name: str = Field(..., min_length=1)
    hourly_rate: int = Field(0, ge=0)


@router.get("", summary="직원 목록 + 고용 상세 + 월 인건비 추정")
def list_staff_api(
    month: Optional[str] = None,
    current_user: User = Depends(require_owner),
):
    """인건비는 근무 달력에 등록된 해당 월 근무시간 기준으로 계산된다.

    month는 YYYY-MM, 생략하면 이번 달.
    """
    return staff_service.list_staff(current_user.email, month=month)


@router.post("", summary="직원 등록 + 고용 상세 한 번에")
def create_staff_api(
    body: StaffCreate,
    current_user: User = Depends(require_owner),
):
    """등록과 상세 저장을 한 트랜잭션으로 묶는다 — 반쪽만 저장되는 직원이 안 생기게.

    반환값은 목록의 한 줄과 같은 모양(프로필 + 인건비 계산)이라 화면이 바로 붙일 수 있다.
    """
    try:
        return staff_service.create_staff(
            current_user.email, **body.model_dump(exclude_none=True),
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.put("/{employee_id}/profile", summary="직원 기본 정보 + 고용 상세 저장")
def save_profile_api(
    employee_id: int,
    body: ProfileUpdate,
    current_user: User = Depends(require_owner),
):
    """저장된 결과를 목록 한 줄 모양(인건비 재계산 포함)으로 돌려준다."""
    try:
        return staff_service.save_profile(
            current_user.email, employee_id,
            **body.model_dump(exclude_none=True),
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


class AvailabilityUpdate(BaseModel):
    """근무 가능 시간만 따로 저장할 때 (통째 교체)"""

    availability: List[AvailabilityWindow] = Field(default_factory=list)


class ShiftCreate(BaseModel):
    employee_id: int
    date: str = Field(..., description="근무 날짜 YYYY-MM-DD")
    start: str = Field("09:00", description="시작 시각 HH:MM")
    end: str = Field("18:00", description="종료 시각 HH:MM (시작보다 이르면 익일로 본다)")


class ShiftUpdate(BaseModel):
    """교대·시간 변경 — 담당 직원을 바꾸는 것이 핵심이다"""

    employee_id: Optional[int] = Field(None, description="이 근무를 대신할 직원 ID (교대)")
    date: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None


@router.put("/{employee_id}/availability", summary="직원 근무 가능 시간 저장 (통째 교체)")
def save_availability_api(
    employee_id: int,
    body: AvailabilityUpdate,
    current_user: User = Depends(require_owner),
):
    try:
        windows = staff_service.save_availability(
            current_user.email, employee_id,
            [w.model_dump() for w in body.availability],
        )
        return {"employee_id": employee_id, "availability": windows,
                "availability_text": staff_service.describe_windows(windows)}
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.get("/calendar", summary="월 근무 달력 — 날짜별 배정 근무 + 그날 가능한 직원")
def calendar_api(
    month: Optional[str] = None,
    current_user: User = Depends(require_owner),
):
    """month는 YYYY-MM, 생략하면 이번 달."""
    try:
        return staff_service.month_calendar(current_user.email, month=month)
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.post("/shifts", summary="근무 배정 추가")
def add_shift_api(
    body: ShiftCreate,
    current_user: User = Depends(require_owner),
):
    try:
        return staff_service.add_shift(
            current_user.email, body.employee_id, body.date, body.start, body.end,
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


class ApplyAvailability(BaseModel):
    """가능 시간 → 달력 반영 (해당 월, 지난 날짜 제외, 중복은 건너뜀)"""

    month: Optional[str] = Field(None, description="YYYY-MM, 생략하면 이번 달")
    employee_id: Optional[int] = Field(None, description="비우면 매장 전체 직원")


@router.post("/shifts/apply-availability", summary="근무 가능 시간대로 달력 채우기")
def apply_availability_api(
    body: ApplyAvailability,
    current_user: User = Depends(require_owner),
):
    """등록해 둔 가능 시간을 그 달의 실제 근무로 만든다 — 기존 근무 달력에 그대로 뜬다."""
    try:
        return staff_service.apply_availability(
            current_user.email, month=body.month, employee_id=body.employee_id,
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.put("/shifts/{schedule_id}", summary="근무 교대 · 시간 변경")
def update_shift_api(
    schedule_id: int,
    body: ShiftUpdate,
    current_user: User = Depends(require_owner),
):
    """employee_id를 보내면 그 근무를 다른 직원이 대신하는 것으로 바뀐다 (출퇴근 기록 유지)."""
    try:
        return staff_service.update_shift(
            current_user.email, schedule_id,
            employee_id=body.employee_id, day=body.date, start=body.start, end=body.end,
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.delete("/shifts/{schedule_id}", summary="근무 배정 삭제")
def delete_shift_api(
    schedule_id: int,
    current_user: User = Depends(require_owner),
):
    try:
        staff_service.remove_shift(current_user.email, schedule_id)
        return {"ok": True}
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.get("/monthly-payroll", summary="전 직원 월 예상 급여 (배치 계산 — 직원 수와 무관하게 왕복 2번)")
def monthly_payroll_api(
    year_month: Optional[str] = None,
    current_user: User = Depends(require_owner),
):
    """/operation/payroll/all과 같은 모양·같은 기준. 그 경로는 직원마다 DB 왕복 5번이 붙어
    직원 5명이면 5초가 걸렸다. year_month는 YYYY-MM, 생략하면 이번 달."""
    try:
        return staff_service.monthly_payroll(current_user.email, year_month=year_month)
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.get("/month-settlement", summary="월 손익 정산 + 직원별 급여 한 번에 (배치 계산)")
def month_settlement_api(
    year_month: Optional[str] = None,
    current_user: User = Depends(require_owner),
):
    """'정산·급여' 카드가 요청 1번(DB 왕복 4번)으로 그려지게 정산과 급여를 함께 준다.
    집계 기준은 기존 /operation/settlements/calculate와 동일하다."""
    try:
        return staff_service.month_settlement(current_user.email, year_month=year_month)
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.get("/weekly-payroll", summary="이번 주 주급 정산 (스케줄 기준)")
def weekly_payroll_api(
    week_start: Optional[str] = None,
    current_user: User = Depends(require_owner),
):
    try:
        return staff_service.weekly_payroll(current_user.email, week_start=week_start)
    except ValueError as e:
        raise HTTPException(400, str(e))
