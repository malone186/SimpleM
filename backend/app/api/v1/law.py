# backend/app/api/v1/law.py
"""
[한글 주석] 법령 RAG 검색 및 수집/동기화 REST API 라우터 모듈

본 라우터는 법령 조문 검색, 데이터 수집/동기화 및 색인 상태 조회를 담당합니다.
- POST /api/v1/law/search : RAG 기반 하이브리드 법령 조문 검색
- GET /api/v1/law/documents : 등록된 법령 문서 리스트 조회
- POST /api/v1/law/sync : 법령 데이터 수집 및 ChromaDB/RDB 동기화 (관리자)
- GET /api/v1/law/stats : ChromaDB 적재 상태 조회
"""

import logging
from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.law import (
    LawSearchRequest, LawSearchResponse, LawSource,
    LawSyncRequest, LawSyncResponse
)
from app.services.operation.law_rag_service import LawRAGService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/law", tags=["Law RAG - 법령 검색 및 동기화"])

DISCLAIMER_TEXT = "\n\n※ 본 답변은 국가법령정보센터 조문 기반 참고용 정보이며, 최종 법률 판단은 전문가 자문을 권장합니다."


@router.post(
    "/search",
    response_model=LawSearchResponse,
    summary="법령 하이브리드 RAG 검색",
    description="사용자의 질문을 입력받아 하이브리드 검색 및 RRF 리랭킹을 거쳐 인용 조문과 근거 답변을 반환합니다."
)
def search_law_articles(req: LawSearchRequest):
    """[한글 주석] 법령 검색 REST 엔드포인트 (임계값 컷 + 면책 고지 적용)"""
    try:
        results = LawRAGService.search_law_documents(
            query=req.query,
            category=req.category,
            top_k=req.top_k,
            min_similarity_score=req.min_score
        )

        if not results:
            return LawSearchResponse(
                answer="카페 운영 관련 법령 정보가 부족하여 명확한 답변이 어렵습니다." + DISCLAIMER_TEXT,
                sources=[],
                has_answer=False,
                message=f"'{req.query}'에 대한 적절한 근거 조문을 찾지 못했거나 유사도가 미달되었습니다."
            )

        sources = [
            LawSource(
                law_name=r["law_name"],
                article_no=r["article_no"],
                category=r["category"],
                content=r["content"],
                source=r["source"],
                effective_date=r["effective_date"],
                score=r["score"]
            ) for r in results
        ]

        # 근거 기반 요약 답변 생성
        primary = results[0]
        answer_summary = f"[{primary['law_name']} {primary['article_no']}]에 따르면 다음과 같습니다:\n{primary['content']}"

        return LawSearchResponse(
            answer=answer_summary + DISCLAIMER_TEXT,
            sources=sources,
            has_answer=True,
            message=f"성공적으로 관련 법령 조문 {len(sources)}건이 검색되었습니다."
        )
    except Exception as e:
        logger.exception(f"법령 검색 API 실행 실패: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"법령 검색 중 내부 서버 오류가 발생했습니다: {str(e)}"
        )


@router.get(
    "/documents",
    summary="법령 RAG 문서 목록 조회",
    description="ChromaDB 및 RDB에 적재된 법령 문서 리스트를 키워드로 검색/조회합니다."
)
def get_law_documents(
    keyword: Optional[str] = Query(None, description="검색 키워드"),
    top_k: int = Query(5, ge=1, le=20)
):
    """[한글 주석] 등록 문서 리스트 조회 엔드포인트"""
    query_text = keyword if keyword else "근로기준 최저임금 임대차 위생"
    results = LawRAGService.search_law_documents(query=query_text, top_k=top_k, min_similarity_score=0.40)
    return {
        "success": True,
        "count": len(results),
        "documents": results
    }


@router.post(
    "/sync",
    response_model=LawSyncResponse,
    summary="법령 데이터 수집 및 ChromaDB/RDB 동기화",
    description="국가법령정보센터 및 파이프라인에서 최신 데이터를 수집해 RDB에 보관하고 ChromaDB에 선택적 재임베딩합니다."
)
def sync_law_database(
    req: LawSyncRequest,
    db: Session = Depends(get_db)
):
    """[한글 주석] 관리자용 법령 데이터 수집/동기화 엔드포인트"""
    try:
        res = LawRAGService.sync_law_documents(db=db, target_law=req.law_name or "전체")
        return LawSyncResponse(
            success=res["success"],
            total_fetched=res["total_fetched"],
            total_updated_or_new=res["total_updated_or_new"],
            total_indexed=res["total_indexed"],
            timestamp=res["timestamp"],
            message=res["message"]
        )
    except Exception as e:
        logger.exception(f"법령 데이터 동기화 실패: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"법령 데이터 동기화 중 오류 발생: {str(e)}"
        )


@router.get(
    "/stats",
    summary="법령 RAG 색인 상태 조회",
    description="ChromaDB 색인 수량 및 DB 저장소 상태를 반환합니다."
)
def get_law_stats():
    """[한글 주석] 법령 색인 현황 조회 엔드포인트"""
    return LawRAGService.get_collection_stats()
