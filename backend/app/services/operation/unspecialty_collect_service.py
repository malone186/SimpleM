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
from app.services.operation.crawling.rendered_scraper import fetch_rendered, is_available
from app.services.operation.crawling.unspecialty_parser import (
    BASE_URL,
    SOURCE_SITE,
    parse_unspecialty_cards,
    parse_unspecialty_products,
)

logger = logging.getLogger(__name__)

# [한글 주석] 전체 원두 목록 — JS로 그려지므로 브라우저 렌더링이 필요하다.
# 정적으로 받으면 0건, 렌더링하면 151건이 나온다(실측).
RENDERED_LIST_URL = f"{BASE_URL}/product/all_beans.html?cate_no=85"

# 렌더링을 못 쓰는 환경(Playwright 미설치)에서 쓰는 폴백.
# 홈페이지는 서버가 상품을 HTML로 그려줘서 정적으로도 17건 정도는 얻을 수 있다.
STATIC_FALLBACK_URLS = [
    f"{BASE_URL}/",
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

    기본은 브라우저 렌더링(all_beans.html)으로 전체 목록을 가져온다.
    Playwright가 없으면 홈페이지 정적 수집으로 폴백한다(건수가 크게 줄어든다).

    html을 직접 넘기면 그것만 파싱한다(테스트용).
    dry_run=True면 DB에 쓰지 않고 결과만 돌려준다.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    mode = "rendered"
    pages = 0

    if html:
        # 넘겨받은 HTML — 카드 구조를 먼저 시도하고, 없으면 정적 구조로 해석한다.
        mode = "provided"
        pages = 1
        for item in parse_unspecialty_cards(html, beans_only=True) or parse_unspecialty_products(html, beans_only=True):
            merged[item["product_url"]] = item

    elif is_available():
        # [한글 주석] 전체 목록은 JS로 그려지므로 렌더링이 필요하다.
        content = fetch_rendered(RENDERED_LIST_URL)
        if content:
            pages = 1
            for item in parse_unspecialty_cards(content, beans_only=True):
                merged[item["product_url"]] = item
        if not merged:
            logger.warning("렌더링 수집이 0건 — 정적 폴백으로 전환합니다")
            mode = "static-fallback"

    else:
        mode = "static-fallback"
        logger.info("Playwright 미설치 — 정적 수집으로 진행합니다(건수가 적습니다)")

    # 렌더링을 못 썼거나 결과가 없으면 홈페이지라도 긁는다.
    if not merged:
        scraper = BaseScraper(rate_limit_sec=1.0, max_retries=2)
        for u in (urls or STATIC_FALLBACK_URLS):
            content = scraper.fetch_url(u)
            if content:
                pages += 1
                for item in parse_unspecialty_products(content, beans_only=True):
                    merged[item["product_url"]] = item
            else:
                logger.warning("언스페셜티 페이지 수집 실패: %s", u)

    items = list(merged.values())
    created, updated, skipped = 0, 0, 0

    if dry_run:
        with_notes = sum(1 for i in items if i.get("cup_notes"))
        with_ppg = sum(1 for i in items if i.get("price_per_gram"))
        return {
            "mode": mode,
            "pages": pages,
            "parsed": len(items),
            "with_cup_notes": with_notes,
            "with_price_per_gram": with_ppg,
            "created": 0,
            "updated": 0,
            "dry_run": True,
            "sample": items[:10],
            "message": f"[미리보기] 원두 {len(items)}건 파싱 — 컵노트 {with_notes}건, g당단가 {with_ppg}건 (DB 미반영)",
        }

    for it in items:
        name = it["name"]
        price = it.get("price") or 0
        if not name or price <= 0:
            skipped += 1
            continue

        # 렌더링 카드는 로스터리를 별도 필드로 준다. 없으면 상품명 대괄호에서 뽑는다.
        card_roastery = (it.get("roastery_name") or "").strip()
        if card_roastery:
            roastery_name, pure_name = card_roastery, name
        else:
            roastery_name, pure_name = _split_roastery(name)
        roastery = _get_or_create_roastery(db, roastery_name or SOURCE_SITE)

        bean = (
            db.query(RoasteryBean)
            .filter(RoasteryBean.product_url == it["product_url"])
            .first()
        )

        # 카드에 용량이 있으면 그걸로 계산된 g당 단가를 쓰고, 없으면 이름에서 추정한다.
        ppg = it.get("price_per_gram") or _extract_price_per_gram(name, price)
        cup_notes = (it.get("cup_notes") or "").strip()

        if bean is None:
            bean = RoasteryBean(
                name=pure_name[:100],
                price=price,
                roastery_id=roastery.id,
                thumbnail_url=(it.get("thumbnail_url") or "")[:255] or None,
                product_url=it["product_url"],
                price_per_gram=ppg,
                # [한글 주석] 컵노트를 description에 넣는다.
                # 기존 599개 원두는 description이 전부 비어 있어 화면에 맛 정보가
                # 하나도 안 나왔다. 렌더링 수집은 이걸 100% 채워준다.
                description=cup_notes or None,
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
            if cup_notes:
                bean.description = cup_notes
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
        "mode": mode,
        "pages": pages,
        "parsed": len(items),
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "with_cup_notes": sum(1 for i in items if i.get("cup_notes")),
        "with_price_per_gram": sum(1 for i in items if i.get("price_per_gram")),
        "message": f"원두 {len(items)}건 처리 — 신규 {created}건, 갱신 {updated}건",
    }
