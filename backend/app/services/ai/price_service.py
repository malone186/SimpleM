"""인터넷 가격 비교 (백엔드 B) — 발주 추천 보조

발주할 재료를 인터넷 가격비교 사이트에서 검색해 최저가 후보들을 돌려준다.

소스:
  다나와  : 검색 결과 HTML 파싱 — 다나와 자체가 여러 쇼핑몰 최저가를 모아 보여주는 곳이라
            상품 링크로 이동하면 몰별 가격 비교표까지 볼 수 있다. (키 불필요)
  네이버쇼핑 : 공식 오픈API — backend/.env에 NAVER_CLIENT_ID/SECRET가 있으면 자동 활성화.

주의: 소매가 기준 참고 정보다. 실제 발주는 사장님이 확인 후 진행한다 (PRD §5.3).
"""

import logging
import os
import re
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
}
_TIMEOUT = 8          # 소스 하나가 느려도 발주 화면이 오래 멈추지 않게
_CACHE_TTL = 3600     # 같은 검색어는 1시간 재사용 (쿼터·트래픽 절약)
_RELEVANCE_POOL = 12  # 검색 상위 N개 안에서만 최저가를 고른다 (엉뚱한 상품 방지)

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class PriceError(RuntimeError):
    """가격 비교 실패 (네트워크·파싱)"""


def _clean_query(name: str) -> str:
    """'종이컵 12oz (줄(50개))' → '종이컵 12oz' — 단위 괄호는 검색 품질을 떨어뜨린다."""
    return re.sub(r"\s*\(.*\)\s*$", "", name).strip()


def _parse_price(text: str) -> Optional[int]:
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else None


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[\s/·,()\[\]]+", text) if len(t) >= 2]


# 검색어에 없는데 상품에 들어 있으면 '형태가 다른 상품'으로 보는 키워드 —
# 원두를 찾는데 드립백·캡슐이 최저가로 잡히는 것을 막는다 (카페 재료 도메인 휴리스틱)
_FORM_KEYWORDS = ["드립백", "핸드드립", "티백", "캡슐", "커피믹스", "믹스커피",
                  "스틱", "파우치", "액상", "콜드브루", "더치"]


def _match_level(query: str, item: dict) -> int:
    """검색어 단어가 얼마나 정확히 매칭되는지 — 2: 상품명에 전부, 1: 상품명+스펙에 전부, 0: 불일치.

    '에티오피아 원두' 검색에서 드립백(스펙에만 '원두')보다 진짜 원두 상품(이름에 '원두')을
    우선하기 위한 2단계 판정이다.
    """
    q = query.replace(" ", "").lower()
    name = item["name"].replace(" ", "").lower()
    haystack = f"{name}{item.get('spec', '').replace(' ', '').lower()}"
    # 검색어에 없는 형태 키워드(드립백 등)가 상품에 있으면 다른 형태의 상품 → 제외
    if any(kw in haystack and kw not in q for kw in _FORM_KEYWORDS):
        return 0
    toks = [t.replace(" ", "").lower() for t in _tokens(query)]
    if all(t in name for t in toks):
        return 2
    if all(t in haystack for t in toks):
        return 1
    return 0


# ---------------------------------------------------------------------------
# 소스별 검색
# ---------------------------------------------------------------------------

def _danawa_search(query: str) -> list[dict[str, Any]]:
    """다나와 검색 — 상품명·최저가·스펙·상품 페이지(몰별 가격 비교표) 링크."""
    import requests
    from bs4 import BeautifulSoup

    r = requests.get(
        "https://search.danawa.com/dsearch.php",
        params={"query": query},
        headers=_HEADERS,
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")

    results = []
    for item in soup.select("li.prod_item")[:_RELEVANCE_POOL]:
        name_el = item.select_one("p.prod_name a")
        price_el = item.select_one("p.price_sect a strong") or item.select_one("p.price_sect strong")
        if not name_el or not price_el:
            continue
        price = _parse_price(price_el.get_text())
        link = name_el.get("href") or ""
        if not price or "prod.danawa.com" not in link:
            continue
        spec_el = item.select_one("div.spec_list")
        results.append({
            "name": name_el.get_text(strip=True),
            "price": price,
            "source": "다나와",
            "mall": "다나와 최저가 (몰별 비교는 링크에서)",
            "link": link,
            "spec": spec_el.get_text(" ", strip=True)[:80] if spec_el else "",
        })
    return results


def _naver_search(query: str) -> list[dict[str, Any]]:
    """네이버 쇼핑 공식 오픈API — 키가 .env에 있을 때만 호출된다."""
    import requests

    client_id = os.getenv("NAVER_CLIENT_ID", "")
    client_secret = os.getenv("NAVER_CLIENT_SECRET", "")
    if not (client_id and client_secret):
        return []

    r = requests.get(
        "https://openapi.naver.com/v1/search/shop.json",
        params={"query": query, "display": _RELEVANCE_POOL, "sort": "sim"},
        headers={"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    results = []
    for it in r.json().get("items", []):
        price = _parse_price(it.get("lprice", ""))
        if not price:
            continue
        results.append({
            "name": re.sub(r"</?b>", "", it.get("title", "")),  # 검색어 강조 태그 제거
            "price": price,
            "source": "네이버쇼핑",
            "mall": it.get("mallName", ""),
            "link": it.get("link", ""),
            "spec": "",
        })
    return results


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def compare_prices(product_name: str, current_price: int = 0, limit: int = 5) -> dict[str, Any]:
    """상품명으로 인터넷 가격을 비교한다.

    반환: {query, current_price, results(가격 오름차순 상위 limit개), best, saving_pct, sources}
    saving_pct: 현재 매입 단가 대비 최저가 절감률(%) — current_price가 0이면 None.
    """
    query = _clean_query(product_name)
    if not query:
        raise PriceError("상품명이 비어 있습니다")

    cached = _cache.get(query)
    if cached and time.time() - cached[0] < _CACHE_TTL:
        data = cached[1]
    else:
        results: list[dict[str, Any]] = []
        sources: list[str] = []
        for source_fn, source_name in ((_danawa_search, "다나와"), (_naver_search, "네이버쇼핑")):
            try:
                found = source_fn(query)
                results.extend(found)
                if found:
                    sources.append(source_name)
            except Exception:
                logger.warning("가격 소스 실패: %s (%s) — 다른 소스로 계속", source_name, query, exc_info=True)
        if not results:
            raise PriceError(f"'{query}'의 가격 정보를 가져오지 못했습니다 — 잠시 후 다시 시도하세요")
        # 가장 정확한 매칭 그룹만 후보로: 상품명 완전 일치 > 상품명+스펙 일치 > 전체(유사 상품)
        by_level = {2: [], 1: [], 0: []}
        for r in results:
            by_level[_match_level(query, r)].append(r)
        pool = by_level[2] or by_level[1] or results
        matched = bool(by_level[2] or by_level[1])
        pool.sort(key=lambda x: x["price"])
        data = {"results": pool, "sources": sources, "matched_all_terms": matched}
        _cache[query] = (time.time(), data)

    top = data["results"][:limit]
    best = top[0]
    saving_pct = None
    if current_price > 0:
        saving_pct = round((current_price - best["price"]) / current_price * 100, 1)
    return {
        "query": query,
        "current_price": current_price,
        "results": top,
        "best": best,
        "saving_pct": saving_pct,  # 양수 = 현재 단가보다 저렴
        "matched_all_terms": data["matched_all_terms"],  # False = 유사 상품 기준 (참고만)
        "sources": data["sources"],
        "note": "소매가 기준 참고 정보입니다. 대량 구매(도매) 조건은 링크에서 직접 확인하세요.",
    }
