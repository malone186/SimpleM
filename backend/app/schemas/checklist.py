"""근무 체크리스트 스키마"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class ChecklistItemCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=120, description="항목 이름")
    # 담당 직원(staff_accounts.id). 사장님이 특정 알바에게 지시할 때만 채운다 — 없으면 공용.
    assigned_staff_id: Optional[int] = None


class ChecklistItemUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    active: Optional[bool] = None
    sort_order: Optional[int] = None


class ChecklistItemRow(BaseModel):
    """오늘 기준 한 항목 — 템플릿 정보 + 오늘 체크 상태."""
    id: int
    label: str
    sort_order: int
    done: bool = Field(..., description="오늘 체크됐는지")
    done_by: Optional[str] = Field(None, description="오늘 체크한 사람 (직원 이름 또는 '사장님')")
    checked_at: Optional[datetime] = None
    # 담당 직원 — 지정된 항목만 채워진다. 이름은 표시용(직원 계정이 지워졌으면 None).
    assigned_staff_id: Optional[int] = None
    assigned_staff_name: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class ChecklistToggleResult(BaseModel):
    id: int
    done: bool
    done_by: Optional[str] = None
