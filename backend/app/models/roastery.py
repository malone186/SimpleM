# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\models\roastery.py
"""
[한글 주석] 로스터리 업체, 판매 원두, 외부 리뷰 및 판매 오퍼 데이터베이스 모델
"""

from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, Float, ForeignKey, Index, Text, JSON, DateTime, UniqueConstraint, func
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
    # 마이그레이션(c8f12a345678)과 같은 이름·정의 — 모델(create_all)로 만든 DB와
    # 마이그레이션으로 만든 DB의 스키마가 갈라지지 않게 메타데이터를 단일 진실로 둔다.
    __table_args__ = (
        UniqueConstraint("source_url", name="uq_bean_reviews_source_url"),
    )

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
    # 마이그레이션(c8f12a345678·d9f12a345679)과 같은 이름·정의 — 수집 upsert의 멱등성을
    # 지키는 유니크 제약과 조회 인덱스가 create_all로 만든 DB에도 똑같이 생기게 한다.
    __table_args__ = (
        UniqueConstraint("bean_id", "source_site", name="uq_product_offers_bean_source"),
        Index("ix_product_offers_price_stock", "price", "in_stock"),
        Index("ix_product_offers_review_rating", "review_count", "rating"),
        Index("ix_product_offers_bean_updated", "bean_id", "updated_at"),
    )

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


# [한글 주석] 5. 원두 가격 이력 (시세 추이 = 트렌드의 원천 데이터)
class BeanPriceHistory(Base):
    """원두 가격 스냅샷 이력 — 하루 1회 append하여 시세 추이를 만든다.

    [한글 주석] ProductOffer는 가격을 덮어써서(onupdate) 과거가 남지 않는다.
    추이 그래프를 그리려면 과거 값이 필요하므로, 이 테이블에 append-only로 쌓는다.
    수집을 시작한 날부터 데이터가 생기므로 '오늘 시작해야 다음 주에 추이가 보인다'.
    """
    __tablename__ = "bean_price_histories"

    id = Column(Integer, primary_key=True, index=True)
    bean_id = Column(Integer, ForeignKey("roastery_beans.id", ondelete="CASCADE"), nullable=False, index=True)

    # 그 시점의 판매가 (원) — 여러 판매처가 있으면 최저가 기준
    price = Column(Integer, nullable=False, default=0)

    # 그 시점의 g당 단가 (용량이 달라도 비교 가능하게)
    price_per_gram = Column(Float, nullable=True)

    # 가격 출처 (어느 판매처의 값인지)
    source_site = Column(String(50), nullable=True)

    # 그 시점의 품절 여부 — 품절이면 가격이 의미 없으므로 추이에서 제외할 때 사용
    sold_out = Column(Boolean, nullable=False, default=False)

    # 기록 시각 (하루 1회 스냅샷)
    recorded_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    bean = relationship("RoasteryBean")


def ensure_roastery_constraints(engine) -> None:
    """[자가치유] 기존 DB의 product_offers·bean_reviews에 유니크/조회 인덱스 보강.

    이 제약들은 옛 마이그레이션에만 있었고 모델에는 없어서, create_all로 만들어진
    운영 DB에는 빠져 있었다 — 수집 upsert(select-then-insert)가 동시 실행되면 같은
    (원두, 판매처) 오퍼가 중복으로 쌓였다. 모델 __table_args__로 선언을 옮겼고(신규 DB),
    기존 DB는 여기서 중복 정리 후 걸어 준다. 실패해도 서비스는 계속 뜬다.
    """
    import logging
    from sqlalchemy import inspect, text
    logger = logging.getLogger(__name__)
    try:
        insp = inspect(engine)
        with engine.begin() as conn:
            if insp.has_table("product_offers"):
                conn.execute(text(
                    "DELETE FROM product_offers WHERE id NOT IN ("
                    " SELECT MAX(id) FROM product_offers GROUP BY bean_id, source_site)"
                ))
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_product_offers_bean_source"
                    " ON product_offers (bean_id, source_site)"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_product_offers_price_stock"
                    " ON product_offers (price, in_stock)"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_product_offers_review_rating"
                    " ON product_offers (review_count, rating)"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS ix_product_offers_bean_updated"
                    " ON product_offers (bean_id, updated_at)"
                ))
            if insp.has_table("bean_reviews"):
                # source_url이 NULL인 행은 유니크 대상이 아니다 (표준 SQL: NULL은 중복 아님)
                conn.execute(text(
                    "DELETE FROM bean_reviews WHERE source_url IS NOT NULL AND id NOT IN ("
                    " SELECT MAX(id) FROM bean_reviews WHERE source_url IS NOT NULL"
                    " GROUP BY source_url)"
                ))
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_bean_reviews_source_url"
                    " ON bean_reviews (source_url)"
                ))
        logger.info("product_offers·bean_reviews 제약 보강 완료")
    except Exception:
        logger.exception("로스터리 제약 보강 실패 — 다음 기동 때 재시도")
