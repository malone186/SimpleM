"""내 카페 ↔ 주변 카페 유사도 채점 (백엔드 B)

핵심 설계: '내 카페'도 네이버에 있는 가게다 — 주변 카페에 쓰는 리뷰 분석 파이프라인
(nearby_cafe_service.analyze_cafe)을 내 매장 이름으로 한 번 돌려, 남들이 보는 내 카페
(분위기·고객층·시그니처)를 얻는다. 여기에 내부 DB의 확실한 사실(메뉴·가격·업태)을 합쳐
'내 카페 프로필'을 만들고, 주변 카페들과 5개 축으로 비교해 0~100% 유사도를 매긴다.

── 비교 축과 가중치 (합 100) ─────────────────────────────────────────────
  menu       30  메뉴 구성   — 같은 걸 팔수록 같은 지갑을 두고 싸운다(대체가능성 1순위).
                              내 DB의 실제 메뉴 목록이라 데이터 신뢰도도 가장 높다.
  price      25  가격대     — 메뉴가 겹쳐도 가격대가 다르면 고객이 갈린다(대체가능성 2순위).
                              내 쪽은 실판매가 평균이라 역시 신뢰도 높음.
  concept    20  업태/컨셉  — 방문 목적(커피/디저트/스터디)이 같아야 비교 대상이 된다.
                              네이버 카테고리 기반이라 명확하지만 굵은 분류라 3순위.
  atmosphere 15  분위기     — 목적이 같아도 감성으로 선택이 갈린다. 단 양쪽 다 리뷰
                              '추정'이라 신뢰도가 낮아 비중을 절제.
  customers  10  고객층     — 중요하지만 가격·컨셉·분위기의 결과로 따라오는 종속 변수
                              성격 + 추정 신뢰도 최저 → 최저 비중.
  원칙: ① 지갑이 겹치는 정도(대체가능성)에 직결될수록 높게,
        ② 실데이터(내 DB) 기반 축일수록 리뷰 추정 축보다 높게.
──────────────────────────────────────────────────────────────────────────

총점은 Gemini가 아니라 파이썬이 가중합으로 계산한다 — 축별 점수만 AI에 맡기고
합산 규칙은 결정론으로 고정해, 같은 축 점수면 항상 같은 총점이 나온다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

WEIGHTS = {"menu": 30, "price": 25, "concept": 20, "atmosphere": 15, "customers": 10}

_SCORE_TTL = 6 * 3600          # 채점 캐시 6시간 — 메뉴·리뷰가 하루 안에 급변하지 않는다
_FALLBACK_TTL = 5 * 60         # 간이 추정은 5분만 — 쿼터가 풀리면 곧 AI 채점으로 돌아오게
_score_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_AXIS_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "menu": {"type": "integer"},        # 0~100
                    "price": {"type": "integer"},
                    "concept": {"type": "integer"},
                    "atmosphere": {"type": "integer"},
                    "customers": {"type": "integer"},
                    "reason": {"type": "string"},       # 한 줄 근거
                },
                "required": ["name", "menu", "price", "concept",
                             "atmosphere", "customers", "reason"],
            },
        },
    },
    "required": ["results"],
}

_PROMPT = """너는 카페 상권 분석가다. '내 카페'와 주변 카페들의 유사도를 축별로 채점한다.

[내 카페]
{my_profile}

[주변 카페 목록]
{cafes}

각 주변 카페마다 아래 5개 축을 0~100 정수로 채점하라 (높을수록 내 카페와 비슷):
- menu: 파는 메뉴 구성이 겹치는 정도 (이름·카테고리에서 추정. 디저트 전문 vs 커피 중심 구분)
- price: 가격대가 비슷한 정도 (프랜차이즈 저가/일반/스페셜티 프리미엄 등으로 추정)
- concept: 업태·방문 목적이 같은 정도 (커피전문/디저트카페/스터디/테마)
- atmosphere: 분위기·감성이 비슷한 정도
- customers: 주 고객층이 겹치는 정도
정보가 부족한 축은 카테고리·이름·지역 상식으로 보수적으로(50 근처) 추정하라.
reason은 사장님이 읽을 한국어 한 문장 — 가장 점수를 가른 축을 짚어라.
카페 이름(name)은 입력 그대로 돌려준다. JSON만 반환한다."""


def _tier(total: int) -> str:
    if total >= 80:
        return "직접 경쟁"
    if total >= 50:
        return "부분 경쟁"
    return "보완 관계"


def _weighted_total(axes: dict[str, int]) -> int:
    s = sum(WEIGHTS[k] * max(0, min(100, int(axes.get(k, 50)))) for k in WEIGHTS)
    return round(s / 100)


def _my_profile(store_id: str, region: str) -> dict[str, Any]:
    """내부 DB 사실(메뉴·가격·업태) + 내 카페의 네이버 리뷰 분석(핵심 통찰)을 합친다."""
    profile: dict[str, Any] = {"store_name": "", "biz_type": "카페",
                               "menus": [], "avg_price": 0, "review_view": None}
    try:
        from app.models.user import User
        from app.services.ai.document_service import _session

        with _session() as db:
            user = db.query(User).filter(User.email == store_id).first()
            if user:
                profile["store_name"] = user.store_name or ""
    except Exception:
        pass
    try:
        from app.models.ai import StoreProfile
        from app.services.ai.document_service import _session

        with _session() as db:
            sp = db.get(StoreProfile, store_id)
            if sp and sp.business_type:
                profile["biz_type"] = sp.business_type
    except Exception:
        pass
    try:
        from app.models.inventory import Menu
        from app.services.ai.document_service import _session

        with _session() as db:
            menus = (db.query(Menu).filter(Menu.store_id == store_id, Menu.selling_price > 0)
                     .order_by(Menu.id).limit(20).all())
            profile["menus"] = [{"name": m.name, "price": m.selling_price} for m in menus]
            if menus:
                profile["avg_price"] = round(sum(m.selling_price for m in menus) / len(menus))
    except Exception:
        pass

    # 내 카페의 '외부 평판' — 주변 카페와 완전히 같은 잣대(분위기·고객층·시그니처)를 얻는다.
    # analyze_cafe 자체 캐시(TTL)가 있어 반복 호출 부담이 없다.
    if profile["store_name"]:
        try:
            from app.services.ai import nearby_cafe_service

            mine = nearby_cafe_service.analyze_cafe(profile["store_name"], region=region)
            a = mine.get("analysis") or {}
            if a:
                profile["review_view"] = {
                    "price_level": a.get("price_level", ""),
                    "atmosphere": a.get("atmosphere", ""),
                    "main_customers": a.get("main_customers", ""),
                    "signature_menus": a.get("signature_menus", []),
                }
        except Exception:
            logger.debug("내 카페 리뷰 분석 실패 — DB 프로필만으로 채점", exc_info=True)
    return profile


def _profile_text(p: dict[str, Any]) -> str:
    menu_line = ", ".join(f"{m['name']}({m['price']:,}원)" for m in p["menus"][:15]) or "메뉴 미등록"
    lines = [f"상호: {p['store_name'] or '이름 미등록'} / 업태: {p['biz_type']}",
             f"메뉴(실판매가): {menu_line}",
             f"평균 판매가: {p['avg_price']:,}원" if p["avg_price"] else "평균 판매가: 정보 없음"]
    rv = p.get("review_view")
    if rv:
        lines.append(
            "외부 리뷰 평판 — 가격대: {price_level} / 분위기: {atmosphere} / 고객층: {main_customers} / "
            "시그니처: {sig}".format(sig=", ".join(rv.get("signature_menus") or []) or "정보 없음", **rv))
    return "\n".join(lines)


def _heuristic(cafes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """AI 불가 시 폴백 — 카테고리 일치 중심의 보수적 추정 (concept만 실제 신호)."""
    out = []
    for c in cafes:
        cat = (c.get("category") or "").split(">")[-1]
        if any(k in cat for k in ("스터디", "무인", "만화", "보드")):
            concept = 35  # '카페'가 이름에 붙어도 방문 목적이 다른 업태
        elif "커피" in cat:
            concept = 85
        elif "디저트" in cat or "카페" in cat:
            concept = 65
        else:
            concept = 40
        axes = {"menu": 50, "price": 50, "concept": concept, "atmosphere": 50, "customers": 50}
        out.append({"name": c["name"], "axes": axes, "total": _weighted_total(axes),
                    "tier": _tier(_weighted_total(axes)),
                    "reason": f"카테고리({cat or '카페'}) 기준 간이 추정"})
    return out


def score_nearby(store_id: str, cafes: list[dict[str, Any]], region: str = "") -> dict[str, Any]:
    """주변 카페들을 내 카페와 5축 비교해 유사도(0~100)를 매긴다. 일괄 1회 호출."""
    cafes = [c for c in cafes if c.get("name")][:20]
    if not cafes:
        return {"engine": "none", "weights": WEIGHTS, "results": []}

    profile = _my_profile(store_id, region)
    key = hashlib.md5((store_id + json.dumps(profile, ensure_ascii=False, sort_keys=True)
                       + "|".join(sorted(c["name"] for c in cafes))).encode()).hexdigest()
    hit = _score_cache.get(key)
    if hit:
        # 간이 추정(heuristic)은 Gemini가 막혔을 때의 임시 결과다. AI 채점과 똑같이
        # 6시간 들고 있으면, 쿼터가 잠깐 429였던 대가로 반나절 내내 모든 카페가
        # 같은 점수(예: 전부 53%)로 보인다 — 유사도순 정렬도 무의미해진다.
        ttl = _SCORE_TTL if hit[1].get("engine") == "ai" else _FALLBACK_TTL
        if time.time() - hit[0] < ttl:
            return {**hit[1], "cached": True}

    cafe_lines = "\n".join(
        f"- {c['name']} (카테고리: {(c.get('category') or '카페').split('>')[-1]}, "
        f"거리 {c.get('distance_m', '?')}m)" for c in cafes)

    from app.services.ai.nearby_cafe_service import _gemini_json

    raw = _gemini_json(_PROMPT.format(my_profile=_profile_text(profile), cafes=cafe_lines),
                       _AXIS_SCHEMA, timeout=30.0)

    engine = "ai"
    if raw and raw.get("results"):
        by_name = {r["name"]: r for r in raw["results"]}
        results = []
        for c in cafes:
            r = by_name.get(c["name"])
            if not r:  # AI가 빠뜨린 카페는 간이 추정으로 메꾼다
                results.append(_heuristic([c])[0])
                continue
            axes = {k: max(0, min(100, int(r.get(k, 50)))) for k in WEIGHTS}
            total = _weighted_total(axes)
            results.append({"name": c["name"], "axes": axes, "total": total,
                            "tier": _tier(total), "reason": str(r.get("reason", ""))[:120]})
    else:
        engine = "heuristic"
        results = _heuristic(cafes)

    results.sort(key=lambda r: -r["total"])
    out = {"engine": engine, "weights": WEIGHTS,
           "my_profile": {"store_name": profile["store_name"], "avg_price": profile["avg_price"],
                          "menu_count": len(profile["menus"]),
                          "has_review_view": profile.get("review_view") is not None},
           "results": results}
    _score_cache[key] = (time.time(), out)
    return out
