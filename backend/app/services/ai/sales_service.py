"""판매 수동 입력 (백엔드 B)

POS 자동 동기화(operation의 /pos/sync)와 별개로, 사장님이 '매출 입력' 화면에서
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


def menu_contribution(store_id: str, days: int = 30) -> dict[str, Any]:
    """메뉴별 '실제로 번 돈' — 잔당 마진 × 실제 판매 잔 수.

    원가율(%)만 보면 아메리카노(원가율은 낮지만 단가도 낮음)와 프리미엄 음료 중
    무엇이 매장을 먹여 살리는지 알 수 없다. 사장님이 실제로 알고 싶은 건
    "이 메뉴로 이번 달에 얼마 남았나"이므로 판매량을 곱한 기여이익을 함께 준다.

    원가는 레시피 × 재료 현재 단가로 계산한다 (재료가 등록 안 된 메뉴는 원가 0 →
    마진이 과대평가되므로 recipe_missing 플래그로 표시해 화면에서 걸러낼 수 있게 한다).
    """
    from sqlalchemy import func as sa_func

    from app.models.inventory import Ingredient, Menu, Recipe, Sale
    from app.services.ai.document_service import _session

    days = max(1, min(int(days), 365))
    since = datetime.now(KST) - timedelta(days=days)

    with _session() as db:
        menus = db.query(Menu).filter(Menu.store_id == store_id).all()
        if not menus:
            return {"days": days, "menus": [], "total_margin": 0, "total_revenue": 0}

        # 메뉴별 원가 — 레시피 조인 1번으로 전부 (메뉴 수만큼 쿼리하면 N+1)
        recipe_rows = (
            db.query(Recipe.menu_id, Recipe.quantity, Ingredient.current_price)
            .join(Ingredient, Recipe.ingredient_id == Ingredient.id)
            .filter(Recipe.menu_id.in_([m.id for m in menus]))
            .all()
        )
        cost_by_menu: dict[int, float] = {}
        for menu_id, qty, unit_price in recipe_rows:
            cost_by_menu[menu_id] = cost_by_menu.get(menu_id, 0.0) + float(qty) * float(unit_price or 0)

        sold_rows = (
            db.query(Sale.menu_id,
                     sa_func.sum(Sale.quantity),
                     sa_func.sum(Sale.total_price))
            .filter(Sale.store_id == store_id, Sale.sold_at >= since)
            .group_by(Sale.menu_id)
            .all()
        )
        sold_by_menu = {mid: (int(q or 0), int(rev or 0)) for mid, q, rev in sold_rows}

    rows: list[dict[str, Any]] = []
    for m in menus:
        cost = round(cost_by_menu.get(m.id, 0.0))
        qty, revenue = sold_by_menu.get(m.id, (0, 0))
        margin_per_cup = m.selling_price - cost
        rows.append({
            "menu_id": m.id,
            "name": m.name,
            "selling_price": m.selling_price,
            "cost_price": cost,
            "cost_ratio": round(cost / m.selling_price * 100, 1) if m.selling_price else None,
            "margin_per_cup": margin_per_cup,
            "sold_qty": qty,
            "revenue": revenue,
            "total_margin": margin_per_cup * qty,
            "recipe_missing": m.id not in cost_by_menu,
        })

    rows.sort(key=lambda r: -r["total_margin"])
    total_margin = sum(r["total_margin"] for r in rows)
    for r in rows:
        r["margin_share"] = round(r["total_margin"] / total_margin * 100, 1) if total_margin > 0 else 0.0
    return {
        "days": days,
        "menus": rows,
        "total_margin": total_margin,
        "total_revenue": sum(r["revenue"] for r in rows),
        "total_qty": sum(r["sold_qty"] for r in rows),
    }


def recent_sales(store_id: str, limit: int = 10) -> list[dict[str, Any]]:
    """최근 판매 내역 (매출 입력 화면 '최근 판매' 표시용)."""
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
