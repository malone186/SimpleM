# backend/app/schemas/law.py
"""
[한글 주석] 법령 RAG API 요청 및 응답 Pydantic 스키마 정의 모듈
"""

from typing import List, Optional
from pydantic import BaseModel, Field


class LawSearchRequest(BaseModel):
    """법령 검색 요청 스키마"""
    query: str = Field(..., description="법률 질의 키워드 또는 사용자 문장", example="알바생 주휴수당 조건이 뭐야?")
    category: Optional[str] = Field(None, description="법령 카테고리 (예: 노무/근로, 임대차, 위생/보건)", example="노무/근로")
    top_k: int = Field(5, description="최대 추출 조문 건수", ge=1, le=20)
    min_score: float = Field(0.55, description="최소 유사도 임계값 스코어 (0.0~1.0)", ge=0.0, le=1.0)


class LawSource(BaseModel):
    """법령 검색 결과 조문 근거 스키마"""
    law_name: str = Field(..., description="법령명", example="근로기준법")
    article_no: str = Field(..., description="조문번호", example="제55조(휴일)")
    category: str = Field(..., description="카테고리", example="노무/근로")
    content: str = Field(..., description="조문 원문 내용")
    source: str = Field(..., description="출처", example="국가법령정보센터")
    effective_date: str = Field(..., description="시행일자", example="2026-01-01")
    score: float = Field(..., description="하이브리드 RRF 스코어", example=0.82)


class LawSearchResponse(BaseModel):
    """법령 검색 결과 표준 응답 스키마"""
    answer: str = Field(..., description="RAG 기반 합성 답변 또는 요약")
    sources: List[LawSource] = Field(default_factory=list, description="인용 근거 조문 목록")
    has_answer: bool = Field(..., description="답변 가능 여부 (임계값 만족 시 True, 정보 부족 시 False)")
    message: str = Field(..., description="상태 안내 메시지")


class LawSyncRequest(BaseModel):
    """법령 데이터 동기화 요청 스키마"""
    law_name: Optional[str] = Field("전체", description="수집/동기화할 법령 명칭", example="근로기준법")
    admin_secret: Optional[str] = Field(None, description="관리자 인증 시크릿 키")


class LawSyncResponse(BaseModel):
    """법령 데이터 동기화 결과 스키마"""
    success: bool
    total_fetched: int
    total_updated_or_new: int
    total_indexed: int
    timestamp: str
    message: str
