# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\schemas\bean_rag.py
"""
[한글 주석] 원두 챗봇 RAG 고도화 관련 Pydantic 데이터 검증 스키마 모듈
질문/답변, Grounding(근거 정보), 하이브리드 검색 및 증분 색인 입출력 스펙을 정의합니다.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


# --- [1. 근거(Grounding) 정보 스키마] ---

class GroundingInfo(BaseModel):
    """[한글 주석] RAG 답변 생성에 사용된 근거 데이터 구조"""
    bean_ids: List[int] = Field(default_factory=list, description="답변에 참작된 원두 고유 ID 목록")
    review_count: int = Field(default=0, description="분석된 실사용자 리뷰 총 건수")
    sources: List[str] = Field(default_factory=list, description="리뷰 및 원두 정보 출처 (예: Naver Shopping)")
    avg_rating: float = Field(default=0.0, description="참조된 리뷰들의 평균 평점")


# --- [2. RAG 대화(Chat) 입출력 스키마] ---

class BeanRAGChatRequest(BaseModel):
    """[한글 주석] POST /beans/chat 요청 데이터"""
    question: str = Field(..., description="자연어 질문 (예: '산미 적고 고소한 1만원대 원두 추천해줘')", example="산미 적고 고소한 1만원대 원두 추천해줘")
    top_k: int = Field(default=5, ge=1, le=20, description="참조할 최대 원두/리뷰 개수")
    bean_id: Optional[int] = Field(None, description="특정 원두 ID로 필터링 시 지정")


class BeanRAGChatResponse(BaseModel):
    """[한글 주석] POST /beans/chat 응답 데이터"""
    answer: str = Field(..., description="LLM이 컨텍스트만 근거로 작성한 답변 본문")
    grounding: GroundingInfo = Field(..., description="답변에 활용된 데이터 근거 요약")
    confidence: float = Field(..., ge=0.0, le=1.0, description="답변 신뢰도 점수 (0.0~1.0)")
    documents: List[Dict[str, Any]] = Field(default_factory=list, description="검색에 사용된 원본 Chunk 문맥 정보")
    disclaimer: str = Field(
        default="본 원두 추천 및 리뷰 분석 정보는 참고용 데이터입니다.",
        description="법적 고지 및 참고용 표현"
    )


# --- [3. 하이브리드 검색 입출력 스키마] ---

class BeanSearchRequest(BaseModel):
    """[한글 주석] POST /beans/search 요청 데이터"""
    query: str = Field(..., description="검색 키워드 (예: '에티오피아 내추럴')", example="에티오피아 내추럴")
    min_price: Optional[int] = Field(None, ge=0, description="최소 가격 (원)")
    max_price: Optional[int] = Field(None, ge=0, description="최대 가격 (원)")
    country: Optional[str] = Field(None, description="원산지 국가 필터 (예: '에티오피아')")
    process: Optional[str] = Field(None, description="가공 방식 필터 (예: '워시드', '내추럴')")
    limit: int = Field(default=5, ge=1, le=20, description="반환할 최대 결과 수")


class BeanSearchResultItem(BaseModel):
    """[한글 주석] 하이브리드 검색 결과 개별 원두 항목"""
    bean_id: int = Field(..., description="원두 고유 ID")
    name: str = Field(..., description="원두 상품명")
    roastery_name: str = Field(..., description="로스터리 이름")
    price: int = Field(..., description="판매 단가 (원)")
    country: Optional[str] = Field(None, description="원산지")
    process: Optional[str] = Field(None, description="가공방식")
    avg_rating: float = Field(default=0.0, description="평균 평점")
    review_count: int = Field(default=0, description="총 리뷰 수")
    hybrid_score: float = Field(..., description="유사도+속성+신뢰도 가중합 점수")
    product_url: Optional[str] = Field(None, description="상세 페이지 정규화 URL")


class BeanSearchResponse(BaseModel):
    """[한글 주석] POST /beans/search 응답 데이터"""
    total_count: int = Field(..., description="검색된 총 원두 개수")
    items: List[BeanSearchResultItem] = Field(default_factory=list, description="하이브리드 점수 정렬 목록")
    disclaimer: str = Field(
        default="본 원두 시세 및 검색 결과는 참고용 정보입니다.",
        description="참고용 고지 문구"
    )


# --- [4. 증분 색인 스키마] ---

class ReindexResponse(BaseModel):
    """[한글 주석] POST /rag/reindex 응답 데이터"""
    success: bool = Field(..., description="색인 성공 여부")
    indexed_count: int = Field(..., description="추가 색인된 리뷰 건수")
    full_reindex: bool = Field(..., description="전체 색인 여부")
    message: str = Field(..., description="처리 결과 메세지")
