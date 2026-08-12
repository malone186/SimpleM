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


# 옵션 행은 메뉴가 아니다 — '샷추가 500원'·'사이즈업 500원'까지 평균에 넣으면 실제 객단가가
# 통째로 내려앉는다(실측: 4,929원 → 4,265원). 가격 축이 그만큼 어긋나므로 평균에서 뺀다.
_OPTION_WORDS = ("추가", "사이즈업", "업그레이드", "변경", "옵션", "포장", "캐리어", "일회용")

# 내 메뉴 중 '디저트/베이커리'로 볼 이름 — 주변 카페의 디저트 비중과 맞대 볼 기준이 된다.
_MY_DESSERT_WORDS = ("케이크", "티라미수", "크루아상", "마카롱", "쿠키", "브라우니", "스콘",
                     "베이글", "도넛", "와플", "빙수", "마들렌", "휘낭시에", "타르트", "파이",
                     "샌드위치", "토스트", "크로플", "빵", "디저트", "푸딩", "젤라또", "아이스크림")


def _menu_stats(menus: list[dict[str, Any]]) -> tuple[int, float]:
    """실제 판매 메뉴만 추려 (평균가, 디저트 비중)을 낸다. 옵션 행은 제외."""
    real = [m for m in menus if not any(w in m["name"] for w in _OPTION_WORDS)]
    if not real:
        real = menus
    if not real:
        return 0, 0.0
    avg = round(sum(m["price"] for m in real) / len(real))
    dessert = sum(1 for m in real if any(w in m["name"] for w in _MY_DESSERT_WORDS))
    return avg, dessert / len(real)


def _my_profile(store_id: str, region: str,
                linked_place: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """내부 DB 사실(메뉴·가격·업태) + 내 카페의 네이버 리뷰 분석(핵심 통찰)을 합친다.

    DB 조회는 세 테이블을 한 세션에서 끝낸다 — 원격 DB(Neon)는 왕복 자체가 비싸서
    세션을 세 번 여는 것만으로 응답이 눈에 띄게 늘어난다.
    """
    profile: dict[str, Any] = {"store_name": "", "biz_type": "카페", "menus": [],
                               "avg_price": 0, "dessert_ratio": 0.0,
                               "review_view": None, "review_source": "none"}
    try:
        from app.models.ai import StoreProfile
        from app.models.inventory import Menu
        from app.models.user import User
        from app.services.ai.document_service import _session

        with _session() as db:
            user = db.query(User).filter(User.email == store_id).first()
            if user:
                profile["store_name"] = user.store_name or ""
            sp = db.get(StoreProfile, store_id)
            if sp and sp.business_type:
                profile["biz_type"] = sp.business_type
            # 숨긴 메뉴(is_active=False)는 지금 파는 게 아니다 — 프로필에서 뺀다
            menus = (db.query(Menu)
                     .filter(Menu.store_id == store_id, Menu.selling_price > 0,
                             Menu.is_active.is_(True))
                     .order_by(Menu.id).limit(40).all())
            profile["menus"] = [{"name": m.name, "price": m.selling_price} for m in menus]
    except Exception:
        logger.debug("내 카페 DB 프로필 조회 실패", exc_info=True)
    profile["avg_price"], profile["dessert_ratio"] = _menu_stats(profile["menus"])

    # 내 카페의 '외부 평판' — 주변 카페와 완전히 같은 잣대(분위기·고객층·시그니처)를 얻는다.
    # 반드시 사장님이 지정한 장소(이름+주소)로만 조회한다: 상호만으로 검색하면 같은 이름의
    # 남의 카페 후기가 내 평판으로 둔갑해 분위기·고객층 축이 통째로 틀어진다
    # (my-cafe/analysis 엔드포인트가 같은 이유로 상호 검색을 거부한다).
    if linked_place and linked_place.get("name"):
        try:
            from app.services.ai import nearby_cafe_service

            mine = nearby_cafe_service.analyze_cafe(
                linked_place["name"],
                address=linked_place.get("address", ""),
                region=linked_place.get("address") or region,
            )
            a = mine.get("analysis") or {}
            if a:
                profile["review_view"] = {
                    "price_level": a.get("price_level", ""),
                    "atmosphere": a.get("atmosphere", ""),
                    "main_customers": a.get("main_customers", ""),
                    "signature_menus": a.get("signature_menus", []),
                }
                profile["review_source"] = "linked"
        except Exception:
            logger.debug("내 카페 리뷰 분석 실패 — DB 프로필만으로 채점", exc_info=True)
    else:
        profile["review_source"] = "unlinked"
    return profile


def _profile_text(p: dict[str, Any]) -> str:
    menu_line = ", ".join(f"{m['name']}({m['price']:,}원)" for m in p["menus"][:15]) or "메뉴 미등록"
    lines = [f"상호: {p['store_name'] or '이름 미등록'} / 업태: {p['biz_type']}",
             f"메뉴(실판매가): {menu_line}",
             f"평균 판매가: {p['avg_price']:,}원 (샷추가 등 옵션 제외)"
             if p["avg_price"] else "평균 판매가: 정보 없음",
             f"디저트·베이커리 비중: 메뉴의 {round(p.get('dessert_ratio', 0) * 100)}%"]
    rv = p.get("review_view")
    if rv:
        lines.append(
            "외부 리뷰 평판 — 가격대: {price_level} / 분위기: {atmosphere} / 고객층: {main_customers} / "
            "시그니처: {sig}".format(sig=", ".join(rv.get("signature_menus") or []) or "정보 없음", **rv))
    return "\n".join(lines)


# ── 간이 추정(폴백)이 읽는 상호·카테고리 신호 ────────────────────────────────
# 예전 폴백은 concept 말고 네 축을 전부 50으로 박아 두어, 어떤 동네에서든 모든 카페가
# 총점 53%(= 부분 경쟁)로 똑같이 나왔다. 배지가 전부 '유사 53%'라 정렬 자체가 무의미했고,
# 무료 쿼터가 막히는 순간(팀 공용 키라 흔하다) 기능이 통째로 죽은 것처럼 보였다.
# 추가 네트워크 호출 없이 얻는 신호(상호·카테고리 + 내 DB 프로필)만으로 가격대·메뉴 구성을
# 추정해 점수가 실제로 갈리게 한다. 정확도는 AI 채점보다 낮지만 순위는 뜻을 갖는다.
_LOW_COST_BRANDS = ("메가", "컴포즈", "빽다방", "더벤티", "매머드", "이디야", "텐퍼센트",
                    "커피에반하다", "바나프레소", "감성커피", "더리터")
_PREMIUM_BRANDS = ("폴바셋", "블루보틀", "테라로사", "앤트러사이트", "프릳츠", "커피리브레",
                   "센터커피")
# '메가'는 위 저가 목록이 먼저 잡는다(순서 의존) — 여기에 또 넣지 않는다.
_MAJOR_BRANDS = ("스타벅스", "투썸", "할리스", "엔제리너스", "커피빈", "파스쿠찌",
                 "탐앤탐스", "드롭탑", "카페베네", "공차")
# 디저트 전문점 판정은 '상호'로 한다. 네이버 카테고리의 '카페,디저트'는 동네 카페 대부분에
# 기본으로 붙는 일반 분류라, 여기서 '디저트'를 읽으면 평범한 카페까지 전부 베이커리로
# 둔갑해 한 점수에 뭉친다(실측: 13곳 중 7곳이 51% 동점).
_DESSERT_NAME_WORDS = ("베이글", "베이커리", "케이크", "도넛", "빙수", "와플", "브런치",
                       "디저트", "제과", "타르트", "마카롱", "크로플", "샌드위치", "토스트",
                       "젤라또", "아이스크림", "쿠키", "떡", "파이", "츄러스", "크레페")
# 카테고리에서 읽어도 안전한, 전문점에만 붙는 분류어 ('디저트'는 위 이유로 뺀다)
_DESSERT_CAT_WORDS = ("베이커리", "제과", "도넛", "빙수", "브런치", "떡", "아이스크림")
_THEME_WORDS = ("만화", "보드", "방탈출", "애견", "반려", "플라워", "오티티", "ott", "스터디",
                "무인", "룸카페", "키즈", "테마", "북카페", "갤러리", "공방", "펫")
_COFFEE_WORDS = ("커피", "coffee", "로스터", "로스팅", "에스프레소", "브루", "원두")

# 업태별 '메뉴 평균가' 어림값(원). 아메리카노 단가가 아니라 메뉴판 전체 평균 기준 —
# 내 avg_price(옵션 제외 평균)와 같은 잣대로 비교해야 가격 축이 뜻을 갖는다.
_BAND_LOW, _BAND_MAJOR, _BAND_PLAIN, _BAND_DESSERT, _BAND_PREMIUM, _BAND_THEME = (
    3200, 5500, 5000, 7000, 7500, 8000)


def _cafe_signals(cafe: dict[str, Any]) -> dict[str, Any]:
    """상호 + 카테고리에서 업태·가격대·디저트 비중을 추정한다."""
    name = (cafe.get("name") or "")
    low = name.lower()
    cat = (cafe.get("category") or "").split(">")[-1]
    catlow = cat.lower()

    is_theme = any(w in low for w in _THEME_WORDS) or any(w in catlow for w in _THEME_WORDS)
    is_dessert = (any(w in low for w in _DESSERT_NAME_WORDS)
                  or any(w in catlow for w in _DESSERT_CAT_WORDS))
    is_coffee = any(w in low for w in _COFFEE_WORDS) or "커피전문점" in cat
    if any(b in name for b in _LOW_COST_BRANDS):
        band, kind = _BAND_LOW, "저가 프랜차이즈"
    elif any(b in name for b in _PREMIUM_BRANDS):
        band, kind = _BAND_PREMIUM, "스페셜티"
    elif any(b in name for b in _MAJOR_BRANDS):
        band, kind = _BAND_MAJOR, "대형 프랜차이즈"
    elif is_theme:
        band, kind = _BAND_THEME, "테마 공간"
    elif is_dessert:
        band, kind = _BAND_DESSERT, "디저트·베이커리"
    else:
        band, kind = _BAND_PLAIN, "동네 카페"

    # menu_cap: 테마 공간은 음료를 팔아도 메뉴판이 부차적이다. 우연히 디저트 비중이
    # 겹쳤다는 이유로 '메뉴가 95% 같다'가 나오면(만화카페가 그랬다) 총점이 부풀려진다.
    menu_cap = 100
    if is_theme:
        dessert_ratio, concept, menu_cap = 0.35, 25, 55
    elif is_dessert:
        dessert_ratio, concept = 0.75, 55
    elif is_coffee:
        dessert_ratio, concept = 0.20, 85
    elif "카페" in catlow or "카페" in low:
        dessert_ratio, concept = 0.35, 70
    else:
        dessert_ratio, concept = 0.35, 45
    return {"kind": kind, "band": band, "dessert_ratio": dessert_ratio,
            "concept": concept, "menu_cap": menu_cap, "cat": cat or "카페"}


def _heuristic(cafes: list[dict[str, Any]], profile: dict[str, Any]) -> list[dict[str, Any]]:
    """AI 불가 시 폴백 — 상호·카테고리에서 읽은 업태를 내 프로필과 맞대 축별로 채점한다."""
    my_price = profile.get("avg_price") or 0
    my_dessert = profile.get("dessert_ratio") or 0.0
    out = []
    for c in cafes:
        s = _cafe_signals(c)

        # 가격: 두 평균가의 상대 격차. 20% 벌어질 때마다 약 25점씩 깎는다.
        if my_price:
            gap = abs(my_price - s["band"]) / max(my_price, s["band"])
            price = int(max(10, min(95, round(95 - gap * 125))))
        else:
            price = 50  # 메뉴를 아직 안 넣은 매장 — 비교 근거가 없으니 중립

        # 메뉴: 디저트 비중 차이. 우리가 커피 중심인데 상대가 베이커리면 지갑이 덜 겹친다.
        menu = int(max(15, min(95, round(95 - abs(my_dessert - s["dessert_ratio"]) * 130))))
        menu = min(menu, s["menu_cap"])

        concept = s["concept"]
        # 분위기·고객층은 직접 신호가 없다 — 컨셉·가격에서 끌어오되 중앙(50)으로 당겨
        # 근거 없이 극단으로 튀지 않게 한다(원래 이 두 축의 신뢰도가 가장 낮다).
        atmosphere = int(round(50 + (concept - 50) * 0.5 + (price - 50) * 0.2))
        customers = int(round(50 + (price - 50) * 0.5 + (concept - 50) * 0.3))

        axes = {"menu": menu, "price": price, "concept": concept,
                "atmosphere": max(5, min(95, atmosphere)),
                "customers": max(5, min(95, customers))}
        total = _weighted_total(axes)
        if my_price:
            reason = (f"{s['kind']}으로 보여 메뉴 평균가를 {s['band']:,}원대로 봤어요 "
                      f"(우리 {my_price:,}원). AI 채점이 아닌 간이 추정입니다.")
        else:
            reason = (f"{s['kind']}({s['cat']}) 기준 간이 추정 — 메뉴를 등록하면 "
                      f"가격·메뉴 비교가 훨씬 정확해져요.")
        out.append({"name": c["name"], "axes": axes, "total": total,
                    "tier": _tier(total), "reason": reason})
    return out


def score_nearby(store_id: str, cafes: list[dict[str, Any]], region: str = "",
                 linked_place: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """주변 카페들을 내 카페와 5축 비교해 유사도(0~100)를 매긴다. 일괄 1회 호출.

    상한은 목록 API가 내려 줄 수 있는 최대치(30)와 맞춘다 — 20에서 끊으면 반경을 넓혀
    30곳을 받은 사장님 화면에서 뒤쪽 열 곳만 배지가 사라져 채점이 실패한 것처럼 보인다.
    """
    cafes = [c for c in cafes if c.get("name")][:30]
    if not cafes:
        return {"engine": "none", "weights": WEIGHTS, "results": [], "note": ""}

    profile = _my_profile(store_id, region, linked_place)
    # 캐시 키에서 review_view는 뺀다 — 그 값은 analyze_cafe가 자체 캐시로 관리하고
    # 상호·주소가 같으면 같은 결과다. 넣어 두면 리뷰 문장이 조금 바뀔 때마다 키가 달라져
    # 채점 캐시가 사실상 매번 빗나간다.
    key_src = {k: v for k, v in profile.items() if k not in ("review_view",)}
    key = hashlib.md5((store_id + json.dumps(key_src, ensure_ascii=False, sort_keys=True)
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
        # AI 응답은 잘리거나 모양이 어긋날 수 있다 — name이 없는 항목이나 축 값이
        # null인 항목에서 KeyError/TypeError가 나면, 폴백(_heuristic)으로 내려가라고
        # 만든 아래 else가 무색하게 화면 전체가 500으로 죽었다.
        by_name = {
            r["name"]: r
            for r in raw["results"]
            if isinstance(r, dict) and r.get("name")
        }
        results = []
        for c in cafes:
            r = by_name.get(c["name"])
            if not r:  # AI가 빠뜨린 카페는 간이 추정으로 메꾼다
                results.append(_heuristic([c], profile)[0])
                continue
            axes = {k: max(0, min(100, int(r.get(k) or 50))) for k in WEIGHTS}
            total = _weighted_total(axes)
            results.append({"name": c["name"], "axes": axes, "total": total,
                            "tier": _tier(total), "reason": str(r.get("reason", ""))[:120]})
    else:
        engine = "heuristic"
        results = _heuristic(cafes, profile)

    # 동점이면 가까운 곳을 앞에 — 순위가 매번 뒤집혀 보이지 않게 정렬을 완전히 결정론으로 둔다
    order = {c["name"]: i for i, c in enumerate(cafes)}
    results.sort(key=lambda r: (-r["total"], order.get(r["name"], 999)))

    # 화면이 결과를 어디까지 믿어야 하는지 알려 준다 — 채점이 왜 거칠어졌는지 밝히지 않으면
    # 사장님은 '기능이 고장 났다'로 읽는다.
    if engine == "heuristic":
        note = "AI 채점이 잠시 어려워 상호·업태 기준 간이 추정으로 보여 드려요."
    elif not profile["avg_price"]:
        note = "메뉴를 등록하면 메뉴·가격 비교가 훨씬 정확해져요."
    elif profile.get("review_source") == "unlinked":
        note = "'내 카페'를 지정하면 분위기·고객층까지 우리 가게 후기로 비교해요."
    else:
        note = ""

    out = {"engine": engine, "weights": WEIGHTS, "note": note,
           "my_profile": {"store_name": profile["store_name"], "avg_price": profile["avg_price"],
                          "menu_count": len(profile["menus"]),
                          "dessert_ratio": round(profile.get("dessert_ratio", 0.0), 2),
                          "review_source": profile.get("review_source", "none"),
                          "has_review_view": profile.get("review_view") is not None},
           "results": results}
    _score_cache[key] = (time.time(), out)
    return out
