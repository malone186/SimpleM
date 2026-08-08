"""메뉴 개선 (백엔드 B) — AI가 바꿀 곳을 찾아 주고, 바꾸면 어떻게 되는지 계산한다

[왜 만들었나]
사장님은 메뉴를 자주 손본다. 그런데 무엇을 손봐야 하는지는 아무도 말해 주지 않고,
바꾼 게 잘한 일인지 아는 데는 두 달이 걸린다(다음 달 정산을 봐야 한다).
이미 등록된 판매 기록과 원가가 있으니, 둘 다 지금 할 수 있다.

[두 가지 일]
1. 추천(recommend): 지금 매장 숫자를 훑어 "이 메뉴는 팔수록 손해라 얼마로 올리세요",
   "30일간 한 잔도 안 나갔으니 빼세요", "이런 신메뉴는 어떠세요"를 먼저 찾아 준다.
2. 점검(review): 사장님이 이미 정한 안("아메리카노 4500, 바닐라라떼 빼고")을 채점한다.
   추천도 결국 이 채점기를 통과하므로, 두 경로의 숫자가 서로 어긋날 수 없다.

[무엇을 답하나]
가격을 올릴 때 진짜 궁금한 건 "얼마 더 버나"가 아니라 "손님이 얼마나 떨어져도 괜찮나"다.
그래서 이 파일의 중심 숫자는 '버틸 수 있는 판매 감소폭'이다.
    아메리카노 4,000원(원가 900) → 4,500원
    잔당 남는 돈 3,100원 → 3,600원. 판매량이 13.9%까지 줄어도 본전이다.
이 숫자는 가정이 아니라 산수라서 틀릴 수가 없다. 반대로 "손님이 X% 빠질 것"은 아무도 모르므로
이 파일은 그걸 지어내지 않는다.

[원칙]
- 저장하지 않는다. 추천도 점검도 계산일 뿐, 반영은 사장님이 apply_changes를 부를 때만.
- 원가(레시피)가 없는 메뉴는 마진을 계산하지 않는다. 0원으로 잡으면 이익이 부풀려져
  "올려도 남는다"는 틀린 결론이 나온다 — 모른다고 말하는 편이 낫다.
- 판매량은 최근 실적 그대로라고 가정한다. 이 가정은 결과에 항상 함께 실어 보낸다.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 원가율 경고선 — insight_service의 COST_RATIO_WARN(40%)과 같은 기준을 쓴다.
# 여기서 다시 정의하지 않고 가져다 쓴다 (두 화면이 다른 말을 하면 사장님이 혼란스럽다).
COST_RATIO_WARN = 40.0
COST_RATIO_DANGER = 50.0

# 한 번에 인상하면 손님이 체감하는 폭. 통계가 아니라 '이쯤이면 한 번 더 보시라'는 선이다.
# 4,000 → 4,500(12.5%)처럼 흔한 인상까지 경고하면 경고가 배경음이 되어 아무도 안 본다.
PRICE_UP_WATCH = 15.0
PRICE_UP_RISK = 25.0

# 개선안이 한 번에 건드릴 수 있는 메뉴 수 — 그 이상은 사람이 확인할 수 없는 양이다
MAX_CHANGES = 60

_KIND_LABEL = {"price": "가격 조정", "add": "새 메뉴", "remove": "메뉴 빼기", "cost": "원가 조정"}


class MenuReviewError(RuntimeError):
    """점검 불가 — 호출자가 사장님에게 그대로 보여줄 수 있는 문장을 담는다."""


# ---------------------------------------------------------------------------
# 개선안 표기 해석 — 사람이 말하는 대로 받는다
# ---------------------------------------------------------------------------

# "빼다"의 여러 말 (단종·삭제·제외…). 챗봇으로 오면 어떤 말로 올지 모른다.
_REMOVE_WORDS = ("단종", "삭제", "제외", "빼기", "뺀다", "빼고", "뺄", "뺌", "내림", "내린다", "중단")
_ADD_WORDS = ("신메뉴", "새메뉴", "새 메뉴", "추가", "출시", "런칭")
_COST_WORDS = ("원가", "재료비")


def _to_won(raw: str) -> Optional[int]:
    """'4,500원' '4500' '4.5' → 4500. 메뉴판과 같은 규칙(천원 단위 축약)을 쓴다."""
    s = (raw or "").replace(",", "").strip()
    m = re.search(r"\d+(?:\.\d+)?", s)
    if not m:
        return None
    v = float(m.group())
    if v <= 0:
        return None
    if v < 100:  # "4.5" = 4,500원
        v *= 1000
    return int(round(v))


def parse_change_spec(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """사람이 적은 개선안을 구조로 바꾼다. (변경목록, 못 읽은 줄)

    받아들이는 표기 (쉼표·줄바꿈으로 구분):
        아메리카노 4500            → 가격 4,500원으로
        아메리카노 4000 -> 4500    → 같음 (앞 숫자는 참고용, 지금 판매가는 DB에서 읽는다)
        아메리카노 500원 인상       → 지금 가격 + 500 (해석은 review에서 — 여기선 delta로 남긴다)
        +흑임자라떼 6000 / 신메뉴 흑임자라떼 6000원
        -바닐라라떼 / 바닐라라떼 단종
        아메리카노 원가 900

    못 읽은 줄은 버리지 않고 그대로 돌려준다 — 조용히 빠지면 사장님은 반영된 줄 안다.
    """
    changes: list[dict[str, Any]] = []
    unparsed: list[str] = []

    for chunk in re.split(r"[,\n;]+", text or ""):
        raw = chunk.strip()
        if not raw:
            continue
        s = raw

        # ① 빼기
        if s.startswith("-") or any(w in s for w in _REMOVE_WORDS):
            name = s.lstrip("-").strip()
            for w in _REMOVE_WORDS:
                name = name.replace(w, "")
            name = re.sub(r"(은|는|을|를|에서|에)\s*$", "", name.strip()).strip()
            if name:
                changes.append({"kind": "remove", "name": name})
            else:
                unparsed.append(raw)
            continue

        price = _to_won(s.split("->")[-1].split("→")[-1])

        # ② 원가 조정
        if any(w in s for w in _COST_WORDS) and price is not None:
            name = s
            for w in _COST_WORDS:
                name = name.replace(w, "")
            name = re.sub(r"[\d,.\s원→>-]+$", "", name).strip()
            if name:
                changes.append({"kind": "cost", "name": name, "cost": price})
            else:
                unparsed.append(raw)
            continue

        is_add = s.startswith("+") or any(w in s for w in _ADD_WORDS)
        name = s.lstrip("+").strip()
        for w in _ADD_WORDS:
            name = name.replace(w, "")
        # 뒤쪽 숫자(가격) 덩어리와 화살표를 이름에서 걷어낸다
        name = re.sub(r"[\d,.\s원→>-]+$", "", name).strip()
        # "아메리카노 4000 -> 4500"처럼 중간에 숫자가 낀 경우도 앞 이름만 남긴다
        name = re.split(r"\s+\d", name)[0].strip()
        name = re.sub(r"(을|를|은|는|의|가격|판매가)\s*$", "", name).strip()

        if not name:
            unparsed.append(raw)
            continue

        # ③ 인상/인하 폭만 말한 경우 ("아메리카노 500원 인상")
        if price is not None and re.search(r"(인상|올림|올려|올리|인하|내려|내리|할인)", s):
            sign = -1 if re.search(r"(인하|내려|내리|할인)", s) else 1
            changes.append({"kind": "price", "name": name, "delta": sign * price})
            continue

        if price is None:
            unparsed.append(raw)
            continue

        changes.append({"kind": "add" if is_add else "price", "name": name, "price": price})

    return changes[:MAX_CHANGES], unparsed


# ---------------------------------------------------------------------------
# 매장 현황 읽기
# ---------------------------------------------------------------------------

def _norm(name: str) -> str:
    from app.services.ai import recipe_presets

    return recipe_presets.normalize(name)


def _find_menu(menus: list[dict[str, Any]], name: str) -> Optional[dict[str, Any]]:
    """개선안에 적힌 이름으로 등록된 메뉴를 찾는다 (표기 차이를 넘어서).

    정확히 같은 이름 → 정규화 일치 → 한쪽이 다른 쪽을 포함. 후보가 여럿이면 가장 짧은 이름을
    고른다 ('라떼'라고 적었을 때 '바닐라라떼'보다 '카페라떼'가 맞을 확률이 높다).
    """
    key = _norm(name)
    if not key:
        return None
    exact = [m for m in menus if _norm(m["name"]) == key]
    if exact:
        return exact[0]
    partial = [m for m in menus if key in _norm(m["name"]) or _norm(m["name"]) in key]
    if not partial:
        return None
    return min(partial, key=lambda m: len(m["name"]))


def _store_ingredients(store_id: str) -> list[dict[str, Any]]:
    """신메뉴 원가 추정용 재료 목록 [{name, unit, price}] — 쿼리 1회."""
    from app.models.inventory import Ingredient
    from app.services.ai.document_service import _session

    with _session() as db:
        rows = (
            db.query(Ingredient.name, Ingredient.unit, Ingredient.current_price)
            .filter(Ingredient.store_id == store_id)
            .all()
        )
    return [{"name": n, "unit": u or "", "price": float(p or 0)} for n, u, p in rows]


def _estimate_cost(name: str, price: int, store_ings: list[dict[str, Any]],
                   avg_ratio: Optional[float]) -> tuple[Optional[int], str, list[str]]:
    """신메뉴의 원가를 추정한다 → (원가, 근거, 재료설명).

    1순위 표준 레시피 × 매장 재료 단가 — 재료가 매장에 다 있고 단위 환산이 되는 경우만.
    2순위 매장 평균 원가율 × 판매가 — 이건 정말 '대충'이라 화면에서 반드시 추정임을 밝힌다.
    둘 다 안 되면 None (모른다고 말한다).
    """
    from app.services.ai import recipe_presets

    preset = recipe_presets.lookup(name)
    if preset and store_ings:
        names = [s["name"] for s in store_ings]
        total, lines, ok = 0.0, [], True
        for ing_name, qty, unit in preset:
            cands = set(recipe_presets.match_ingredient(ing_name, names))
            rows = [s for s in store_ings if s["name"] in cands]
            # 후보가 여럿이면 어느 원두를 쓸지 여기서 정할 수 없다 — 추정을 포기한다
            if len(rows) != 1:
                ok = False
                break
            conv = recipe_presets.convert_quantity(qty, unit, rows[0]["unit"], rows[0]["name"])
            if conv is None or not rows[0]["price"]:
                ok = False
                break
            total += conv * rows[0]["price"]
            lines.append(f"{rows[0]['name']} {qty:g}{unit}")
        if ok and total > 0:
            return int(round(total)), "preset", lines

    if avg_ratio and price > 0:
        return int(round(price * avg_ratio)), "average", []
    return None, "unknown", []


# ---------------------------------------------------------------------------
# 항목별 채점
# ---------------------------------------------------------------------------

def _won(v: float) -> str:
    return f"{int(round(v)):,}원"


def _price_item(target: dict[str, Any], new_price: int, scale: float) -> dict[str, Any]:
    """가격 조정 한 건 — 중심 숫자는 '버틸 수 있는 판매 감소폭'이다."""
    old_price = int(target["selling_price"])
    cost = None if target["recipe_missing"] else int(target["cost_price"])
    qty30 = round(target["sold_qty"] * scale)
    diff = new_price - old_price
    pct = (diff / old_price * 100) if old_price else 0.0

    item: dict[str, Any] = {
        "kind": "price",
        "menu_id": target["menu_id"],
        "name": target["name"],
        "before": {"price": old_price, "cost": cost,
                   "margin": None if cost is None else old_price - cost,
                   "sold_qty_30d": qty30},
        "after": {"price": new_price, "cost": cost,
                  "margin": None if cost is None else new_price - cost},
        "change_pct": round(pct, 1),
        "monthly_delta": None,
        "notes": [],
    }

    if diff == 0:
        item.update(verdict="watch", headline="가격이 그대로예요",
                    reason=f"{target['name']}은(는) 지금도 {_won(old_price)}입니다.")
        return item

    direction = "인상" if diff > 0 else "인하"
    if cost is None:
        # 원가를 모르면 마진 계산이 전부 거짓말이 된다 — 여기서 멈추는 게 맞다
        item.update(
            verdict="watch",
            headline=f"{_won(abs(diff))} {direction} · 원가를 모르는 메뉴예요",
            reason=(f"{target['name']}은(는) 레시피가 없어 원가를 계산할 수 없어요. "
                    f"재료를 등록하면 얼마가 남는지까지 알려드릴 수 있어요."),
        )
        item["monthly_delta"] = None
        return item

    old_margin, new_margin = old_price - cost, new_price - cost
    item["monthly_delta"] = int(round((new_margin - old_margin) * qty30))

    if new_margin <= 0:
        item.update(
            verdict="risk",
            headline=f"{direction} 뒤엔 팔수록 손해예요",
            reason=(f"{target['name']} 재료비가 {_won(cost)}인데 판매가를 {_won(new_price)}로 "
                    f"내리면 한 잔당 {_won(-new_margin)}씩 손해예요."),
        )
        return item

    if diff > 0:
        # 본전 감소폭: 새 마진 × (1-x) × q = 옛 마진 × q  →  x = 1 - 옛마진/새마진
        allow = 1 - (old_margin / new_margin)
        allow_cups = round(qty30 * allow)
        item["breakeven_drop_pct"] = round(allow * 100, 1)
        item["breakeven_drop_cups"] = allow_cups
        verdict = "risk" if pct >= PRICE_UP_RISK else ("watch" if pct >= PRICE_UP_WATCH else "good")
        reason = (f"한 잔 남는 돈이 {_won(old_margin)} → {_won(new_margin)}. "
                  f"최근 30일 {qty30}잔 기준으로 판매가 {round(allow * 100, 1)}%"
                  f"({allow_cups}잔)까지 줄어도 본전이에요.")
        headline = (f"월 {_won(item['monthly_delta'])} 늘어요"
                    if qty30 else f"한 잔에 {_won(diff)} 더 남아요")
        if qty30 == 0:
            reason = (f"한 잔 남는 돈이 {_won(old_margin)} → {_won(new_margin)}. "
                      f"다만 최근 30일 판매 기록이 없어 월 수익 변화는 계산하지 못했어요.")
            item["monthly_delta"] = None
        if pct >= PRICE_UP_WATCH:
            item["notes"].append(f"한 번에 {round(pct, 1)}% 올리는 안이에요. "
                                 f"손님이 가장 크게 체감하는 구간이라 나눠 올리는 것도 방법이에요.")
        # 4,900 → 5,000처럼 천원 벽을 넘는 인상은 체감이 유독 크다
        if old_price // 1000 != new_price // 1000 and new_price % 1000 <= 500:
            item["notes"].append(f"{new_price // 1000}천원대로 올라가는 가격이라 "
                                 f"금액보다 크게 느껴질 수 있어요.")
        item.update(verdict=verdict, headline=headline, reason=reason)
        return item

    # 인하 — 얼마나 더 팔아야 본전인가
    need = (old_margin / new_margin) - 1
    item["breakeven_gain_pct"] = round(need * 100, 1)
    item["breakeven_gain_cups"] = round(qty30 * need)
    item.update(
        verdict="watch",
        headline=f"{round(need * 100, 1)}% 더 팔아야 본전이에요",
        reason=(f"한 잔 남는 돈이 {_won(old_margin)} → {_won(new_margin)}으로 줄어요. "
                f"최근 30일 {qty30}잔 기준으로 {round(qty30 * need)}잔을 더 팔아야 지금과 같아요."),
    )
    return item


def _remove_item(target: dict[str, Any], menus: list[dict[str, Any]], scale: float,
                 total_margin30: float) -> dict[str, Any]:
    """메뉴 빼기 — 잃는 이익과, 그 자리를 받아 줄 메뉴가 있는지."""
    cost = None if target["recipe_missing"] else int(target["cost_price"])
    qty30 = round(target["sold_qty"] * scale)
    margin = None if cost is None else int(target["selling_price"] - cost)
    lost = None if margin is None else int(round(margin * qty30))

    item: dict[str, Any] = {
        "kind": "remove",
        "menu_id": target["menu_id"],
        "name": target["name"],
        "before": {"price": int(target["selling_price"]), "cost": cost,
                   "margin": margin, "sold_qty_30d": qty30},
        "after": None,
        "monthly_delta": None if lost is None else -lost,
        "notes": [],
    }

    if margin is not None and margin <= 0:
        item.update(
            verdict="good",
            headline="잘 빼셨어요 · 팔수록 손해였어요",
            reason=(f"{target['name']}은(는) 판매가 {_won(target['selling_price'])}에 재료비가 "
                    f"{_won(cost)}라 한 잔당 {_won(-margin)}씩 손해였어요."),
        )
        item["monthly_delta"] = None if lost is None else -lost  # 손해였으니 빼면 오히려 이득
        return item

    if qty30 == 0:
        item.update(
            verdict="good",
            headline="최근 30일 판매가 없던 메뉴예요",
            reason=f"{target['name']}은(는) 최근 30일 팔린 기록이 없어 빼도 매출 영향이 없어요.",
        )
        item["monthly_delta"] = 0
        return item

    share = (lost / total_margin30 * 100) if (lost and total_margin30 > 0) else 0.0
    item["margin_share"] = round(share, 1)

    # 비슷한 가격대(±20%)의 살아남는 메뉴 — 손님이 옮겨 갈 자리가 있는지
    price = target["selling_price"]
    alts = [m["name"] for m in menus
            if m["menu_id"] != target["menu_id"] and price
            and abs(m["selling_price"] - price) <= price * 0.2][:3]
    if alts:
        item["notes"].append(f"비슷한 가격대 메뉴가 있어요: {', '.join(alts)}. "
                             f"손님 일부는 이쪽으로 옮겨 갈 수 있어요.")

    if share >= 15:
        item.update(
            verdict="risk",
            headline=f"이익의 {round(share, 1)}%를 책임지던 메뉴예요",
            reason=(f"최근 30일 {qty30}잔이 팔려 {_won(lost)}을 남겼어요. "
                    f"빼면 그만큼이 그대로 빠집니다."),
        )
    elif lost:
        item.update(
            verdict="watch",
            headline=f"월 {_won(lost)}이 빠져요",
            reason=f"최근 30일 {qty30}잔 판매, 한 잔당 {_won(margin)}이 남던 메뉴예요.",
        )
    else:
        item.update(
            verdict="watch",
            headline="원가를 모르는 메뉴예요",
            reason=(f"레시피가 없어 얼마가 남던 메뉴인지 계산할 수 없어요 "
                    f"(최근 30일 {qty30}잔 판매)."),
        )
    return item


def _add_item(name: str, price: int, cost: Optional[int], cost_source: str,
              recipe_note: list[str], menus: list[dict[str, Any]],
              median_margin30: float) -> dict[str, Any]:
    """새 메뉴 — 판매량을 모르니 '얼마 벌지'가 아니라 '얼마 팔면 되는지'로 답한다."""
    item: dict[str, Any] = {
        "kind": "add",
        "menu_id": None,
        "name": name,
        "before": None,
        "after": {"price": price, "cost": cost,
                  "margin": None if cost is None else price - cost,
                  "cost_source": cost_source},
        "monthly_delta": None,   # 신메뉴 판매량은 아무도 모른다 — 총합에 넣지 않는다
        "notes": [],
    }
    if recipe_note:
        item["notes"].append("원가 추정 근거: " + ", ".join(recipe_note))
    elif cost_source == "average":
        item["notes"].append("매장 평균 원가율로 잡은 대략값이에요. 레시피를 넣으면 정확해져요.")

    # 가격대 위치 — 기존 메뉴 대비 어디쯤인가
    prices = sorted(m["selling_price"] for m in menus if m["selling_price"] > 0)
    if prices:
        if price > prices[-1]:
            item["notes"].append(f"지금 가장 비싼 메뉴({_won(prices[-1])})보다 비싼 가격이에요.")
        elif price < prices[0]:
            item["notes"].append(f"지금 가장 싼 메뉴({_won(prices[0])})보다 싼 가격이에요.")

    if cost is None:
        item.update(verdict="watch", headline="원가를 알 수 없어요",
                    reason=(f"{name}의 재료를 알 수 없어 원가를 계산하지 못했어요. "
                            f"등록 후 레시피를 넣으면 원가율까지 볼 수 있어요."))
        return item

    margin = price - cost
    ratio = (cost / price * 100) if price else 0.0
    item["after"]["cost_ratio"] = round(ratio, 1)

    if margin <= 0:
        item.update(verdict="risk", headline="팔수록 손해인 가격이에요",
                    reason=f"재료비 {_won(cost)}가 판매가 {_won(price)}보다 커요.")
        return item

    need = int(round(median_margin30 / margin)) if median_margin30 and margin else 0
    reason = f"한 잔 남는 돈 {_won(margin)}, 원가율 {round(ratio, 1)}%."
    if need:
        reason += (f" 한 달 {need}잔(하루 {max(1, round(need / 30))}잔쯤) 팔면 "
                   f"지금 메뉴 중간 정도는 벌어요.")
        item["target_qty_30d"] = need
    if ratio >= COST_RATIO_DANGER:
        item.update(verdict="risk", headline=f"원가율 {round(ratio, 1)}%는 높아요", reason=reason)
    elif ratio >= COST_RATIO_WARN:
        item.update(verdict="watch", headline=f"원가율 {round(ratio, 1)}%예요", reason=reason)
    else:
        item.update(verdict="good", headline=f"한 잔에 {_won(margin)} 남아요", reason=reason)
    return item


def _cost_item(target: dict[str, Any], new_cost: int, scale: float) -> dict[str, Any]:
    """원가 조정안 (재료를 더 싼 걸로 바꿨을 때) — 판매가는 그대로."""
    price = int(target["selling_price"])
    old_cost = None if target["recipe_missing"] else int(target["cost_price"])
    qty30 = round(target["sold_qty"] * scale)
    item: dict[str, Any] = {
        "kind": "cost",
        "menu_id": target["menu_id"],
        "name": target["name"],
        "before": {"price": price, "cost": old_cost,
                   "margin": None if old_cost is None else price - old_cost,
                   "sold_qty_30d": qty30},
        "after": {"price": price, "cost": new_cost, "margin": price - new_cost,
                  "cost_ratio": round(new_cost / price * 100, 1) if price else None},
        "monthly_delta": None if old_cost is None else int(round((old_cost - new_cost) * qty30)),
        "notes": ["재료를 실제로 바꾸면 재고 화면에서 레시피·단가를 함께 고쳐야 반영돼요."],
    }
    if old_cost is None:
        item.update(verdict="watch", headline="지금 원가를 몰라 비교할 수 없어요",
                    reason=f"{target['name']}에 레시피가 없어 얼마나 아끼는지 계산하지 못했어요.")
        return item
    saved = old_cost - new_cost
    if saved <= 0:
        item.update(verdict="watch", headline="원가가 오히려 올라가요",
                    reason=f"재료비가 {_won(old_cost)} → {_won(new_cost)}로 {_won(-saved)} 늘어요.")
        return item
    item.update(
        verdict="good",
        headline=(f"월 {_won(item['monthly_delta'])} 아껴요" if qty30 else f"한 잔에 {_won(saved)} 아껴요"),
        reason=(f"재료비가 {_won(old_cost)} → {_won(new_cost)}로 줄어 한 잔 남는 돈이 "
                f"{_won(price - old_cost)} → {_won(price - new_cost)}가 돼요"
                + (f" (최근 30일 {qty30}잔 기준)." if qty30 else ".")),
    )
    return item


# ---------------------------------------------------------------------------
# 총평
# ---------------------------------------------------------------------------

_VERDICT_LABEL = {
    "good": "괜찮은 개선이에요",
    "caution": "한 번 더 볼 곳이 있어요",
    "risky": "이대로는 위험해요",
}

_COMMENT_PROMPT = """카페 사장님이 메뉴를 이렇게 바꿔 보려고 합니다. 아래 계산 결과를 보고
총평을 2문장 이내로 써 주세요.

{data}

규칙:
- 반드시 한국어. 사장님께 말하듯 존댓말로.
- 위에 있는 숫자만 쓰세요. 없는 숫자를 만들지 마세요.
- '원가율', '기여이익' 같은 회계 용어 대신 '재료비 비중', '남는 돈'처럼 쉬운 말로.
- 잘한 점과 걱정되는 점이 함께 있으면 걱정되는 쪽을 먼저 말해 주세요.
- 이미 계산해 준 숫자를 그대로 반복하지 말고, 무엇을 하면 되는지에 초점을 두세요.
"""


def _rule_comment(summary: dict[str, Any], items: list[dict[str, Any]]) -> str:
    """AI 없이도 총평은 나가야 한다 (키가 없거나 쿼터가 막힌 경우)."""
    risks = [i for i in items if i.get("verdict") == "risk"]
    delta = summary.get("monthly_delta")
    if risks:
        return f"{risks[0]['name']}부터 다시 보시는 게 좋겠어요 — {risks[0]['headline']}."
    if delta and delta > 0:
        return f"지금 판매량이 유지된다면 한 달에 {_won(delta)}쯤 더 남는 구성이에요."
    if delta and delta < 0:
        return f"지금 판매량 그대로면 한 달에 {_won(-delta)}쯤 덜 남아요. 빼는 메뉴를 다시 보세요."
    return "큰 위험 신호는 없어요. 바꾼 뒤 2주쯤 판매량을 지켜보시면 좋겠어요."


def _ai_comment(summary: dict[str, Any], items: list[dict[str, Any]]) -> tuple[str, str]:
    """Gemini 한 줄 총평 → (문장, 출처). 실패하면 규칙 문장으로 내려간다."""
    fallback = _rule_comment(summary, items)
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        return fallback, "rule"

    slim = {
        "요약": summary,
        "변경": [{"메뉴": i["name"], "종류": _KIND_LABEL.get(i["kind"], i["kind"]),
                  "판정": i.get("verdict"), "한줄": i.get("headline"),
                  "근거": i.get("reason")} for i in items[:12]],
    }
    try:
        import httpx

        model = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
        config: dict[str, Any] = {"temperature": 0.4, "maxOutputTokens": 512}
        # 두 문장 쓰는 데 사고 예산을 쓰면 답이 통째로 비어 온다 (OCR과 같은 이유)
        if model.startswith("gemini-2.5"):
            config["thinkingConfig"] = {"thinkingBudget": 0}
        elif model.startswith("gemini-3"):
            config["thinkingConfig"] = {"thinkingLevel": "low"}
        resp = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            json={"contents": [{"parts": [{"text": _COMMENT_PROMPT.format(
                data=json.dumps(slim, ensure_ascii=False))}]}], "generationConfig": config},
            headers={"x-goog-api-key": api_key},
            timeout=15.0,
        )
        resp.raise_for_status()
        text = (resp.json()["candidates"][0]["content"]["parts"][0]["text"] or "").strip()
        return (text, "ai") if text else (fallback, "rule")
    except Exception as e:  # 총평이 없다고 점검 결과를 못 보여줄 이유는 없다
        logger.info("메뉴 개선안 총평 생성 실패 — 규칙 문장으로 대체: %s", e)
        return fallback, "rule"


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def review(store_id: str, changes: list[dict[str, Any]], days: int = 30,
           comment: bool = True) -> dict[str, Any]:
    """개선안을 지금 매장 숫자로 채점한다. 아무것도 저장하지 않는다.

    changes 각 항목:
        {"kind": "price",  "name": "아메리카노", "price": 4500}   또는 {"delta": 500}
        {"kind": "add",    "name": "흑임자라떼", "price": 6000, "cost": 2200(선택)}
        {"kind": "remove", "name": "바닐라라떼"}
        {"kind": "cost",   "name": "아메리카노", "cost": 800}
    """
    from app.services.ai import sales_service

    changes = [c for c in (changes or []) if isinstance(c, dict)][:MAX_CHANGES]
    if not changes:
        raise MenuReviewError("점검할 변경 내용이 없어요. 무엇을 어떻게 바꿨는지 알려주세요.")

    days = max(7, min(int(days or 30), 180))
    data = sales_service.menu_contribution(store_id, days=days)
    all_menus = data.get("menus") or []
    menus = [m for m in all_menus if m.get("is_active", True)]
    if not menus:
        raise MenuReviewError(
            "등록된 메뉴가 없어 비교할 기준이 없어요. 메뉴판 사진으로 먼저 등록해 주세요.")

    scale = 30 / days  # 집계 기간이 30일이 아니어도 '한 달'로 환산해 말한다
    priced = [m for m in menus if not m["recipe_missing"]]
    margins30 = sorted(m["margin_per_cup"] * m["sold_qty"] * scale for m in priced) or [0]
    median_margin30 = margins30[len(margins30) // 2]
    total_margin30 = sum(margins30)
    avg_ratio = None
    ratios = [m["cost_ratio"] for m in priced if m.get("cost_ratio")]
    if ratios:
        avg_ratio = sum(ratios) / len(ratios) / 100

    store_ings: list[dict[str, Any]] = []
    if any(c.get("kind") == "add" for c in changes):
        store_ings = _store_ingredients(store_id)

    items: list[dict[str, Any]] = []
    unmatched: list[str] = []
    seen_targets: set[int] = set()

    for c in changes:
        kind = str(c.get("kind") or "price").lower()
        name = str(c.get("name") or "").strip()
        if not name:
            continue

        if kind == "add":
            price = _to_won(str(c.get("price") or "")) or 0
            dup = _find_menu(menus, name)
            if dup:
                items.append({
                    "kind": "add", "menu_id": dup["menu_id"], "name": name,
                    "before": None, "after": {"price": price or dup["selling_price"], "cost": None,
                                              "margin": None},
                    "monthly_delta": None, "verdict": "watch",
                    "headline": "이미 있는 메뉴예요",
                    "reason": f"'{dup['name']}'(으)로 이미 등록돼 있어요. 가격만 바꾸시려는 거라면 "
                              f"가격 조정으로 알려주세요.",
                    "notes": [],
                })
                continue
            if price <= 0:
                unmatched.append(f"{name} (가격을 알 수 없어요)")
                continue
            cost = c.get("cost")
            cost = int(cost) if isinstance(cost, (int, float)) and cost > 0 else None
            source, note = "manual", []
            if cost is None:
                cost, source, note = _estimate_cost(name, price, store_ings, avg_ratio)
            items.append(_add_item(name, price, cost, source, note, menus, median_margin30))
            continue

        target = _find_menu(menus, name)
        if not target:
            unmatched.append(name)
            continue
        # 같은 메뉴에 두 번 지시가 오면(가격+단종) 뒤엣것이 앞엣것을 덮어 계산이 이중으로 잡힌다
        if target["menu_id"] in seen_targets:
            unmatched.append(f"{name} (같은 메뉴가 두 번 나와 한 번만 계산했어요)")
            continue
        seen_targets.add(target["menu_id"])

        if kind == "remove":
            items.append(_remove_item(target, menus, scale, total_margin30))
        elif kind == "cost":
            new_cost = _to_won(str(c.get("cost") or ""))
            if new_cost is None:
                unmatched.append(f"{name} (바꿀 원가를 알 수 없어요)")
                continue
            items.append(_cost_item(target, new_cost, scale))
        else:
            new_price = _to_won(str(c.get("price") or ""))
            if new_price is None and isinstance(c.get("delta"), (int, float)):
                new_price = max(0, int(target["selling_price"] + c["delta"]))
            if new_price is None:
                unmatched.append(f"{name} (바꿀 가격을 알 수 없어요)")
                continue
            items.append(_price_item(target, new_price, scale))

    if not items:
        raise MenuReviewError(
            "점검할 수 있는 메뉴를 찾지 못했어요: " + ", ".join(unmatched[:5])
            + " — 메뉴 이름이 등록된 이름과 같은지 확인해 주세요.")

    summary = _summarize(menus, items, scale)
    comment_text, comment_source = (_ai_comment(summary, items) if comment
                                    else (_rule_comment(summary, items), "rule"))

    risks = [i["headline"] for i in items if i.get("verdict") == "risk"]
    wins = [i["headline"] for i in items if i.get("verdict") == "good"]
    verdict = "risky" if risks else ("caution" if any(
        i.get("verdict") == "watch" for i in items) else "good")

    return {
        "days": days,
        "changes": items,
        "unmatched": unmatched,
        "summary": summary,
        "risks": risks,
        "wins": wins,
        "verdict": verdict,
        "verdict_label": _VERDICT_LABEL[verdict],
        "comment": comment_text,
        "comment_source": comment_source,
        "assumptions": [
            f"최근 {days}일 판매 실적이 그대로 유지된다고 보고 계산했어요.",
            "원가는 지금 등록된 레시피와 재료 단가 기준이에요.",
            "새 메뉴는 얼마나 팔릴지 알 수 없어 월 수익 합계에는 넣지 않았어요.",
        ],
    }


def _summarize(menus: list[dict[str, Any]], items: list[dict[str, Any]],
               scale: float) -> dict[str, Any]:
    """개선안 반영 전후의 매장 전체 그림 (판매량 유지 가정)."""
    removed = {i["menu_id"] for i in items if i["kind"] == "remove" and i.get("menu_id")}
    new_price = {i["menu_id"]: i["after"]["price"]
                 for i in items if i["kind"] == "price" and i.get("menu_id") and i.get("after")}
    new_cost = {i["menu_id"]: i["after"]["cost"]
                for i in items if i["kind"] == "cost" and i.get("menu_id") and i.get("after")}

    margin_before = margin_after = 0.0
    rev_before = rev_after = 0.0
    qty_before = qty_after = 0.0
    ratios_after: list[float] = []
    per_menu_after: list[float] = []

    for m in menus:
        qty = m["sold_qty"] * scale
        price_b = m["selling_price"]
        price_a = new_price.get(m["menu_id"], price_b)
        cost_b = None if m["recipe_missing"] else m["cost_price"]
        cost_a = new_cost.get(m["menu_id"], cost_b)

        qty_before += qty
        rev_before += price_b * qty
        if cost_b is not None:
            margin_before += (price_b - cost_b) * qty

        if m["menu_id"] in removed:
            continue
        qty_after += qty
        rev_after += price_a * qty
        if cost_a is not None:
            margin_after += (price_a - cost_a) * qty
            per_menu_after.append((price_a - cost_a) * qty)
            if price_a:
                ratios_after.append(cost_a / price_a * 100)

    added = len([i for i in items if i["kind"] == "add" and not i.get("menu_id")])
    top3 = sorted(per_menu_after, reverse=True)[:3]
    return {
        "monthly_margin_before": int(round(margin_before)),
        "monthly_margin_after": int(round(margin_after)),
        "monthly_delta": int(round(margin_after - margin_before)),
        "avg_ticket_before": int(round(rev_before / qty_before)) if qty_before else 0,
        "avg_ticket_after": int(round(rev_after / qty_after)) if qty_after else 0,
        "menu_count_before": len(menus),
        "menu_count_after": len(menus) - len(removed) + added,
        "cost_ratio_avg_after": round(sum(ratios_after) / len(ratios_after), 1) if ratios_after else None,
        "top3_margin_share_after": (round(sum(top3) / margin_after * 100, 1)
                                    if margin_after > 0 else None),
    }


# ---------------------------------------------------------------------------
# 추천 — 무엇을 바꿔야 하는지 먼저 찾아 준다
# ---------------------------------------------------------------------------

# 인상 폭을 정할 때 쓰는 기준선. 카페 음료 원가율 통상 목표(30~35%)의 중간값이다.
TARGET_COST_RATIO = 33.0
# 목표까지 한 번에 올리면 손님이 놀란다 — 이번엔 여기까지만 올리고 다음에 또 올린다.
MAX_STEP_UP = 0.15
# 한 번에 보여줄 제안 수. 열 개를 늘어놓으면 하나도 실행되지 않는다.
MAX_SUGGESTIONS = 6
# '팔수록 손해인데 이만큼밖에 안 나간다' → 올리는 대신 빼는 게 낫다는 선
FEW_SALES_QTY = 5

_NEW_MENU_PROMPT = """한국 카페 사장님에게 새로 넣을 메뉴 {count}가지를 제안해 주세요.

지금 파는 메뉴와 가격:
{menus}

이번 달: {month}월

규칙:
- 실제로 한국 카페에서 파는 메뉴만. 이름은 손님이 메뉴판에서 보는 그대로 짧게.
- 지금 파는 메뉴와 겹치거나 거의 같은 메뉴는 빼세요.
- price는 원 단위 정수로, 지금 메뉴들의 가격대와 어울리게 정하세요.
- 재료가 완전히 새로 필요한 메뉴보다, 지금 재료에 하나만 더하면 되는 메뉴가 좋습니다.
- reason은 왜 이 매장에 어울리는지 한 문장으로 (계절·지금 메뉴 구성과 엮어서).
"""

_NEW_MENU_SCHEMA = {
    "type": "object",
    "properties": {
        "menus": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "price": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["name", "price", "reason"],
            },
        }
    },
    "required": ["menus"],
}


def _suggest_price(cost: int, price: int) -> Optional[int]:
    """원가율을 목표치로 되돌리는 판매가 (100원 단위 올림, 한 번에 15%까지).

    목표까지 한 번에 올리지 않는 이유: 원가율 60%인 메뉴를 33%로 맞추려면 가격이 1.8배가 된다.
    그 제안은 아무도 실행하지 않는다 — 실행할 수 있는 크기로 잘라 주는 편이 낫다.
    """
    if cost <= 0:
        return None
    ideal = cost / (TARGET_COST_RATIO / 100)
    capped = min(ideal, price * (1 + MAX_STEP_UP)) if price > 0 else ideal
    new = int(-(-capped // 100) * 100)  # 100원 단위 올림
    return new if new > price else None


def _ai_new_menus(menus: list[dict[str, Any]], month: int, count: int = 2) -> list[dict[str, Any]]:
    """신메뉴 아이디어 → [{"name","price","reason"}]. 실패하면 빈 목록 (추천은 계속된다)."""
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        return []
    listing = "\n".join(f"- {m['name']} {int(m['selling_price']):,}원" for m in menus[:25])
    try:
        import httpx

        model = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
        config: dict[str, Any] = {
            "temperature": 0.8,   # 아이디어라 매번 같으면 재미가 없다
            "responseMimeType": "application/json",
            "responseSchema": _NEW_MENU_SCHEMA,
            "maxOutputTokens": 1024,
        }
        if model.startswith("gemini-2.5"):
            config["thinkingConfig"] = {"thinkingBudget": 0}
        elif model.startswith("gemini-3"):
            config["thinkingConfig"] = {"thinkingLevel": "low"}
        resp = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            json={"contents": [{"parts": [{"text": _NEW_MENU_PROMPT.format(
                count=count, menus=listing, month=month)}]}], "generationConfig": config},
            headers={"x-goog-api-key": api_key},
            timeout=20.0,
        )
        resp.raise_for_status()
        raw = json.loads(resp.json()["candidates"][0]["content"]["parts"][0]["text"])
    except Exception as e:
        logger.info("신메뉴 아이디어 생성 실패 — 나머지 추천만 냅니다: %s", e)
        return []

    out = []
    for m in (raw.get("menus") or [])[:count]:
        name = str(m.get("name") or "").strip()
        price = _to_won(str(m.get("price") or ""))
        if not name or not price:
            continue
        out.append({"name": name, "price": price, "reason": str(m.get("reason") or "").strip()})
    return out


def recommend(store_id: str, days: int = 30, include_new: bool = True) -> dict[str, Any]:
    """지금 매장 숫자를 훑어 '바꾸면 좋을 것'을 먼저 찾아 준다. 저장하지 않는다.

    찾는 것 (급한 순):
      1. 팔수록 손해인 메뉴 → 얼마로 올려야 하는지, 아니면 빼는 게 나은지
      2. 재료비 비중이 높은 메뉴 → 목표 원가율로 되돌리는 가격
      3. 30일간 한 잔도 안 나간 메뉴 → 메뉴판에서 빼기
      4. 신메뉴 아이디어 (AI, 실패해도 나머지는 그대로 나온다)
      5. 원가를 모르는 메뉴 → 레시피부터 등록 (계산의 전제가 없다)

    각 제안은 review()와 같은 채점기를 통과한다 — 두 화면의 숫자가 어긋날 수 없다.
    """
    from datetime import datetime

    from app.services.ai import sales_service

    days = max(7, min(int(days or 30), 180))
    data = sales_service.menu_contribution(store_id, days=days)
    menus = [m for m in (data.get("menus") or []) if m.get("is_active", True)]
    if not menus:
        raise MenuReviewError(
            "등록된 메뉴가 없어 볼 것이 없어요. 메뉴판 사진으로 먼저 등록해 주세요.")

    scale = 30 / days
    priced = [m for m in menus if not m["recipe_missing"]]
    margins30 = sorted(m["margin_per_cup"] * m["sold_qty"] * scale for m in priced) or [0]
    median_margin30 = margins30[len(margins30) // 2]
    total_margin30 = sum(margins30)

    suggestions: list[dict[str, Any]] = []
    used: set[int] = set()

    def _add(item: dict[str, Any], why: str, priority: int, actionable: bool = True) -> None:
        item["why"] = why
        item["priority"] = priority
        item["actionable"] = actionable
        suggestions.append(item)

    # 1·2. 손해 메뉴와 재료비가 무거운 메뉴 — 올릴지 뺄지
    risky = sorted(
        [m for m in priced if m["margin_per_cup"] <= 0
         or (m["cost_ratio"] or 0) >= COST_RATIO_WARN],
        key=lambda m: (m["margin_per_cup"] > 0, -(m["cost_ratio"] or 0)),
    )
    for m in risky:
        qty30 = round(m["sold_qty"] * scale)
        losing = m["margin_per_cup"] <= 0
        if losing and qty30 < FEW_SALES_QTY:
            used.add(m["menu_id"])
            _add(_remove_item(m, menus, scale, total_margin30),
                 f"한 잔당 {_won(-m['margin_per_cup'])}씩 손해인데 최근 30일 {qty30}잔뿐이에요. "
                 f"가격을 올리기보다 메뉴판에서 빼는 편이 나아요.", 0)
            continue

        new_price = _suggest_price(int(m["cost_price"]), int(m["selling_price"]))
        if not new_price:
            continue
        used.add(m["menu_id"])
        item = _price_item(m, new_price, scale)
        if losing:
            item["notes"].append("판매가·레시피 용량·재료 단가 중 하나가 잘못 입력됐을 수도 있어요. "
                                 "올리기 전에 재료 양부터 확인해 보세요.")
            why = (f"판매가 {_won(m['selling_price'])}인데 재료비가 {_won(m['cost_price'])}예요. "
                   f"지금은 팔수록 손해라, 최소한 {_won(new_price)}은 받아야 해요.")
        else:
            why = (f"재료비가 판매가의 {m['cost_ratio']}%를 먹고 있어요"
                   f"(최근 30일 {qty30}잔). {_won(new_price)}이면 "
                   f"{round(m['cost_price'] / new_price * 100, 1)}%로 내려가요.")
        # 목표까지 한 번에 못 간 경우 — 이번엔 여기까지라는 걸 밝힌다
        if m["cost_price"] / new_price * 100 > TARGET_COST_RATIO + 1:
            item["notes"].append(f"한 번에 올릴 수 있는 폭(15%)까지만 잡았어요. "
                                 f"자리 잡으면 다음에 한 번 더 보세요.")
        _add(item, why, 0 if losing else 1)

    # 3. 30일간 한 잔도 안 나간 메뉴 — 메뉴판 자리를 차지하고 고르기만 어렵게 만든다
    dead = [m for m in menus if m["menu_id"] not in used and round(m["sold_qty"] * scale) == 0]
    for m in dead[:3]:
        used.add(m["menu_id"])
        _add(_remove_item(m, menus, scale, total_margin30),
             "최근 30일 한 잔도 안 나갔어요. 메뉴가 많으면 손님이 고르기 어려워져요.", 2)

    # 4. 신메뉴 아이디어 — 없어도 나머지 추천은 그대로 나온다
    if include_new:
        store_ings = _store_ingredients(store_id)
        ratios = [m["cost_ratio"] for m in priced if m.get("cost_ratio")]
        avg_ratio = (sum(ratios) / len(ratios) / 100) if ratios else None
        for idea in _ai_new_menus(menus, datetime.now().month):
            if _find_menu(menus, idea["name"]):
                continue
            cost, source, note = _estimate_cost(idea["name"], idea["price"], store_ings, avg_ratio)
            item = _add_item(idea["name"], idea["price"], cost, source, note, menus, median_margin30)
            item["source"] = "ai"
            _add(item, idea["reason"] or "지금 메뉴 구성에 어울리는 메뉴예요.", 3)

    # 5. 원가를 모르는 메뉴 — 위 계산이 서지 않는 근본 원인이라 마지막에 짚는다
    missing = [m["name"] for m in menus if m["recipe_missing"]]
    if missing:
        # 절반 넘게 원가를 모르면 가격 제안 자체가 성립하지 않는다 — 그게 오늘의 첫 할 일이다
        blind = len(missing) >= max(2, len(menus) / 2)
        _add({
            "kind": "info", "menu_id": None, "name": "원가부터 등록해 주세요",
            "before": None, "after": None, "monthly_delta": None, "notes": [],
            "verdict": "watch",
            "headline": f"{len(missing)}개 메뉴는 원가를 모르는 상태예요",
            "reason": (f"레시피가 없어 얼마 남는지 계산할 수 없어요: "
                       f"{', '.join(missing[:5])}{' 외 ' + str(len(missing) - 5) + '개' if len(missing) > 5 else ''}. "
                       f"메뉴를 눌러 재료를 넣으면 얼마로 올리면 좋을지까지 알려드릴 수 있어요."),
        }, "원가를 모르면 올릴지 뺄지 판단할 근거가 없어요.", 0 if blind else 4, actionable=False)

    suggestions.sort(key=lambda s: (s["priority"], -abs(s.get("monthly_delta") or 0)))
    suggestions = suggestions[:MAX_SUGGESTIONS]

    gain = sum(s["monthly_delta"] for s in suggestions
               if s["actionable"] and isinstance(s.get("monthly_delta"), int))
    actionable = [s for s in suggestions if s["actionable"]]

    if not actionable:
        headline = "지금은 급하게 바꿀 곳이 안 보여요"
    elif gain > 0:
        headline = f"다 하면 한 달에 약 {_won(gain)} 더 남아요"
    else:
        headline = f"바꿀 곳 {len(actionable)}군데를 찾았어요"

    return {
        "days": days,
        "suggestions": suggestions,
        "headline": headline,
        "expected_gain": gain,
        # 가장 급한 것 하나를 그대로 앞에 세운다 — 목록 맨 위와 다른 말을 하면 신뢰를 잃는다
        "comment": (suggestions[0]["why"] if suggestions else
                    "최근 30일 기준으로는 손해 보는 메뉴도, 안 나가는 메뉴도 없어요."),
        "assumptions": [
            f"최근 {days}일 판매 실적이 그대로 유지된다고 보고 계산했어요.",
            "권하는 가격은 재료비가 판매가의 33%가 되도록 잡되, 한 번에 15%까지만 올렸어요.",
            "새 메뉴는 얼마나 팔릴지 알 수 없어 예상 수익 합계에는 넣지 않았어요.",
        ],
    }


async def review_menu_board(db, store_id: str, image_bytes: bytes,
                            mime_type: str = "image/jpeg", comment: bool = True) -> dict[str, Any]:
    """새로 만든 메뉴판 사진 → 지금 등록된 메뉴와 대조해 무엇이 바뀌었는지 찾아내고 점검한다.

    사장님은 무엇을 바꿨는지 일일이 적지 않는다. 새 메뉴판을 찍는 게 전부여야 한다.
    다만 '메뉴판에 없다 = 뺐다'는 확실하지 않다 — 사진이 잘리거나 안 읽힌 것일 수 있어
    빼기 항목에는 uncertain 표시를 달아 화면에서 되묻게 한다.
    """
    from app.services.ai import menu_ocr_service, sales_service

    board = await menu_ocr_service.read_menu_board(image_bytes, mime_type=mime_type)
    current = [m for m in (sales_service.menu_contribution(store_id, days=30).get("menus") or [])
               if m.get("is_active", True)]
    if not current:
        raise MenuReviewError(
            "등록된 메뉴가 없어 비교할 수 없어요. 메뉴판 사진으로 먼저 등록해 주세요.")

    changes: list[dict[str, Any]] = []
    matched_ids: set[int] = set()
    same: list[str] = []

    for b in board:
        hit = _find_menu(current, b["name"])
        if hit:
            matched_ids.add(hit["menu_id"])
            if b["price"] and b["price"] != hit["selling_price"]:
                changes.append({"kind": "price", "name": hit["name"], "price": b["price"]})
            else:
                same.append(hit["name"])
        elif b["price"]:
            changes.append({"kind": "add", "name": b["name"], "price": b["price"]})

    gone = [m for m in current if m["menu_id"] not in matched_ids]
    for m in gone:
        changes.append({"kind": "remove", "name": m["name"], "uncertain": True})

    if not changes:
        return {
            "days": 30, "changes": [], "unmatched": [], "unchanged": same,
            "summary": None, "risks": [], "wins": [], "verdict": "good",
            "verdict_label": "바뀐 게 없어요",
            "comment": "새 메뉴판이 지금 등록된 메뉴·가격과 같아요.",
            "comment_source": "rule", "assumptions": [], "source": "board",
        }

    result = review(store_id, changes, days=30, comment=comment)
    result["unchanged"] = same
    result["source"] = "board"
    # 사진에서 못 읽어 '뺀 것처럼' 보였을 수 있다는 사실을 항목에 남긴다
    gone_names = {m["name"] for m in gone}
    for item in result["changes"]:
        if item["kind"] == "remove" and item["name"] in gone_names:
            item["uncertain"] = True
            item["notes"].append("새 메뉴판에서 이 메뉴를 찾지 못해 '뺀 것'으로 봤어요. "
                                 "사진에 안 나온 것뿐이라면 이 항목은 무시해 주세요.")
    if gone:
        result["assumptions"].append(
            "사진에서 못 읽은 메뉴는 '뺀 메뉴'로 잡혀요 — 목록에서 확인해 주세요.")
    return result


def apply_changes(db, store_id: str, changes: list[dict[str, Any]]) -> dict[str, Any]:
    """점검을 마친 개선안을 실제 메뉴에 반영한다 (사장님이 눌러야만 실행된다).

    빼기는 삭제가 아니라 '숨김'(is_active=False)이다 — 지우면 지난 판매 기록의 메뉴 이름까지
    함께 사라져 지난달 리포트가 달라진다.
    """
    from app.models.inventory import Menu
    from app.services.ai import recipe_presets

    changes = [c for c in (changes or []) if isinstance(c, dict)][:MAX_CHANGES]
    if not changes:
        raise MenuReviewError("반영할 변경 내용이 없어요.")

    rows = db.query(Menu).filter(Menu.store_id == store_id).all()
    by_key = {recipe_presets.normalize(m.name): m for m in rows}

    def _lookup(name: str) -> Optional[Any]:
        key = recipe_presets.normalize(name)
        if key in by_key:
            return by_key[key]
        cands = [m for m in rows if key and (key in recipe_presets.normalize(m.name)
                                             or recipe_presets.normalize(m.name) in key)]
        return min(cands, key=lambda m: len(m.name)) if cands else None

    updated, hidden, created, warnings = [], [], [], []
    try:
        for c in changes:
            kind = str(c.get("kind") or "price").lower()
            name = str(c.get("name") or "").strip()
            if not name:
                continue

            if kind == "add":
                price = _to_won(str(c.get("price") or "")) or 0
                if _lookup(name):
                    warnings.append(f"{name}: 이미 있는 메뉴라 새로 만들지 않았어요")
                    continue
                menu = Menu(store_id=store_id, name=name, selling_price=max(0, price))
                db.add(menu)
                db.flush()
                by_key[recipe_presets.normalize(name)] = menu
                rows.append(menu)
                created.append(name)
                warnings.append(f"{name}: 레시피가 없어 원가는 0원으로 잡혀요 — "
                                f"메뉴 관리에서 재료를 넣어 주세요")
                continue

            menu = _lookup(name)
            if not menu:
                warnings.append(f"{name}: 등록된 메뉴에서 찾지 못했어요")
                continue

            if kind == "remove":
                if not menu.is_active:
                    warnings.append(f"{menu.name}: 이미 숨겨진 메뉴예요")
                    continue
                menu.is_active = False
                hidden.append(menu.name)
            elif kind == "cost":
                warnings.append(f"{menu.name}: 원가는 재료 단가에서 정해져요 — "
                                f"재고 화면에서 레시피·단가를 고쳐 주세요")
            else:
                new_price = _to_won(str(c.get("price") or ""))
                if new_price is None and isinstance(c.get("delta"), (int, float)):
                    new_price = max(0, int(menu.selling_price + c["delta"]))
                if new_price is None:
                    warnings.append(f"{menu.name}: 바꿀 가격을 알 수 없어요")
                    continue
                if new_price == menu.selling_price:
                    continue
                menu.selling_price = new_price
                updated.append(f"{menu.name} {new_price:,}원")
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("메뉴 개선안 반영 실패 — 전부 되돌렸습니다 (%s)", store_id)
        raise

    # 판매·원가 화면이 옛 숫자를 계속 보여주지 않게 예측 캐시를 비운다
    try:
        from app.services.ai import forecast_service

        forecast_service.invalidate_forecast_cache(store_id)
    except Exception:
        logger.debug("예측 캐시 무효화 생략", exc_info=True)

    return {"updated": updated, "hidden": hidden, "created": created, "warnings": warnings}
