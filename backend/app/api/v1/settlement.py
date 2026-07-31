"""카드 정산 API (백엔드 B) — 현금/카드사별 매출 입력과 입금 예정·수수료 조회

POS 연동이 없는 매장을 위한 핵심 입력 경로다. 메뉴별 잔 수 대신 '결제수단별 총액'만
받고, 그 대가로 카드사별 입금 예정일·수수료·실입금액을 계산해 돌려준다.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import get_current_user
from app.models.user import User
from app.services.ai import settlement_service

router = APIRouter(prefix="/settlement", tags=["settlement"])


class CardEntryIn(BaseModel):
    issuer: str = Field(..., description="카드사 코드 (shinhan, kb, ...)")
    amount: int = Field(0, ge=0, description="해당 카드사 매출 총액(원)")
    card_type: str = Field("credit", description="credit | check")
    cups: Optional[int] = Field(None, ge=0, description="선택 — 잔 수를 세는 매장만")
    memo: Optional[str] = None


class DaySaveRequest(BaseModel):
    date: str = Field(..., description="매출 발생일 YYYY-MM-DD")
    cash: int = Field(0, ge=0)
    cash_cups: Optional[int] = Field(None, ge=0)
    cards: list[CardEntryIn] = Field(default_factory=list)
    memo: Optional[str] = None


class SettingsUpdate(BaseModel):
    revenue_tier: Optional[str] = None
    custom_credit_fee: Optional[float] = Field(None, ge=0, le=10)
    custom_check_fee: Optional[float] = Field(None, ge=0, le=10)
    lag_overrides: Optional[dict[str, int]] = None


@router.get("/settings", summary="수수료 구간·카드사별 입금 소요일")
def get_settings_api(current_user: User = Depends(get_current_user)):
    return settlement_service.get_settings(current_user.email)


@router.put("/settings", summary="정산 설정 저장")
def update_settings_api(
    body: SettingsUpdate,
    current_user: User = Depends(get_current_user),
):
    try:
        return settlement_service.update_settings(
            current_user.email,
            revenue_tier=body.revenue_tier,
            custom_credit_fee=body.custom_credit_fee,
            custom_check_fee=body.custom_check_fee,
            lag_overrides=body.lag_overrides,
        )
    except settlement_service.SettlementError as e:
        raise HTTPException(400, str(e))


@router.get("/tier-suggestion", summary="최근 매출로 추정한 우대수수료율 구간 추천")
def suggest_tier_api(
    lookback_days: int = 90,
    current_user: User = Depends(get_current_user),
):
    return settlement_service.suggest_tier(current_user.email, lookback_days=lookback_days)


@router.get("/preview", summary="설정 미리보기 — 이 금액이 언제 얼마로 들어오는지")
def preview_api(
    amount: int = 100_000,
    card_type: str = "credit",
    issuer: str = "",
    sale_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    try:
        return settlement_service.preview(
            current_user.email,
            amount=amount,
            card_type=card_type,
            issuer=issuer,
            sale_date=sale_date,
        )
    except settlement_service.SettlementError as e:
        raise HTTPException(400, str(e))


@router.get("/day", summary="하루치 매출 입력 내용 + 그날 수수료·입금 예정")
def get_day_api(date: str, current_user: User = Depends(get_current_user)):
    try:
        return settlement_service.get_day(current_user.email, date)
    except settlement_service.SettlementError as e:
        raise HTTPException(400, str(e))


@router.post("/day", status_code=201, summary="하루치 매출 저장(덮어쓰기)")
def save_day_api(
    body: DaySaveRequest,
    current_user: User = Depends(get_current_user),
):
    try:
        result = settlement_service.save_day(
            current_user.email,
            body.date,
            cash=body.cash,
            cash_cups=body.cash_cups,
            cards=[c.model_dump() for c in body.cards],
            memo=body.memo,
        )
    except settlement_service.SettlementError as e:
        raise HTTPException(400, str(e))
    # 매출이 바뀌었으니 예측 캐시를 비운다 — 대시보드가 바로 최신을 본다
    try:
        from app.services.ai import forecast_service

        forecast_service.invalidate_forecast_cache(current_user.email)
    except Exception:  # 캐시 무효화 실패가 저장을 되돌릴 이유는 없다
        pass
    return result


@router.get("/deposits", summary="다가오는 카드 대금 입금 예정")
def deposits_api(
    ahead_days: int = 21,
    lookback_days: int = 21,
    current_user: User = Depends(get_current_user),
):
    return settlement_service.upcoming_deposits(
        current_user.email, lookback_days=lookback_days, ahead_days=ahead_days)


@router.get("/summary", summary="최근 기간 매출 요약 (현금·카드 비중, 전주 동요일 대비)")
def summary_api(days: int = 28, current_user: User = Depends(get_current_user)):
    return settlement_service.period_summary(current_user.email, days=days)
