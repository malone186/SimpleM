# c:\STUDY\SimpleM\backend\app\api\v1\inventory.py
from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.user import User

from app.schemas.inventory import (
    IngredientCreate, IngredientResponse,
    StockAdjust, StockResponse, StockDetailResponse,
    MenuCreate, MenuResponse, MenuDetailResponse
)
from app.services.inventory_service import (
    create_ingredient, get_ingredients, delete_ingredient,
    add_or_adjust_stock, get_stocks,
    create_menu_with_recipes, get_menus_with_recipes, delete_menu
)

# APIRouter를 통해 "/inventory"로 시작하는 신호를 전담 접수하는 창구를 개설합니다.
router = APIRouter(prefix="/inventory", tags=["재고·발주·메뉴(Inventory)"])


# --- [1. 재료 등록 및 목록 조회 API 창구] ---

@router.post("/ingredients", response_model=IngredientResponse, status_code=status.HTTP_201_CREATED)
def add_ingredient(
    item_in: IngredientCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [재료 등록] 사장님이 매장에서 사용할 새로운 원자재(예: 우유, 원두) 정보를 등록합니다.
    (등록 성공 시, 실시간 재고 대장에도 수량 0개로 자동 생성됩니다.)
    """
    # 로그인한 사장님의 이메일을 store_id로 사용하여 등록을 실행합니다.
    return create_ingredient(db=db, store_id=current_user.email, item_in=item_in)


@router.get("/ingredients", response_model=list[IngredientResponse])
def list_ingredients(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [재료 목록 조회] 로그인한 사장님의 매장에 등록된 모든 식재료 목록을 가저옵니다.
    """
    return get_ingredients(db=db, store_id=current_user.email)


# --- [2. 재고 조정 API 창구] ---

@router.get("/stocks", response_model=list[StockDetailResponse])
def list_stocks(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [백엔드 B 추가 — 재고 현황 조회] 내 매장의 재료별 실시간 재고를 이름·단위·단가와 함께 조회합니다.
    (재고 화면과 OCR 입고 확인에서 사용)
    """
    return get_stocks(db=db, store_id=current_user.email)


@router.post("/stocks/adjust", response_model=StockResponse)
def adjust_stock(
    adjust_in: StockAdjust,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [재고 조정 / 입고] 원자재의 재고 수량을 변경하고 변동 내역(입출고 이력)을 기록합니다.
    (양수를 적어 보내면 입고가 되고, 음수를 보내면 차감/폐기 처리가 됩니다.)
    """
    return add_or_adjust_stock(db=db, store_id=current_user.email, adjust_in=adjust_in)


# --- [3. 메뉴 및 레시피 일괄 등록 및 목록 조회 API 창구] ---

@router.post("/menus", response_model=MenuResponse, status_code=status.HTTP_201_CREATED)
def add_menu_with_recipes(
    menu_in: MenuCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [메뉴 등록] 새로운 음료/상품 메뉴 이름과 가격, 그리고 그 메뉴를 만들기 위해
    어떤 재료가 몇 그람/ml씩 필요한지 레시피 비율을 묶어 일괄 조립 등록합니다.
    """
    return create_menu_with_recipes(db=db, store_id=current_user.email, menu_in=menu_in)


@router.get("/menus", response_model=list[MenuDetailResponse])
def list_menus_with_recipes(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [메뉴 및 레시피 조회] 내 매장의 메뉴판 목록과 각 메뉴별 세부 레시피 구성을 정돈하여 불러옵니다.
    """
    return get_menus_with_recipes(db=db, store_id=current_user.email)


# --- [4. 삭제 API 창구] ---

@router.delete("/ingredients/{ingredient_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_ingredient(
    ingredient_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """[재료 삭제] 본인 매장의 재료를 삭제합니다. (재고·레시피 함께 정리)"""
    delete_ingredient(db=db, store_id=current_user.email, ingredient_id=ingredient_id)


@router.delete("/menus/{menu_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_menu(
    menu_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """[메뉴 삭제] 본인 매장의 메뉴를 삭제합니다. (레시피 함께 정리)"""
    delete_menu(db=db, store_id=current_user.email, menu_id=menu_id)
