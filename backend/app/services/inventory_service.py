# c:\STUDY\SimpleM\backend\app\services\inventory_service.py
from sqlalchemy.orm import Session
from fastapi import HTTPException, status

from app.models.inventory import Ingredient, Menu, Recipe, Stock, StockTransaction
from app.schemas.inventory import IngredientCreate, StockAdjust, MenuCreate


# --- [1. 재료 관리 서비스 로직] ---

def create_ingredient(db: Session, store_id: str, item_in: IngredientCreate) -> Ingredient:
    """
    새로운 식재료를 등록하고, 동시에 실시간 재고 대장(Stock)에도 자리를 파서 0개로 세팅합니다.
    """
    # 1-1. 재료 정보 생성
    db_item = Ingredient(
        name=item_in.name,
        unit=item_in.unit,
        current_price=item_in.current_price,
        store_id=store_id
    )
    db.add(db_item)
    db.flush()  # DB에 임시로 임포트하여 부여된 id(고유번호)를 획득합니다. (아직 최종 저장 커밋은 안 함)

    # 1-2. 재고 대장에 수량 0.0개로 1대1 매핑하여 연동 생성
    db_stock = Stock(
        ingredient_id=db_item.id,
        current_quantity=0.0,
        safety_quantity=0.0
    )
    db.add(db_stock)
    
    # 1-3. 최종 확정 저장
    db.commit()
    db.refresh(db_item)
    return db_item


def get_ingredients(db: Session, store_id: str) -> list[Ingredient]:
    """
    현재 매장(store_id)에 등록되어 있는 모든 식재료 목록을 조회합니다.
    """
    return db.query(Ingredient).filter(Ingredient.store_id == store_id).order_by(Ingredient.id.asc()).all()


# --- [2. 재고 조정 및 입출고 장부 관리 서비스 로직] ---

def get_stocks(db: Session, store_id: str) -> list[dict]:
    """
    [백엔드 B 추가 — 재고 현황 화면·OCR 입고 확인용] 내 매장의 재료별 실시간 재고 목록을
    재료 이름·단위·단가와 함께 한 번에 조회합니다. (A 확인 요망: 필요 시 자유롭게 수정하세요)
    """
    stocks = (
        db.query(Stock)
        .join(Ingredient, Stock.ingredient_id == Ingredient.id)
        .filter(Ingredient.store_id == store_id)
        .order_by(Ingredient.id.asc())
        .all()
    )
    return [
        {
            "ingredient_id": s.ingredient_id,
            "name": s.ingredient.name,
            "unit": s.ingredient.unit,
            "current_price": s.ingredient.current_price,
            "current_quantity": s.current_quantity,
            "safety_quantity": s.safety_quantity,
            "updated_at": s.updated_at,
        }
        for s in stocks
    ]


def add_or_adjust_stock(db: Session, store_id: str, adjust_in: StockAdjust) -> Stock:
    """
    창고 재고를 가감하고, 왜 변했는지 변동 이력 장부(StockTransaction)에 의무적으로 기록합니다.
    """
    # 2-1. [보안 검증] 조작하려는 재료가 진짜 내 매장(store_id) 소유의 재료인지 확인합니다.
    ingredient = db.query(Ingredient).filter(
        Ingredient.id == adjust_in.ingredient_id,
        Ingredient.store_id == store_id
    ).first()
    
    if not ingredient:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="매장에 해당 식재료 정보가 존재하지 않습니다."
        )

    # 2-2. 실시간 재고 레코드를 찾아서 값을 증감시킵니다.
    stock = db.query(Stock).filter(Stock.ingredient_id == adjust_in.ingredient_id).first()
    if not stock:
        # 혹시 모를 에러 방지용: 재고 레코드가 없었다면 새로 파줍니다.
        stock = Stock(ingredient_id=adjust_in.ingredient_id, current_quantity=0.0)
        db.add(stock)
        db.flush()

    # 재고 수량 계산 (기존 수량 + 변동량)
    stock.current_quantity += adjust_in.quantity_change

    # 2-3. 변동 장부(StockTransaction)에 한 줄 기록을 의무적으로 남깁니다.
    # 변동량이 양수이면 입고(IN), 음수이면 차감/수정(OUT/ADJUST)으로 자동 분류합니다.
    tx_type = "IN" if adjust_in.quantity_change > 0 else "OUT"
    if adjust_in.description and "조정" in adjust_in.description:
        tx_type = "ADJUST"

    db_tx = StockTransaction(
        ingredient_id=adjust_in.ingredient_id,
        quantity_change=adjust_in.quantity_change,
        type=tx_type,
        description=adjust_in.description
    )
    db.add(db_tx)
    
    # 2-4. 최종 확정
    db.commit()
    db.refresh(stock)
    return stock


# --- [3. 메뉴 및 레시피 일괄 등록 서비스 로직] ---

def create_menu_with_recipes(db: Session, store_id: str, menu_in: MenuCreate) -> Menu:
    """
    메뉴 이름과 그 메뉴를 만드는 데 들어가는 재료 조합(레시피) 목록을 일괄 조립하여 등록합니다.
    """
    # 3-1. 메뉴 기본 정보 생성
    db_menu = Menu(
        name=menu_in.name,
        selling_price=menu_in.selling_price,
        store_id=store_id
    )
    db.add(db_menu)
    db.flush()  # 메뉴의 id를 미리 따둡니다.

    # 3-2. 레시피 품목들을 하나씩 꺼내 검증한 뒤 등록합니다.
    for item in menu_in.recipes:
        # [보안 검증] 레시피에 넣으려는 재료가 내 매장에 등록된 재료인지 재차 검사합니다.
        ing = db.query(Ingredient).filter(
            Ingredient.id == item.ingredient_id,
            Ingredient.store_id == store_id
        ).first()
        
        if not ing:
            db.rollback()  # 잘못된 재료가 하나라도 섞여 있다면 트랜잭션을 전부 취소(롤백)합니다.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"아이디 {item.ingredient_id}번 재료는 매장에 등록되지 않은 재료입니다."
            )
        
        # 레시피 데이터 조립
        db_recipe = Recipe(
            menu_id=db_menu.id,
            ingredient_id=item.ingredient_id,
            quantity=item.quantity
        )
        db.add(db_recipe)

    # 3-3. 최종 저장
    db.commit()
    db.refresh(db_menu)
    return db_menu


def get_menus_with_recipes(db: Session, store_id: str) -> list[dict]:
    """
    현재 매장의 메뉴판 정보와 각 메뉴별 레시피(재료 이름, 단위, 양)를 정렬하여 한 묶음의 리스트로 받아옵니다.
    """
    menus = db.query(Menu).filter(Menu.store_id == store_id).order_by(Menu.id.asc()).all()
    results = []

    for menu in menus:
        recipes_detail = []
        for r in menu.recipes:
            recipes_detail.append({
                "ingredient_id": r.ingredient_id,
                "ingredient_name": r.ingredient.name,
                "quantity": r.quantity,
                "unit": r.ingredient.unit
            })
        
        results.append({
            "id": menu.id,
            "name": menu.name,
            "selling_price": menu.selling_price,
            "store_id": menu.store_id,
            "is_active": menu.is_active,
            "created_at": menu.created_at,
            "recipes": recipes_detail
        })
    
    return results


# --- [4. 삭제 서비스 로직] ---

def delete_ingredient(db: Session, store_id: str, ingredient_id: int) -> None:
    """
    재료를 삭제합니다. 연결된 재고(Stock)·거래내역·레시피는 cascade로 함께 정리됩니다.
    (본인 매장 재료만 삭제 가능)
    """
    item = (
        db.query(Ingredient)
        .filter(Ingredient.id == ingredient_id, Ingredient.store_id == store_id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="재료를 찾을 수 없습니다.")
    db.delete(item)
    db.commit()


def delete_menu(db: Session, store_id: str, menu_id: int) -> None:
    """
    메뉴를 삭제합니다. 연결된 레시피는 cascade로 함께 정리됩니다.
    (본인 매장 메뉴만 삭제 가능)
    """
    menu = (
        db.query(Menu)
        .filter(Menu.id == menu_id, Menu.store_id == store_id)
        .first()
    )
    if not menu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="메뉴를 찾을 수 없습니다.")
    db.delete(menu)
    db.commit()
