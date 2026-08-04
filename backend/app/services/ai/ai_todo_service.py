"""브루의 오늘 할 일 제안 (백엔드 B) — 홈 투두에 들어갈 짧은 행동 문구를 만든다.

투두 한 줄은 **훑어보는 것**이라 문장이 아니라 라벨이어야 한다. 그래서 제목은
"에티오피아 원두 발주"처럼 `<재료명> 발주` 명사형으로 짧게 고정하고, 숫자 근거는
아래 회색 보조줄(subtitle)로 뺀다 — "다 떨어짐 · 최소 5kg 필요".
'안전재고' 같은 용어는 쓰지 않는다 — 사장님이 바로 읽히는 말로만.
(예전엔 "에티오피아 원두가 0kg 남았어요 / 오늘 발주하세요"처럼 두 줄 문장이었다.)

문구가 이렇게 정형화되면 LLM을 부를 이유가 없다 — 표현이 매번 달라져 들쭉날쭉해지고
Gemini 무료 쿼터만 쓴다. 그래서 재고 투두는 데이터에서 바로 만든다(engine="rule").

여기에 매출 데이터가 있으면 **홍보 투두**(kind=promo)를 하나 붙인다 — 앱에서
'홍보할 메뉴 고르기'를 누르면 홍보 스튜디오에 메뉴가 자동 입력된다.

- id_hint는 안정적으로 유지한다(stock-<재료id>, promo-main) — 프론트가 이 id로
  숨김(X)·완료 체크를 기기에 기록하므로, 매일 id가 바뀌면 숨겨도 계속 되살아난다.
- 하루 캐시(매장별): 같은 날 반복 호출에 DB를 다시 훑지 않는다.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

logger = logging.getLogger(__name__)

_TTL = 24 * 3600
# 키에 붙은 v2는 문구 형식 버전 — 형식을 바꾸면 올려서 그날 캐시를 무효화한다
_cache: dict[str, tuple[float, str, dict[str, Any]]] = {}  # store:v2 → (ts, day, result)

# 홍보 투두는 메뉴를 고르지 않는다 — 고정 문구로 항상 노출하고,
# 어떤 메뉴를 홍보할지는 앱의 '홍보할 메뉴 고르기'에서 사장님이 직접 고른다.
# id를 날마다 같게(promo-main) 유지해야 X로 숨긴 기록이 계속 존중된다.
_PROMO_TODO = {
    "id_hint": "promo-main",
    "title": "주 메뉴 홍보하기",
    "subtitle": "메뉴를 고르면 문구·이미지를 만들어 드려요",
    "kind": "promo",
    "menu": None,
}


def _num(v: float) -> str:
    """0.0 → "0", 2.50 → "2.5" — 투두 한 줄에 소수점 꼬리가 남지 않게."""
    return f"{v:g}"


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


def _stock_todos(stocks: list[dict]) -> list[dict[str, Any]]:
    """부족 재고 → 짧은 라벨 투두.

    제목은 `<재료명> 발주` 한 덩어리로만 둔다 (앱에서 굵은 글씨 한 줄).
    남은 양·필요량은 아래 보조줄로 뺀다 — 제목만 훑어도 무엇을 할지 보이게.

    문구는 쉬운 말로만 쓴다: '안전재고'·'재고 소진' 같은 용어 대신
    "다 떨어짐 · 최소 5kg 필요"처럼 바로 읽히는 말.
    """
    todos: list[dict[str, Any]] = []
    for s in stocks:
        unit = s["unit"] or ""
        soldout = s["current"] <= 0
        todos.append({
            "id_hint": f"stock-{s['id']}",
            "title": f"{s['name']} 발주",
            "subtitle": (f"다 떨어짐 · 최소 {_num(s['safety'])}{unit} 필요" if soldout
                         else f"{_num(s['current'])}{unit} 남음 · 최소 {_num(s['safety'])}{unit} 필요"),
            "kind": "stock",
            "urgent": soldout,   # 앱에서 '소진' 배지로 강조
            "menu": None,
        })
    return todos


# 인사이트에서 만들 투두 상한 — 홈 화면은 훑는 곳이라 다 쏟으면 아무것도 안 읽힌다
MAX_INSIGHT_TODOS = 4


def _first_clause(body: str, limit: int = 42) -> str:
    """근거 문장에서 보조줄로 쓸 첫 조각만 — 투두 아래 회색 한 줄에 들어갈 길이로."""
    text = " ".join((body or "").split())
    for sep in (". ", "니다. ", "요. "):
        idx = text.find(sep)
        if 0 < idx <= limit:
            return text[: idx + len(sep) - 1].strip()
    return text[:limit].rstrip() + ("…" if len(text) > limit else "")


def _insight_todos(store_id: str, stock_ids: set[str]) -> list[dict[str, Any]]:
    """선제 인사이트(모든 기능의 발동 조건) → 홈 할 일.

    insight_service가 정산·단골·발주·홍보·POS·센서·메뉴 원가·수요 전망까지 전부 검사하므로,
    여기서는 그중 '지금/이번 주에 손을 대야 하는 것'만 짧은 라벨로 바꿔 얹는다.

    - todo가 빈 문자열인 인사이트는 알림으로만 쓰는 것이라 투두로 만들지 않는다
      (예: 오늘 입금 예정액 — 알아두면 좋지만 할 일은 아니다).
    - id는 인사이트 key 그대로라 상황이 그대로면 매일 같은 id다 → 숨김·완료 기록이 유지되고,
      상황이 해소되면 인사이트가 사라지면서 투두도 함께 사라진다.
    """
    from app.services.ai import insight_service

    scan = insight_service.scan(store_id)
    todos: list[dict[str, Any]] = []
    seen_categories: set[str] = set()
    for ins in scan.get("insights", []):
        if ins.get("severity") == "low":
            continue
        # 영역마다 하나씩만 — 재고 인사이트가 많은 날에 네 칸을 전부 '발주'로 채우면
        # 정작 오늘 확인해야 할 서류·정산·단골이 밀려난다 (심각한 것부터 정렬돼 있다)
        if ins.get("category") in seen_categories:
            continue
        label = ins.get("todo")
        if label == "":
            continue  # 알림 전용
        label = (label or str(ins.get("title", ""))).strip()
        if not label:
            continue
        # 재고 투두(안전재고 기준)와 소진 예측이 같은 재료를 두 줄로 만들지 않게
        if ins["key"].startswith("stock_runout:"):
            ing_id = ins["key"].split(":")[1]
            if f"stock-{ing_id}" in stock_ids:
                continue
        todos.append({
            "id_hint": f"insight-{ins['key']}"[:120],
            "title": label[:40],
            "subtitle": _first_clause(ins.get("body", "")),
            "kind": "insight",
            "urgent": ins.get("severity") == "high",
            "menu": None,
            # 앱이 '어느 영역 이야기인지' 배지·아이콘을 붙일 수 있게 (없으면 무시된다)
            "category": ins.get("category"),
        })
        seen_categories.add(ins.get("category"))
        if len(todos) >= MAX_INSIGHT_TODOS:
            break
    return todos


def suggest_todos(store_id: str) -> dict[str, Any]:
    """오늘의 브루 추천 투두. 반환: {engine, todos:[{id_hint,title,subtitle,kind,urgent,menu}]}

    ① 부족 재고 발주  ② 선제 인사이트(정산·단골·발주서·POS·메뉴 원가·수요 전망…)
    ③ 홍보 — 이 셋이 홈 '오늘 할 일' 한 곳에 모인다.
    """
    today = date.today().isoformat()
    key = f"{store_id}:v3"   # v3 = 인사이트 기반 항목 추가. 형식을 바꾸면 올려서 캐시를 버린다
    hit = _cache.get(key)
    if hit and hit[1] == today and time.time() - hit[0] < _TTL:
        return {**hit[2], "cached": True}

    stocks, menus = _gather(store_id)
    todos = _stock_todos(stocks)

    # 인사이트는 재고·메뉴가 비어 있어도 나올 수 있다 (서류·세무·정산·POS…)
    try:
        todos += _insight_todos(store_id, {t["id_hint"] for t in todos})
    except Exception:
        logger.exception("AI 투두: 인사이트 수집 실패 — 재고·홍보 항목만 내보낸다")

    # 홍보 투두 — 등록된 메뉴가 있으면 항상 붙는 고정 항목 (메뉴 선택은 앱에서)
    if menus:
        todos.append(dict(_PROMO_TODO))

    result = {"engine": "rule" if todos else "none", "todos": todos}
    _cache[key] = (time.time(), today, result)
    return result
