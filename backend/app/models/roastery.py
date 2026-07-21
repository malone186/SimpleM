# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\models\roastery.py
"""
[한글 주석] 로스터리 업체, 판매 원두, 외부 리뷰 및 판매 오퍼 데이터베이스 모델
"""

from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, Float, ForeignKey, Text, JSON, DateTime, func
from sqlalchemy.orm import relationship
from app.core.database import Base


# [한글 주석] 1. 외부 로스터리(원두 볶는 매장) 업체 정보를 보관하는 테이블입니다.
class Roastery(Base):
    """로스터리 브랜드 업체 모델"""
    __tablename__ = "roasteries"

    # 로스터리 업체 고유 번호 (JSON의 id와 매핑됩니다)
    id = Column(Integer, primary_key=True, index=True)
    
    # 로스터리 이름 (예: 가델로 커피)
    name = Column(String(100), nullable=False)
    
    # 썸네일 이미지 파일 주소
    thumbnail_url = Column(String(255), nullable=True)
    
    # 로스터리 업체 정보 요약 설명 (예: 블렌딩 천재가 만드는 맛도리)
    roastery_info = Column(String(255), nullable=True)
    
    # 이미지 파일 실제 저장 경로 (webp 파일명)
    file_path = Column(String(255), nullable=True)

    # [한글 주석] 이 로스터리가 판매하는 원두 상품들과의 1대N 관계선을 연결해 둡니다.
    beans = relationship("RoasteryBean", back_populates="roastery", cascade="all, delete-orphan")


# [한글 주석] 2. 로스터리 업체들이 판매하는 개별 원두 상품 상세 정보를 보관하는 테이블입니다.
class RoasteryBean(Base):
    """로스터리별 판매 원두 상품 모델"""
    __tablename__ = "roastery_beans"

    # 원두 상품 고유 일련번호
    id = Column(Integer, primary_key=True, index=True)
    
    # 원두 상품 이름 (예: BG블랜드, 500g)
    name = Column(String(100), nullable=False)
    
    # 판매 단가 가격 (원)
    price = Column(Integer, nullable=False, default=0)
    
    # 이 원두를 만들어 파는 제조사가 어느 로스터리(Roastery)인지 연결해 주는 외래키입니다.
    roastery_id = Column(Integer, ForeignKey("roasteries.id", ondelete="CASCADE"), nullable=False)
    
    # 상품 썸네일 이미지 주소
    thumbnail_url = Column(String(255), nullable=True)
    
    # [한글 주석] 정규화된 공개 상품 상세 웹페이지 주소 (추적 파라미터가 제거된 canonical URL)
    product_url = Column(Text, nullable=True)
    
    # 네이버 쇼핑 수집 및 등록일자 (YYYYMMDD 형식 문자열)
    date_added = Column(String(8), nullable=True)
    
    # 베스트 상품 딱지 여부
    best = Column(Boolean, default=False, nullable=False)
    
    # 신상품 딱지 여부
    new = Column(Boolean, default=False, nullable=False)
    
    # 품절 처리 여부
    sold_out = Column(Boolean, default=False, nullable=False)
    
    # 원두의 풍미, 아로마 등 텍스트 설명
    description = Column(Text, nullable=True)
    
    # 원산지 국가명 (예: 에티오피아, 브라질)
    country = Column(String(50), nullable=True)
    
    # 가공 방식 (예: 내추럴, 워시드)
    process = Column(String(50), nullable=True)
    
    # 블렌딩 원두 여부 (여러 생두를 섞어 볶았는지 여부)
    blend = Column(Boolean, default=False, nullable=False)
    
    # 디카페인 원두 여부
    decaf = Column(Boolean, default=False, nullable=False)
    
    # 게샤 품종 여부 (고가 품종인 게이샤 원두 여부)
    gesha = Column(Boolean, default=False, nullable=False)
    
    # 원두 1g당 단가 가격 (원/g)
    price_per_gram = Column(Float, nullable=True)
    
    # 네이버 쇼핑 원본 상품 고유 ID
    naver_product_id = Column(String(50), nullable=True)

    # [한글 주석] 원두별 집계 정보 컬럼 (리뷰 평점/건수/긍정 비율/대표 키워드)
    avg_rating = Column(Float, default=0.0, nullable=False)
    review_count = Column(Integer, default=0, nullable=False)
    positive_ratio = Column(Float, default=0.0, nullable=False)
    top_keywords = Column(JSON, nullable=True)

    # [한글 주석] 원두 큐레이터 기준 집계 스냅샷 (산미/바디/단맛/쓴맛 평균 & 표본수, 최빈값 범주)
    curation_snapshot = Column(JSON, nullable=True)

    # [한글 주석] 관계 정의
    roastery = relationship("Roastery", back_populates="beans")
    reviews = relationship("BeanReview", back_populates="bean", cascade="all, delete-orphan")
    offers = relationship("ProductOffer", back_populates="bean", cascade="all, delete-orphan")


# [한글 주석] 3. 원두 외부 수집 리뷰 및 감성 분석 데이터 테이블입니다.
class BeanReview(Base):
    """외부 상품 사이트 리뷰 수집 및 감성 분석 모델"""
    __tablename__ = "bean_reviews"

    id = Column(Integer, primary_key=True, index=True)
    bean_id = Column(Integer, ForeignKey("roastery_beans.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 리뷰 출처 사이트 (예: Naver Shopping, Coupang 등)
    source_site = Column(String(50), nullable=False, default="Naver Shopping")
    
    # 리뷰 원본 링크 주소
    source_url = Column(Text, nullable=True)
    
    # 리뷰 평점 (1.0 ~ 5.0)
    rating = Column(Float, nullable=False, default=5.0)
    
    # 리뷰 본문 내용
    content = Column(Text, nullable=False)
    
    # 감성 분석 결과 (positive: 긍정, neutral: 중립, negative: 부정)
    sentiment = Column(String(20), nullable=False, default="neutral")
    
    # 리뷰 추출 주요 키워드 (JSON 배열 리스트)
    keywords = Column(JSON, nullable=True)
    
    # 도움됨/추천 수
    helpful_count = Column(Integer, nullable=False, default=0)
    
    # 리뷰 수집 일시
    collected_at = Column(DateTime(timezone=True), server_default=func.now())

    # [한글 주석] 원두 취향 큐레이터 필터용 구조화 추출 컬럼
    # 척도 (0=없음, 1=낮음, 2=중간, 3=높음, 근거없으면 null)
    acidity = Column(Integer, nullable=True)
    body = Column(Integer, nullable=True)
    sweetness = Column(Integer, nullable=True)
    bitterness = Column(Integer, nullable=True)

    # 범주 (roast_level: light/medium/medium_dark/dark, process: washed/natural/honey/anaerobic, origin: ethiopia/colombia/brazil/kenya/etc, caffeine: normal/decaf)
    roast_level = Column(String(30), nullable=True)
    process = Column(String(30), nullable=True)
    origin = Column(String(30), nullable=True)
    caffeine = Column(String(30), nullable=True)

    # 판단 근거 문장 인용
    evidence = Column(Text, nullable=True)

    # LLM 증분 배치 처리 완료 플래그
    processed = Column(Boolean, default=False, nullable=False, index=True)

    bean = relationship("RoasteryBean", back_populates="reviews")



# [한글 주석] 4. 외부 판매처별 상품 실시간 가격 및 재고 정보(오퍼) 테이블입니다.
class ProductOffer(Base):
    """판매처별 실시간 원두 가격 및 재고 오퍼 모델"""
    __tablename__ = "product_offers"

    id = Column(Integer, primary_key=True, index=True)
    bean_id = Column(Integer, ForeignKey("roastery_beans.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 판매처 이름 (예: 네이버 스마트스토어, 쿠팡, 가델로 공식몰)
    source_site = Column(String(50), nullable=False)
    
    # 정규화된 공개 상품 상세 페이지 주소
    product_url = Column(Text, nullable=False)
    
    # 판매 가격 (원)
    price = Column(Integer, nullable=False, default=0)
    
    # 재고 보유 여부
    in_stock = Column(Boolean, nullable=False, default=True)
    
    # 해당 판매처 평점
    rating = Column(Float, nullable=True)
    
    # 해당 판매처 리뷰 수
    review_count = Column(Integer, nullable=True, default=0)
    
    # 정보 최종 갱신 시각 (시세 캐시 용도)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    bean = relationship("RoasteryBean", back_populates="offers")
