"""메뉴판 OCR (백엔드 B) — 사진 한 장으로 메뉴판을 통째로 등록한다

[왜 만들었나]
원가를 보려면 메뉴와 레시피가 있어야 하는데, 그걸 손으로 넣게 하면 30분이 든다.
사장님은 그 전에 앱을 닫는다. 메뉴판은 어느 매장에나 이미 붙어 있으니 찍기만 하면 된다.

흐름 (영수증 OCR과 같은 원칙 — 사람 확인 전에는 저장하지 않는다):
    analyze(사진) → 메뉴명·가격 추출 → 표준 레시피 채움 → 매장 재료와 매칭
                 → 미리보기 반환 → (사장님 확인·수정) → confirm에서 일괄 등록

[레시피를 어디서 가져오는가]
1순위 recipe_presets 상수 테이블 — 같은 메뉴엔 항상 같은 값이 나와야 원가가 흔들리지 않는다.
2순위 사전에 없는 메뉴만 Gemini에 물어본다 (커스텀 메뉴·시즌 메뉴).
둘 다 실패하면 레시피 없이 메뉴만 등록한다 — 이름과 가격만 있어도 매출 입력에는 쓸 수 있다.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, Optional

import httpx

from app.services.ai import recipe_presets

logger = logging.getLogger(__name__)


class MenuOcrError(Exception):
    """메뉴판 인식 실패 — 호출자가 사용자에게 그대로 보여줄 수 있는 메시지를 담는다."""


# 이미지 → 메뉴명·가격. 영수증과 달리 배경·글꼴이 제각각이라 규칙을 촘촘히 준다.
_MENU_PROMPT = """이 이미지는 카페 메뉴판입니다. 판매 중인 메뉴와 가격을 모두 읽어 주세요.

규칙:
- name: 메뉴 이름만. "ICE/HOT", 용량(12oz), 별표·이모지 같은 장식은 빼세요.
- price: 적힌 숫자를 '원 단위'로 바꿔 주세요.
    "3,500" 또는 "3500원"  → 3500
    "4.5" 또는 "4.5"       → 4500   (카페 메뉴판은 천원 단위를 소수로 줄여 적는 일이 많습니다)
    "10.0"                 → 10000
  즉 100보다 작은 수는 천원 단위 축약이니 1000을 곱하세요. 가격이 안 보이면 null.
- 같은 메뉴의 ICE/HOT이 따로 적혀 있으면 한 줄로 합치고 더 비싼 가격을 쓰세요.
- 메뉴판이 두 단(왼쪽/오른쪽)으로 나뉘어 있으면 양쪽을 모두 읽으세요.
- 메뉴가 아닌 글자(매장명, 전화번호, 영업시간, 와이파이 비밀번호, 안내문,
  'HOT/ICE'·'ONLY ICE' 같은 구분 표시)는 빼세요.
- 사이드·디저트·베이커리도 판매 메뉴이면 포함하세요.
- 읽을 수 없으면 추측하지 말고 빼세요.
"""

# 카페 메뉴 가격이 1,000원 미만인 경우는 사실상 없다.
# 프롬프트로 시켜도 모델이 "4.5"를 그대로 주는 경우가 있어 받는 쪽에서 한 번 더 바로잡는다.
_MIN_REALISTIC_PRICE = 100

# 알림창에 한 번에 보여줄 경고 개수 (넘치면 아무도 안 읽는다)
_MAX_WARNINGS = 5


def _normalize_price(raw: Any) -> Optional[int]:
    """메뉴판의 '4.5'를 4500원으로 바로잡는다. 숫자가 아니면 None."""
    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
        return None
    v = float(raw)
    if v <= 0:
        return None
    if v < _MIN_REALISTIC_PRICE:
        v *= 1000  # 천원 단위 축약 표기
    return int(round(v))

_MENU_SCHEMA = {
    "type": "object",
    "properties": {
        "menus": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    # integer로 못 박으면 "4.5"가 4로 잘려 4,500원이 4원이 된다 — number로 받고
                    # _normalize_price에서 원 단위로 바로잡는다.
                    "price": {"type": "number", "nullable": True},
                },
                "required": ["name"],
            },
        }
    },
    "required": ["menus"],
}

# 사전에 없는 메뉴의 레시피를 물을 때. 모르면 모른다고 하게 만드는 게 핵심이다 —
# 없는 재료를 지어내면 원가가 조용히 틀린다.
_RECIPE_PROMPT = """한국 카페 메뉴의 표준 레시피를 알려주세요. 1잔 기준입니다.

메뉴: {names}

규칙:
- 흔히 쓰는 통상적인 양으로. 정확한 정답이 아니라 '보통 이 정도'면 됩니다.
- 단위는 g 또는 ml 또는 개 중 하나만 쓰세요.
- 얼음, 물, 컵, 뚜껑, 빨대는 넣지 마세요.
- 무엇이 들어가는지 확신할 수 없는 메뉴는 recipes를 빈 배열로 두세요. 추측하지 마세요.
"""

_RECIPE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "menu": {"type": "string"},
                    "recipes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ingredient": {"type": "string"},
                                "quantity": {"type": "number"},
                                "unit": {"type": "string"},
                            },
                            "required": ["ingredient", "quantity", "unit"],
                        },
                    },
                },
                "required": ["menu", "recipes"],
            },
        }
    },
    "required": ["items"],
}


async def _ask_gemini(parts: list[dict], schema: dict) -> dict[str, Any]:
    """Gemini에 JSON 스키마를 강제해 물어본다. 영수증 OCR과 같은 호출 규약을 쓴다."""
    from app.services.ai.ocr_service import (
        GEMINI_API_KEY,
        GEMINI_MODEL,
        _get_gemini_client,
        _parse_model_json,
    )

    if not GEMINI_API_KEY:
        raise MenuOcrError("GEMINI_API_KEY가 없어 메뉴판 인식을 사용할 수 없습니다.")

    generation_config: dict[str, Any] = {
        "temperature": 0,
        "responseMimeType": "application/json",
        "responseSchema": schema,
        "maxOutputTokens": 8192,
    }
    # OCR과 같은 이유로 추론을 끈다 — 읽어 적는 일에 사고 예산을 쓰면 출력이 잘린다
    from app.services.ai.gemini_config import apply_thinking
    apply_thinking(generation_config, GEMINI_MODEL)

    payload = {"contents": [{"parts": parts}], "generationConfig": generation_config}
    last: Exception | None = None
    quota_hit = False
    for attempt in (1, 2, 3):
        try:
            resp = await _get_gemini_client().post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}",
                json=payload,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                quota_hit = quota_hit or resp.status_code == 429
                last = MenuOcrError(f"Gemini HTTP {resp.status_code}")
                if attempt < 3:
                    # 429는 분 단위 한도라 2초 뒤 재시도해도 대개 또 걸린다 — 더 길게 쉰다
                    await asyncio.sleep((6 if resp.status_code == 429 else 2) * attempt)
                continue
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return _parse_model_json(text) or {}
        except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as e:
            last = e
            if attempt < 3:
                await asyncio.sleep(2 * attempt)

    # 사장님에게 'HTTP 429'는 아무 뜻이 없다. 무엇을 하면 되는지로 바꿔 말한다.
    if quota_hit:
        raise MenuOcrError("지금 AI 사용량이 많아 잠시 대기가 필요해요. 1~2분 뒤에 다시 시도해 주세요.")
    logger.warning("메뉴판 인식 실패: %s", last)
    raise MenuOcrError("메뉴판을 읽지 못했어요. 사진이 흐리면 더 밝은 곳에서 다시 찍어 주세요.")


async def _fill_missing_recipes(names: list[str]) -> dict[str, list[tuple[str, float, str]]]:
    """사전에 없는 메뉴들의 레시피를 Gemini에게 한 번에 물어본다.

    메뉴마다 부르면 느리고 비싸다 — 매출 임포트가 열 매핑을 한 번만 묻는 것과 같은 이유.
    실패하면 조용히 빈 dict를 돌려준다: 레시피가 없어도 메뉴 등록 자체는 계속돼야 한다.
    """
    if not names:
        return {}
    try:
        data = await _ask_gemini(
            [{"text": _RECIPE_PROMPT.format(names=", ".join(names))}], _RECIPE_SCHEMA
        )
    except MenuOcrError:
        logger.warning("사전에 없는 메뉴 레시피 조회 실패 — 레시피 없이 진행합니다", exc_info=True)
        return {}

    out: dict[str, list[tuple[str, float, str]]] = {}
    for item in data.get("items") or []:
        rs = []
        for r in item.get("recipes") or []:
            try:
                qty = float(r["quantity"])
            except (KeyError, TypeError, ValueError):
                continue
            if qty <= 0:
                continue
            rs.append((str(r["ingredient"]).strip(), qty, str(r.get("unit") or "g").strip()))
        if rs:
            out[str(item.get("menu") or "").strip()] = rs
    return out


def _store_ingredients(db, store_id: str) -> list[dict[str, Any]]:
    """매장 재료 목록 [{id, name, unit}].

    단위까지 들고 오는 이유: 표준 레시피는 원두를 g으로 말하는데 매장은 kg으로 등록한다.
    단위를 모르면 18g을 18kg으로 저장해 원가가 1000배가 된다.

    [dict가 아니라 list인 이유]
    이름을 키로 쓰면 같은 이름의 재료가 둘일 때 하나가 통째로 사라진다.
    실제로 '우유'를 팩·개로 따로 등록한 매장이 있을 수 있고, 그러면 사장님은
    화면에서 그 재료를 아예 고를 수 없게 된다.
    """
    from app.models.inventory import Ingredient

    rows = (
        db.query(Ingredient.id, Ingredient.name, Ingredient.unit)
        .filter(Ingredient.store_id == store_id)
        .all()
    )
    return [{"id": iid, "name": name, "unit": unit or ""} for iid, name, unit in rows]


async def read_menu_board(image_bytes: bytes, mime_type: str = "image/jpeg") -> list[dict[str, Any]]:
    """메뉴판 사진에서 '메뉴명 + 가격'만 읽는다 — [{"name", "price"}] (가격은 못 읽으면 None).

    등록(analyze_menu_board)과 개선안 점검(menu_review_service)이 함께 쓴다.
    점검 쪽은 레시피가 필요 없다 — 이름과 가격만 있으면 기존 메뉴와 대조할 수 있는데,
    등록용 흐름을 그대로 부르면 쓰지도 않을 표준 레시피를 AI에게 또 물어보게 된다
    (호출 1회·수 초가 통째로 낭비된다).
    """
    parts = [
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}},
        {"text": _MENU_PROMPT},
    ]
    data = await _ask_gemini(parts, _MENU_SCHEMA)

    raw = data.get("menus") or []
    if not raw:
        raise MenuOcrError("메뉴를 찾지 못했습니다. 메뉴판이 화면에 꽉 차게 다시 찍어 주세요.")

    # 이름 중복 제거 — 메뉴판에 ICE/HOT이 나뉘어 있으면 같은 이름이 두 번 나온다
    seen: set[str] = set()
    menus: list[dict[str, Any]] = []
    for m in raw:
        name = str(m.get("name") or "").strip()
        if not name:
            continue
        key = recipe_presets.normalize(name)
        if key in seen:
            continue
        seen.add(key)
        menus.append({"name": name, "price": _normalize_price(m.get("price"))})
    if not menus:
        raise MenuOcrError("메뉴를 찾지 못했습니다. 메뉴판이 화면에 꽉 차게 다시 찍어 주세요.")
    return menus


async def analyze_menu_board(db, store_id: str, image_bytes: bytes,
                             mime_type: str = "image/jpeg") -> dict[str, Any]:
    """메뉴판 사진 → 등록 초안. 저장하지 않는다 (사람이 확인한 뒤 confirm에서 저장).

    반환:
      {
        "menus": [
          {"name","price","exists",           # exists=이미 등록된 메뉴인가
           "recipe_source": "preset|ai|none", # 레시피를 어디서 가져왔나
           "recipes": [
             {"ingredient","quantity","unit",
              "ingredient_id",                # 매칭된 매장 재료 (없으면 None → 새로 등록 필요)
              "candidates": [...]}            # 후보가 여럿이면 화면에서 고르게 한다
           ]}
        ],
        "unknown_ingredients": [...]          # 매장에 없어 새로 만들어야 하는 재료
      }
    """
    from app.models.inventory import Menu

    menus = await read_menu_board(image_bytes, mime_type=mime_type)

    existing = {
        recipe_presets.normalize(n)
        for (n,) in db.query(Menu.name).filter(Menu.store_id == store_id).all()
    }
    store_ings = _store_ingredients(db, store_id)
    name_list = [s["name"] for s in store_ings]

    # 1차: 사전에서 채운다
    need_ai: list[str] = []
    for m in menus:
        preset = recipe_presets.lookup(m["name"])
        if preset:
            m["_raw_recipes"] = preset
            m["recipe_source"] = "preset"
        else:
            need_ai.append(m["name"])
            m["_raw_recipes"] = []
            m["recipe_source"] = "none"

    # 2차: 사전에 없는 것만 AI에게
    if need_ai:
        ai = await _fill_missing_recipes(need_ai)
        for m in menus:
            if m["recipe_source"] != "none":
                continue
            hit = ai.get(m["name"]) or next(
                (v for k, v in ai.items()
                 if recipe_presets.normalize(k) == recipe_presets.normalize(m["name"])),
                None,
            )
            if hit:
                m["_raw_recipes"] = hit
                m["recipe_source"] = "ai"

    # 재료를 매장 재고와 연결한다
    unknown: set[str] = set()
    for m in menus:
        rs = []
        for ing_name, qty, unit in m.pop("_raw_recipes"):
            cands = recipe_presets.match_ingredient(ing_name, name_list)
            # 후보를 매장 단위로 환산한 양까지 붙여 준다 — 고르는 순간 바로 쓸 수 있게.
            # 환산이 안 되는 재료(팩·개인데 이름에 용량이 없음)는 qty를 null로 두고
            # 화면에서 사장님이 직접 넣는다. 지어낸 숫자를 채우지 않는다.
            # 이름이 같은 재료가 둘 이상일 수 있으므로 이름 집합으로 걸러 전부 후보에 담는다
            matched = set(cands)
            cand_list = []
            for s in store_ings:
                if s["name"] not in matched:
                    continue
                conv = recipe_presets.convert_quantity(qty, unit, s["unit"], s["name"])
                cand_list.append({
                    "id": s["id"],
                    "name": s["name"],
                    "unit": s["unit"],
                    "quantity": conv,
                    # 표준 1단위(1g·1ml)당 매장 단위 값.
                    # 사장님이 화면에서 '18g'을 '20g'으로 고치면 화면이 이 값을 곱해
                    # 저장할 양을 다시 계산한다 — 환산 규칙을 프론트에 복사하지 않기 위해서다.
                    "ratio": (conv / qty) if (conv is not None and qty) else None,
                })

            auto = cand_list[0] if len(cand_list) == 1 else None
            rs.append({
                "ingredient": ing_name,
                # 표준 레시피가 말하는 원래 양 — 화면에 "원두 18g" 근거로 보여준다
                "preset_quantity": qty,
                "preset_unit": unit,
                # 실제로 저장될 양(매장 단위 기준). 못 정하면 null → 사장님이 입력한다
                "quantity": auto["quantity"] if auto else None,
                "unit": auto["unit"] if auto else unit,
                # 후보가 하나일 때만 자동 선택한다. 여럿이면 사장님이 고른다 —
                # 원두를 두 종류 쓰는 매장에서 임의로 고르면 원가가 조용히 틀린다.
                "ingredient_id": auto["id"] if auto else None,
                "candidates": cand_list,
            })
            if not cands:
                unknown.add(ing_name)
        m["recipes"] = rs
        m["exists"] = recipe_presets.normalize(m["name"]) in existing

    return {
        "menus": menus,
        "unknown_ingredients": sorted(unknown),
        # 화면에서 '추정치'임을 밝히기 위한 표시 — 사장님이 그대로 믿게 두면 안 된다
        "estimated": True,
    }


def confirm_menu_board(db, store_id: str, menus: list[dict[str, Any]]) -> dict[str, Any]:
    """확인·수정을 마친 메뉴들을 실제로 등록한다.

    이미 있는 메뉴는 건너뛴다 — 메뉴판을 두 번 찍어도 중복이 생기지 않아야 한다.
    재료가 연결되지 않은 레시피 줄은 버린다 (id 없이는 원가를 계산할 수 없다).

    저장은 하되 '이상해 보이는 것'은 warnings로 함께 돌려준다. 막지 않는 이유:
    원가가 판매가를 넘는 메뉴도, 레시피가 없는 메뉴도 실제로 있을 수 있다.
    다만 말없이 넘어가면 원가율 0%·5000%가 화면에 그냥 찍혀 아무도 눈치채지 못한다.
    """
    from sqlalchemy.exc import IntegrityError

    from app.models.inventory import Ingredient, Menu, Recipe

    # 원가율 점검용 재료 단가 (한 번만 읽는다)
    prices = {
        iid: float(p or 0)
        for iid, p in db.query(Ingredient.id, Ingredient.current_price)
        .filter(Ingredient.store_id == store_id).all()
    }
    # 중복 판정은 analyze와 같은 기준(정규화)을 쓴다.
    # 예전엔 여기만 이름 완전 일치라, analyze가 '이미 있음'으로 본 "카페 라떼"를
    # "카페라떼"로 다시 등록해 중복이 생겼다.
    existing = {
        recipe_presets.normalize(n): n
        for (n,) in db.query(Menu.name).filter(Menu.store_id == store_id).all()
    }

    created, skipped, warnings = [], [], []
    try:
        for m in menus:
            name = str(m.get("name") or "").strip()
            if not name:
                continue
            key = recipe_presets.normalize(name)
            if key in existing:
                skipped.append(name)
                continue

            # 음수 판매가는 어떤 경로로도 정상이 아니다 — 원가율이 음수로 나와 화면이 깨진다
            price = max(0, _normalize_price(m.get("price")) or 0)
            menu = Menu(store_id=store_id, name=name, selling_price=price)
            try:
                # SAVEPOINT로 감싼다 — 그냥 rollback하면 앞서 만든 메뉴까지 전부 날아간다.
                # 이 메뉴 하나만 되돌리고 나머지는 계속 등록해야 한다.
                with db.begin_nested():
                    db.add(menu)
                    db.flush()  # menu.id를 얻어야 레시피를 붙일 수 있다
            except IntegrityError:
                # 위 조회와 여기 사이에 다른 요청이 같은 메뉴를 넣었다.
                # DB 유니크 제약이 막아 준 것이므로 오류가 아니라 '이미 있음'으로 처리한다.
                skipped.append(name)
                existing[key] = name
                continue

            cost = 0.0
            rows = 0
            for r in m.get("recipes") or []:
                iid, qty = r.get("ingredient_id"), r.get("quantity")
                if not iid or not qty:
                    continue
                try:
                    iid, qty = int(iid), float(qty)
                except (TypeError, ValueError):
                    continue
                # prices는 이 매장 재료만 담고 있다 — 없는 id면 남의 매장 재료다.
                # 예전엔 클라이언트가 보낸 ingredient_id를 그대로 레시피에 박아서,
                # 그 메뉴가 팔릴 때마다 판매·OCR·예측이 재료 id만 보고 남의 매장
                # 재고를 깎았다(다섯 경로가 전부 id만으로 Stock을 찾는다).
                # sales_import_service.register_menus는 이미 같은 검사를 하고 있다.
                if qty <= 0 or iid not in prices:
                    continue
                db.add(Recipe(menu_id=menu.id, ingredient_id=iid, quantity=qty))
                cost += qty * prices.get(iid, 0.0)
                rows += 1

            if rows == 0:
                warnings.append(f"{name}: 레시피가 없어 원가가 0원으로 잡힙니다")
            elif price <= 0:
                # 가격을 못 읽은 메뉴 — 원가율을 낼 수 없어 원가 분석에서 빠진다
                warnings.append(f"{name}: 판매가가 없어 원가율을 낼 수 없습니다")
            elif cost > price:
                # 단위를 잘못 넣으면(18g을 18kg으로) 여기서 걸린다
                warnings.append(
                    f"{name}: 재료비 {cost:,.0f}원이 판매가 {price:,}원보다 큽니다 — 양·단위를 확인해 주세요"
                )

            existing[key] = name  # 같은 요청 안에 같은 메뉴가 두 번 있어도 한 번만
            created.append(name)

        db.commit()
    except Exception:
        # 중간에 터지면 앞서 만든 메뉴만 남아 반쯤 등록된 상태가 된다
        db.rollback()
        logger.exception("메뉴판 등록 실패 — 전부 되돌렸습니다 (%s)", store_id)
        raise

    # 경고가 수십 건이면 알림창이 화면을 넘어가 아무도 안 읽는다 — 앞의 몇 건만 보여주고
    # 나머지는 개수로 알린다 (전부 숨기면 문제가 더 있다는 걸 모른다)
    if len(warnings) > _MAX_WARNINGS:
        rest = len(warnings) - _MAX_WARNINGS
        warnings = warnings[:_MAX_WARNINGS] + [f"…확인이 필요한 메뉴가 {rest}개 더 있습니다"]

    return {"created": created, "skipped": skipped, "warnings": warnings}
