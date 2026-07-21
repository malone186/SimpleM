# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\schemas\bean_review.py
"""
[한글 주석] 원두 리뷰 수집, 감성 분석, 상품 검색/정렬, RAG 챗봇 및 대체 상품 추천용 Pydantic 스키마 모듈
"""

from datetime import datetime
from typing import List, Optional, Any, Dict
from pydantic import BaseModel, Field, ConfigDict


# --- [1. 리뷰 관련 Pydantic 스키마] ---

class BeanReviewBase(BaseModel):
    """[한글 주석] 리뷰 기본 스키마"""
    source_site: str = Field(..., description="리뷰 출처 사이트명 (예: Naver Shopping, Coupang)")
    source_url: Optional[str] = Field(None, description="리뷰 원본 웹페이지 주소")
    rating: float = Field(..., ge=1.0, le=5.0, description="리뷰 평점 (1.0~5.0)")
    content: str = Field(..., description="리뷰 본문 텍스트")
    sentiment: Optional[str] = Field("neutral", description="감성 분석 결과 (positive, neutral, negative)")
    keywords: Optional[List[str]] = Field(default_factory=list, description="리뷰에서 추출된 핵심 키워드 리스트")
    helpful_count: int = Field(0, description="도움됨/추천 수")


class BeanReviewCreate(BeanReviewBase):
    """[한글 주석] 리뷰 등록/수집 요청 스키마"""
    bean_id: int = Field(..., description="대상 원두 상품 ID")


class BeanReviewResponse(BeanReviewBase):
    """[한글 주석] 리뷰 응답 스키마"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    bean_id: int
    collected_at: datetime


class BeanReviewSummaryResponse(BaseModel):
    """[한글 주석] 원두별 리뷰 분석 집계 요약 정보"""
    bean_id: int
    avg_rating: float = Field(0.0, description="평균 평점")
    review_count: int = Field(0, description="총 리뷰 수")
    positive_ratio: float = Field(0.0, description="긍정 리뷰 비율 (0.0 ~ 1.0)")
    top_keywords: List[str] = Field(default_factory=list, description="대표 키워드 Top 5")


# --- [2. 판매 오퍼(가격/재고) 관련 스키마] ---

class ProductOfferBase(BaseModel):
    """[한글 주석] 외부 판매처 오퍼 기본 스키마"""
    source_site: str = Field(..., description="판매처 이름 (예: 네이버 스마트스토어, 쿠팡)")
    product_url: str = Field(..., description="정규화된 공개 상품 상세 주소")
    price: int = Field(..., ge=0, description="판매 가격 (원)")
    in_stock: bool = Field(True, description="재고 상태 여부")
    rating: Optional[float] = Field(None, description="해당 판매처 평점")
    review_count: Optional[int] = Field(0, description="해당 판매처 리뷰 수")


class ProductOfferResponse(ProductOfferBase):
    """[한글 주석] 외부 판매처 오퍼 응답 스키마"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    bean_id: int
    updated_at: datetime
    disclaimer: str = Field("본 시세 및 재고 정보는 참고용이며 확정 금액이 아닙니다.", description="안내 문구")


# --- [3. 원두 검색 및 정렬/대체 상품 추천 스키마] ---

class BeanSearchQuery(BaseModel):
    """[한글 주석] 원두 상품 상세 검색 및 정렬 요청 파라미터"""
    query: Optional[str] = Field(None, description="검색어 (원두 이름, 원산지, 풍미 등)")
    min_price: Optional[int] = Field(None, ge=0, description="최저 가격 필터")
    max_price: Optional[int] = Field(None, ge=0, description="최고 가격 필터")
    in_stock_only: bool = Field(False, description="재고 보유 상품만 보기 여부")
    sort_by: str = Field(
        "relevance",
        description="정렬 방식 (lowest_price: 최저가순, price_asc: 가격오름차순, price_desc: 가격내림차순, reviews: 리뷰순, relevance: 관련도순)"
    )
    limit: int = Field(20, ge=1, le=100, description="조회 개수 제한")


class BeanSearchResultItem(BaseModel):
    """[한글 주석] 원두 검색 결과 개별 항목 스키마"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    roastery_id: int
    roastery_name: str
    price: int
    price_per_gram: Optional[float] = None
    country: Optional[str] = None
    process: Optional[str] = None
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    product_url: str
    is_public_fallback: bool = Field(False, description="내부 공개 상세 URL 사용 여부")
    sold_out: bool = Field(False, description="품절 여부")
    review_summary: BeanReviewSummaryResponse
    lowest_offer: Optional[ProductOfferResponse] = None
    all_offers: List[ProductOfferResponse] = Field(default_factory=list)
    alternative_recommendations: List["BeanSearchResultItem"] = Field(default_factory=list)


class BeanSearchResponse(BaseModel):
    """[한글 주석] 원두 검색 전체 응답 스키마"""
    total_count: int
    items: List[BeanSearchResultItem]
    disclaimer: str = Field("본 상품 가격 및 시세 정보는 참고용이며 실시간으로 변경될 수 있습니다.", description="안내 문구")


# --- [4. 리뷰 백그라운드 수집 요청 스키마] ---

class ReviewCollectRequest(BaseModel):
    """[한글 주석] 백그라운드 리뷰 수집 요청 스키마"""
    bean_id: int
    source_url: str
    source_site: str = Field("Naver Shopping", description="수집 대상 사이트명")
    max_reviews: int = Field(50, ge=1, le=200, description="최대 수집 리뷰 개수")


class ReviewCollectResponse(BaseModel):
    """[한글 주석] 리뷰 수집 작업 응답 스키마"""
    success: bool
    bean_id: int
    collected_count: int
    new_embedded_count: int
    summary: BeanReviewSummaryResponse
    message: str
