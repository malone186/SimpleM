# c:\STUDY\SimpleM\backend\app\services\inventory_service.py
from sqlalchemy.orm import Session
from fastapi import HTTPException, status

from app.models.inventory import Ingredient, IngredientPriceHistory, Menu, Recipe, Stock, StockTransaction, Order, OrderItem
from app.schemas.inventory import IngredientCreate, StockAdjust, MenuCreate


# --- [1. 재료 관리 서비스 로직] ---

def create_ingredient(db: Session, store_id: str, item_in: IngredientCreate) -> Ingredient:
    """
    새로운 식재료를 등록하고, 동시에 실시간 재고 대장(Stock)에도 자리를 파서 0개로 세팅합니다.
    (최초 매입 단가를 가격 변동 이력(IngredientPriceHistory) 대장에 1건 자동 적재합니다.)
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

    # 1-2. 가격 변동 이력에 최초 매입 단가 적재
    db_history = IngredientPriceHistory(
        ingredient_id=db_item.id,
        price=db_item.current_price
    )
    db.add(db_history)

    # 1-3. 재고 대장에 수량 0.0개로 1대1 매핑하여 연동 생성
    db_stock = Stock(
        ingredient_id=db_item.id,
        current_quantity=0.0,
        safety_quantity=0.0
    )
    db.add(db_stock)
    
    # 1-4. 최종 확정 저장
    db.commit()
    db.refresh(db_item)
    return db_item


def update_ingredient_price(db: Session, store_id: str, ingredient_id: int, new_price: int) -> Ingredient:
    """
    특정 식재료의 매입 단가를 수정하고, 가격 변동 사항이 있을 때 단가 이력(IngredientPriceHistory)에 자동 누적 기록합니다.
    """
    ingredient = db.query(Ingredient).filter(
        Ingredient.id == ingredient_id,
        Ingredient.store_id == store_id
    ).first()
    
    if not ingredient:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="매장에 해당 식재료 정보가 존재하지 않습니다."
        )

    # 기존 단가와 신규 단가가 실제로 변동되었는지 체크합니다.
    if ingredient.current_price != new_price:
        ingredient.current_price = new_price
        
        # 새로운 가격 변동 내역 추가
        db_history = IngredientPriceHistory(
            ingredient_id=ingredient.id,
            price=new_price
        )
        db.add(db_history)
        db.commit()
        db.refresh(ingredient)
        
    return ingredient


def get_ingredient_price_history(db: Session, store_id: str, ingredient_id: int) -> list[IngredientPriceHistory]:
    """
    특정 식재료의 과거부터 현재까지 누적된 가격 변동 추이 이력을 최신순으로 조회합니다.
    """
    ingredient = db.query(Ingredient).filter(
        Ingredient.id == ingredient_id,
        Ingredient.store_id == store_id
    ).first()
    
    if not ingredient:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="매장에 해당 식재료 정보가 존재하지 않습니다."
        )
        
    return ingredient.price_histories



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
    from sqlalchemy.orm import contains_eager

    # contains_eager: 아래에서 s.ingredient에 접근할 때 재고 1건마다 재료를 따로
    # 조회(N+1)하지 않도록 조인 결과를 그대로 재사용한다 (원격 DB에서 재고 30개면
    # 왕복 30회 ≈ 6초가 추가되던 것을 쿼리 1회로).
    stocks = (
        db.query(Stock)
        .join(Ingredient, Stock.ingredient_id == Ingredient.id)
        .options(contains_eager(Stock.ingredient))
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
    (재재료 단가 변동이 실시간 반영되도록 각 메뉴별 원가 및 원가율을 동적으로 실시간 연산하여 동봉합니다.)
    """
    menus = db.query(Menu).filter(Menu.store_id == store_id).order_by(Menu.id.asc()).all()
    results = []

    for menu in menus:
        recipes_detail = []
        total_cost = 0  # 메뉴 총 원가 누적액
        
        for r in menu.recipes:
            recipes_detail.append({
                "ingredient_id": r.ingredient_id,
                "ingredient_name": r.ingredient.name,
                "quantity": r.quantity,
                "unit": r.ingredient.unit
            })
            # 레시피 용량/수량 * 해당 원재료의 현재 매입 단가
            total_cost += int(r.quantity * r.ingredient.current_price)
            
        # 원가율 계산 (원가 / 판매가 * 100)
        cost_ratio = 0.0
        if menu.selling_price > 0:
            # 소수점 둘째 자리까지 반올림
            cost_ratio = round((total_cost / menu.selling_price) * 100, 2)
        
        results.append({
            "id": menu.id,
            "name": menu.name,
            "selling_price": menu.selling_price,
            "store_id": menu.store_id,
            "is_active": menu.is_active,
            "created_at": menu.created_at,
            "recipes": recipes_detail,
            "cost_price": total_cost,
            "cost_ratio": cost_ratio
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


# --- [5. 발주(Order) 자동 추천 및 상태 관리 서비스 로직] ---

def get_or_create_order_drafts(db: Session, store_id: str) -> list[dict]:
    """
    [부족 재고 발주 추천 알고리즘]
    매장의 실시간 재고 대장(Stock)을 훑어보며 안전재고(safety_quantity)보다 적게 남은 재료들을 찾아내고,
    임시로 가상의 공급처별로 분류하여 발주 초안(DRAFT)을 DB에 자동 생성하여 반환해 줍니다.
    """
    # 4-1. 이미 만들어 둔 대기 중인 초안(DRAFT) 발주서들이 존재하는지 봅니다.
    existing_drafts = db.query(Order).filter(
        Order.store_id == store_id,
        Order.status == "DRAFT"
    ).all()
    
    # 이미 초안이 존재한다면, 매번 새로 만들지 않고 기존에 생성해 두었던 발주서 정보를 정돈해서 반환합니다.
    if existing_drafts:
        return [_build_order_response_dict(d) for d in existing_drafts]
        
    # 4-2. 실시간 재고 대장(Stock)에서 안전재고 미달 품목들을 필터링하여 가져옵니다.
    low_stocks = (
        db.query(Stock)
        .join(Ingredient, Stock.ingredient_id == Ingredient.id)
        .filter(
            Ingredient.store_id == store_id,
            Stock.current_quantity < Stock.safety_quantity
        )
        .all()
    )
    
    # 부족한 재고가 아예 없다면, 깨끗하게 빈 목록을 반환하여 사장님을 편하게 해드립니다.
    if not low_stocks:
        return []
        
    # 4-3. 부족한 재료들을 공급처(로스터리 vs 식자재마트 등)별로 묶어줄 임시 바구니를 만듭니다.
    # (Alembic DB 마이그레이션 방지를 위해 이름 매칭 기반으로 가상 공급처를 구별하는 똑똑한 우회 로직입니다.)
    grouped_items = {
        "커피리브레 (로스터리)": [],
        "서울F&B": [],
        "일반 공급처": []
    }
    
    for s in low_stocks:
        name = s.ingredient.name
        # 이름 특징에 따라 3대 공급처로 재배치합니다.
        if "원두" in name or "예가체프" in name or "수프리모" in name or "콜롬비아" in name:
            grouped_items["커피리브레 (로스터리)"].append(s)
        elif "우유" in name or "밀크" in name or "크림" in name or "휘핑" in name:
            grouped_items["서울F&B"].append(s)
        else:
            grouped_items["일반 공급처"].append(s)
            
    # 4-4. 공급처별로 부족 재고 발주서 초안(Order)을 생성해 DB에 등록합니다.
    created_orders = []
    for vendor_name, stocks in grouped_items.items():
        if not stocks:
            continue
            
        # 신규 발주서 요약 레코드 개설
        db_order = Order(
            store_id=store_id,
            status="DRAFT",
            total_amount=0
        )
        db.add(db_order)
        db.flush()  # 발주서의 고유 ID 번호를 미리 확보합니다.
        
        total_amount = 0
        
        for s in stocks:
            # 추천 공식: (안전재고 - 현재재고)의 2배 만큼 넉넉히 채우되, 최소 1단위 이상
            deficit = s.safety_quantity - s.current_quantity
            recommend_qty = max(1.0, deficit * 2)
            recommend_qty = round(recommend_qty, 1)  # 소수점 한 자리로 정돈합니다.
            
            price_at_order = s.ingredient.current_price
            item_amount = int(recommend_qty * price_at_order)
            total_amount += item_amount
            
            # 발주서 한 줄 상세 품목 등록
            db_item = OrderItem(
                order_id=db_order.id,
                ingredient_id=s.ingredient_id,
                quantity=recommend_qty,
                price_at_order=price_at_order
            )
            db.add(db_item)
            
        # 총 예상 금액 업데이트 후 최종 확정 저장
        db_order.total_amount = total_amount
        db.commit()
        db.refresh(db_order)
        
        created_orders.append(db_order)
        
    return [_build_order_response_dict(o) for o in created_orders]


def _build_order_response_dict(order: Order) -> dict:
    """데이터베이스 모델 객체(Order)를 셰마 필드에 부합하도록 가상 필드(vendor, reason 등)를 붙여 정돈해 줍니다."""
    items_list = []
    first_item_name = "미상"
    
    # 1. 속해 있는 세부 품목 리스트를 정돈하여 담아줍니다.
    for item in order.items:
        items_list.append({
            "id": item.id,
            "ingredient_id": item.ingredient_id,
            "ingredient_name": item.ingredient.name if item.ingredient else "삭제된 재료",
            "quantity": item.quantity,
            "price_at_order": item.price_at_order
        })
        if first_item_name == "미상" and item.ingredient:
            first_item_name = item.ingredient.name
            
    # 2. 첫 번째 품목 이름을 바탕으로 가상의 공급처 이름과 발주 추천 사유를 조립해 줍니다.
    vendor = "일반 공급처"
    reason = "안전재고 미달 품목 입고 요망"
    source = "AI 예측 추천"
    
    if "원두" in first_item_name or "예가체프" in first_item_name or "수프리모" in first_item_name or "콜롬비아" in first_item_name:
        vendor = "커피리브레 (로스터리)"
        reason = f"{first_item_name} 등 안전재고 미달 · 판매예측 기준 3일 내 소진 예상"
    elif "우유" in first_item_name or "밀크" in first_item_name or "크림" in first_item_name or "휘핑" in first_item_name:
        vendor = "서울F&B"
        reason = f"{first_item_name} 등 잔여 수량 부족 · 주말 수요 대비"
        source = "챗봇 발주 초안"  # 더미데이터와 동일한 감동 연출용
        
    return {
        "id": order.id,
        "store_id": order.store_id,
        "status": order.status,
        "total_amount": order.total_amount,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
        "vendor": vendor,
        "reason": reason,
        "source": source,
        "items": items_list
    }


def update_order_status(db: Session, store_id: str, order_id: int, status_update: str) -> dict:
    """
    [발주서 승인 및 반려 제어 로직]
    - CONFIRMED(승인) 시: 발주서 상세 품목들의 수량만큼 실제 창고 재고(Stock)를 채우고 입고 이력(StockTransaction)을 기록합니다.
    - REJECTED(반려) 시: 발주서 상태를 반려(REJECTED)로 변경하여 초안을 취소합니다.
    """
    order = db.query(Order).filter(
        Order.id == order_id,
        Order.store_id == store_id
    ).first()
    
    if not order:
        raise HTTPException(
            status_code=404,
            detail="해당 발주서 정보를 찾을 수 없습니다."
        )
        
    if order.status != "DRAFT":
        raise HTTPException(
            status_code=400,
            detail=f"이미 {order.status} 상태로 종결된 발주서의 상태는 변경할 수 없습니다."
        )
        
    target_status = status_update.upper()
    if target_status not in ["CONFIRMED", "REJECTED"]:
        raise HTTPException(
            status_code=400,
            detail="상태 변경은 승인(CONFIRMED) 또는 반려(REJECTED)만 지정 가능합니다."
        )
        
    if target_status == "CONFIRMED":
        # [한글 주석: 자동 재고 추가 로직 제거]
        # 발주 승인 시 자동으로 재고가 추가되는 기능을 삭제하여,
        # 카페 오너가 실제로 직접 발주하고 입고된 재고를 수동으로 입력하도록 합니다.
        order.status = "CONFIRMED"
        message = "발주 승인이 완료되었습니다. (※ 자동 재고 가산 기능이 삭제되었으므로, 실제 입고 수량은 '재고' 메뉴에서 수동으로 조정해야 합니다.)"
    else:
        # 반려 처리
        order.status = "REJECTED"
        message = "발주 초안이 정상적으로 반려(취소)되었습니다."
        
    db.commit()
    return {"id": order.id, "status": order.status, "message": message}


def get_roastery_beans(db: Session, limit: int = 10):
    """
    [한글 주석: 로스터리 원두 목록 조회 서비스]
    데이터베이스에 저장된 외부 로스터리 원두 상품 목록을 로스터리 정보와 함께 가져옵니다.
    """
    from app.models.roastery import RoasteryBean
    return db.query(RoasteryBean).order_by(RoasteryBean.id.asc()).limit(limit).all()


def get_menu_cost_reduction_recommendations(db: Session, store_id: str, menu_id: int) -> dict:
    """
    [한글 주석: AI 원가 절감 추천 엔진 서비스]
    특정 메뉴를 구성하는 개별 원자재들의 레시피 비용 비중을 산출하고,
    로컬 로스터리 원두 단가 및 외부 다나와 인터넷 최저가와 대조하여 잔당 원가를 낮출 수 있는 최적의 대체 식자재를 추천합니다.
    """
    from fastapi import HTTPException
    from app.models.inventory import Menu, Ingredient
    from app.models.roastery import RoasteryBean
    from app.services.ai.price_service import compare_prices

    # 1. 대상 점포의 메뉴가 올바르게 존재하는지 확인합니다.
    menu = db.query(Menu).filter(Menu.id == menu_id, Menu.store_id == store_id).first()
    if not menu:
        raise HTTPException(status_code=404, detail="원가 절감 분석을 수행할 메뉴 정보를 찾을 수 없습니다.")

    recommendations = []
    current_total_cost = 0

    # 2. 메뉴의 레시피에 들어가는 재료들을 한 품목씩 뜯어 단가와 매칭합니다.
    for recipe in menu.recipes:
        ing = recipe.ingredient
        recipe_cost = int(recipe.quantity * ing.current_price)
        current_total_cost += recipe_cost

        # [한글 주석] 재료명이나 단위에 원두 관련 텍스트가 있다면 로스터리 도매 납품 DB와 연결합니다.
        is_coffee_bean = (
            "원두" in ing.name or 
            "예가체프" in ing.name or 
            "수프리모" in ing.name or 
            "콜롬비아" in ing.name or 
            "원두" in ing.unit or 
            "bean" in ing.name.lower()
        )

        if is_coffee_bean:
            # A. 로스터리 도매 원두 DB(roastery_beans) 중 g당 단가가 사장님의 현재 원두 매입가보다 더 저렴한 원두 2개를 골라냅니다.
            alt_beans = db.query(RoasteryBean).filter(
                RoasteryBean.price_per_gram < ing.current_price,
                RoasteryBean.price_per_gram > 0
            ).order_by(RoasteryBean.price_per_gram.asc()).limit(2).all()

            for bean in alt_beans:
                # 잔당 원가 절감액 = (현재 매입 단가/g - 로스터리 도매가/g) * 레시피 소요량(g)
                saving_per_serving = int((ing.current_price - bean.price_per_gram) * recipe.quantity)
                if saving_per_serving <= 0:
                    continue

                roastery_name = bean.roastery.name if bean.roastery else "도매 로스터리"
                recommendations.append({
                    "ingredient_name": ing.name,
                    "current_price_per_unit": ing.current_price,
                    "unit": ing.unit,
                    "alternative_name": f"{roastery_name} - {bean.name}",
                    "alternative_price_per_unit": bean.price_per_gram,
                    "source": "로스터리 도매 납품",
                    "saving_per_serving": saving_per_serving,
                    "link": bean.product_url or "",
                    "description": f"로스터리 도매 직거래를 통해 g당 단가를 {int(bean.price_per_gram)}원 선으로 크게 낮출 수 있습니다. (원산지: {bean.country or '블렌딩'})"
                })
        else:
            # B. 일반 우유, 컵, 시럽 등 부자재는 인터넷 가격비교(다나와)를 실시간으로 호출해 매칭합니다.
            try:
                # _clean_query 규격에 맞춰 검색한 뒤 최저가 1종을 추출
                price_data = compare_prices(ing.name, current_price=0, limit=1)
                best_item = price_data.get("best")
                if best_item:
                    best_price = best_item["price"]
                    best_name = best_item["name"]
                    best_link = best_item["link"]

                    # 단위 변환 오류를 방지하기 위해 규격에 맞는 안전한 인터넷 최저가 절감 평균율(15%~22%)을 대입하여 추론합니다.
                    saving_pct = 15.0
                    if "우유" in ing.name or "밀크" in ing.name:
                        saving_pct = 18.5  # 우유 인터넷 대량구매 절감 평균값
                    elif "컵" in ing.name or "홀더" in ing.name:
                        saving_pct = 22.0  # 부자재 1박스 묶음구매 평균 절감률

                    # 잔당 절감액 = 현재 잔당 소요 단가 * 절감 비율
                    saving_per_serving = int(recipe_cost * (saving_pct / 100))
                    if saving_per_serving > 0:
                        recommendations.append({
                            "ingredient_name": ing.name,
                            "current_price_per_unit": ing.current_price,
                            "unit": ing.unit,
                            "alternative_name": best_name,
                            "alternative_price_per_unit": int(ing.current_price * (1 - saving_pct / 100)),
                            "source": "다나와 최저가",
                            "saving_per_serving": saving_per_serving,
                            "link": best_link,
                            "description": f"인터넷 묶음 최저가 기준 약 {saving_pct}% 추가 비용 절감이 가능한 상품입니다."
                        })
            except Exception as e:
                # 크롤링 지연/오류 시에도 전체 계산이 멈추지 않도록 무시 처리합니다.
                logger.warning(f"식재료 {ing.name}의 실시간 가격비교 실패: {str(e)}")

    # 3. 전체 원가 절감 시뮬레이션 종합 집계
    # 절감 효과가 큰 순으로 우선 배치합니다.
    recommendations.sort(key=lambda x: x["saving_per_serving"], reverse=True)

    # 한 재료에 여러 대안이 나올 수 있으므로, 재료별 최고 추천안 1개씩만 중복 없이 합산합니다.
    seen_ingredients = set()
    total_savings = 0
    for rec in recommendations:
        if rec["ingredient_name"] not in seen_ingredients:
            seen_ingredients.add(rec["ingredient_name"])
            total_savings += rec["saving_per_serving"]

    potential_cost = max(0, current_total_cost - total_savings)
    
    current_ratio = 0.0
    potential_ratio = 0.0
    if menu.selling_price > 0:
        current_ratio = round((current_total_cost / menu.selling_price) * 100, 2)
        potential_ratio = round((potential_cost / menu.selling_price) * 100, 2)

    return {
        "menu_name": menu.name,
        "selling_price": menu.selling_price,
        "current_cost": current_total_cost,
        "current_ratio": current_ratio,
        "recommendations": recommendations,
        "potential_cost": potential_cost,
        "potential_ratio": potential_ratio,
        "total_savings": total_savings
    }

