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
from app.services.operation.bean_market_service import (
    get_market_summary,
    get_market_position,
    get_price_trend,
    snapshot_prices,
)
from app.services.operation.bean_blog_review_service import (
    collect_blog_reviews_for_bean,
    collect_blog_reviews_bulk,
)
from app.services.operation.unspecialty_collect_service import collect_unspecialty
from app.services.operation.bean_alternative_service import find_alternatives

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


# --- [5. 원두 시세 분석 API — 포지션(즉시) / 추이(누적 필요)] ---

@router.get("/market/summary", summary="원산지·가공방식별 g당 단가 시세표")
def market_summary_api(db: Session = Depends(get_db)):
    """[한글 주석] 원산지/가공방식 그룹별 g당 단가 통계를 반환합니다.

    화면은 이 통계 하나만 받아두면 각 원두의 g당 단가와 비교해
    "시세보다 6% 저렴" 판단을 즉시 내릴 수 있습니다.
    (원두 50개를 그리려고 50번 호출할 필요가 없습니다)

    표본 5개 미만 그룹은 통계로 쓰지 않고 제외합니다.
    """
    try:
        return get_market_summary(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"시세표 생성 중 오류: {str(e)}")


@router.get("/beans/{bean_id}/market-position", summary="이 원두가 같은 원산지 중 어느 가격대인지")
def market_position_api(bean_id: int, db: Session = Depends(get_db)):
    """[한글 주석] 같은 원산지 원두들과 g당 단가를 비교해 저렴/시세/비쌈을 판정합니다.

    과거 데이터가 없어도 계산되므로 오늘 바로 동작합니다.
    """
    result = get_market_position(db, bean_id)
    if result is None:
        raise HTTPException(status_code=404, detail="원두를 찾을 수 없거나 g당 단가 정보가 없습니다.")
    return result


@router.get("/beans/{bean_id}/price-trend", summary="가격 추이 (이력이 쌓인 만큼만)")
def price_trend_api(
    bean_id: int,
    days: int = Query(30, ge=2, le=365, description="조회 기간(일)"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 가격 이력 기반 추이를 반환합니다.

    이력이 2점 미만이면 ready=false와 안내 문구를 돌려줍니다 —
    화면이 한 점짜리 그래프를 '추이'처럼 그리지 않도록 하기 위함입니다.
    """
    try:
        return get_price_trend(db, bean_id, days=days)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"가격 추이 조회 중 오류: {str(e)}")


@router.post("/beans/{bean_id}/collect-blog-reviews", summary="네이버 공식 검색 API로 블로그·카페 후기 수집")
def collect_blog_reviews_api(
    bean_id: int,
    display: int = Query(30, ge=1, le=100, description="검색 결과 개수"),
    include_cafe: bool = Query(True, description="카페 글도 함께 수집"),
    exclude_ads: bool = Query(True, description="협찬·광고 글 제외"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 원두 1건의 후기를 네이버 공식 검색 API(블로그·카페)로 수집합니다.

    쇼핑 리뷰 크롤링과 달리 정식 오픈 API라 약관 문제가 없습니다.
    다만 블로그 글에는 별점이 없어 rating은 감성 분석 기반 추정치입니다.
    협찬·광고 글은 기본적으로 제외합니다(긍정 편향 방지).
    """
    try:
        return collect_blog_reviews_for_bean(
            db, bean_id, display=display, include_cafe=include_cafe, exclude_ads=exclude_ads
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"후기 수집 중 오류: {str(e)}")


@router.post("/beans/collect-blog-reviews-bulk", summary="여러 원두의 후기를 한 번에 수집")
def collect_blog_reviews_bulk_api(
    limit: int = Query(50, ge=1, le=300, description="처리할 원두 수"),
    display: int = Query(20, ge=1, le=100, description="원두당 검색 결과 개수"),
    only_missing: bool = Query(True, description="리뷰가 없는 원두만 대상으로"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 리뷰가 비어 있는 원두부터 순차적으로 후기를 채웁니다.

    네이버 초당 요청 제한을 지키려 원두마다 짧게 쉬므로 시간이 걸립니다.
    같은 검색어가 되는 용량 변형 상품(200g/400g)은 중복 호출하지 않습니다.
    """
    try:
        return collect_blog_reviews_bulk(db, limit=limit, display=display, only_missing=only_missing)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"후기 일괄 수집 중 오류: {str(e)}")


@router.get("/beans/{bean_id}/alternatives", summary="이 원두와 비슷하면서 더 저렴한 대체 원두")
def bean_alternatives_api(
    bean_id: int,
    limit: int = Query(5, ge=1, le=20, description="추천 개수"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 같은 원산지·가공방식·풍미를 공유하면서 g당 단가가 더 싼 원두를 찾습니다.

    · '더 싸다'는 절대가격이 아니라 g당 단가 기준입니다.
      200g과 1kg의 절대가격을 비교하면 대용량이 무조건 비싸 보이기 때문입니다.
    · 절감률 3~70% 범위만 추천합니다. 70%를 넘으면 대체품이 아니라
      아예 다른 등급의 제품이고(예: 17g 게이샤 샘플 vs 일반 원두),
      3% 미만이면 원두를 바꿀 이유가 되지 못합니다.
    · 포장 용량이 기준 원두의 0.5~2배인 것만 비교합니다. 소포장은 g당 단가가
      원래 비싸서, 용량을 무시하면 추천이 "더 싼 원두"가 아니라
      "더 큰 봉지"만 찾아냅니다(실측: 100g 원두의 1~3위가 전부 1kg이었습니다).
    """
    result = find_alternatives(db, bean_id, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="원두를 찾을 수 없습니다.")
    return result


@router.post("/collect/unspecialty", summary="언스페셜티에서 원두 시세 수집 (robots.txt 허용 확인됨)")
def collect_unspecialty_api(
    dry_run: bool = Query(True, description="true면 DB에 쓰지 않고 파싱 결과만 미리보기"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 언스페셜티(카페24 쇼핑몰)에서 원두 목록을 수집합니다.

    · robots.txt에서 크롤링을 허용하는 것을 확인하고 만들었습니다(2026-07 기준).
    · 머신·저울·드리퍼 같은 장비와 판매 종료 상품은 자동으로 제외됩니다.
    · 상품명 앞 대괄호에서 실제 로스터리를 분리해 저장합니다.
      (예: '[트레커스빈] 에티오피아 구지…' → 로스터리=트레커스빈)

    처음에는 dry_run=true로 무엇이 들어올지 먼저 확인하는 것을 권합니다.
    """
    try:
        return collect_unspecialty(db, dry_run=dry_run)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"언스페셜티 수집 중 오류: {str(e)}")


@router.post("/market/snapshot", summary="오늘 가격을 이력에 기록 (하루 1회 · 스케줄러용)")
def market_snapshot_api(
    force: bool = Query(False, description="같은 날 중복 기록 허용 여부"),
    db: Session = Depends(get_db),
):
    """[한글 주석] 전체 원두의 현재 가격을 이력 테이블에 append합니다.

    추이(트렌드)는 이 기록이 쌓여야 만들어집니다. 하루 1회 호출하세요.
    같은 날 이미 기록했으면 건너뜁니다(멱등) — 중복 실행돼도 안전합니다.
    """
    try:
        return snapshot_prices(db, force=force)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"가격 스냅샷 기록 중 오류: {str(e)}")
