"""원두 시세 감시 (백엔드 B) — 생두모아 현재가를 갱신하고 '가격 하락'을 찾아낸다.

알림 크론(notification_service)이 하루 한 번 부른다:
  1) 생두모아 목록 페이지(~25장)만 가볍게 긁어 상품명→현재가를 얻고
  2) DB(RoasteryBean)에 이름으로 매칭해 가격을 갱신하면서
  3) 기존가 대비 min_pct% 이상 내린 원두를 하락 목록으로 돌려준다.

상세페이지 1,100장을 매일 도는 대신 목록만 봐서 요청을 25번으로 줄인다(예의).
결과는 프로세스 내 하루 캐시로 보관 — 매장 순회 중 재크롤을 막는다.
환경변수 BEAN_PRICE_WATCH=0 이면 전체 비활성(크롤 없이 빈 목록).
"""
from __future__ import annotations

import html
import logging
import os
import re
import time
import urllib.request
from datetime import date
from typing import Any, Optional
from app.utils.datetime_kst import today_kst

logger = logging.getLogger(__name__)

BASE = "https://saengdoo-moa.com"
UA = "Mozilla/5.0 (compatible; BrewNoteResearch/0.1)"
MAX_PAGES = 30
REQUEST_DELAY = 0.3  # 초 — 하루 1회 25요청이지만 그래도 간격을 둔다
MIN_DROP_PCT = float(os.getenv("BEAN_PRICE_MIN_DROP_PCT", "7"))

_CARD = re.compile(r'<a\b[^>]*href="/products/(\d+)[^"]*"[^>]*>(.*?)</a>', re.DOTALL)

# 하루 캐시: (날짜, 하락 목록) — run_all이 매장 수만큼 돌아도 크롤은 하루 한 번
_cache: dict[str, Any] = {"day": None, "drops": []}


def _flat(s: str) -> str:
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", str(s or "")).lower()


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", "replace")


def fetch_current_prices() -> dict[str, int]:
    """생두모아 목록에서 {정규화된 상품명: 현재가(원/kg)}를 모은다. 실패는 빈 dict."""
    out: dict[str, int] = {}
    try:
        for p in range(1, MAX_PAGES + 1):
            h = _fetch(f"{BASE}/?page={p}")
            ci, ti = h.find('data-view-panel="card"'), h.find('data-view-panel="table"')
            if ci != -1:
                h = h[ci:(ti if ti > ci else len(h))]
            found = 0
            for _pid, body in _CARD.findall(h):
                b = _flat(body)
                pm = re.search(r"([\d,]+)\s*원/kg", b)
                if not pm:
                    continue
                price = int(pm.group(1).replace(",", ""))
                om = re.match(r"([가-힣A-Za-z]+)\s", b)
                origin = om.group(1) if om else ""
                nm = re.search(
                    r"^\s*" + (re.escape(origin) + r"\s+" if origin else "")
                    + r"(.+?)\s*" + re.escape(pm.group(1)) + r"\s*원/kg", b)
                name = nm.group(1).strip() if nm else ""
                if name and _norm(name) not in out:
                    out[_norm(name)] = price
                    found += 1
            if found == 0:
                break
            time.sleep(REQUEST_DELAY)
    except Exception as e:
        logger.warning("[원두 시세] 크롤 실패 — 이번 회차 건너뜀: %s", e)
    return out


def refresh_and_find_drops(db, min_pct: float = MIN_DROP_PCT) -> list[dict[str, Any]]:
    """현재가를 DB에 반영하고, min_pct% 이상 내린 원두를 하락폭 순으로 돌려준다.

    매칭은 정규화 이름 기준(생두모아 수집분과 이름이 같아야 함). 값이 오른 경우도
    가격은 갱신하되 알림 대상은 '하락'만이다 — 사장님에게 좋은 소식만 푸시한다.
    """
    from app.models.roastery import RoasteryBean

    current = fetch_current_prices()
    if not current:
        raise BeanPriceUnavailable("시세 수집 결과가 비었다 — 네트워크/사이트 문제로 본다")

    drops: list[dict[str, Any]] = []
    updated = 0
    beans = db.query(RoasteryBean).filter(RoasteryBean.price > 0).all()
    for b in beans:
        new_price = current.get(_norm(b.name))
        if new_price is None or new_price <= 0 or new_price == b.price:
            continue
        old_price = int(b.price)
        pct = round((old_price - new_price) / old_price * 100, 1)
        b.price = new_price
        b.price_per_gram = round(new_price / 1000.0, 2)
        updated += 1
        if pct >= min_pct:
            drops.append({
                "bean_id": b.id, "name": b.name, "old_price": old_price,
                "new_price": new_price, "drop_pct": pct,
                "product_url": b.product_url or "",
            })
    db.commit()
    drops.sort(key=lambda d: -d["drop_pct"])
    logger.info("[원두 시세] 가격 갱신 %d건 · 하락(%.0f%%↑) %d건", updated, min_pct, len(drops))
    return drops


class BeanPriceUnavailable(RuntimeError):
    """시세 수집이 통째로 실패했다 — '오늘 하락 없음'과 구분해야 캐시가 오염되지 않는다"""


def get_today_drops(db) -> list[dict[str, Any]]:
    """오늘의 하락 목록 (하루 캐시). BEAN_PRICE_WATCH=0 이면 항상 빈 목록.

    수집이 통째로 실패한 날은 캐시에 '오늘 확인함'을 남기지 않는다 — 예전엔 일시적인
    네트워크 오류 한 번이 빈 결과로 하루 종일 캐시돼 그날 시세 알림이 전부 죽었다.
    """
    if os.getenv("BEAN_PRICE_WATCH", "1") == "0":
        return []
    today = today_kst().isoformat()
    if _cache["day"] != today:
        try:
            drops = refresh_and_find_drops(db)
        except BeanPriceUnavailable as e:
            logger.info("[원두 시세] 오늘 수집 실패 — 다음 호출에서 재시도: %s", e)
            return []
        _cache["drops"] = drops
        _cache["day"] = today
    return _cache["drops"]
