"""언스페셜티 원두 수집 서비스 — 파싱 결과를 DB(RoasteryBean/ProductOffer)에 반영

[한글 주석] 설계 메모:

  · 로스터리 추출
      언스페셜티 상품명은 '[트레커스빈] 에티오피아 구지...'처럼 대괄호에 실제 로스터리가 온다.
      전부 '언스페셜티'로 묶어버리면 로스터리별 시세 비교가 불가능해지므로 분리해서 저장한다.
      다만 '[커피 생두]', '[7월 커피 월픽]'처럼 카테고리인 경우도 있어 구분이 필요하다.

  · 중복 판정
      product_url이 상품마다 고유하므로 이걸 열쇠로 쓴다.
      같은 상품이 다시 수집되면 새로 만들지 않고 가격만 갱신한다.

  · price_per_gram(g당 단가)
      목록 페이지에는 용량이 없는 경우가 대부분이라 대개 null이 된다.
      용량을 모르는 채 g당 단가를 지어내면 시세 통계가 오염되므로 비워 둔다.
      (상세 페이지를 긁으면 채울 수 있지만 요청이 상품 수만큼 늘어난다)
"""
import logging
import re
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.roastery import ProductOffer, Roastery, RoasteryBean
from app.services.operation.crawling.base_scraper import BaseScraper
from app.services.operation.crawling.unspecialty_parser import (
    BASE_URL,
    SOURCE_SITE,
    parse_unspecialty_products,
)

logger = logging.getLogger(__name__)

# 원두 목록이 있는 페이지들 (홈 + 원두 카테고리)
DEFAULT_LIST_URLS = [
    f"{BASE_URL}/",
    f"{BASE_URL}/product/coffee_beans.html?cate_no=85",
]

_CATEGORY_RE = re.compile(r"^\s*\[([^\]]+)\]\s*")

# 대괄호 안이 로스터리가 아니라 '분류'인 경우 — 이때는 판매처를 로스터리로 쓴다.
_NOT_ROASTERY = [
    "커피 생두", "생두", "월픽", "할인", "한정", "판매", "이벤트", "기획",
    "신상품", "추천", "세트", "구독", "선물",
]

# 이름에서 용량(200g 등)을 찾아 g당 단가를 계산할 때 사용
_WEIGHT_RE = re.compile(r"(\d{2,5})\s*(g|kg)\b", re.I)


def _split_roastery(name: str) -> tuple:
    """상품명에서 (로스터리명, 순수 상품명)을 분리한다.

    '[트레커스빈] 에티오피아 구지 우라가' → ('트레커스빈', '에티오피아 구지 우라가')
    '[커피 생두] 브라질 파젠다'          → (None, '브라질 파젠다')   ← 분류이므로 로스터리 아님
    """
    m = _CATEGORY_RE.match(name or "")
    if not m:
        return None, (name or "").strip()

    bracket = m.group(1).strip()
    rest = name[m.end():].strip()

    if any(w in bracket for w in _NOT_ROASTERY):
        return None, rest or name.strip()
    return bracket, (rest or name.strip())


def _extract_price_per_gram(name: str, price: Optional[int]) -> Optional[float]:
    """상품명에 용량이 있으면 g당 단가를 계산한다. 없으면 None.

    [한글 주석] 용량을 모르면 계산하지 않는다 — 200g인지 1kg인지 모르는 채로
    g당 단가를 만들면 시세 비교가 통째로 틀어진다.
    """
    if not price:
        return None
    m = _WEIGHT_RE.search(name or "")
    if not m:
        return None
    try:
        value = float(m.group(1))
        grams = value * 1000 if m.group(2).lower() == "kg" else value
        if grams <= 0:
            return None
        return round(price / grams, 2)
    except (ValueError, ZeroDivisionError):
        return None


def _get_or_create_roastery(db: Session, name: str) -> Roastery:
    """로스터리를 이름으로 찾고 없으면 만든다."""
    r = db.query(Roastery).filter(Roastery.name == name).first()
    if r:
        return r
    r = Roastery(name=name, roastery_info=f"{SOURCE_SITE}에서 수집")
    db.add(r)
    db.flush()  # id 확보
    return r


def collect_unspecialty(
    db: Session,
    html: Optional[str] = None,
    urls: Optional[List[str]] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """언스페셜티 원두를 수집해 DB에 반영한다.

    html을 직접 넘기면 그것만 파싱한다(테스트용).
    아니면 urls(기본: 홈 + 원두 카테고리)를 순회하며 가져온다.
    dry_run=True면 DB에 쓰지 않고 결과만 돌려준다.
    """
    pages: List[str] = []

    if html:
        pages.append(html)
    else:
        scraper = BaseScraper(rate_limit_sec=1.0, max_retries=2)
        for u in (urls or DEFAULT_LIST_URLS):
            content = scraper.fetch_url(u)
            if content:
                pages.append(content)
            else:
                logger.warning("언스페셜티 페이지 수집 실패: %s", u)

    # 여러 페이지에 같은 상품이 겹쳐 나오므로 product_url로 합친다.
    merged: Dict[str, Dict[str, Any]] = {}
    for page in pages:
        for item in parse_unspecialty_products(page, beans_only=True):
            merged[item["product_url"]] = item

    items = list(merged.values())
    created, updated, skipped = 0, 0, 0

    if dry_run:
        return {
            "pages": len(pages),
            "parsed": len(items),
            "created": 0,
            "updated": 0,
            "dry_run": True,
            "sample": items[:10],
            "message": f"[미리보기] 원두 {len(items)}건 파싱 (DB 미반영)",
        }

    for it in items:
        name = it["name"]
        price = it.get("price") or 0
        if not name or price <= 0:
            skipped += 1
            continue

        roastery_name, pure_name = _split_roastery(name)
        roastery = _get_or_create_roastery(db, roastery_name or SOURCE_SITE)

        bean = (
            db.query(RoasteryBean)
            .filter(RoasteryBean.product_url == it["product_url"])
            .first()
        )

        ppg = _extract_price_per_gram(name, price)

        if bean is None:
            bean = RoasteryBean(
                name=pure_name[:100],
                price=price,
                roastery_id=roastery.id,
                thumbnail_url=(it.get("thumbnail_url") or "")[:255] or None,
                product_url=it["product_url"],
                price_per_gram=ppg,
                sold_out=False,
            )
            db.add(bean)
            db.flush()
            created += 1
        else:
            # 이미 있는 상품은 가격만 갱신한다 (이름·이미지는 사이트 표기가 바뀔 수 있어 함께 갱신)
            bean.price = price
            bean.name = pure_name[:100]
            if ppg is not None:
                bean.price_per_gram = ppg
            if it.get("thumbnail_url"):
                bean.thumbnail_url = it["thumbnail_url"][:255]
            updated += 1

        # 판매처 시세(ProductOffer) 갱신 — 같은 판매처는 1건만 유지
        offer = (
            db.query(ProductOffer)
            .filter(ProductOffer.bean_id == bean.id, ProductOffer.source_site == SOURCE_SITE)
            .first()
        )
        if offer is None:
            db.add(
                ProductOffer(
                    bean_id=bean.id,
                    source_site=SOURCE_SITE,
                    product_url=it["product_url"],
                    price=price,
                    in_stock=True,
                )
            )
        else:
            offer.price = price
            offer.product_url = it["product_url"]
            offer.in_stock = True

    db.commit()
    return {
        "pages": len(pages),
        "parsed": len(items),
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "message": f"원두 {len(items)}건 처리 — 신규 {created}건, 갱신 {updated}건",
    }
