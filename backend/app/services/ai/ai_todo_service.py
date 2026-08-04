"""브루의 오늘 할 일 제안 (백엔드 B) — LLM이 실행형 문장으로 투두를 만들어 준다.

기존 홈 투두의 '재고 부족' 같은 상태 나열 대신, "원두가 2kg 남았어요 — 오늘 발주하세요"
처럼 **무엇을 해야 하는지**가 담긴 문장을 만든다. 여기에 매출 데이터를 보고
**홍보할 메뉴 1개**를 골라 "딸기라떼를 홍보해 보세요" 투두(kind=promo)를 추가한다 —
앱에서 이 항목의 '홍보하러 가기'를 누르면 홍보 스튜디오에 메뉴가 자동 입력된다.

- id_hint는 안정적으로 유지한다(stock-<재료id>, promo-<메뉴명>) — 프론트가 이 id로
  숨김(X)·완료 체크를 기기에 기록하므로, 매일 id가 바뀌면 숨겨도 계속 되살아난다.
- 하루 캐시(매장별): 같은 날 반복 호출에 LLM을 다시 부르지 않는다.
- 키가 없거나 실패하면 규칙 기반 문장으로 폴백 — 기능은 항상 동작한다.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

logger = logging.getLogger(__name__)

_TTL = 24 * 3600
_cache: dict[str, tuple[float, str, dict[str, Any]]] = {}  # store → (ts, day, result)

_SCHEMA = {
    "type": "object",
    "properties": {
        "todos": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id_hint": {"type": "string"},
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "kind": {"type": "string"},   # stock | promo
                    "menu": {"type": "string", "nullable": True},
                },
                "required": ["id_hint", "title", "subtitle", "kind"],
            },
        },
    },
    "required": ["todos"],
}

_PROMPT = """너는 카페 사장님의 하루를 챙기는 매니저 '브루'다. 아래 매장 데이터로 오늘의 할 일을 만든다.

[부족 재고] (id는 그대로 id_hint="stock-<id>"로 돌려줄 것)
{stocks}

[메뉴별 최근 14일 판매] (판매가·판매잔수)
{menus}

규칙:
1) 부족 재고마다 투두 1개 (kind="stock", id_hint="stock-<id>").
   - title: '상태 나열'이 아니라 '해야 할 일'로. 예: "원두가 2kg 남았어요 — 오늘 발주하세요"
     (18~28자, 사장님에게 말 걸듯 자연스럽게. 재료명·남은 양 포함)
   - subtitle: 근거 한 줄 (예: "안전재고 5kg 기준 · 이틀 안에 소진 예상")
2) 과장·없는 데이터 금지. 재고가 없으면 stock 투두는 만들지 않는다. JSON만 반환."""

# 홍보 투두는 LLM이 메뉴를 고르지 않는다 — 고정 문구로 항상 노출하고,
# 어떤 메뉴를 홍보할지는 앱의 '홍보할 메뉴 고르기'에서 사장님이 직접 고른다.
# id를 날마다 같게(promo-main) 유지해야 X로 숨긴 기록이 계속 존중된다.
_PROMO_TODO = {
    "id_hint": "promo-main",
    "title": "우리 카페의 주 메뉴를 홍보하세요",
    "subtitle": "홍보할 메뉴를 고르면 문구·이미지를 만들어 드려요",
    "kind": "promo",
    "menu": None,
}


def _gather(store_id: str) -> tuple[list[dict], list[dict]]:
    """부족 재고 + 메뉴별 최근 14일 판매를 모은다 (전부 best-effort)."""
    stocks: list[dict] = []
    menus: list[dict] = []
    try:
        from app.models.inventory import Ingredient, Stock
        from app.services.ai.document_service import _session

        with _session() as db:
            rows = (db.query(Stock, Ingredient.name, Ingredient.unit, Ingredient.id)
                    .join(Ingredient, Stock.ingredient_id == Ingredient.id)
                    .filter(Ingredient.store_id == store_id).all())
            for stock, name, unit, ing_id in rows:
                threshold = float(stock.safety_quantity or 0) or 3.0
                cur = float(stock.current_quantity or 0)
                if cur <= threshold:
                    stocks.append({"id": ing_id, "name": name, "unit": unit,
                                   "current": cur, "safety": threshold})
            stocks.sort(key=lambda s: s["current"] / (s["safety"] or 1))
            stocks = stocks[:4]  # 홈 투두와 같은 상한
    except Exception:
        logger.debug("AI 투두: 재고 수집 실패", exc_info=True)

    try:
        from sqlalchemy import func as sa_func

        from app.models.inventory import Menu, Sale
        from app.services.ai.document_service import _session

        since = datetime.now() - timedelta(days=14)
        with _session() as db:
            sold = dict(
                db.query(Sale.menu_id, sa_func.sum(Sale.quantity))
                .filter(Sale.store_id == store_id, Sale.sold_at >= since)
                .group_by(Sale.menu_id).all())
            for m in (db.query(Menu)
                      .filter(Menu.store_id == store_id, Menu.selling_price > 0)
                      .limit(25).all()):
                menus.append({"name": m.name, "price": m.selling_price,
                              "sold_14d": int(sold.get(m.id, 0) or 0)})
    except Exception:
        logger.debug("AI 투두: 메뉴 판매 수집 실패", exc_info=True)
    return stocks, menus


def _fallback(stocks: list[dict], menus: list[dict]) -> list[dict[str, Any]]:
    """LLM 없이도 '실행형 문장'을 만든다 — 규칙 기반이지만 상태 나열보다는 낫게."""
    todos: list[dict[str, Any]] = []
    for s in stocks:
        qty = f"{s['current']:g}{s['unit']}"
        soldout = s["current"] <= 0
        todos.append({
            "id_hint": f"stock-{s['id']}",
            "title": (f"{s['name']}이(가) 다 떨어졌어요 — 바로 채워주세요" if soldout
                      else f"{s['name']}이(가) {qty} 남았어요 — 오늘 채워주세요"),
            "subtitle": f"안전재고 {s['safety']:g}{s['unit']} 기준",
            "kind": "stock", "menu": None,
        })
    return todos


def suggest_todos(store_id: str) -> dict[str, Any]:
    """오늘의 브루 추천 투두. 반환: {engine, todos:[{id_hint,title,subtitle,kind,menu}]}"""
    today = date.today().isoformat()
    hit = _cache.get(store_id)
    if hit and hit[1] == today and time.time() - hit[0] < _TTL:
        return {**hit[2], "cached": True}

    stocks, menus = _gather(store_id)
    if not stocks and not menus:
        result = {"engine": "none", "todos": []}
        _cache[store_id] = (time.time(), today, result)
        return result

    stocks_txt = "\n".join(
        f"- id={s['id']} {s['name']}: 잔여 {s['current']:g}{s['unit']} / 안전재고 {s['safety']:g}{s['unit']}"
        for s in stocks) or "(없음)"
    menus_txt = "\n".join(
        f"- {m['name']}: {m['price']:,}원, 최근 14일 {m['sold_14d']}잔" for m in menus) or "(없음)"

    from app.services.ai.nearby_cafe_service import _gemini_json

    # 부족 재고가 없으면 LLM을 부를 필요가 없다 — 홍보 고정 항목만 나간다
    raw = _gemini_json(_PROMPT.format(stocks=stocks_txt, menus=menus_txt),
                       _SCHEMA, timeout=25.0) if stocks else None

    engine = "ai"
    todos: list[dict[str, Any]] = []
    if raw and isinstance(raw.get("todos"), list):
        valid_stock_ids = {f"stock-{s['id']}" for s in stocks}
        for t in raw["todos"]:
            if t.get("kind") == "stock" and t.get("id_hint") in valid_stock_ids:
                todos.append({"id_hint": t["id_hint"], "title": str(t.get("title", ""))[:60],
                              "subtitle": str(t.get("subtitle", ""))[:80],
                              "kind": "stock", "menu": None})
    if not todos and stocks:
        engine = "heuristic"
        todos = _fallback(stocks, menus)

    # 홍보 투두 — 등록된 메뉴가 있으면 항상 붙는 고정 항목 (메뉴 선택은 앱에서)
    if menus:
        todos.append(dict(_PROMO_TODO))

    result = {"engine": engine, "todos": todos}
    _cache[store_id] = (time.time(), today, result)
    return result
