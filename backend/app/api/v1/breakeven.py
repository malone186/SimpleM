"""손익분기점 API (백엔드 B) — 고정비 입력과 "얼마 팔아야 본전인가" 조회

고정비는 매장마다 한 벌만 저장한다(월 기준). 계산은 저장된 고정비 + 최근 판매에서
뽑은 변동비율로 하고, 화면에서 값을 바꿔 보는 동안에는 /simulate로 저장 없이 돌린다.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.auth import require_owner
from app.models.user import User
from app.services.ai import breakeven_service

router = APIRouter(prefix="/breakeven", tags=["breakeven"])


class FixedCostUpdate(BaseModel):
    rent: Optional[int] = Field(None, ge=0, description="임대료·관리비(월)")
    labor: Optional[int] = Field(None, ge=0, description="고정 인건비(월, 사장 급여 포함)")
    utilities: Optional[int] = Field(None, ge=0, description="공과금(월)")
    other: Optional[int] = Field(None, ge=0, description="기타 고정비(월)")
    custom_variable_ratio: Optional[float] = Field(
        None, ge=0, lt=100, description="변동비율(%)을 직접 적을 때만 — 비우면 판매 데이터에서 자동"
    )
    open_days_per_month: Optional[int] = Field(None, ge=1, le=31, description="한 달 영업일수")
    memo: Optional[str] = None


class SimulateRequest(BaseModel):
    """저장하지 않고 값만 바꿔 보는 계산 — 화면 슬라이더·목표이익 입력에 쓴다."""

    rent: Optional[int] = Field(None, ge=0)
    labor: Optional[int] = Field(None, ge=0)
    utilities: Optional[int] = Field(None, ge=0)
    other: Optional[int] = Field(None, ge=0)
    variable_cost_ratio: Optional[float] = Field(None, ge=0, lt=100)
    target_profit: int = Field(0, ge=0, description="이만큼 남기려면 얼마를 팔아야 하는지")
    open_days_per_month: Optional[int] = Field(None, ge=1, le=31)


@router.get("", summary="손익분기점 — 저장된 고정비 기준")
def get_breakeven_api(
    target_profit: int = Query(0, ge=0, description="목표이익(월). 0이면 본전만"),
    current_user: User = Depends(require_owner),
):
    return breakeven_service.compute_breakeven(
        current_user.email, target_profit=target_profit
    )


@router.get("/fixed-costs", summary="저장된 월 고정비")
def get_fixed_costs_api(current_user: User = Depends(require_owner)):
    return breakeven_service.get_fixed_costs(current_user.email)


@router.get("/fixed-costs/suggest", summary="고정비 자동 제안 (지난 지출·급여에서)")
def suggest_fixed_costs_api(current_user: User = Depends(require_owner)):
    """설정 화면을 처음 열 때 빈 칸 대신 앱이 이미 아는 값으로 미리 채우게 한다."""
    return breakeven_service.suggest_fixed_costs(current_user.email)


@router.put("/fixed-costs", summary="월 고정비 저장 (보낸 항목만 반영)")
def save_fixed_costs_api(payload: FixedCostUpdate, current_user: User = Depends(require_owner)):
    try:
        saved = breakeven_service.save_fixed_costs(
            current_user.email, **payload.model_dump(exclude_unset=True)
        )
    except breakeven_service.BreakevenError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 저장 직후 바뀐 결과를 함께 준다 — 화면이 두 번 호출하지 않게
    return {"fixed_costs": saved, "breakeven": breakeven_service.compute_breakeven(current_user.email)}


@router.delete("/fixed-costs/variable-ratio", summary="직접 적은 변동비율을 지우고 자동 계산으로")
def clear_variable_ratio_api(current_user: User = Depends(require_owner)):
    saved = breakeven_service.clear_custom_variable_ratio(current_user.email)
    return {"fixed_costs": saved, "breakeven": breakeven_service.compute_breakeven(current_user.email)}


@router.post("/simulate", summary="저장하지 않고 가정만 바꿔 계산")
def simulate_api(payload: SimulateRequest, current_user: User = Depends(require_owner)):
    body = payload.model_dump(exclude_unset=True)
    sent = {f: body[f] for f in breakeven_service.FIXED_COST_FIELDS if f in body}
    # 보낸 항목만 저장값 위에 덮어쓴다 — 임대료만 바꿔 볼 때 나머지가 0으로 사라지지 않게
    if sent:
        saved = breakeven_service.get_fixed_costs(current_user.email)
        fixed = {f: sent.get(f, int(saved.get(f) or 0)) for f in breakeven_service.FIXED_COST_FIELDS}
    else:
        fixed = None
    try:
        return breakeven_service.compute_breakeven(
            current_user.email,
            fixed_costs=fixed,
            variable_cost_ratio=body.get("variable_cost_ratio"),
            target_profit=body.get("target_profit", 0),
            open_days_per_month=body.get("open_days_per_month"),
        )
    except breakeven_service.BreakevenError as e:
        raise HTTPException(status_code=400, detail=str(e))
