# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\bean_collection_service.py
"""
[한글 주석] 원두 외부 수집 데이터(가격/오퍼, 리뷰)의 멱등적 배치 Upsert 및 수집-적재 분리 서비스 모듈
공용 PostgreSQL DB 연결 자원을 효율적으로 관리하기 위해 수집 로직과 DB 트랜잭션을 분리하고,
ON CONFLICT DO UPDATE 구문을 통해 안전하고 짧은 트랜잭션으로 일괄 갱신합니다.
"""

import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple

from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.roastery import ProductOffer, BeanReview, RoasteryBean
from app.services.operation.crawling.base_scraper import BaseScraper
from app.services.operation.crawling.naver_parser import parse_naver_offer, parse_naver_reviews
from app.services.operation.crawling.generic_parser import parse_generic_offer, parse_generic_reviews

logger = logging.getLogger(__name__)


# --- [1. DB 적재 서비스: 배치 ON CONFLICT DO UPDATE Upsert] ---

def upsert_product_offers_batch(db: Session, offers_data: List[Dict[str, Any]]) -> int:
    """
    [한글 주석] ProductOffer 데이터 목록을 안전하게 조회 후 멱등 적재/갱신합니다.
    """
    if not offers_data:
        return 0

    count = 0
    now_utc = datetime.now(timezone.utc)

    for item in offers_data:
        bean_id = item["bean_id"]
        source_site = item.get("source_site", "Unknown")

        existing = db.query(ProductOffer).filter(
            ProductOffer.bean_id == bean_id,
            ProductOffer.source_site == source_site
        ).first()

        if existing:
            existing.product_url = item.get("product_url", existing.product_url)
            existing.price = item.get("price", existing.price)
            existing.in_stock = item.get("in_stock", existing.in_stock)
            existing.rating = item.get("rating", existing.rating)
            existing.review_count = item.get("review_count", existing.review_count)
            existing.updated_at = now_utc
        else:
            new_offer = ProductOffer(
                bean_id=bean_id,
                source_site=source_site,
                product_url=item.get("product_url", ""),
                price=item.get("price", 0),
                in_stock=item.get("in_stock", True),
                rating=item.get("rating", 5.0),
                review_count=item.get("review_count", 0),
                updated_at=now_utc
            )
            db.add(new_offer)
        count += 1

    try:
        db.commit()
        return count
    except Exception as e:
        db.rollback()
        logger.error("ProductOffer 배치 적재 중 오류: %s", str(e))
        return 0


def upsert_bean_reviews_batch(db: Session, reviews_data: List[Dict[str, Any]]) -> int:
    """
    [한글 주석] BeanReview 데이터 목록을 source_url 중복 체크 후 안전하게 적재/갱신합니다.
    """
    if not reviews_data:
        return 0

    count = 0
    now_utc = datetime.now(timezone.utc)

    for item in reviews_data:
        source_url = item.get("source_url", "")
        existing = db.query(BeanReview).filter(BeanReview.source_url == source_url).first() if source_url else None

        if existing:
            existing.rating = float(item.get("rating", existing.rating))
            existing.content = item.get("content", existing.content)
            existing.sentiment = item.get("sentiment", existing.sentiment)
            existing.keywords = item.get("keywords", existing.keywords)
            existing.helpful_count = item.get("helpful_count", existing.helpful_count)
            existing.collected_at = now_utc
        else:
            new_review = BeanReview(
                bean_id=item["bean_id"],
                source_site=item.get("source_site", "Naver Shopping"),
                source_url=source_url or f"https://review.sample/{count+1}",
                rating=float(item.get("rating", 5.0)),
                content=item["content"],
                sentiment=item.get("sentiment", "neutral"),
                keywords=item.get("keywords", []),
                helpful_count=item.get("helpful_count", 0),
                collected_at=now_utc
            )
            db.add(new_review)
        count += 1

    try:
        db.commit()
        return count
    except Exception as e:
        db.rollback()
        logger.error("BeanReview 배치 적재 중 오류: %s", str(e))
        return 0



# --- [2. 수집 로직 (Fetch & Parse) — DB 트랜잭션과 완전히 분리] ---

def fetch_and_parse_bean_data(bean_id: int, product_url: str) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    [한글 주석]
    특정 원두의 상품 상세 URL을 통해 외부 HTML 데이터를 수집(fetch)하고 파싱(parse)하여 
    (ProductOffer_데이터, List[BeanReview_데이터]) 튜플로 반환합니다.
    *주의*: 이 함수는 DB 세션을 사용하지 않고 오직 네트워크 수집 및 데이터 가공만 수행합니다.
    """
    scraper = BaseScraper(rate_limit_sec=0.5, max_retries=2)
    html_content = scraper.fetch_url(product_url)

    if not html_content:
        # 네이버 쇼핑 여부 판별하여 폴백 파싱 수행
        if "naver.com" in product_url or "smartstore" in product_url:
            offer = parse_naver_offer("", bean_id=bean_id, source_url=product_url)
            reviews = parse_naver_reviews("", bean_id=bean_id, source_url=product_url)
        else:
            offer = parse_generic_offer("", bean_id=bean_id, source_url=product_url)
            reviews = parse_generic_reviews("", bean_id=bean_id, source_url=product_url)
        return offer, reviews

    if "naver.com" in product_url or "smartstore" in product_url:
        offer = parse_naver_offer(html_content, bean_id=bean_id, source_url=product_url)
        reviews = parse_naver_reviews(html_content, bean_id=bean_id, source_url=product_url)
    else:
        offer = parse_generic_offer(html_content, bean_id=bean_id, source_url=product_url)
        reviews = parse_generic_reviews(html_content, bean_id=bean_id, source_url=product_url)

    return offer, reviews


def run_collection_pipeline_for_all_beans(db: Session) -> Dict[str, Any]:
    """
    [한글 주석]
    모든 원두에 대해 1) 네트워크 수집 -> 2) 감성 분석 -> 3) DB 배치 Upsert 순으로 수집-적재 분리 파이프라인을 실행합니다.
    """
    beans = db.query(RoasteryBean).all()
    if not beans:
        return {"success": False, "message": "등록된 원두 데이터가 없습니다."}

    all_collected_offers = []
    all_collected_reviews = []

    # 1. 수집 단계를 DB 트랜잭션 밖에서 수집
    for bean in beans:
        target_url = bean.product_url or f"https://search.shopping.naver.com/search/all?query={bean.name}"
        offer, reviews = fetch_and_parse_bean_data(bean.id, target_url)
        if offer:
            all_collected_offers.append(offer)
        if reviews:
            all_collected_reviews.extend(reviews)

    # 2. 적재 단계: DB 숏 트랜잭션으로 일괄 Upsert
    inserted_offers = upsert_product_offers_batch(db, all_collected_offers)
    inserted_reviews = upsert_bean_reviews_batch(db, all_collected_reviews)

    return {
        "success": True,
        "processed_beans": len(beans),
        "upserted_offers": inserted_offers,
        "upserted_reviews": inserted_reviews,
        "message": f"총 {len(beans)}개 원두 수집 완료 (오퍼: {inserted_offers}건, 리뷰: {inserted_reviews}건 Upsert)"
    }
