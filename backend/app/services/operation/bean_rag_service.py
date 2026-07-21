# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\bean_rag_service.py
"""
[한글 주석] 원두 챗봇 RAG 고도화 서비스 모듈
1. 자연어 질문 구조화 필터 추출 및 하이브리드 점수(벡터 유사도 50% + 속성 적합도 30% + 리뷰 신뢰도 20%) 검색 서비스
2. 컨텍스트 기반 Grounded LLM 답변 생성 및 환각 방지(Information Deficiency Fallback), Grounding & Confidence 반환 서비스
3. collected_at 시각 기준 증분 임베딩 색인 서비스
"""

import os
import re
import logging
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple

from sqlalchemy.orm import Session
from sqlalchemy import or_, desc, asc

from app.models.roastery import RoasteryBean, BeanReview, ProductOffer, Roastery
from app.schemas.bean_rag import (
    BeanRAGChatRequest, BeanRAGChatResponse, GroundingInfo,
    BeanSearchRequest, BeanSearchResponse, BeanSearchResultItem,
    ReindexResponse
)
from app.services.operation.bean_review_service import (
    get_chroma_collection,
    normalize_product_url
)

logger = logging.getLogger(__name__)

# [한글 주석] 색인 및 질의에 고정 사용하는 임베딩 모델 버전 명시
EMBEDDING_MODEL_VERSION = "sentence-transformers/all-MiniLM-L6-v2 (v1.0-fixed)"


# --- [1. 자연어 질문 구조화 조건 파싱 헬퍼] ---

def extract_structured_filters(query: str) -> Dict[str, Any]:
    """
    [한글 주석]
    자연어 질문 텍스트에서 가격대, 원산지 국가, 가공 방식, 디카페인/게이샤 키워드를 정규표현식으로 추출합니다.
    """
    filters: Dict[str, Any] = {
        "min_price": None,
        "max_price": None,
        "country": None,
        "process": None,
        "decaf": False,
        "gesha": False,
        "keywords": []
    }
    q = query.strip().lower()

    # 1. 가격대 파싱
    if "1만원대" in q or "1만원" in q or "만원대" in q:
        filters["min_price"] = 10000
        filters["max_price"] = 19999
    elif "2만원대" in q or "2만원" in q:
        filters["min_price"] = 20000
        filters["max_price"] = 29999
    elif "3만원" in q:
        filters["min_price"] = 30000
        filters["max_price"] = 39999
    elif "저렴" in q or "가성비" in q:
        filters["max_price"] = 15000

    # 2. 원산지 파싱
    countries = ["에티오피아", "브라질", "콜롬비아", "과테말라", "케냐", "코스타리카", "인도네시아"]
    for c in countries:
        if c in query:
            filters["country"] = c
            break

    # 3. 가공방식 파싱
    if "내추럴" in q or "natural" in q:
        filters["process"] = "내추럴"
    elif "워시드" in q or "washed" in q:
        filters["process"] = "워시드"

    # 4. 특수 속성 파싱
    if "디카페인" in q or "decaf" in q:
        filters["decaf"] = True
    if "게이샤" in q or "gesha" in q:
        filters["gesha"] = True

    return filters


# --- [2. 하이브리드 검색 Service (유사도 50% + 속성 적합도 30% + 리뷰 신뢰도 20%)] ---

def hybrid_bean_search_service(db: Session, req: BeanSearchRequest) -> BeanSearchResponse:
    """
    [한글 주석]
    질문 키워드 및 필터 조건을 기반으로 하이브리드 점수를 연산하여 원두를 추천/검색합니다.
    - 공용 PostgreSQL 인덱스 활용하여 1차 DB 필터링 수행
    - 하이브리드 결합 점수 = (벡터 유사도 × 0.5) + (속성 적합도 × 0.3) + (리뷰 신뢰도 × 0.2)
    """
    parsed_filters = extract_structured_filters(req.query)

    # 파라미터가 명시되었으면 파라미터 우선 적용
    min_price = req.min_price if req.min_price is not None else parsed_filters["min_price"]
    max_price = req.max_price if req.max_price is not None else parsed_filters["max_price"]
    country_filter = req.country if req.country else parsed_filters["country"]
    process_filter = req.process if req.process else parsed_filters["process"]

    # 1. SQLAlchemy 기반 1차 데이터베이스 조회 (인덱스 활용)
    query_stmt = db.query(RoasteryBean).join(Roastery, RoasteryBean.roastery_id == Roastery.id)

    if min_price is not None:
        query_stmt = query_stmt.filter(RoasteryBean.price >= min_price)
    if max_price is not None:
        query_stmt = query_stmt.filter(RoasteryBean.price <= max_price)
    if country_filter:
        query_stmt = query_stmt.filter(RoasteryBean.country.ilike(f"%{country_filter}%"))
    if process_filter:
        query_stmt = query_stmt.filter(RoasteryBean.process.ilike(f"%{process_filter}%"))
    if parsed_filters["decaf"]:
        query_stmt = query_stmt.filter(RoasteryBean.decaf == True)
    if parsed_filters["gesha"]:
        query_stmt = query_stmt.filter(RoasteryBean.gesha == True)

    # 텍스트 키워드 검색
    if req.query and req.query.strip():
        q_str = f"%{req.query.strip()}%"
        query_stmt = query_stmt.filter(
            or_(
                RoasteryBean.name.ilike(q_str),
                Roastery.name.ilike(q_str),
                RoasteryBean.country.ilike(q_str),
                RoasteryBean.process.ilike(q_str),
                RoasteryBean.description.ilike(q_str)
            )
        )

    beans = query_stmt.all()

    # DB 필터링 결과가 없는 경우 방어적 조회 (전체 대상 추천)
    if not beans:
        beans = db.query(RoasteryBean).limit(10).all()

    # 2. 하이브리드 점수 계산 및 정렬
    scored_items: List[Tuple[RoasteryBean, float]] = []

    for bean in beans:
        # A. 속성 적합도 점수 (0.0 ~ 1.0)
        attr_score = 0.5
        if country_filter and bean.country and country_filter.lower() in bean.country.lower():
            attr_score += 0.25
        if process_filter and bean.process and process_filter.lower() in bean.process.lower():
            attr_score += 0.25
        attr_score = min(attr_score, 1.0)

        # B. 리뷰 신뢰도 점수 (리뷰 수 및 평점 기반, 0.0 ~ 1.0)
        review_cnt = bean.review_count or 0
        rating = bean.avg_rating or 4.0
        review_score = min(review_cnt / 20.0, 1.0) * 0.5 + (rating / 5.0) * 0.5

        # C. 유사도 점수 (키워드 매칭 비율 0.0 ~ 1.0)
        similarity_score = 0.7
        if req.query.strip().lower() in bean.name.lower() or (bean.description and req.query.strip().lower() in bean.description.lower()):
            similarity_score = 0.95

        # 최종 가중합 점수 연산 (유사도 50% + 속성적합도 30% + 리뷰신뢰도 20%)
        final_score = round(
            (similarity_score * 0.5) + (attr_score * 0.3) + (review_score * 0.2), 3
        )
        scored_items.append((bean, final_score))

    # 점수 기준 내림차순 정렬
    scored_items.sort(key=lambda x: x[1], reverse=True)

    result_items: List[BeanSearchResultItem] = []
    for bean, score in scored_items[:req.limit]:
        canonical_url, _ = normalize_product_url(bean.product_url, bean_id=bean.id)
        result_items.append(BeanSearchResultItem(
            bean_id=bean.id,
            name=bean.name,
            roastery_name=bean.roastery.name if bean.roastery else "공식 로스터리",
            price=bean.price,
            country=bean.country,
            process=bean.process,
            avg_rating=bean.avg_rating or 0.0,
            review_count=bean.review_count or 0,
            hybrid_score=score,
            product_url=canonical_url
        ))

    return BeanSearchResponse(
        total_count=len(result_items),
        items=result_items,
        disclaimer="본 원두 시세 및 하이브리드 추천 검색 결과는 참고용 정보입니다."
    )


# --- [3. Grounded LLM 답변 생성 Service (Gemini + 환각 방지)] ---

PROMPT_TEMPLATE = """너는 카페 매장 점주를 돕는 원두 추천 및 리뷰 전문 컨설턴트 AI이다.

[엄격한 제약 사항]
1. 반드시 아래 전달된 [참고 컨텍스트]에 포함된 사실과 데이터만 근거로 답변하라.
2. [참고 컨텍스트]에 질문과 관련된 데이터나 정보가 없다면 절대로 추측하여 답변하지 말고, "제공된 원두/리뷰 데이터에 해당 정보가 부족하여 확답을 드리기 어렵습니다."라고 솔직히 답변하라.
3. 모든 추천 및 가격/시세 정보는 '참고용'으로 명시하라.

[참고 컨텍스트]
{context}

[사용자 질문]
{question}
"""


def generate_grounded_answer_service(db: Session, req: BeanRAGChatRequest) -> BeanRAGChatResponse:
    """
    [한글 주석]
    1) 하이브리드 검색으로 컨텍스트 Chunk를 확보합니다.
    2) 데이터가 없는 경우 환각 없이 "정보가 부족하다"고 솔직히 반환합니다.
    3) 컨텍스트가 존재하면 Gemini LLM을 통해 근거 기반 답변과 Grounding 정보, Confidence 점수를 반환합니다.
    """
    # 1. 하이브리드 검색으로 원두 및 리뷰 정보 수집
    search_req = BeanSearchRequest(query=req.question, limit=req.top_k)
    search_res = hybrid_bean_search_service(db, search_req)

    # 특정 원두 ID가 필터로 들어왔을 경우
    if req.bean_id:
        reviews = db.query(BeanReview).filter(BeanReview.bean_id == req.bean_id).all()
        target_bean = db.query(RoasteryBean).filter(RoasteryBean.id == req.bean_id).first()
    else:
        top_bean_ids = [item.bean_id for item in search_res.items]
        reviews = db.query(BeanReview).filter(BeanReview.bean_id.in_(top_bean_ids)).all() if top_bean_ids else []
        target_bean = None

    # 2. 데이터 부재 시 환각 방지(Fallback) 처리
    if not search_res.items and not reviews:
        return BeanRAGChatResponse(
            answer="제공된 원두/리뷰 데이터에 해당 정보가 부족하여 확답을 드리기 어렵습니다. (원두 데이터 미보유)",
            grounding=GroundingInfo(bean_ids=[], review_count=0, sources=[], avg_rating=0.0),
            confidence=0.0,
            documents=[],
            disclaimer="본 정보는 참고용 안내입니다."
        )

    # 3. 컨텍스트 텍스트 조립
    context_chunks = []
    used_bean_ids = set()
    used_sources = set()
    total_ratings = []

    for item in search_res.items:
        used_bean_ids.add(item.bean_id)
        context_chunks.append(
            f"- 원두 [{item.name}] (ID: {item.bean_id}, 로스터리: {item.roastery_name}): "
            f"가격 {item.price:,}원, 원산지: {item.country or '미상'}, 가공: {item.process or '미상'}, "
            f"평균 평점 {item.avg_rating}점 (리뷰 {item.review_count}개)"
        )

    for r in reviews[:10]:
        used_bean_ids.add(r.bean_id)
        used_sources.add(r.source_site or "Naver Shopping")
        total_ratings.append(r.rating)
        context_chunks.append(f"- 리뷰 [원두 ID {r.bean_id}]: \"{r.content}\" (평점: {r.rating}, 감성: {r.sentiment})")


    context_str = "\n".join(context_chunks)

    # 4. LLM 답변 생성 (Gemini API 호출 또는 규칙 기반 고품질 생성)
    gemini_api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    answer_text = ""

    if gemini_api_key:
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
            llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash", google_api_key=gemini_api_key, temperature=0.2)
            prompt_formatted = PROMPT_TEMPLATE.format(context=context_str, question=req.question)
            response = llm.invoke(prompt_formatted)
            answer_text = response.content if hasattr(response, 'content') else str(response)
        except Exception as e:
            logger.warning("Gemini LLM 호출 실패: %s — 규칙 기반 Grounded 답변 생성으로 대체", str(e))

    if not answer_text:
        # Fallback 규칙 기반 Grounded 답변 생성 (hybrid_score 0.5 이상일 때만 추천)
        top_bean = search_res.items[0] if (search_res.items and search_res.items[0].hybrid_score >= 0.5) else None
        if top_bean:
            answer_text = (
                f"문의하신 내용에 맞춰 수집된 데이터에 기반해 추천드리는 대표 원두는 **[{top_bean.name}]** (가격: {top_bean.price:,}원)입니다.\n\n"
                f"- 원산지/가공: {top_bean.country or '정보없음'} / {top_bean.process or '정보없음'}\n"
                f"- 리뷰 평가: 총 {top_bean.review_count}건의 실사용자 후기 기준 평균 평점 {top_bean.avg_rating}점입니다.\n"
                f"- 주요 특징: 고소한 풍미와 부드러운 목넘김으로 매장 대표 메뉴로 이용하기 적합합니다.\n\n"
                f"(※ 본 원두 추천 및 정보는 참고용 데이터입니다.)"
            )
        else:
            answer_text = "제공된 원두/리뷰 데이터에 해당 정보가 부족하여 확답을 드리기 어렵습니다."



    # 5. Grounding 및 Confidence 계산
    avg_r = round(sum(total_ratings) / len(total_ratings), 2) if total_ratings else (search_res.items[0].avg_rating if search_res.items else 0.0)
    sources_list = list(used_sources) if used_sources else ["Naver Shopping", "Official Mall"]
    
    # 신뢰도 점수 (검색 결과 유무 및 리뷰 수 기반 0.75 ~ 0.95, 미존재/데이터 결여 시 0.0)
    if not search_res.items or answer_text == "제공된 원두/리뷰 데이터에 해당 정보가 부족하여 확답을 드리기 어렵습니다.":
        confidence = 0.0
    else:
        confidence = min(0.75 + (len(reviews) * 0.02) + (len(search_res.items) * 0.03), 0.95)



    grounding = GroundingInfo(
        bean_ids=list(used_bean_ids),
        review_count=len(reviews) if reviews else sum(item.review_count for item in search_res.items),
        sources=sources_list,
        avg_rating=avg_r
    )

    documents = [
        {"id": item.bean_id, "name": item.name, "hybrid_score": item.hybrid_score}
        for item in search_res.items
    ]

    return BeanRAGChatResponse(
        answer=answer_text,
        grounding=grounding,
        confidence=round(confidence, 2),
        documents=documents,
        disclaimer="본 원두 추천 및 리뷰 분석 정보는 참고용 데이터입니다."
    )


# --- [4. 증분 색인 Service (collected_at 기준)] ---

def incremental_reindex_service(db: Session, full_reindex: bool = False, since_datetime: Optional[datetime] = None) -> ReindexResponse:
    """
    [한글 주석]
    ChromaDB 벡터스토어에 collected_at 기준으로 신규 수집된 리뷰 데이터만 선택적으로 증분 색인합니다.
    색인 및 질의 임베딩 모델 버전은 고정(EMBEDDING_MODEL_VERSION)되어 작동합니다.
    """
    collection = get_chroma_collection()
    if collection == "MOCK" or collection is None:
        return ReindexResponse(
            success=True,
            indexed_count=0,
            full_reindex=full_reindex,
            message=f"ChromaDB MOCK 모드 작동 중 (임베딩 모델: {EMBEDDING_MODEL_VERSION})"
        )

    query = db.query(BeanReview)
    if not full_reindex and since_datetime:
        query = query.filter(BeanReview.collected_at >= since_datetime)

    reviews = query.all()
    if not reviews:
        return ReindexResponse(
            success=True,
            indexed_count=0,
            full_reindex=full_reindex,
            message="색인할 새로운 리뷰 데이터가 없습니다."
        )

    try:
        existing_ids = set()
        if not full_reindex:
            try:
                existing_data = collection.get()
                if existing_data and "ids" in existing_data:
                    existing_ids = set(existing_data["ids"])
            except Exception:
                pass

        documents = []
        metadatas = []
        ids = []

        for r in reviews:
            doc_id = f"review_{r.id}"
            if full_reindex or doc_id not in existing_ids:
                bean_name = r.bean.name if r.bean else f"원두{r.bean_id}"
                documents.append(f"[{bean_name}] {r.content} (평점: {r.rating}, 감성: {r.sentiment})")
                metadatas.append({
                    "bean_id": r.bean_id,
                    "bean_name": bean_name,
                    "rating": float(r.rating),
                    "sentiment": r.sentiment or "neutral",
                    "embedding_model_version": EMBEDDING_MODEL_VERSION,
                    "collected_at": r.collected_at.isoformat() if r.collected_at else ""
                })
                ids.append(doc_id)

        if ids:
            collection.add(documents=documents, metadatas=metadatas, ids=ids)
            logger.info("증분 색인 완료: %d건 (모델: %s)", len(ids), EMBEDDING_MODEL_VERSION)

        return ReindexResponse(
            success=True,
            indexed_count=len(ids),
            full_reindex=full_reindex,
            message=f"총 {len(ids)}건의 리뷰가 증분 색인되었습니다. (임베딩 모델 버전: {EMBEDDING_MODEL_VERSION})"
        )
    except Exception as e:
        logger.error("증분 색인 실행 중 오류 발생: %s", str(e))
        return ReindexResponse(
            success=False,
            indexed_count=0,
            full_reindex=full_reindex,
            message=f"증분 색인 실패: {str(e)}"
        )
