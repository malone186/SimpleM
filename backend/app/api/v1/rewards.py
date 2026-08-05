"""포인트·상점 API (백엔드 B) — 게임화 보상

할 일을 끝내면 코인이 쌓이고(적립은 todo_service가 자동으로 호출한다), 그 코인으로
브루 꾸미기 아이템을 산다. 여기서는 조회·구매·착용만 다룬다.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.models.user import User
from app.schemas.ai import (
    AwardResponse,
    DerivedTodoDoneRequest,
    EquipRequest,
    ShopResponse,
    WalletResponse,
)
from app.services.ai import reward_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rewards", tags=["rewards"])


@router.get("/wallet", response_model=WalletResponse)
def get_wallet(current_user: User = Depends(get_current_user)):
    """코인 잔액 + 누적 적립 + 최근 적립·사용 내역 (상점 화면 상단)."""
    return reward_service.get_wallet(current_user.email)


@router.get("/shop", response_model=ShopResponse)
def get_shop(current_user: User = Depends(get_current_user)):
    """상점 카탈로그 — 보유 여부·착용 여부·구매 가능 여부가 함께 온다."""
    return reward_service.get_shop(current_user.email)


@router.post("/shop/{item_id}/buy", response_model=ShopResponse)
def buy_item(item_id: str, current_user: User = Depends(get_current_user)):
    """아이템 구매. 성공하면 갱신된 상점 상태를 그대로 돌려준다(재조회 불필요)."""
    try:
        return reward_service.buy(current_user.email, item_id)
    except reward_service.RewardError as e:
        raise HTTPException(400, str(e))


@router.post("/equip", response_model=ShopResponse)
def equip_item(body: EquipRequest, current_user: User = Depends(get_current_user)):
    """착용/해제 — 같은 부위(모자·얼굴·손·배경)에는 하나만 착용된다."""
    try:
        return reward_service.set_equipped(current_user.email, body.item_id, body.equipped)
    except reward_service.RewardError as e:
        raise HTTPException(400, str(e))


@router.post("/todo-done", response_model=AwardResponse)
def award_derived_todo(body: DerivedTodoDoneRequest, current_user: User = Depends(get_current_user)):
    """자동 도출 할 일 완료 적립.

    저장된 할 일(todo_items)은 완료 API가 알아서 적립하지만, 재고 부족·서류 갱신·브루
    추천처럼 조건에서 매번 조립되는 항목은 서버에 행이 없다. 앱이 완료를 눌렀을 때
    이 엔드포인트로 알려준다. 같은 key로 두 번 오면 두 번째는 awarded=0이다.
    """
    try:
        awarded = reward_service.award_derived_todo(current_user.email, body.key, body.title)
    except reward_service.RewardError as e:
        raise HTTPException(400, str(e))
    return {
        "awarded": reward_service.POINTS_PER_TODO if awarded else 0,
        "balance": reward_service.get_balance(current_user.email),
    }


@router.get("/equipped")
def get_equipped(current_user: User = Depends(get_current_user)) -> list[dict]:
    """현재 착용 중인 아이템 — 브루를 그리는 화면들이 가볍게 조회한다."""
    return reward_service.get_equipped(current_user.email)


@router.get("/progress")
def get_progress(current_user: User = Depends(get_current_user)) -> dict:
    """브루 키우기 상태 — 레벨·EXP·스트릭·일일 도전 (상점 상단 성장 카드).

    일일 도전을 오늘 달성했으면 이 조회 중에 보너스 코인이 지급될 수 있다(하루 한 번).
    """
    return reward_service.get_progress(current_user.email)


@router.get("/quests")
def get_quests(current_user: User = Depends(get_current_user)) -> dict:
    """주간 퀘스트 — 이번 주(월요일 시작) 할 일 완료 누적으로 진행도를 센다."""
    return reward_service.get_quests(current_user.email)


@router.post("/quests/{quest_id}/claim")
def claim_quest(quest_id: str, current_user: User = Depends(get_current_user)) -> dict:
    """달성한 퀘스트 보상 수령 — 갱신된 퀘스트 목록 + 잔액을 돌려준다."""
    try:
        return reward_service.claim_quest(current_user.email, quest_id)
    except reward_service.RewardError as e:
        raise HTTPException(400, str(e))
