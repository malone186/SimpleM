"""직원 인건비 상세 API (백엔드 B)

기존 직원 등록(operation의 /employees)은 이름·시급·직책만 다룬다. 여기서는 그 위에
고용형태(주 15시간 미만/이상·정규·매니저), 급여형태(시급/월급), 보험(4대/2대/미가입)을
붙여 '실제로 매장에서 나가는 돈'을 계산한다.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import get_current_user
from app.models.user import User
from app.services.ai import staff_service

router = APIRouter(prefix="/staff", tags=["staff"])


class ProfileUpdate(BaseModel):
    employment_type: Optional[str] = Field(None, description="part_time | part_time_15 | full_time | manager")
    pay_type: Optional[str] = Field(None, description="hourly | monthly")
    monthly_salary: Optional[int] = Field(None, ge=0)
    weekly_hours: Optional[float] = Field(None, ge=0, le=80)
    insurance: Optional[str] = Field(None, description="four | two | none")
    weekly_holiday_pay: Optional[bool] = None
    hired_on: Optional[str] = None
    memo: Optional[str] = None


@router.get("", summary="직원 목록 + 고용 상세 + 월 인건비 추정")
def list_staff_api(
    month: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """인건비는 근무 달력에 등록된 해당 월 근무시간 기준으로 계산된다.

    month는 YYYY-MM, 생략하면 이번 달.
    """
    return staff_service.list_staff(current_user.email, month=month)


@router.put("/{employee_id}/profile", summary="직원 고용 상세 저장")
def save_profile_api(
    employee_id: int,
    body: ProfileUpdate,
    current_user: User = Depends(get_current_user),
):
    try:
        return staff_service.save_profile(
            current_user.email, employee_id,
            **body.model_dump(exclude_none=True),
        )
    except staff_service.StaffError as e:
        raise HTTPException(400, str(e))


@router.get("/weekly-payroll", summary="이번 주 주급 정산 (스케줄 기준)")
def weekly_payroll_api(
    week_start: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    try:
        return staff_service.weekly_payroll(current_user.email, week_start=week_start)
    except ValueError as e:
        raise HTTPException(400, str(e))
