"""매장 주변 카페 조사·분석 (백엔드 B) — 상권 경쟁 인텔리전스

매장 "고정 위치"(회원가입 지도 핀 → users.store_lat/lon)를 기준으로

  1) 네이버 지역검색 API로 반경 안의 카페를 모으고            → find_nearby_cafes()
  2) 각 카페의 리뷰를 여러 소스에서 모아 Gemini로 분석하고        → analyze_cafe()
     · 네이버 블로그 검색 (기본)
     · 구글 지도 리뷰 — Places API (GOOGLE_PLACES_API_KEY 있을 때, 평점·리뷰 원문)
     · Tavily 웹 검색 — 다이닝코드·인스타그램·티스토리 등 그 밖의 사이트 (TAVILY_API_KEY 있을 때)
  3) 상권 전체를 놓고 "우리 매장은 무엇을 해야 하나"를 정리한다     → analyze_neighborhood()

앱의 매장 지도 화면이 이 결과를 마커+카드로 보여주고, 챗봇(브루)도 같은 함수를
nearby_cafe_tools.py의 @tool로 호출한다.

필요 키 (backend/.env):
  NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  — developers.naver.com '검색 API' (지역·블로그 검색)
  NCP_MAPS_CLIENT_ID / SECRET            — 좌표→행정동 역지오코딩 (없으면 좌표만으로 검색어를 못 만들어 빈 목록)
  GEMINI_API_KEY                         — 리뷰 분석 (없으면 수집 데이터만, 분석은 생략)
  GOOGLE_PLACES_API_KEY                  — [선택] 구글 지도 평점·리뷰 (없으면 구글 소스만 생략)
  TAVILY_API_KEY                         — [선택] 네이버·구글 밖 사이트의 후기 (없으면 해당 소스만 생략)

주의: 네이버 지역검색은 '반경 검색'을 지원하지 않는다(키워드 검색만, 한 번에 최대 5건).
      그래서 역지오코딩으로 얻은 행정동/구 이름으로 여러 키워드를 병렬 조회한 뒤,
      좌표 거리(haversine)로 반경을 직접 걸러 낸다.
"""

import json
import logging
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional
from urllib.parse import urlparse

from app.services.ai.untrusted import quote_untrusted

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

_TIMEOUT = 6.0            # 검색 API 하나가 느려도 지도 화면이 오래 멈추지 않게
_CAFE_TTL = 6 * 3600      # 주변 카페 목록 — 상권은 하루 단위로도 잘 안 바뀐다
_ANALYSIS_TTL = 12 * 3600 # 리뷰 분석 — Gemini 쿼터 절약 (팀 공유 키)

# 지역검색에 던질 키워드들. 한 번에 5건씩만 오므로 각도를 달리해 여러 번 던진다.
# (카페 = 프랜차이즈까지, 커피전문점/로스터리 = 원두 경쟁, 디저트/브런치 = 체류형 경쟁)
_CAFE_KEYWORDS = ["카페", "커피", "커피전문점", "로스터리", "디저트카페", "브런치카페"]

# 지역검색 category가 이 중 하나라도 포함해야 카페로 인정 (같은 상호의 학원·사무실 제외)
_CAFE_CATEGORY_HINTS = ("카페", "커피", "디저트", "베이커리", "제과", "차")

_cafe_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_analysis_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class NearbyCafeError(RuntimeError):
    """주변 카페 조회 실패 (키 미설정·네트워크·검색 실패)"""


# ---------------------------------------------------------------------------
# 공통 유틸
# ---------------------------------------------------------------------------

def _strip_tags(text: str) -> str:
    """네이버 검색 결과의 <b>강조</b> 태그와 HTML 엔티티를 걷어낸다."""
    clean = re.sub(r"<[^>]+>", "", text or "")
    for entity, ch in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                       ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        clean = clean.replace(entity, ch)
    return clean.strip()


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 좌표 사이 거리(m)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.asin(math.sqrt(a))


def _naver_headers() -> Optional[dict[str, str]]:
    cid = os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec):
        return None
    return {"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec}


def _search_naver(endpoint: str, query: str, display: int, sort: str) -> list[dict[str, Any]]:
    """네이버 검색 오픈API 공통 호출.

    지역검색을 여러 개 병렬로 던지면 초당 요청 제한에 걸려 429가 섞여 나온다(실측).
    한 건이 429로 비면 그 키워드의 카페가 통째로 빠지므로 짧게 한 번 재시도한다.
    """
    headers = _naver_headers()
    if not headers:
        return []
    import requests

    # 429는 실측에서 재시도 1회로 부족했다(라이브 로그에 키워드 3개가 통째로 유실).
    # 백오프를 늘려 3회까지 시도한다 — 전부 실패하면 그 키워드의 카페는 목록에서 빠지므로
    # 조용히 넘어가지 않고 경고를 남긴다.
    backoff = (0.5, 1.5)
    for attempt in (1, 2, 3):
        try:
            r = requests.get(
                f"https://openapi.naver.com/v1/search/{endpoint}.json",
                params={"query": query, "display": display, "sort": sort},
                headers=headers,
                timeout=_TIMEOUT,
            )
            if r.status_code in (401, 403):
                logger.warning("네이버 %s 검색 인증 실패(%s) — developers.naver.com 검색 API 키 확인",
                               endpoint, r.status_code)
                return []
            if r.status_code == 429 and attempt < 3:
                time.sleep(backoff[attempt - 1])  # 초당 요청 제한 — 쉬었다 재시도
                continue
            r.raise_for_status()
            return r.json().get("items", [])
        except Exception as e:
            if attempt < 3:
                time.sleep(backoff[attempt - 1])
                continue
            logger.warning("네이버 %s 검색 실패 — 이 키워드 결과는 빠집니다 (query=%s): %s",
                           endpoint, query, e)
    return []


def _search_local(query: str, display: int = 5, sort: str = "comment") -> list[dict[str, Any]]:
    """네이버 지역검색 — 상호·주소·좌표를 준다. sort=comment(리뷰순)/random(정확도순)."""
    return _search_naver("local", query, display, sort)


def _search_blog(query: str, display: int = 10, sort: str = "sim") -> list[dict[str, Any]]:
    """네이버 블로그 검색 — 카페 후기 글의 제목·요약을 준다 (공식 오픈API)."""
    return _search_naver("blog", query, display, sort)


# ---------------------------------------------------------------------------
# 리뷰 다중 소스 — 구글 지도(Places API) · Tavily 웹 검색
# 키가 없거나 실패하면 그 소스만 조용히 빠진다. 네이버 블로그만으로도 화면은 그대로 뜬다.
# ---------------------------------------------------------------------------

# Tavily 결과 도메인 → 화면에 보여줄 출처 이름 (모르는 도메인은 도메인 그대로)
_SOURCE_LABELS = {
    "google": "구글",
    "instagram": "인스타그램",
    "tistory": "티스토리",
    "diningcode": "다이닝코드",
    "mangoplate": "망고플레이트",
    "tripadvisor": "트립어드바이저",
    "brunch": "브런치",
    "youtube": "유튜브",
    "daum": "다음",
    "kakao": "카카오",
}


def _domain_label(url: str) -> str:
    """URL → 출처 이름. 예: https://www.diningcode.com/... → '다이닝코드'"""
    try:
        host = (urlparse(url).netloc or "").lower()
    except ValueError:
        return "웹"
    host = re.sub(r"^(www|m|blog)\.", "", host)
    for key, label in _SOURCE_LABELS.items():
        if key in host:
            return label
    return host or "웹"


def _google_place_reviews(name: str, area: str) -> Optional[dict[str, Any]]:
    """구글 지도(Places API)에서 평점·리뷰 원문을 가져온다.

    반환: {"rating", "rating_count", "link", "reviews": [리뷰 dict…]} 또는 None(키 없음·실패·불일치).
    검색 결과 상호가 요청 상호와 다르면 None — 엉뚱한 가게 리뷰를 붙이는 것보다 없는 편이 낫다.
    """
    key = os.getenv("GOOGLE_PLACES_API_KEY", "").strip()
    if not key:
        return None
    import requests

    try:
        r = requests.post(
            "https://places.googleapis.com/v1/places:searchText",
            json={"textQuery": f"{name} {area} 카페".strip(), "languageCode": "ko",
                  "maxResultCount": 1},
            headers={
                "X-Goog-Api-Key": key,
                # FieldMask에 적은 필드만 과금·반환된다 — 리뷰 분석에 쓰는 것만 요청
                "X-Goog-FieldMask": ("places.displayName,places.rating,places.userRatingCount,"
                                     "places.reviews,places.googleMapsUri"),
            },
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        places = r.json().get("places") or []
    except Exception as e:
        logger.warning("구글 지도 리뷰 조회 실패 — 이 소스만 생략 (name=%s): %s", name, e)
        return None
    if not places:
        return None

    place = places[0]
    got = re.sub(r"\s+", "", (place.get("displayName") or {}).get("text") or "").lower()
    want = re.sub(r"\s+", "", name).lower()
    if not (want and (want in got or got in want)):
        return None

    reviews = []
    for rv in (place.get("reviews") or [])[:5]:
        text = ((rv.get("text") or {}).get("text") or "").strip()
        if not text:
            continue
        reviews.append({
            "title": f"구글 리뷰 ★{rv.get('rating', '?')}",
            "snippet": text[:300],
            "link": place.get("googleMapsUri", ""),
            # 네이버 postdate(YYYYMMDD)와 형식을 맞춘다 — 화면이 한 가지 포맷만 다루게
            "date": (rv.get("publishTime") or "")[:10].replace("-", ""),
            "blogger": ((rv.get("authorAttribution") or {}).get("displayName") or ""),
            "source": "구글 지도",
        })
    return {
        "rating": place.get("rating"),
        "rating_count": place.get("userRatingCount"),
        "link": place.get("googleMapsUri", ""),
        "reviews": reviews,
    }


def _tavily_search(query: str, max_results: int = 6) -> list[dict[str, Any]]:
    """Tavily 웹 검색 공통 호출 — 키 없거나 실패하면 빈 목록."""
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key or key.startswith("tvly-Your"):
        return []
    import requests

    try:
        r = requests.post(
            "https://api.tavily.com/search",
            json={"query": query, "search_depth": "basic", "max_results": max_results,
                  "country": "south korea"},
            headers={"Authorization": f"Bearer {key}"},
            timeout=8.0,
        )
        r.raise_for_status()
        return r.json().get("results", [])
    except Exception as e:
        logger.warning("Tavily 검색 실패 — 이 소스만 생략 (query=%s): %s", query, e)
        return []


def _tavily_reviews(name: str, area: str) -> list[dict[str, Any]]:
    """네이버·구글 밖의 후기 — 다이닝코드·인스타그램·티스토리 등 (Tavily 웹 검색).

    네이버 도메인은 전용 검색(_search_blog)이 이미 다루므로 여기서는 걸러 낸다.
    """
    items = _tavily_search(f"{name} {area} 카페 리뷰 후기".strip())
    out = []
    for it in items:
        url = it.get("url", "")
        if "naver.com" in (urlparse(url).netloc or "").lower():
            continue
        content = (it.get("content") or "").strip()
        if not content:
            continue
        out.append({
            "title": _strip_tags(it.get("title", "")),
            "snippet": content[:300],
            "link": url,
            "date": (it.get("published_date") or "")[:10].replace("-", ""),
            "blogger": "",
            "source": _domain_label(url),
        })
    return out


def _interleave_reviews(*source_lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """소스별 목록을 번갈아 섞는다 — 상위 몇 건만 보여줘도 여러 사이트가 고루 보이게.

    같은 글이 두 소스로 들어오면 먼저 나온 쪽만 남긴다. 링크만으로 판정하면
    구글 리뷰(전부 같은 장소 링크)가 한 건으로 뭉개지므로 본문 앞부분까지 본다.
    """
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i in range(max((len(sl) for sl in source_lists), default=0)):
        for sl in source_lists:
            if i >= len(sl):
                continue
            item = sl[i]
            key = re.sub(r"\s+", "", f"{item.get('link', '')}|{item.get('snippet', '')[:60]}").lower()
            if key in seen:
                continue
            if key:
                seen.add(key)
            merged.append(item)
    return merged


def _region_names(lat: float, lon: float) -> dict[str, str]:
    """좌표 → {시도, 시군구, 읍면동, full}. 검색 키워드를 만들기 위해 필요하다."""
    from app.services.ai import forecast_service

    full = forecast_service._reverse_geocode(lat, lon)  # "서울특별시 강남구 역삼동"
    if full.startswith("위도"):  # 역지오코딩 실패 시 좌표 문자열이 돌아온다
        return {"sido": "", "sigungu": "", "dong": "", "full": ""}
    parts = full.split()
    return {
        "sido": parts[0] if len(parts) > 0 else "",
        "sigungu": parts[1] if len(parts) > 1 else "",
        "dong": parts[2] if len(parts) > 2 else "",
        "full": full,
    }


# ---------------------------------------------------------------------------
# 1) 주변 카페 수집
# ---------------------------------------------------------------------------

def _item_to_cafe(item: dict[str, Any], lat: float, lon: float) -> Optional[dict[str, Any]]:
    """지역검색 item → 카페 dict (좌표·거리 포함). 카페가 아니면 None."""
    category = _strip_tags(item.get("category", ""))
    if not any(hint in category for hint in _CAFE_CATEGORY_HINTS):
        return None
    try:
        # 네이버 지역검색 좌표는 WGS84 × 1e7 정수
        c_lon, c_lat = int(item["mapx"]) / 1e7, int(item["mapy"]) / 1e7
    except (KeyError, ValueError, TypeError):
        return None
    if not (c_lat and c_lon):
        return None

    name = _strip_tags(item.get("title", ""))
    return {
        "name": name,
        "category": category,
        "address": item.get("roadAddress") or item.get("address") or "",
        "telephone": item.get("telephone") or "",
        "link": item.get("link") or "",
        "lat": c_lat,
        "lon": c_lon,
        "distance_m": round(_haversine_m(lat, lon, c_lat, c_lon)),
    }


def find_nearby_cafes(lat: float, lon: float, radius_m: int = 1000, limit: int = 20,
                      exclude_name: str = "") -> dict[str, Any]:
    """매장 좌표 기준 반경 안의 카페 목록 (거리순).

    반환: {"region": "서울특별시 강남구 역삼동", "radius_m": 1000, "count": n, "cafes": [...]}
    카페 하나: {name, category, address, telephone, link, lat, lon, distance_m}
    """
    cache_key = f"{round(lat, 4)},{round(lon, 4)},{radius_m},{limit},{exclude_name}"
    hit = _cafe_cache.get(cache_key)
    if hit and time.time() - hit[0] < _CAFE_TTL:
        return {**hit[1], "cached": True}

    if not _naver_headers():
        raise NearbyCafeError(
            "네이버 검색 API 키가 없어 주변 카페를 조회할 수 없습니다 "
            "(backend/.env의 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET 확인)"
        )

    region = _region_names(lat, lon)
    if not region["full"]:
        raise NearbyCafeError(
            "매장 좌표의 행정동을 확인하지 못했습니다 (NCP Maps Reverse Geocoding 구독 확인 필요)"
        )

    # 동 이름이 가장 정확하고, 없으면 구 단위로 넓혀 찾는다
    base = region["dong"] or region["sigungu"] or region["sido"]
    area_prefix = f"{region['sigungu']} {base}".strip() if region["dong"] else base

    queries: list[tuple[str, str]] = []
    for kw in _CAFE_KEYWORDS:
        queries.append((f"{area_prefix} {kw}", "comment"))  # 리뷰 많은 순 = 상권 대표 매장
        queries.append((f"{base} {kw}", "random"))          # 정확도 순 = 신상·소규모까지
    # 구 단위 유명 카페도 한 번 — 동에 매물이 적은 상권 대비
    if region["sigungu"]:
        queries.append((f"{region['sigungu']} 카페", "comment"))

    # 검색 API 6~13회를 순차로 돌면 지도 화면이 수 초 멈춘다 → 병렬 조회.
    # 다만 동시성이 높으면 네이버가 429(초당 제한)를 뱉고 그 키워드 결과가 통째로 빈다.
    # 라이브에서 4는 429가 섞였다(실측) → 2로 낮춘다. 재시도 백오프와 합쳐 유실을 막는다.
    # 13개 질의 ÷ 2 워커 ≈ 2초로, 체감 속도는 그대로다.
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda q: _search_local(q[0], display=5, sort=q[1]), queries))

    excluded = re.sub(r"\s+", "", exclude_name).lower()
    seen: set[str] = set()
    cafes: list[dict[str, Any]] = []
    for items in results:
        for item in items:
            cafe = _item_to_cafe(item, lat, lon)
            if not cafe:
                continue
            if cafe["distance_m"] > radius_m:
                continue
            key = re.sub(r"\s+", "", f"{cafe['name']}|{cafe['address']}").lower()
            if key in seen:
                continue
            # 내 매장 자신은 경쟁 목록에서 뺀다 (상호가 같고 20m 안이면 본인으로 본다)
            if excluded and re.sub(r"\s+", "", cafe["name"]).lower() == excluded and cafe["distance_m"] < 50:
                continue
            seen.add(key)
            cafes.append(cafe)

    cafes.sort(key=lambda c: c["distance_m"])
    cafes = cafes[:limit]

    result = {"region": region["full"], "radius_m": radius_m, "count": len(cafes),
              "cafes": cafes, "cached": False}
    _cafe_cache[cache_key] = (time.time(), result)
    return result


# ---------------------------------------------------------------------------
# 2) Gemini 분석 (리뷰 수집 → 구조화)
# ---------------------------------------------------------------------------

def _gemini_json(prompt: str, schema: dict[str, Any], timeout: float = 25.0) -> Optional[dict[str, Any]]:
    """Gemini를 JSON 모드로 호출한다. 실패하면 None (수집 데이터만으로 화면은 그대로 뜬다)."""
    if not GEMINI_API_KEY:
        logger.info("GEMINI_API_KEY 없음 — 주변 카페 AI 분석 생략")
        return None

    generation_config: dict[str, Any] = {
        "temperature": 0.3,
        "responseMimeType": "application/json",
        "responseSchema": schema,
        "maxOutputTokens": 2048,
    }
    if GEMINI_MODEL.startswith("gemini-2.5"):
        # 2.5 계열은 기본 thinking이 출력 예산을 잠식해 JSON이 잘린다
        generation_config["thinkingConfig"] = {"thinkingBudget": 0}
    elif GEMINI_MODEL.startswith("gemini-3"):
        generation_config["thinkingConfig"] = {"thinkingLevel": "low"}

    import httpx

    # 503(모델 과부하)·429(쿼터 순간 초과)는 잠깐 뒤에 되면 되는 일시 오류다.
    # 여기서 포기하면 화면에 AI 카드가 통째로 사라지므로 한 번만 쉬었다 다시 던진다.
    for attempt in (1, 2):
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                json={"contents": [{"parts": [{"text": prompt}]}],
                      "generationConfig": generation_config},
                headers={"x-goog-api-key": GEMINI_API_KEY},
                timeout=timeout,
            )
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except httpx.HTTPStatusError as e:
            if attempt == 1 and e.response.status_code in (429, 500, 502, 503, 504):
                time.sleep(2.0)
                continue
            logger.warning("AI 분석 실패 (수집 데이터만 반환): %s", e)
            return None
        except Exception as e:
            logger.warning("AI 분석 실패 (수집 데이터만 반환): %s", e)
            return None
    return None


_CAFE_ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
        "signature_menus": {"type": "array", "items": {"type": "string"}},
        "price_level": {"type": "string"},
        "main_customers": {"type": "string"},
        "atmosphere": {"type": "string"},
        "sentiment": {"type": "string"},
        "counter_strategy": {"type": "string"},
    },
    "required": ["summary", "strengths", "weaknesses", "signature_menus",
                 "price_level", "main_customers", "atmosphere", "sentiment",
                 "counter_strategy"],
}

_CAFE_ANALYSIS_PROMPT = """너는 카페 사장님을 돕는 상권 분석가다.
아래는 경쟁 카페 한 곳에 대해 여러 사이트(네이버 블로그·구글 지도·다이닝코드 등)에서
모은 후기다. 각 줄 앞의 [출처]를 참고하되, 같은 내용이 여러 사이트에서 반복되면 더 믿을 만하다.
후기에서 실제로 드러난 사실만 근거로 분석하고, 근거가 없으면 "정보 부족"이라고 적어라.
광고성 문구는 걸러 내고, 사장님이 바로 참고할 수 있게 한국어로 간결하게 쓴다.

[카페 정보]
이름: {name}
분류: {category}
주소: {address}
내 매장에서 거리: {distance_m}m
구글 평점: {google_rating}

[여러 사이트 후기 {count}건]
{reviews}

[작성 규칙] 사장님은 바쁘다. 짧게, 명사형으로 쓴다. 미사여구·중복 금지.

- summary: 이 카페가 어떤 곳인지 한 문장(45자 이내)
- strengths / weaknesses: 후기에 반복되는 칭찬·불만 각 2~3개. **한 항목 12자 이내 명사구**
  (예: "커피 맛 호평", "좌석 부족", "저녁 일찍 마감")
- signature_menus: 후기에 자주 나오는 대표 메뉴 0~3개 (메뉴 이름만)
- price_level: "저가" / "보통" / "고가" / "정보 부족" 중 하나
- main_customers: 주 고객층 12자 이내 (예: "역삼역 직장인")
- atmosphere: 분위기 12자 이내 (예: "조용한 우드톤")
- sentiment: "긍정" / "보통" / "부정" / "정보 부족" 중 하나
- counter_strategy: 우리가 당장 할 수 있는 대응 한 문장(40자 이내)"""


def analyze_cafe(name: str, address: str = "", category: str = "",
                 distance_m: int = 0, region: str = "") -> dict[str, Any]:
    """경쟁 카페 한 곳의 후기를 여러 사이트에서 모아 Gemini로 분석한다.

    소스: 네이버 블로그(기본) + 구글 지도 리뷰(키 있을 때) + Tavily 웹 검색(키 있을 때).
    반환: {name, review_count, sources:{출처:건수}, google_rating, google_rating_count,
          reviews:[{title, snippet, link, date, blogger, source}], analysis:{...}|None}
    """
    cache_key = f"{name}|{address}"
    hit = _analysis_cache.get(cache_key)
    if hit and time.time() - hit[0] < _ANALYSIS_TTL:
        return {**hit[1], "cached": True}

    # 상호만으로 검색하면 동명이인 카페가 섞인다 → 지역명을 붙여 좁힌다
    area = ""
    for token in (region or address).split():
        if token.endswith(("동", "읍", "면", "가", "구", "시")):
            area = token
    query = f"{name} {area} 카페".strip() if area else f"{name} 카페"

    # 세 소스를 병렬로 — 순차로 돌면 지도 마커 탭이 수 초 멈춘다
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_naver = pool.submit(_search_blog, query, 10)
        f_google = pool.submit(_google_place_reviews, name, area)
        f_tavily = pool.submit(_tavily_reviews, name, area)
        naver_items = f_naver.result()
        google = f_google.result()
        tavily_reviews = f_tavily.result()

    naver_reviews = [{
        "title": _strip_tags(it.get("title", "")),
        "snippet": _strip_tags(it.get("description", "")),
        "link": it.get("link", ""),
        "date": it.get("postdate", ""),
        "blogger": it.get("bloggername", ""),
        "source": "네이버 블로그",
    } for it in naver_items]
    google_reviews = (google or {}).get("reviews") or []

    reviews = _interleave_reviews(naver_reviews, google_reviews, tavily_reviews)
    sources: dict[str, int] = {}
    for r in reviews:
        sources[r["source"]] = sources.get(r["source"], 0) + 1

    analysis = None
    if reviews:
        joined = "\n".join(f"- [{r['source']}] {r['title']} :: {r['snippet']}"
                           for r in reviews[:15])
        g_rating = "정보 없음"
        if google and google.get("rating") is not None:
            g_rating = f"{google['rating']}점 (리뷰 {google.get('rating_count') or '?'}개)"
        analysis = _gemini_json(
            _CAFE_ANALYSIS_PROMPT.format(
                name=name, category=category or "카페", address=address or "정보 없음",
                distance_m=distance_m, google_rating=g_rating, count=len(reviews),
                # 후기는 남이 쓴 글 — 지시문이 섞여 있어도 자료로만 읽히게 경계로 감싼다
                reviews=quote_untrusted(joined, max_len=5000),
            ),
            _CAFE_ANALYSIS_SCHEMA,
        )

    result = {
        "name": name,
        "address": address,
        "category": category,
        "distance_m": distance_m,
        "review_count": len(reviews),
        "sources": sources,
        "google_rating": (google or {}).get("rating"),
        "google_rating_count": (google or {}).get("rating_count"),
        "reviews": reviews[:6],   # 화면에는 상위 6건만 — 섞어 놓았으니 여러 사이트가 고루 보인다
        "analysis": analysis,
        "cached": False,
    }
    _analysis_cache[cache_key] = (time.time(), result)
    return result


_NEIGHBORHOOD_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "competition_level": {"type": "string"},
        "market_summary": {"type": "string"},
        "trends": {"type": "array", "items": {"type": "string"}},
        "opportunities": {"type": "array", "items": {"type": "string"}},
        "threats": {"type": "array", "items": {"type": "string"}},
        "actions": {"type": "array", "items": {"type": "string"}},
        "watch_list": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "competition_level", "market_summary", "trends",
                 "opportunities", "threats", "actions", "watch_list"],
}

_NEIGHBORHOOD_PROMPT = """너는 카페 사장님 전용 상권 분석가다.
아래는 내 매장 주변 반경 {radius_m}m 안의 카페 목록과, 이 동네 카페를 다룬 블로그 글 요약이다.
숫자와 근거에 기반해 분석하고, 사장님이 이번 주에 실행할 수 있는 수준으로 구체적으로 쓴다. 한국어.

[내 매장]
상호: {store_name}
위치: {region}
상권 유형: {biz_type}

[주변 카페 {count}곳 (가까운 순)]
{cafes}

[동네 카페 관련 글 {buzz_count}건 — 줄 앞 [출처] 표기]
{buzz}

[작성 규칙] 사장님은 바쁘다. 화면에 한눈에 들어와야 하므로 **짧게** 쓴다.
같은 말을 항목마다 반복하지 말고, 근거 없는 추측은 아예 빼라.

- headline: 이 상권을 한 문장으로 (30자 이내, 예: "로스터리 밀집 오피스 상권")
- competition_level: "낮음" / "보통" / "높음" / "매우 높음" 중 하나
- market_summary: 경쟁 밀도와 업태 구성을 두 문장 이내(80자 이내)
- trends: 동네 카페 트렌드 2개. **한 항목 20자 이내**
- opportunities: 비어 있는 자리(안 하는 메뉴·시간대·고객층) 2개. **20자 이내**
- threats: 실질적 위협 2개. **20자 이내** (경쟁 카페 이름을 쓰면 거리도 붙일 것)
- actions: 이번 주에 바로 해 볼 실행안 3개. **한 항목 30자 이내, 동사로 끝낼 것**
  (예: "디카페인 메뉴 메뉴판 상단에 배치")
- watch_list: 특히 주시할 경쟁 카페 이름 1~2개 (이름만)"""


def analyze_neighborhood(lat: float, lon: float, store_name: str = "내 매장",
                         biz_type: str = "", radius_m: int = 1000,
                         limit: int = 20) -> dict[str, Any]:
    """주변 카페를 모으고 상권 전체를 Gemini로 분석한다 (매장 지도 화면의 요약 카드용).

    반환: {region, radius_m, count, cafes:[...], insight:{...}|None}
    """
    found = find_nearby_cafes(lat, lon, radius_m=radius_m, limit=limit, exclude_name=store_name)
    cafes = found["cafes"]
    region = found["region"]

    if not cafes:
        return {**found, "insight": None}

    cache_key = f"insight|{round(lat, 4)},{round(lon, 4)}|{radius_m}|{store_name}"
    hit = _analysis_cache.get(cache_key)
    if hit and time.time() - hit[0] < _ANALYSIS_TTL:
        return {**found, "insight": hit[1], "cached": True}

    # 동네 분위기용 글 — 개별 카페가 아니라 상권 전체를 훑는다 (네이버 블로그 + 그 밖의 웹)
    dong = region.split()[-1] if region else ""
    buzz_lines: list[str] = []
    if dong:
        with ThreadPoolExecutor(max_workers=2) as pool:
            f_blog = pool.submit(_search_blog, f"{dong} 카페 추천", 10)
            f_web = pool.submit(_tavily_search, f"{dong} 카페 추천 핫플", 5)
            blog_items, web_items = f_blog.result(), f_web.result()
        buzz_lines = [
            f"- [네이버 블로그] {_strip_tags(it.get('title', ''))} :: {_strip_tags(it.get('description', ''))}"
            for it in blog_items
        ] + [
            f"- [{_domain_label(it.get('url', ''))}] {_strip_tags(it.get('title', ''))}"
            f" :: {(it.get('content') or '').strip()[:200]}"
            for it in web_items
            if "naver.com" not in (urlparse(it.get("url", "")).netloc or "").lower()
        ]
    buzz_count = len(buzz_lines)
    buzz = quote_untrusted("\n".join(buzz_lines), max_len=4000) if buzz_lines else "(수집된 글 없음)"

    cafe_lines = "\n".join(
        f"- {c['name']} | {c['category']} | {c['distance_m']}m | {c['address']}"
        for c in cafes
    )
    insight = _gemini_json(
        _NEIGHBORHOOD_PROMPT.format(
            radius_m=radius_m, store_name=store_name, region=region or "정보 없음",
            biz_type=biz_type or "미지정", count=len(cafes), cafes=cafe_lines,
            buzz_count=buzz_count, buzz=buzz,
        ),
        _NEIGHBORHOOD_SCHEMA,
    )
    if insight:
        _analysis_cache[cache_key] = (time.time(), insight)
    return {**found, "insight": insight}
