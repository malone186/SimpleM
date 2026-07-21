# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\schemas\product_search.py
"""
[한글 주석] 상품 검색, 정렬, 필터, 판매처 오퍼, prefetch 캐시 스키마
"""

from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, Field


# [한글 주석] 1. 개별 판매처 오퍼(ProductOffer) 스펙
class ProductOfferItem(BaseModel):
    """판매처별 오퍼 응답 스펙"""
    id: int = Field(..., description="오퍼 고유 ID")
    bean_id: int = Field(..., description="연결된 원두 ID")
    bean_name: str = Field(..., description="원두 상품명")
    roastery_name: str = Field(..., description="로스터리 이름")
    source_site: str = Field(..., description="판매처 사이트명")
    product_url: str = Field(..., description="공개 상품 상세 URL")
    price: int = Field(..., description="판매 단가 가격")
    in_stock: bool = Field(True, description="재고 보유 여부")
    rating: Optional[float] = Field(None, description="판매처 평점")
    review_count: Optional[int] = Field(0, description="판매처 리뷰 수")
    updated_at: Optional[datetime] = Field(None, description="오퍼 최종 갱신(시세 캐시) 시각")

    class Config:
        from_attributes = True


# [한글 주석] 2. 품절/검색결과 결여 시 대안 추천(Alternatives) 원두 스펙
class ProductAlternativeItem(BaseModel):
    """재고 없음 대체 추천 원두 스펙"""
    bean_id: int = Field(..., description="대체 원두 ID")
    name: str = Field(..., description="대체 원두명")
    roastery_name: str = Field(..., description="로스터리 브랜드명")
    price: int = Field(..., description="대표/최저 판매 가격")
    country: Optional[str] = Field(None, description="원산지 국가")
    process: Optional[str] = Field(None, description="가공 방식")
    avg_rating: float = Field(0.0, description="평균 평점")
    review_count: int = Field(0, description="리뷰 수")
    reason: str = Field("맛과 가격대가 유사한 재고 보유 원두 추천", description="추천 사유")

    class Config:
        from_attributes = True


# [한글 주석] 3. 상품 검색 요청Query 파라미터 스펙
class ProductSearchQuery(BaseModel):
    """상품 검색 질의 파라미터"""
    q: Optional[str] = Field(None, description="검색 키워드 (원두명, 로스터리, 원산지 등)")
    sort: str = Field("price_asc", description="정렬 방식 (price_asc 최저가 | price_desc 가격순 | review_count 리뷰순 | relevance 관련도순)")
    order: str = Field("asc", description="정렬 차순 (asc | desc)")
    min_price: Optional[int] = Field(None, description="최소 가격 필터")
    max_price: Optional[int] = Field(None, description="최대 가격 필터")
    in_stock: Optional[bool] = Field(None, description="재고 보유 전용 필터 (True 설정 시 재고 보유만)")
    source_site: Optional[str] = Field(None, description="특정 판매처 필터 (예: Naver Shopping)")
    min_rating: Optional[float] = Field(None, description="최소 평점 필터 (예: 4.0 이상)")
    page: int = Field(1, ge=1, description="페이지 번호")
    page_size: int = Field(10, ge=1, le=100, description="페이지당 결과 수")


# [한글 주석] 4. 상품 검색 종합 응답 스펙
class ProductSearchResponse(BaseModel):
    """상품 검색 결과 응답 (페이지네이션 + 대체 추천)"""
    total_count: int = Field(..., description="검색된 총 오퍼 수")
    page: int = Field(..., description="현재 페이지")
    page_size: int = Field(..., description="페이지당 결과 수")
    items: List[ProductOfferItem] = Field(default_factory=list, description="검색 오퍼 리스트")
    has_out_of_stock_only: bool = Field(False, description="검색 결과가 모두 품절인지 여부")
    alternatives: List[ProductAlternativeItem] = Field(default_factory=list, description="재고 없음 시 대체 추천 원두 리스트")


# [한글 주석] 5. 특정 원두의 판매처별 오퍼 응답 스펙
class BeanOffersResponse(BaseModel):
    """원두별 판매처 오퍼 리스트 응답"""
    bean_id: int = Field(..., description="원두 ID")
    bean_name: str = Field(..., description="원두명")
    roastery_name: str = Field(..., description="로스터리명")
    best_offer_price: int = Field(..., description="최저가 판매 가격")
    total_offers: int = Field(..., description="등록된 오퍼 수")
    offers: List[ProductOfferItem] = Field(default_factory=list, description="판매처별 오퍼 리스트")


# [한글 주석] 6. 사전 수집(Prefetch) 및 캐시 갱신 스펙
class PrefetchRequest(BaseModel):
    """사전 수집 및 캐시 갱신 요청 스펙"""
    target_keywords: Optional[List[str]] = Field(None, description="사전 수집할 목표 키워드 목록")
    force_refresh: bool = Field(False, description="True일 경우 updated_at 상관없이 강제 재수집")


class PrefetchResponse(BaseModel):
    """사전 수집 결과 응답 스펙"""
    success: bool = True
    enqueued_count: int = Field(..., description="사전 수집 큐에 등록된 키워드 수")
    refreshed_offers_count: int = Field(..., description="갱신 처리된 오퍼 수")
    message: str = Field(..., description="결과 안내 메시지")
