# c:\STUDY\SimpleM\backend\app\api\v1\inventory.py
from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.auth import get_current_user
from app.models.user import User

from app.schemas.inventory import (
    IngredientCreate, IngredientResponse, IngredientPriceUpdate, IngredientPriceHistoryResponse,
    StockAdjust, StockResponse, StockDetailResponse,
    MenuCreate, MenuResponse, MenuDetailResponse,
    OrderResponse, OrderStatusUpdate, RoasteryBeanResponse
)
from app.services.inventory_service import (
    create_ingredient, get_ingredients, delete_ingredient,
    update_ingredient_price, get_ingredient_price_history,
    add_or_adjust_stock, get_stocks,
    create_menu_with_recipes, get_menus_with_recipes, delete_menu,
    get_roastery_beans
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


@router.patch("/ingredients/{ingredient_id}/price", response_model=IngredientResponse)
def update_price_api(
    ingredient_id: int,
    payload: IngredientPriceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [재료 단가 수정] 특정 식재료의 매입 단가를 업데이트하고 단가 변동 히스토리를 자동으로 저장합니다.
    """
    return update_ingredient_price(
        db=db,
        store_id=current_user.email,
        ingredient_id=ingredient_id,
        new_price=payload.price
    )


@router.get("/ingredients/{ingredient_id}/price-history", response_model=list[IngredientPriceHistoryResponse])
def get_price_history_api(
    ingredient_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [단가 변동 이력 조회] 특정 식재료의 과거 가격 변동 내역 목록을 최신순으로 가져옵니다.
    """
    return get_ingredient_price_history(
        db=db,
        store_id=current_user.email,
        ingredient_id=ingredient_id
    )


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


# --- [5. 발주 추천 및 승인/반려 관련 API 창구] ---

@router.get("/orders/drafts", response_model=list[OrderResponse])
def get_order_drafts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [발주 추천 초안 목록 조회]
    매장의 실시간 재고 대장을 탐색하여 안전재고 미달 품목이 있으면 자동으로 발주 제안서 초안들을 돌려줍니다.
    """
    from app.services.inventory_service import get_or_create_order_drafts
    return get_or_create_order_drafts(db=db, store_id=current_user.email)


# --- [6. 로스터리 원두 탐색 마켓 API 창구] ---

@router.get("/roastery-beans", response_model=list[RoasteryBeanResponse])
def list_roastery_beans(
    limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    [한글 주석: 로스터리 원두 탐색 마켓 목록 조회]
    DB에 등록된 외부 전문 로스터리의 원두 상품 목록을 가져옵니다.
    로스터리 업체 정보, 가격, 이미지, 원산지, 가공방식 등을 포함합니다.
    """
    return get_roastery_beans(db=db, limit=limit)


@router.patch("/orders/{order_id}")
def update_order_status_api(
    order_id: int,
    payload: OrderStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [발주서 상태 업데이트 (승인 및 반려)]
    사장님이 검토 후 발주를 승인(CONFIRMED)하면 실제 재고에 반영하고 입고 기록을 생성하며, 반려(REJECTED)하면 반려 상태로 처리합니다.
    """
    from app.services.inventory_service import update_order_status
    return update_order_status(db=db, store_id=current_user.email, order_id=order_id, status_update=payload.status)


@router.get("/menus/{menu_id}/cost-reduction-recommendations")
def get_cost_reduction_recommendations_api(
    menu_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    [한글 주석: AI 원가 절감 대체재 추천 API 창구]
    선택한 메뉴 레시피 재료들의 매입 단가를 분석하고, 원두 마켓 도매 제품 및 인터넷 실시간 가격 비교(다나와)와 대조해
    더 싼 대체 재료와 예상 마진 개선율 분석표를 반환합니다.
    """
    from app.services.inventory_service import get_menu_cost_reduction_recommendations
    return get_menu_cost_reduction_recommendations(db=db, store_id=current_user.email, menu_id=menu_id)
