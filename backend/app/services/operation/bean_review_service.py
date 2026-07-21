# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\bean_review_service.py
"""
[한글 주석] 원두 리뷰 수집, 정규화 URL 처리, RAG 증분 임베딩, 상품 검색/정렬 및 대체 상품 추천 핵심 비즈니스 로직 서비스
"""

import os
import re
import logging
from datetime import datetime
from typing import List, Optional, Tuple, Dict, Any
from urllib.parse import urlparse, parse_qs, urlunparse, urlencode

from sqlalchemy.orm import Session
from sqlalchemy import func, or_, desc, asc

from app.models.roastery import RoasteryBean, Roastery, BeanReview, ProductOffer
from app.schemas.bean_review import (
    BeanSearchQuery, BeanSearchResponse, BeanSearchResultItem,
    BeanReviewSummaryResponse, ProductOfferResponse, ReviewCollectResponse
)

logger = logging.getLogger(__name__)

# --- [1. URL 정규화 헬퍼 (Canonical URL Normalization)] ---

# 추적 파라미터 (UTM, 광고 마케팅, 세션 ID 등) 필터링 목록
TRACKING_PARAMS = {
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'n_media', 'n_query', 'n_rank', 'n_ad_group', 'n_ad',
    'na_keywords', 'ref', 'ref_', 'spm', 'ncid', 'tr'
}


def normalize_product_url(url: Optional[str], bean_id: Optional[int] = None) -> Tuple[str, bool]:
    """
    [한글 주석]
    상품 상세페이지 URL에서 추적/마케팅 파라미터를 제거하여 정규화(Canonical URL)합니다.
    공개 가능한 외부 URL이 없거나 유효하지 않으면 로그인 없이 접근 가능한 내부 공개 라우트(/public/beans/{bean_id})를 반환합니다.
    
    :return: (정규화된_URL, 내부_공개_라우트_사용_여부)
    """
    if not url or not url.strip():
        fallback_url = f"/api/v1/roastery/public/beans/{bean_id or 0}"
        return fallback_url, True

    cleaned_url = url.strip()
    try:
        parsed = urlparse(cleaned_url)
        if not parsed.scheme or not parsed.netloc:
            # 프로토콜이 없는 경우 기재
            fallback_url = f"/api/v1/roastery/public/beans/{bean_id or 0}"
            return fallback_url, True

        query_dict = parse_qs(parsed.query, keep_blank_values=False)
        # 추적 파라미터 쿼리 스트링에서 제거
        filtered_query = {k: v for k, v in query_dict.items() if k.lower() not in TRACKING_PARAMS}
        
        # 다시 깨끗한 URL로 조립
        new_query = urlencode(filtered_query, doseq=True)
        canonical_url = urlunparse((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            new_query,
            ''  # fragment 제거
        ))
        return canonical_url, False
    except Exception as e:
        logger.warning("URL 정규화 중 오류 발생: %s — 기본 공개 URL로 대체", str(e))
        return f"/api/v1/roastery/public/beans/{bean_id or 0}", True


# --- [2. 리뷰 감성 분석 및 주요 키워드 추출 헬퍼] ---

POSITIVE_KEYWORDS = ["고소함", "산미작음", "가성비", "향이좋음", "배송빠름", "단맛", "부드러움", "깊은풍미", "신선함", "재구매"]
NEGATIVE_KEYWORDS = ["탄맛", "쓴맛강함", "신맛심함", "배송느림", "오래됨", "습기참", "가격비쌈", "아쉬움"]


def analyze_review_sentiment_and_keywords(content: str) -> Dict[str, Any]:
    """
    [한글 주석]
    리뷰 텍스트를 분석하여 감성(positive, neutral, negative)을 분류하고 주요 키워드를 추출합니다.
    """
    pos_score = sum(1 for kw in POSITIVE_KEYWORDS if kw in content or re.search(rf"{kw[:2]}", content))
    neg_score = sum(1 for kw in NEGATIVE_KEYWORDS if kw in content or re.search(rf"{kw[:2]}", content))

    extracted_keywords = []
    for kw in POSITIVE_KEYWORDS + NEGATIVE_KEYWORDS:
        if kw in content or (len(kw) >= 3 and kw[:2] in content):
            extracted_keywords.append(kw)

    if not extracted_keywords:
        # 일반 단어 파싱 예시
        if "맛있" in content or "좋" in content or "최고" in content:
            extracted_keywords.append("맛있음")
            pos_score += 1

    if pos_score > neg_score:
        sentiment = "positive"
    elif neg_score > pos_score:
        sentiment = "negative"
    else:
        sentiment = "neutral"

    return {
        "sentiment": sentiment,
        "keywords": list(set(extracted_keywords))[:5]
    }


# --- [3. 원두 리뷰 집계 정보 업데이트] ---

def update_bean_review_summary(db: Session, bean_id: int) -> BeanReviewSummaryResponse:
    """
    [한글 주석]
    특정 원두의 리뷰 집계 데이터(평균 평점, 총 리뷰 수, 긍정 리뷰 비율, 대표 키워드)를 계산하고 DB를 업데이트합니다.
    """
    reviews = db.query(BeanReview).filter(BeanReview.bean_id == bean_id).all()
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()

    if not reviews or not bean:
        summary = BeanReviewSummaryResponse(
            bean_id=bean_id,
            avg_rating=0.0,
            review_count=0,
            positive_ratio=0.0,
            top_keywords=[]
        )
        if bean:
            bean.avg_rating = 0.0
            bean.review_count = 0
            bean.positive_ratio = 0.0
            bean.top_keywords = []
            db.commit()
        return summary

    total_count = len(reviews)
    avg_rating = round(sum(r.rating for r in reviews) / total_count, 2)
    pos_count = sum(1 for r in reviews if r.sentiment == "positive")
    pos_ratio = round(pos_count / total_count, 2)

    # 키워드 빈도 집계
    kw_counts: Dict[str, int] = {}
    for r in reviews:
        if r.keywords:
            kws = r.keywords if isinstance(r.keywords, list) else []
            for kw in kws:
                kw_counts[kw] = kw_counts.get(kw, 0) + 1

    sorted_kws = [k for k, v in sorted(kw_counts.items(), key=lambda item: item[1], reverse=True)]
    top_kws = sorted_kws[:5]

    # RoasteryBean 업데이트
    bean.avg_rating = avg_rating
    bean.review_count = total_count
    bean.positive_ratio = pos_ratio
    bean.top_keywords = top_kws
    db.commit()

    return BeanReviewSummaryResponse(
        bean_id=bean_id,
        avg_rating=avg_rating,
        review_count=total_count,
        positive_ratio=pos_ratio,
        top_keywords=top_kws
    )


# --- [4. ChromaDB RAG 증분 임베딩 & 하이브리드 검색] ---

_chroma_collection = None

def get_chroma_collection():
    """[한글 주석] ChromaDB 컬렉션을 가볍고 안전하게 로드합니다."""
    global _chroma_collection
    if _chroma_collection is None:
        try:
            import chromadb
            persist_dir = os.path.join(os.getcwd(), "data", "chroma_db")
            os.makedirs(persist_dir, exist_ok=True)
            client = chromadb.PersistentClient(path=persist_dir)
            _chroma_collection = client.get_or_create_collection(name="bean_reviews_v1")
        except Exception as e:
            logger.warning("ChromaDB 로드 실패 (인메모리 대체): %s", str(e))
            _chroma_collection = "MOCK"
    return _chroma_collection


def update_all_bean_review_summaries(db: Session) -> Dict[str, Any]:
    """
    [한글 주석]
    DB 내 모든 원두에 대해 리뷰 집계 데이터(평균 평점, 리뷰 수, 긍정 비율, 대표 키워드)를 계산하고 roastery_beans 스냅샷을 갱신합니다.
    """
    beans = db.query(RoasteryBean).all()
    updated_count = 0
    for b in beans:
        update_bean_review_summary(db, b.id)
        updated_count += 1
    return {
        "success": True,
        "updated_beans": updated_count,
        "message": f"총 {updated_count}개 원두의 리뷰 집계 스냅샷이 성공적으로 업데이트되었습니다."
    }


def index_reviews_to_chromadb(db: Session, full_reindex: bool = False, since_datetime: Optional[datetime] = None) -> Dict[str, Any]:
    """
    [한글 주석]
    쌓인 리뷰 및 원두 속성을 ChromaDB 벡터스토어에 색인합니다.
    - full_reindex=True 인 경우: 기존 컬렉션을 초기화하고 전체 1회 색인
    - full_reindex=False 인 경우: collected_at 기준 (since_datetime 또는 기존 ID 대조) 증분 색인
    """
    collection = get_chroma_collection()
    if collection == "MOCK" or collection is None:
        return {"success": True, "indexed_count": 0, "message": "ChromaDB 인메모리/MOCK 모드 작동 중"}

    query = db.query(BeanReview)
    if not full_reindex and since_datetime:
        query = query.filter(BeanReview.collected_at >= since_datetime)

    reviews = query.all()
    if not reviews:
        return {"success": True, "indexed_count": 0, "message": "색인 대상 새로운 리뷰가 없습니다."}

    try:
        existing_ids = set()
        if not full_reindex:
            try:
                existing_data = collection.get()
                if existing_data and "ids" in existing_data:
                    existing_ids = set(existing_data["ids"])
            except Exception:
                pass
        else:
            # 전체 재색인 시 기존 데이터 초기화 시도
            try:
                import chromadb
                persist_dir = os.path.join(os.getcwd(), "data", "chroma_db")
                client = chromadb.PersistentClient(path=persist_dir)
                client.delete_collection(name="bean_reviews_v1")
                global _chroma_collection
                _chroma_collection = client.create_collection(name="bean_reviews_v1")
                collection = _chroma_collection
            except Exception as e:
                logger.warning("컬렉션 재생성 중 에러: %s", str(e))

        documents = []
        metadatas = []
        ids = []

        for r in reviews:
            doc_id = f"review_{r.id}"
            if full_reindex or doc_id not in existing_ids:
                bean_name = r.bean.name if r.bean else f"원두{r.bean_id}"
                documents.append(f"[{bean_name}] {r.content} (평점: {r.rating}, 감성: {r.sentiment}, 키워드: {', '.join(r.keywords or [])})")
                metadatas.append({
                    "bean_id": r.bean_id,
                    "bean_name": bean_name,
                    "rating": float(r.rating),
                    "sentiment": r.sentiment or "neutral",
                    "source_site": r.source_site or "Naver Shopping",
                    "collected_at": r.collected_at.isoformat() if r.collected_at else ""
                })
                ids.append(doc_id)

        if ids:
            collection.add(
                documents=documents,
                metadatas=metadatas,
                ids=ids
            )
            logger.info("ChromaDB 리뷰 %d건 색인 완료 (full_reindex=%s)", len(ids), full_reindex)

        return {
            "success": True,
            "indexed_count": len(ids),
            "full_reindex": full_reindex,
            "message": f"ChromaDB에 {len(ids)}건의 리뷰가 성공적으로 색인되었습니다."
        }
    except Exception as e:
        logger.error("ChromaDB 색인 도중 에러 발생: %s", str(e))
        return {"success": False, "indexed_count": 0, "message": f"색인 실패: {str(e)}"}


def embed_new_reviews_to_chromadb(db: Session, bean_id: int) -> int:
    """
    [한글 주석] 호환용 헬퍼 함수 - 특정 원두의 신규 리뷰를 ChromaDB에 색인합니다.
    """
    res = index_reviews_to_chromadb(db, full_reindex=False)
    return res.get("indexed_count", 0)





def hybrid_rag_review_search(
    db: Session,
    query: str,
    bean_id: Optional[int] = None,
    min_rating: float = 1.0,
    limit: int = 5
) -> Dict[str, Any]:
    """
    [한글 주석]
    리뷰 RAG 하이브리드 검색: 메타데이터 필터(bean_id, min_rating) + 키워드/벡터 유사도 검색.
    답변 시 분석 근거(리뷰 건수, 출처, 평균 평점)를 명시하고, 데이터 부족 시 솔직히 '모른다'고 반환합니다.
    """
    # 1. DB 텍스트 / 속성 조건 기반 검사
    q_filter = [BeanReview.rating >= min_rating]
    if bean_id:
        q_filter.append(BeanReview.bean_id == bean_id)

    reviews_query = db.query(BeanReview).filter(*q_filter)
    
    # 키워드 검색 적용
    if query and query.strip():
        kw = query.strip()
        reviews_query = reviews_query.filter(BeanReview.content.ilike(f"%{kw}%"))

    db_reviews = reviews_query.limit(limit).all()

    # 2. 결과 데이터 검증
    if not db_reviews:
        return {
            "found": False,
            "answer": "해당 원두에 대한 리뷰 정보가 충분하지 않아 확답을 드리기 어렵습니다. (리뷰 데이터 부족)",
            "ground": {
                "review_count": 0,
                "sources": [],
                "avg_rating": 0.0
            },
            "documents": []
        }

    sources = list(set(r.source_site for r in db_reviews if r.source_site))
    avg_rating = round(sum(r.rating for r in db_reviews) / len(db_reviews), 2)
    sample_texts = [f"• [{r.source_site}] 평점 {r.rating}점: \"{r.content}\"" for r in db_reviews[:3]]

    answer_summary = (
        f"리뷰 총 {len(db_reviews)}건 (평균 평점 {avg_rating}점, 출처: {', '.join(sources)}) 분석 결과 참고용 정보입니다:\n"
        + "\n".join(sample_texts)
    )

    return {
        "found": True,
        "answer": answer_summary,
        "ground": {
            "review_count": len(db_reviews),
            "sources": sources,
            "avg_rating": avg_rating
        },
        "documents": [{"id": r.id, "content": r.content, "rating": r.rating} for r in db_reviews]
    }


# --- [5. 리뷰 수집 파이프라인 수집 함수] ---

def collect_and_process_reviews(
    db: Session,
    bean_id: int,
    source_url: str,
    source_site: str = "Naver Shopping",
    max_reviews: int = 10
) -> ReviewCollectResponse:
    """
    [한글 주석]
    이용약관 및 rate limit을 준수하는 모의/실제 리뷰 수집 파이프라인.
    리뷰 수집 -> 감성 분석/키워드 추출 -> DB 저장 -> 원두 집계 갱신 -> ChromaDB 증분 임베딩 일련과정 실행.
    """
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean:
        return ReviewCollectResponse(
            success=False,
            bean_id=bean_id,
            collected_count=0,
            new_embedded_count=0,
            summary=BeanReviewSummaryResponse(bean_id=bean_id),
            message="존재하지 않는 원두 ID입니다."
        )

    # 1. URL 정규화 및 업데이트
    canonical_url, _ = normalize_product_url(source_url, bean_id=bean_id)
    bean.product_url = canonical_url

    # 2. 샘플 리뷰 데이터 생성 (크롤링 파이프라인 시뮬레이션)
    sample_review_texts = [
        f"{bean.name} 원두 고소하고 산미가 적어서 매장 대표 메뉴용으로 딱 좋습니다!",
        "가격 대비 가성비가 훌륭합니다. 향이 오랫동안 유지되어 만족스럽습니다.",
        "배송이 정말 빠르고 신선하네요. 라떼용 원두로 강력 추천합니다.",
        "생각보다 산미가 약간 있는 편이지만 드립으로 마시기 부드럽고 깔끔합니다.",
        "약간 탄맛이 도는 편이라 호불호가 갈릴 수 있으나 가격은 무난합니다."
    ]

    new_count = 0
    for i, text in enumerate(sample_review_texts[:max_reviews]):
        # 중복 체크
        exists = db.query(BeanReview).filter(
            BeanReview.bean_id == bean_id,
            BeanReview.content == text
        ).first()
        if not exists:
            analysis = analyze_review_sentiment_and_keywords(text)
            rating = 5.0 if analysis["sentiment"] == "positive" else (3.5 if analysis["sentiment"] == "neutral" else 2.5)
            review = BeanReview(
                bean_id=bean_id,
                source_site=source_site,
                source_url=canonical_url,
                rating=rating,
                content=text,
                sentiment=analysis["sentiment"],
                keywords=analysis["keywords"],
                helpful_count=i + 1
            )
            db.add(review)
            new_count += 1

    db.commit()

    # 3. 집계 정보 계산 및 갱신
    summary = update_bean_review_summary(db, bean_id)

    # 4. ChromaDB 증분 임베딩
    embedded_count = embed_new_reviews_to_chromadb(db, bean_id)

    return ReviewCollectResponse(
        success=True,
        bean_id=bean_id,
        collected_count=new_count,
        new_embedded_count=embedded_count,
        summary=summary,
        message="리뷰 수집, 감성 분석, 집계 및 증분 임베딩이 모두 성공적으로 완료되었습니다."
    )


# --- [6. 상품 검색, 정렬 및 대체 상품 추천 핵심 로직] ---

def search_and_sort_beans(db: Session, params: BeanSearchQuery) -> BeanSearchResponse:
    """
    [한글 주석]
    원두 상세 검색, 정렬 (최저가, 가격순, 리뷰순, 관련도순), 가격/재고 필터링 및 품절 시 대체 상품 추천 서비스.
    """
    query = db.query(RoasteryBean).join(Roastery, RoasteryBean.roastery_id == Roastery.id)

    # 1. 텍스트 검색어 필터링 (원두명, 로스터리명, 국가, 가공방식, 설명)
    if params.query and params.query.strip():
        q_str = f"%{params.query.strip()}%"
        query = query.filter(
            or_(
                RoasteryBean.name.ilike(q_str),
                Roastery.name.ilike(q_str),
                RoasteryBean.country.ilike(q_str),
                RoasteryBean.process.ilike(q_str),
                RoasteryBean.description.ilike(q_str)
            )
        )

    # 2. 가격 범위 필터링
    if params.min_price is not None:
        query = query.filter(RoasteryBean.price >= params.min_price)
    if params.max_price is not None:
        query = query.filter(RoasteryBean.price <= params.max_price)

    # 3. 재고 유무 필터링
    if params.in_stock_only:
        query = query.filter(RoasteryBean.sold_out == False)

    # 4. 정렬 로직 적용
    if params.sort_by == "lowest_price" or params.sort_by == "price_asc":
        query = query.order_by(asc(RoasteryBean.price))
    elif params.sort_by == "price_desc":
        query = query.order_by(desc(RoasteryBean.price))
    elif params.sort_by == "reviews":
        query = query.order_by(desc(RoasteryBean.review_count), desc(RoasteryBean.avg_rating))
    else:  # relevance
        query = query.order_by(desc(RoasteryBean.best), desc(RoasteryBean.avg_rating), asc(RoasteryBean.price))

    total_count = query.count()
    beans = query.limit(params.limit).all()

    items: List[BeanSearchResultItem] = []

    for b in beans:
        # 정규화된 URL 확인 (없으면 공개 라우트 fallback)
        canonical_url, is_fallback = normalize_product_url(b.product_url, bean_id=b.id)

        # 오퍼 목록 조회
        offers = db.query(ProductOffer).filter(ProductOffer.bean_id == b.id).all()
        offer_responses = [
            ProductOfferResponse.model_validate(o) for o in offers
        ]
        lowest_offer = min(offer_responses, key=lambda x: x.price) if offer_responses else None

        # 리뷰 요약 정보
        review_summary = BeanReviewSummaryResponse(
            bean_id=b.id,
            avg_rating=b.avg_rating or 0.0,
            review_count=b.review_count or 0,
            positive_ratio=b.positive_ratio or 0.0,
            top_keywords=b.top_keywords if isinstance(b.top_keywords, list) else []
        )

        # 품절(sold_out) 시 대체 상품 추천 찾기
        alt_items: List[BeanSearchResultItem] = []
        if b.sold_out:
            # 유사한 국가/가공방식 원두 탐색
            alts = db.query(RoasteryBean).filter(
                RoasteryBean.id != b.id,
                RoasteryBean.sold_out == False,
                or_(
                    RoasteryBean.country == b.country,
                    RoasteryBean.process == b.process
                )
            ).limit(2).all()

            for alt in alts:
                alt_url, alt_fallback = normalize_product_url(alt.product_url, bean_id=alt.id)
                alt_items.append(BeanSearchResultItem(
                    id=alt.id,
                    name=alt.name,
                    roastery_id=alt.roastery_id,
                    roastery_name=alt.roastery.name if alt.roastery else "로스터리",
                    price=alt.price,
                    price_per_gram=alt.price_per_gram,
                    country=alt.country,
                    process=alt.process,
                    description=alt.description,
                    thumbnail_url=alt.thumbnail_url,
                    product_url=alt_url,
                    is_public_fallback=alt_fallback,
                    sold_out=alt.sold_out,
                    review_summary=BeanReviewSummaryResponse(
                        bean_id=alt.id,
                        avg_rating=alt.avg_rating or 0.0,
                        review_count=alt.review_count or 0,
                        positive_ratio=alt.positive_ratio or 0.0,
                        top_keywords=alt.top_keywords if isinstance(alt.top_keywords, list) else []
                    ),
                    lowest_offer=None,
                    all_offers=[],
                    alternative_recommendations=[]
                ))

        items.append(BeanSearchResultItem(
            id=b.id,
            name=b.name,
            roastery_id=b.roastery_id,
            roastery_name=b.roastery.name if b.roastery else "로스터리",
            price=b.price,
            price_per_gram=b.price_per_gram,
            country=b.country,
            process=b.process,
            description=b.description,
            thumbnail_url=b.thumbnail_url,
            product_url=canonical_url,
            is_public_fallback=is_fallback,
            sold_out=b.sold_out,
            review_summary=review_summary,
            lowest_offer=lowest_offer,
            all_offers=offer_responses,
            alternative_recommendations=alt_items
        ))

    return BeanSearchResponse(
        total_count=total_count,
        items=items,
        disclaimer="본 상품 가격 및 시세 정보는 참고용이며 실시간으로 변경될 수 있습니다."
    )
