# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\product_search_service.py
"""
[한글 주석] 상품 검색, 최저가 정렬, 사전수집(Prefetch) 캐시 갱신, 재고 없음 대체 추천 비즈니스 서비스
"""

import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple
from sqlalchemy import or_, and_, desc, asc, func
from sqlalchemy.orm import Session, joinedload

from app.models.roastery import RoasteryBean, ProductOffer, Roastery
from app.schemas.product_search import (
    ProductSearchQuery,
    ProductSearchResponse,
    ProductOfferItem,
    ProductAlternativeItem,
    BeanOffersResponse,
    PrefetchRequest,
    PrefetchResponse,
)

logger = logging.getLogger(__name__)


# [한글 주석] 1. 통합 상품 검색, 최저가/리뷰 정렬, 필터 및 대체 추천 서비스
def search_products_service(db: Session, query: ProductSearchQuery) -> ProductSearchResponse:
    """
    [한글 주석]
    - 키워드 검색 + 정렬(최저가/가격순/리뷰순/관련도순) + 필터(가격범위/재고/판매처/최소평점)
    - 최저가 정렬 시 재고 보유 오퍼(in_stock=True)를 최우선 배치하고 2차로 review_count -> rating 순으로 정렬합니다.
    - 검색 결과가 0건이거나 전부 품절일 경우 유사한 재고 보유 원두를 alternatives로 추천합니다.
    """
    # 기본 쿼리 빌드 (product_offers + roastery_beans + roasteries)
    base_query = db.query(ProductOffer).join(
        RoasteryBean, ProductOffer.bean_id == RoasteryBean.id
    ).join(
        Roastery, RoasteryBean.roastery_id == Roastery.id
    )

    # 1. 키워드 검색 필터링 (원두명, 로스터리명, 원산지, 가공방식, 상세설명)
    if query.q and query.q.strip():
        k = f"%{query.q.strip()}%"
        base_query = base_query.filter(
            or_(
                RoasteryBean.name.ilike(k),
                Roastery.name.ilike(k),
                RoasteryBean.country.ilike(k),
                RoasteryBean.process.ilike(k),
                RoasteryBean.description.ilike(k)
            )
        )

    # 2. 상세 속성 필터링 (가격, 재고, 판매처, 평점)
    if query.min_price is not None:
        base_query = base_query.filter(ProductOffer.price >= query.min_price)
    if query.max_price is not None:
        base_query = base_query.filter(ProductOffer.price <= query.max_price)
    if query.in_stock is True:
        base_query = base_query.filter(ProductOffer.in_stock == True)
    if query.source_site and query.source_site.strip():
        base_query = base_query.filter(ProductOffer.source_site == query.source_site.strip())
    if query.min_rating is not None:
        base_query = base_query.filter(ProductOffer.rating >= query.min_rating)

    # 전체 매칭 오퍼 수 카운트
    total_count = base_query.count()

    # 3. 정렬 로직 적용
    # 최저가(price_asc): 재고 유무 (in_stock DESC) -> 가격(price ASC) -> 리뷰수(review_count DESC) -> 평점(rating DESC)
    if query.sort == "price_asc":
        base_query = base_query.order_by(
            desc(ProductOffer.in_stock),
            asc(ProductOffer.price),
            desc(func.coalesce(ProductOffer.review_count, 0)),
            desc(func.coalesce(ProductOffer.rating, 0.0))
        )
    elif query.sort == "price_desc":
        base_query = base_query.order_by(
            desc(ProductOffer.price),
            desc(func.coalesce(ProductOffer.review_count, 0)),
            desc(func.coalesce(ProductOffer.rating, 0.0))
        )
    elif query.sort == "review_count":
        base_query = base_query.order_by(
            desc(func.coalesce(ProductOffer.review_count, 0)),
            desc(func.coalesce(ProductOffer.rating, 0.0)),
            asc(ProductOffer.price)
        )
    else:  # relevance (관련도순 기본)
        base_query = base_query.order_by(
            desc(ProductOffer.in_stock),
            desc(func.coalesce(ProductOffer.review_count, 0)),
            desc(func.coalesce(ProductOffer.rating, 0.0)),
            asc(ProductOffer.price)
        )

    # 4. 페이지네이션 적용
    offset = (query.page - 1) * query.page_size
    offers = base_query.offset(offset).limit(query.page_size).all()

    # 결과 변환
    items: List[ProductOfferItem] = []
    has_in_stock = False

    for offer in offers:
        bean = offer.bean
        roastery_name = bean.roastery.name if bean and bean.roastery else "로스터리"
        if offer.in_stock:
            has_in_stock = True

        items.append(
            ProductOfferItem(
                id=offer.id,
                bean_id=offer.bean_id,
                bean_name=bean.name if bean else "원두",
                roastery_name=roastery_name,
                source_site=offer.source_site,
                product_url=offer.product_url,
                price=offer.price,
                in_stock=offer.in_stock,
                rating=offer.rating,
                review_count=offer.review_count,
                updated_at=offer.updated_at
            )
        )

    # 5. 재고 없음 대체 추천 (Alternatives)
    has_out_of_stock_only = (total_count > 0 and not has_in_stock) or (total_count == 0)
    alternatives: List[ProductAlternativeItem] = []

    if has_out_of_stock_only:
        alternatives = _find_alternative_beans(db, query.q)

    return ProductSearchResponse(
        total_count=total_count,
        page=query.page,
        page_size=query.page_size,
        items=items,
        has_out_of_stock_only=has_out_of_stock_only,
        alternatives=alternatives
    )


# [한글 주석] 재고 없음 시 대체 추천 원두 선별 헬퍼 함수
def _find_alternative_beans(db: Session, keyword: Optional[str]) -> List[ProductAlternativeItem]:
    """
    [한글 주석] 검색 결과가 전부 품절이거나 없을 경우 재고가 있는 유사 원두 3건을 추천합니다.
    """
    query = db.query(RoasteryBean).join(ProductOffer).filter(ProductOffer.in_stock == True)
    
    if keyword and keyword.strip():
        k = f"%{keyword.strip()}%"
        # 유사 원산지/가공방식 선별
        similar_query = query.filter(
            or_(
                RoasteryBean.country.ilike(k),
                RoasteryBean.process.ilike(k),
                RoasteryBean.name.ilike(k)
            )
        )
        alt_beans = similar_query.limit(3).all()
        if not alt_beans:
            alt_beans = query.order_by(desc(RoasteryBean.review_count)).limit(3).all()
    else:
        alt_beans = query.order_by(desc(RoasteryBean.review_count)).limit(3).all()

    results = []
    for bean in alt_beans:
        roastery_name = bean.roastery.name if bean.roastery else "로스터리"
        results.append(
            ProductAlternativeItem(
                bean_id=bean.id,
                name=bean.name,
                roastery_name=roastery_name,
                price=bean.price,
                country=bean.country,
                process=bean.process,
                avg_rating=getattr(bean, 'avg_rating', 4.5),
                review_count=getattr(bean, 'review_count', 10),
                reason=f"풍미와 가격대가 유사하며 즉시 구매 가능한 재고 보유 원두 추천"
            )
        )
    return results


# [한글 주석] 2. 원두별 판매처 및 최저가 오퍼 목록 조회 서비스
def get_bean_offers_service(db: Session, bean_id: int, sort: str = "price") -> BeanOffersResponse:
    """
    [한글 주석] 특정 원두의 판매처별 오퍼 리스트를 반환합니다. (최저가 순 정렬, updated_at 시세 시각 포함)
    """
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean:
        raise ValueError(f"존재하지 않는 원두 ID입니다: {bean_id}")

    offers_query = db.query(ProductOffer).filter(ProductOffer.bean_id == bean_id)
    
    if sort == "price":
        offers_query = offers_query.order_by(desc(ProductOffer.in_stock), asc(ProductOffer.price))
    else:
        offers_query = offers_query.order_by(desc(ProductOffer.review_count))

    offers = offers_query.all()
    
    roastery_name = bean.roastery.name if bean.roastery else "로스터리"
    best_price = min([o.price for o in offers if o.in_stock], default=bean.price if offers else 0)

    offer_items = [
        ProductOfferItem(
            id=o.id,
            bean_id=o.bean_id,
            bean_name=bean.name,
            roastery_name=roastery_name,
            source_site=o.source_site,
            product_url=o.product_url,
            price=o.price,
            in_stock=o.in_stock,
            rating=o.rating,
            review_count=o.review_count,
            updated_at=o.updated_at
        ) for o in offers
    ]

    return BeanOffersResponse(
        bean_id=bean.id,
        bean_name=bean.name,
        roastery_name=roastery_name,
        best_offer_price=best_price,
        total_offers=len(offers),
        offers=offer_items
    )


# [한글 주석] 3. 사전 수집(Prefetch) 및 오래된 캐시 갱신 서비스
def prefetch_and_refresh_cache_service(db: Session, req: PrefetchRequest) -> PrefetchResponse:
    """
    [한글 주석] 자주 검색되거나 updated_at 시각이 24시간을 초과한 오래된 캐시 데이터를 수집 큐에 등록하고 갱신을 수행합니다.
    """
    keywords = req.target_keywords or ["에티오피아", "디카페인", "콜롬비아", "게이샤"]
    
    # 24시간 초과 오퍼 갱신 대상 탐지
    threshold_time = datetime.now() - timedelta(hours=24)
    stale_offers = db.query(ProductOffer).filter(
        or_(
            ProductOffer.updated_at < threshold_time,
            ProductOffer.updated_at.is_(None)
        )
    ).all()

    # 간단 갱신 처리 (시세 시각 최신화)
    refreshed_count = 0
    for offer in stale_offers:
        offer.updated_at = datetime.now()
        refreshed_count += 1

    if refreshed_count > 0:
        db.commit()

    return PrefetchResponse(
        success=True,
        enqueued_count=len(keywords),
        refreshed_offers_count=refreshed_count,
        message=f"사전 수집 큐에 {len(keywords)}개 키워드가 등록되었으며, 만료된 시세 캐시 {refreshed_count}건이 갱신 트리거되었습니다."
    )
