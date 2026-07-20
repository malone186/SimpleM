"""판매 수동 입력 (백엔드 B)

POS 자동 동기화(operation의 /pos/sync)와 별개로, 사장님이 '판매 입력' 화면에서
직접 등록하는 판매를 Sale 테이블에 기록하고 레시피 기준으로 재고를 자동 차감한다.
대시보드·경영 리포트·판매 예측이 모두 같은 Sale 테이블을 읽으므로,
여기로 입력한 판매는 즉시 모든 화면 집계에 반영된다.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

KST = timezone(timedelta(hours=9))


class SalesError(ValueError):
    """판매 기록 불가 (없는 메뉴·잘못된 수량)"""


def record_sales(store_id: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """판매 등록 — items: [{"menu_id": int, "quantity": int}]

    Sale 생성 + 메뉴 레시피 소요량만큼 재고 차감 + 재고 변동 이력(StockTransaction) 기록.
    """
    from app.models.inventory import Menu, Recipe, Sale, Stock, StockTransaction
    from app.services.ai.document_service import _session

    if not items:
        raise SalesError("판매 항목이 비어 있습니다.")

    created: list[dict[str, Any]] = []
    with _session() as db:
        for it in items:
            menu = db.get(Menu, int(it["menu_id"]))
            if menu is None or menu.store_id != store_id:
                raise SalesError(f"메뉴(id={it.get('menu_id')})를 찾을 수 없습니다.")
            qty = int(it.get("quantity", 1))
            if qty <= 0:
                raise SalesError("판매 수량은 1 이상이어야 합니다.")

            total = menu.selling_price * qty
            db.add(Sale(menu_id=menu.id, quantity=qty, total_price=total,
                        store_id=store_id, sold_at=datetime.now(KST)))

            # 레시피 기준 재고 자동 차감 + 이력 기록 (재고 미등록 재료는 이력만 남긴다)
            for recipe in db.query(Recipe).filter(Recipe.menu_id == menu.id).all():
                use = recipe.quantity * qty
                stock = db.query(Stock).filter(Stock.ingredient_id == recipe.ingredient_id).first()
                if stock is not None:
                    stock.current_quantity = max(0.0, stock.current_quantity - use)
                db.add(StockTransaction(ingredient_id=recipe.ingredient_id,
                                        quantity_change=-use, type="OUT",
                                        description=f"{menu.name} 판매 차감 (수동 입력)"))

            created.append({"menu_id": menu.id, "name": menu.name,
                            "quantity": qty, "total_price": total})
        db.commit()

    return {
        "created": created,
        "count": sum(c["quantity"] for c in created),
        "total": sum(c["total_price"] for c in created),
    }


def recent_sales(store_id: str, limit: int = 10) -> list[dict[str, Any]]:
    """최근 판매 내역 (판매 입력 화면 '최근 판매' 표시용)."""
    from app.models.inventory import Menu, Sale
    from app.services.ai.document_service import _session

    limit = max(1, min(int(limit), 50))
    with _session() as db:
        rows = (
            db.query(Sale, Menu.name)
            .join(Menu, Sale.menu_id == Menu.id)
            .filter(Sale.store_id == store_id)
            .order_by(Sale.sold_at.desc(), Sale.id.desc())
            .limit(limit)
            .all()
        )
        return [{
            "id": sale.id,
            "name": name,
            "quantity": sale.quantity,
            "total_price": sale.total_price,
            "sold_at": str(sale.sold_at),
        } for sale, name in rows]
