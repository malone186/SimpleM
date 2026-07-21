# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\api\v1\roastery_search.py
"""
[한글 주석] 원두 상품 상세 검색/정렬, 리뷰 수집/조회 및 공개 라우트 REST API 전담 창구
"""

from typing import Optional, List
from fastapi import APIRouter, Depends, Query, status, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.roastery import RoasteryBean, BeanReview, Roastery, ProductOffer
from app.schemas.bean_review import (
    BeanSearchQuery, BeanSearchResponse, BeanReviewResponse,
    BeanReviewSummaryResponse, ReviewCollectRequest, ReviewCollectResponse,
    ProductOfferResponse, BeanSearchResultItem
)
from app.services.operation.bean_review_service import (
    search_and_sort_beans,
    collect_and_process_reviews,
    update_bean_review_summary,
    normalize_product_url
)

router = APIRouter(prefix="/roastery", tags=["로스터리 원두 마켓 & 리뷰 검색 (Roastery Search)"])


# --- [1. 원두 상품 상세 검색 및 정렬 API] ---

@router.get("/search", response_model=BeanSearchResponse)
def search_beans_api(
    query: Optional[str] = Query(None, description="검색 키워드 (이름, 원산지, 풍미 등)"),
    min_price: Optional[int] = Query(None, ge=0, description="최소 가격"),
    max_price: Optional[int] = Query(None, ge=0, description="최대 가격"),
    in_stock_only: bool = Query(False, description="재고 보유 상품만 표시 여부"),
    sort_by: str = Query("relevance", description="정렬 (lowest_price, price_asc, price_desc, reviews, relevance)"),
    limit: int = Query(20, ge=1, le=100, description="조회 개수"),
    db: Session = Depends(get_db)
):
    """
    [한글 주석: 원두 상세 검색 API]
    원두 이름, 원산지, 풍미 텍스트 검색 및 최저가순/리뷰순/가격순 정렬과 재고/가격 범위 필터를 수행합니다.
    품절된 상품의 경우 자동으로 대체 원두 추천(alternative_recommendations)이 포함되어 반환됩니다.
    """
    params = BeanSearchQuery(
        query=query,
        min_price=min_price,
        max_price=max_price,
        in_stock_only=in_stock_only,
        sort_by=sort_by,
        limit=limit
    )
    return search_and_sort_beans(db=db, params=params)


# --- [2. 공개 상품 상세 보기 라우트 (로그인 없이 접근 가능)] ---

@router.get("/public/beans/{bean_id}", response_model=BeanSearchResultItem)
def get_public_bean_detail_api(
    bean_id: int,
    db: Session = Depends(get_db)
):
    """
    [한글 주석: 공개 상품 상세 라우트]
    로그인 없이 외부 손님 및 추천 링크를 통해 접근할 수 있는 원두 공개 상세 정보 API입니다.
    """
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean:
        raise HTTPException(status_code=404, detail="원두 상품을 찾을 수 없습니다.")

    canonical_url, is_fallback = normalize_product_url(bean.product_url, bean_id=bean.id)
    offers = db.query(ProductOffer).filter(ProductOffer.bean_id == bean.id).all()
    offer_responses = [ProductOfferResponse.model_validate(o) for o in offers]
    lowest_offer = min(offer_responses, key=lambda x: x.price) if offer_responses else None

    review_summary = BeanReviewSummaryResponse(
        bean_id=bean.id,
        avg_rating=bean.avg_rating or 0.0,
        review_count=bean.review_count or 0,
        positive_ratio=bean.positive_ratio or 0.0,
        top_keywords=bean.top_keywords if isinstance(bean.top_keywords, list) else []
    )

    return BeanSearchResultItem(
        id=bean.id,
        name=bean.name,
        roastery_id=bean.roastery_id,
        roastery_name=bean.roastery.name if bean.roastery else "로스터리",
        price=bean.price,
        price_per_gram=bean.price_per_gram,
        country=bean.country,
        process=bean.process,
        description=bean.description,
        thumbnail_url=bean.thumbnail_url,
        product_url=canonical_url,
        is_public_fallback=is_fallback,
        sold_out=bean.sold_out,
        review_summary=review_summary,
        lowest_offer=lowest_offer,
        all_offers=offer_responses,
        alternative_recommendations=[]
    )


# --- [3. 원두별 리뷰 목록 및 분석 집계 조회 API] ---

@router.get("/beans/{bean_id}/reviews")
def get_bean_reviews_api(
    bean_id: int,
    db: Session = Depends(get_db)
):
    """
    [한글 주석: 원두 리뷰 및 집계 정보 조회 API]
    특정 원두에 대한 수집 리뷰 목록과 분석 집계 요약(평균 평점, 긍정 비율, 대표 키워드)을 반환합니다.
    """
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean:
        raise HTTPException(status_code=404, detail="원두 상품을 찾을 수 없습니다.")

    summary = update_bean_review_summary(db, bean_id)
    reviews = db.query(BeanReview).filter(BeanReview.bean_id == bean_id).order_by(BeanReview.collected_at.desc()).all()
    review_items = [BeanReviewResponse.model_validate(r) for r in reviews]

    return {
        "summary": summary,
        "reviews": review_items
    }


# --- [4. 원두 리뷰 수집 파이프라인 트리거 API] ---

@router.post("/beans/{bean_id}/collect-reviews", response_model=ReviewCollectResponse)
def trigger_collect_reviews_api(
    bean_id: int,
    payload: ReviewCollectRequest,
    db: Session = Depends(get_db)
):
    """
    [한글 주석: 백그라운드 리뷰 수집 파이프라인 트리거 API]
    외부 상품 웹페이지 URL을 수집·분석하여 감성/키워드를 DB화하고 ChromaDB 증분 임베딩을 실행합니다.
    """
    return collect_and_process_reviews(
        db=db,
        bean_id=bean_id,
        source_url=payload.source_url,
        source_site=payload.source_site,
        max_reviews=payload.max_reviews
    )
