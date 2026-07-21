# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_bean_review_service.py
"""
[한글 주석] 원두 리뷰 수집, URL 정규화, 감성 분석, RAG 증분 임베딩 및 검색/정렬 서비스 단위 테스트
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.roastery import Roastery, RoasteryBean, BeanReview, ProductOffer
from app.schemas.bean_review import BeanSearchQuery
from app.services.operation.bean_review_service import (
    normalize_product_url,
    analyze_review_sentiment_and_keywords,
    collect_and_process_reviews,
    update_bean_review_summary,
    search_and_sort_beans,
    hybrid_rag_review_search
)
from app.services.operation.bean_chatbot_tools import (
    search_roastery_beans_tool,
    get_bean_review_rag_tool,
    get_bean_lowest_price_tool
)


# 테스트용 메모리 SQLite 데이터베이스 엔진 생성
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="function")
def db_session():
    """[한글 주석] 각 테스트마다 깨끗한 DB 테이블을 생성하고 종료 후 세션을 닫습니다."""
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


def test_normalize_product_url():
    """[한글 주석] URL 추적 파라미터 제거 및 canonical URL 생성 테스트"""
    raw_url = "https://smartstore.naver.com/gadelho/products/12345?utm_source=naver&utm_medium=cpc&gclid=xyz123&product_id=99"
    canonical, is_fallback = normalize_product_url(raw_url, bean_id=1)
    
    assert "utm_source" not in canonical
    assert "gclid" not in canonical
    assert "product_id=99" in canonical
    assert is_fallback is False

    # 빈 URL 처리 시 공개 라우트 fallback 검증
    empty_url, is_fallback_empty = normalize_product_url("", bean_id=10)
    assert empty_url == "/api/v1/roastery/public/beans/10"
    assert is_fallback_empty is True


def test_analyze_review_sentiment_and_keywords():
    """[한글 주석] 감성 분석 및 키워드 추출 테스트"""
    text = "에티오피아 원두 고소함과 깊은풍미가 훌륭하며 배송빠르고 가성비 최고입니다!"
    res = analyze_review_sentiment_and_keywords(text)
    
    assert res["sentiment"] == "positive"
    assert "고소함" in res["keywords"]
    assert "가성비" in res["keywords"]


def test_collect_and_process_reviews_pipeline(db_session):
    """[한글 주석] 리뷰 수집, DB 저장, 감성분석, 원두 집계 갱신 통합 테스트"""
    # 1. 테스트용 로스터리 및 원두 생성
    roastery = Roastery(name="테스트 로스터리", roastery_info="고품질 원두 브랜딩")
    db_session.add(roastery)
    db_session.commit()

    bean = RoasteryBean(
        name="테스트 BG 블렌드",
        price=15000,
        roastery_id=roastery.id,
        country="콜롬비아",
        process="워시드",
        description="고소함과 밸런스가 좋은 매장 대표 원두"
    )
    db_session.add(bean)
    db_session.commit()

    # 2. 리뷰 수집 파이프라인 트리거
    collect_res = collect_and_process_reviews(
        db=db_session,
        bean_id=bean.id,
        source_url="https://smartstore.naver.com/test/1?utm_source=ad",
        source_site="Naver Shopping",
        max_reviews=5
    )

    assert collect_res.success is True
    assert collect_res.collected_count > 0
    assert collect_res.summary.avg_rating > 0.0
    assert collect_res.summary.review_count > 0

    # 3. RoasteryBean 집계 반영 검증
    updated_bean = db_session.query(RoasteryBean).filter(RoasteryBean.id == bean.id).first()
    assert updated_bean.avg_rating > 0.0
    assert updated_bean.review_count > 0
    assert updated_bean.positive_ratio > 0.0


def test_search_and_sort_beans_with_alternatives(db_session):
    """[한글 주석] 검색, 정렬 및 품절 시 대체 상품 추천 테스트"""
    roastery = Roastery(name="가델로 커피")
    db_session.add(roastery)
    db_session.commit()

    # 정상 원두 1
    bean1 = RoasteryBean(
        name="에티오피아 예가체프",
        price=18000,
        roastery_id=roastery.id,
        country="에티오피아",
        process="내추럴",
        sold_out=False,
        avg_rating=4.8,
        review_count=12
    )
    # 품절 원두 2 (에티오피아 동일 원산지)
    bean2 = RoasteryBean(
        name="에티오피아 아리차 [품절]",
        price=22000,
        roastery_id=roastery.id,
        country="에티오피아",
        process="내추럴",
        sold_out=True,
        avg_rating=4.9,
        review_count=20
    )
    db_session.add_all([bean1, bean2])
    db_session.commit()

    # 검색 실행 (품절 원두 포함)
    params = BeanSearchQuery(query="에티오피아", sort_by="lowest_price")
    res = search_and_sort_beans(db_session, params)

    assert res.total_count == 2
    # 품절 상품의 대체 추천 확인
    sold_out_item = next(i for i in res.items if i.sold_out)
    assert len(sold_out_item.alternative_recommendations) > 0
    assert sold_out_item.alternative_recommendations[0].name == "에티오피아 예가체프"


def test_hybrid_rag_review_search(db_session):
    """[한글 주석] 하이브리드 RAG 검색 및 데이터 부재 시 예외 답변 처리 검증"""
    roastery = Roastery(name="테스트 로스터리")
    db_session.add(roastery)
    db_session.commit()

    bean = RoasteryBean(name="신규 원두", price=12000, roastery_id=roastery.id)
    db_session.add(bean)
    db_session.commit()

    # 1. 리뷰 데이터가 없는 경우 모른다고 답변
    no_review_res = hybrid_rag_review_search(db_session, query="맛이 어때요?", bean_id=bean.id)
    assert no_review_res["found"] is False
    assert "정보가 충분하지 않아" in no_review_res["answer"]

    # 2. 리뷰 추가 후 정상 근거 반환 확인
    review = BeanReview(
        bean_id=bean.id,
        source_site="Naver Shopping",
        rating=5.0,
        content="고소하고 부드러운 라떼용 최고 원두입니다.",
        sentiment="positive"
    )
    db_session.add(review)
    db_session.commit()

    has_review_res = hybrid_rag_review_search(db_session, query="라떼용", bean_id=bean.id)
    assert has_review_res["found"] is True
    assert "리뷰 총 1건" in has_review_res["answer"]
    assert "평균 평점 5.0점" in has_review_res["answer"]
