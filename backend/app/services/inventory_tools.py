"""재고 챗봇 도구 래퍼 (백엔드 A)

챗봇 연동을 위해 inventory_service의 로직을 @tool로 감싼다 — 이 파일에 로직을 두지 않는다.
삭제 도구는 사용자가 명확히 요청한 경우에만 에이전트가 호출하도록 설명에 명시한다.
"""

import json

from langchain_core.tools import tool


def _db():
    from app.core.database import SessionLocal

    return SessionLocal()


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_stock_status(store_id: str) -> str:
    """내 매장의 재고 현황을 조회한다 — 재료별 현재 수량, 단위, 단가, 안전재고."""
    from app.services import inventory_service

    with _db() as db:
        stocks = inventory_service.get_stocks(db, store_id)
    if not stocks:
        return "등록된 재고가 없습니다. 영수증 촬영 입고나 재료 등록으로 시작할 수 있습니다."
    return _dump(stocks)


@tool
def register_ingredient(store_id: str, name: str, unit: str = "개",
                        unit_price: int = 0, initial_quantity: float = 0) -> str:
    """새 재료를 등록한다 (초기 수량이 있으면 바로 입고까지).
    같은 이름의 재료가 이미 있으면 중복 생성하지 않고 기존 재고에 수량만 추가한다."""
    from app.models.inventory import Ingredient
    from app.schemas.inventory import IngredientCreate, StockAdjust
    from app.services import inventory_service

    with _db() as db:
        existing = (db.query(Ingredient)
                    .filter(Ingredient.store_id == store_id, Ingredient.name == name).first())
        if existing:
            if initial_quantity > 0:
                inventory_service.add_or_adjust_stock(db, store_id, StockAdjust(
                    ingredient_id=existing.id, quantity_change=initial_quantity,
                    description="챗봇 추가 입고"))
                return f"'{name}'은(는) 이미 등록된 재료라 기존 재고에 {initial_quantity}{existing.unit} 추가 입고했습니다."
            return f"'{name}'은(는) 이미 등록된 재료입니다. 수량을 추가하려면 initial_quantity를 지정하세요."
        ing = inventory_service.create_ingredient(db, store_id, IngredientCreate(
            name=name, unit=unit, current_price=unit_price))
        if initial_quantity > 0:
            inventory_service.add_or_adjust_stock(db, store_id, StockAdjust(
                ingredient_id=ing.id, quantity_change=initial_quantity,
                description="챗봇 등록 초기 수량"))
        return f"'{name}' 재료를 등록했습니다 (단위 {unit}, 단가 {unit_price:,}원, 초기 수량 {initial_quantity})."


@tool
def adjust_stock_quantity(store_id: str, ingredient_name: str,
                          quantity_change: float, reason: str = "챗봇 재고 조정") -> str:
    """재료의 재고 수량을 조정한다. 입고는 양수, 차감·폐기는 음수. 변동 이력 장부에 기록된다."""
    from app.models.inventory import Ingredient
    from app.schemas.inventory import StockAdjust
    from app.services import inventory_service

    with _db() as db:
        ing = (db.query(Ingredient)
               .filter(Ingredient.store_id == store_id, Ingredient.name == ingredient_name).first())
        if ing is None:
            return f"'{ingredient_name}' 재료를 찾을 수 없습니다. get_stock_status로 정확한 이름을 확인하세요."
        try:
            stock = inventory_service.add_or_adjust_stock(db, store_id, StockAdjust(
                ingredient_id=ing.id, quantity_change=quantity_change, description=reason))
        except Exception as e:
            return f"재고 조정 실패: {e}"
        sign = "+" if quantity_change > 0 else ""
        return f"'{ingredient_name}' {sign}{quantity_change}{ing.unit} 반영 완료 — 현재 재고 {stock.current_quantity}{ing.unit}."


@tool
def delete_ingredient_by_name(store_id: str, ingredient_name: str) -> str:
    """재료를 삭제한다. 연결된 재고·입출고 이력·레시피도 함께 삭제되며 되돌릴 수 없다.
    사용자가 명확하게 삭제를 요청한 경우에만 호출할 것."""
    from app.models.inventory import Ingredient
    from app.services import inventory_service

    with _db() as db:
        ing = (db.query(Ingredient)
               .filter(Ingredient.store_id == store_id, Ingredient.name == ingredient_name).first())
        if ing is None:
            return f"'{ingredient_name}' 재료를 찾을 수 없습니다. get_stock_status로 정확한 이름을 확인하세요."
        try:
            inventory_service.delete_ingredient(db, store_id, ing.id)
        except Exception as e:
            return f"삭제 실패: {e}"
        return f"'{ingredient_name}' 재료를 삭제했습니다 (재고·입출고 이력·레시피 연결도 함께 정리됨)."


@tool
def get_menus_with_recipes(store_id: str) -> str:
    """메뉴판과 각 메뉴의 레시피(어떤 재료가 얼마나 들어가는지)를 조회한다."""
    from app.services import inventory_service

    with _db() as db:
        menus = inventory_service.get_menus_with_recipes(db, store_id)
    return _dump(menus) if menus else "등록된 메뉴가 없습니다."


TOOLS = [
    adjust_stock_quantity,
    delete_ingredient_by_name,
    get_menus_with_recipes,
    get_stock_status,
    register_ingredient,
]
