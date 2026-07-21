# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\bean_chatbot_tools.py
"""
[한글 주석] 원두 추천, 리뷰 RAG 검색, 최저가 시세 비교 AI 챗봇 전용 LangChain Tool 래퍼 모듈
"""

import logging
from typing import Optional, Dict, Any

# LangChain @tool 데코레이터 안전 로드 구조
try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func

from app.core.database import SessionLocal
from app.schemas.bean_review import BeanSearchQuery
from app.schemas.bean_rag import BeanRAGChatRequest
from app.services.operation.bean_review_service import (
    search_and_sort_beans,
    hybrid_rag_review_search,
    normalize_product_url
)
from app.services.operation.bean_rag_service import generate_grounded_answer_service
from app.models.roastery import RoasteryBean, ProductOffer

logger = logging.getLogger(__name__)


@tool
def bean_chat_rag_tool(question: str, bean_id: Optional[int] = None) -> Dict[str, Any]:
    """[한글 주석] 카페 매장용 원두 추천, 실사용자 리뷰 평가 분석 및 시세 정보를 하이브리드 RAG 검색과 Grounded LLM으로 답변하는 종합 챗봇 도구입니다.
    - question: 사용자 자연어 질문 (예: '산미 적고 고소한 1만원대 원두 추천해줘')
    - bean_id: 특정 원두 ID (선택 사항)
    """
    db = SessionLocal()
    try:
        req = BeanRAGChatRequest(question=question, bean_id=bean_id, top_k=5)
        res = generate_grounded_answer_service(db, req)
        return {
            "success": True,
            "data": {
                "answer": res.answer,
                "grounding": res.grounding.model_dump(),
                "confidence": res.confidence,
                "disclaimer": res.disclaimer
            },
            "documents": res.documents,
            "message": "원두 RAG 종합 답변 생성이 완료되었습니다."
        }
    except Exception as e:
        logger.error("bean_chat_rag_tool 오류: %s", str(e))
        return {
            "success": False,
            "data": {
                "answer": "원두 정보 조회 중 오류가 발생하여 답변할 수 없습니다.",
                "grounding": {"bean_ids": [], "review_count": 0, "sources": [], "avg_rating": 0.0},
                "confidence": 0.0,
                "disclaimer": "본 정보는 참고용입니다."
            },
            "documents": [],
            "message": f"오류 발생: {str(e)}"
        }
    finally:
        db.close()



@tool
def search_roastery_beans_tool(
    query: str = "",
    sort_by: str = "relevance",
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    in_stock_only: bool = False
) -> Dict[str, Any]:
    """[한글 주석] 원두 상품을 이름, 원산지, 풍미, 정렬 방식(lowest_price: 최저가순, reviews: 리뷰순, relevance: 관련도순) 및 가격 범위 조건으로 상세 검색합니다.
    - query: 검색할 키워드 (예: '에티오피아', '고소한 원두', '디카페인')
    - sort_by: 정렬 방식 ('lowest_price': 최저가순, 'reviews': 리뷰많은순, 'relevance': 관련도순)
    - min_price: 최소 가격 (원)
    - max_price: 최대 가격 (원)
    - in_stock_only: True 설정 시 품절되지 않은 상품만 조회
    """
    db = SessionLocal()
    try:
        search_params = BeanSearchQuery(
            query=query,
            sort_by=sort_by,
            min_price=min_price,
            max_price=max_price,
            in_stock_only=in_stock_only,
            limit=5
        )
        res = search_and_sort_beans(db, search_params)
        
        items_data = []
        for item in res.items:
            items_data.append({
                "id": item.id,
                "name": item.name,
                "roastery_name": item.roastery_name,
                "price": f"{item.price:,}원",
                "country": item.country,
                "process": item.process,
                "product_url": item.product_url,
                "avg_rating": item.review_summary.avg_rating,
                "review_count": item.review_summary.review_count,
                "top_keywords": item.review_summary.top_keywords,
                "sold_out": item.sold_out,
                "alternative_recommendations": [
                    {"id": alt.id, "name": alt.name, "price": f"{alt.price:,}원", "product_url": alt.product_url}
                    for alt in item.alternative_recommendations
                ]
            })

        return {
            "success": True,
            "data": {
                "total_count": res.total_count,
                "items": items_data,
                "disclaimer": res.disclaimer
            },
            "documents": [],
            "message": f"원두 검색이 완료되었습니다. ({res.total_count}건 검색됨)"
        }
    except Exception as e:
        logger.error("search_roastery_beans_tool 오류: %s", str(e))
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"원두 검색 중 오류가 발생했습니다: {str(e)}"
        }
    finally:
        db.close()


@tool
def get_bean_review_rag_tool(query: str, bean_id: Optional[int] = None) -> Dict[str, Any]:
    """[한글 주석] 실사용자 리뷰 및 감성 분석 데이터베이스(ChromaDB RAG)를 탐색하여 질문에 대한 근거(리뷰 건수, 평점, 출처)와 함께 평가 정보를 답변합니다.
    - query: 리뷰 관련 질문 키워드 (예: '맛이 어떤가요', '산미가 심한가요', '가성비')
    - bean_id: 특정 원두 ID (선택 사항)
    """
    db = SessionLocal()
    try:
        rag_res = hybrid_rag_review_search(
            db=db,
            query=query,
            bean_id=bean_id,
            limit=5
        )

        return {
            "success": rag_res["found"],
            "data": {
                "answer": rag_res["answer"],
                "ground": rag_res["ground"],
                "disclaimer": "본 리뷰 분석 정보는 실사용자 후기 참고용 정보입니다."
            },
            "documents": rag_res.get("documents", []),
            "message": "리뷰 RAG 조회가 완료되었습니다." if rag_res["found"] else "관련 리뷰 데이터가 부족하여 답변할 수 없습니다."
        }
    except Exception as e:
        logger.error("get_bean_review_rag_tool 오류: %s", str(e))
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"리뷰 RAG 조회 중 오류가 발생했습니다: {str(e)}"
        }
    finally:
        db.close()


@tool
def get_bean_lowest_price_tool(bean_name: str) -> Dict[str, Any]:
    """[한글 주석] 특정 원두의 외부 파트너 판매처별 최저가 시세 및 재고 오퍼 정보를 비교 조회합니다.
    - bean_name: 가격 비교를 원하는 원두 이름 (예: 'BG블랜드', '에티오피아 예가체프')
    """
    db = SessionLocal()
    try:
        bean = db.query(RoasteryBean).filter(RoasteryBean.name.ilike(f"%{bean_name.strip()}%")).first()
        if not bean:
            return {
                "success": False,
                "data": {},
                "documents": [],
                "message": f"'{bean_name}' 이름과 일치하는 원두를 찾을 수 없습니다."
            }

        offers = db.query(ProductOffer).filter(ProductOffer.bean_id == bean.id).all()
        canonical_url, _ = normalize_product_url(bean.product_url, bean_id=bean.id)

        offer_list = []
        for o in offers:
            offer_list.append({
                "source_site": o.source_site,
                "price": f"{o.price:,}원",
                "in_stock": "재고있음" if o.in_stock else "품절",
                "product_url": o.product_url,
                "updated_at": o.updated_at.strftime("%Y-%m-%d %H:%M") if o.updated_at else None
            })

        offer_list.sort(key=lambda x: int(x["price"].replace(",", "").replace("원", "")))

        return {
            "success": True,
            "data": {
                "bean_id": bean.id,
                "bean_name": bean.name,
                "base_price": f"{bean.price:,}원",
                "canonical_product_url": canonical_url,
                "lowest_price": offer_list[0]["price"] if offer_list else f"{bean.price:,}원",
                "offers": offer_list,
                "disclaimer": "본 가격 시세는 외부 쇼핑몰 수집 참고용 데이터이며 실시간 변동될 수 있습니다."
            },
            "documents": [],
            "message": f"'{bean.name}' 최저가 및 시세 조회가 완료되었습니다."
        }
    except Exception as e:
        logger.error("get_bean_lowest_price_tool 오류: %s", str(e))
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"시세 조회 중 오류 발생: {str(e)}"
        }
    finally:
        db.close()


@tool
def product_search_tool(
    query_text: Optional[str] = None,
    sort: str = "price_asc",
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    in_stock_only: bool = False
) -> Dict[str, Any]:
    """[한글 주석] 상품 최저가 검색, 정렬(최저가/가격순/리뷰순), 재고 유무 및 품절 시 대체 추천(Alternatives)을 통합 검색합니다.
    - query_text: 검색어 (원두명, 원산지, 가공방식 등)
    - sort: 정렬 기준 ('price_asc' 최저가 | 'price_desc' 가격순 | 'review_count' 리뷰순 | 'relevance' 관련도순)
    - min_price: 최소 가격 제한 (선택)
    - max_price: 최대 가격 제한 (선택)
    - in_stock_only: 재고 보유 상품만 조회 여부 (기본 False)
    """
    db = SessionLocal()
    try:
        from app.schemas.product_search import ProductSearchQuery
        from app.services.operation.product_search_service import search_products_service

        search_query = ProductSearchQuery(
            q=query_text,
            sort=sort,
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock_only if in_stock_only else None,
            page=1,
            page_size=5
        )
        res = search_products_service(db, search_query)

        items_summary = []
        for item in res.items:
            items_summary.append({
                "bean_id": item.bean_id,
                "name": item.bean_name,
                "roastery": item.roastery_name,
                "source_site": item.source_site,
                "price": f"{item.price:,}원",
                "in_stock": "재고있음" if item.in_stock else "품절",
                "product_url": item.product_url,
                "updated_at": item.updated_at.strftime("%Y-%m-%d %H:%M") if item.updated_at else None
            })

        alts_summary = []
        for alt in res.alternatives:
            alts_summary.append({
                "bean_id": alt.bean_id,
                "name": alt.name,
                "roastery": alt.roastery_name,
                "price": f"{alt.price:,}원",
                "country": alt.country,
                "reason": alt.reason
            })

        return {
            "success": True,
            "data": {
                "total_count": res.total_count,
                "has_out_of_stock_only": res.has_out_of_stock_only,
                "items": items_summary,
                "alternatives": alts_summary,
                "disclaimer": "본 상품 검색 및 최저가 시세는 참고용 데이터입니다."
            },
            "documents": [],
            "message": f"상품 검색 완료 (총 {res.total_count}건)"
        }
    except Exception as e:
        logger.error("product_search_tool 오류: %s", str(e))
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"상품 검색 중 오류 발생: {str(e)}"
        }
    finally:
        db.close()

