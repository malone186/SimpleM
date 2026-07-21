"""
법령 RAG 챗봇 도구 래퍼 모듈 (운영 도메인)

※ 본 모듈은 LangChain 챗봇이 법령 조문 및 관련 판례/지침을 RAG 검색할 수 있도록 해주는 도구(tools)입니다.
※ 순수 서비스 호출 후 결과를 JSON 딕셔너리 포맷으로 반환하며, 비즈니스/검색 로직을 직접 포함하지 않습니다.
"""

from typing import Optional, Dict, Any
from app.services.operation.law_rag_service import LawRAGService

# [한글 주석] LangChain @tool 데코레이터 안전 로드 구조
try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func


@tool
def search_law_documents_tool(
    keyword: str,
    category: Optional[str] = None
) -> Dict[str, Any]:
    """카페 사장님의 법률 질문(예: '알바 휴게시간 몇 분 줘야 해?', '야간 수당 조건', '상가 계약 갱신')에 대해 
    관련 법령 조문(법령명, 조문번호, 본문, 출처, 시행일 포함)을 의미 기반(하이브리드 RAG)으로 검색합니다.
    
    [챗봇 응답 지침]
    1. 반드시 검색된 조문의 법령명, 조문번호, 출처, 시행일을 근거로 답변을 작성하세요.
    2. data가 비어있으면 정보를 지어내지 말고 "카페 운영 관련 법령 정보가 부족하여 명확한 답변이 어렵습니다"라고 안내하세요.
    
    - keyword: 검색 키워드 또는 사용자 질문 문장
    - category: 필터링할 법령 카테고리 (예: '근로기준', '임대차', '최저임금' 등, 기본값 None)
    """
    try:
        # [한글 주석] 법령 RAG 검색 서비스 호출 (하이브리드 + RRF)
        results = LawRAGService.search_law_documents(
            query=keyword,
            category=category,
            top_k=5
        )

        # [한글 주석] 환각 방지: 결과가 비어있으면 명확한 안내 메시지 반환
        if not results:
            return {
                "success": True,
                "data": [],
                "documents": [],
                "message": f"'{keyword}'에 대한 카페 운영 관련 법령 조문을 찾을 수 없거나 관련 정보가 부족합니다."
            }

        return {
            "success": True,
            "data": results,
            "documents": results,
            "message": f"'{keyword}' 관련 법령 조문 {len(results)}건이 성공적으로 검색되었습니다."
        }

    except Exception as e:
        # [한글 주석] 예외 발생 시 안전한 JSON 결과 반환
        return {
            "success": False,
            "data": [],
            "documents": [],
            "message": f"법령 RAG 검색 중 오류가 발생했습니다: {str(e)}"
        }


@tool
def get_law_rag_documents_tool(
    keyword: Optional[str] = None
) -> Dict[str, Any]:
    """챗봇 컨텍스트용 법령 RAG 문서 목록을 가져옵니다. 키워드가 전달되면 검색을 수행합니다.
    - keyword: 검색 키워드 (선택 사항)
    """
    try:
        query_text = keyword if keyword else "카페 운영 주요 법령 근로기준 최저임금 임대차"
        results = LawRAGService.search_law_documents(query=query_text, top_k=5)

        return {
            "success": True,
            "data": results,
            "documents": results,
            "message": "법령 RAG 문서 목록 조회가 완료되었습니다."
        }
    except Exception as e:
        return {
            "success": False,
            "data": [],
            "documents": [],
            "message": f"법령 RAG 문서 목록 조회 중 오류 발생: {str(e)}"
        }


@tool
def sync_law_database_tool(
    law_name: Optional[str] = "전체"
) -> Dict[str, Any]:
    """국가법령정보센터 및 법령 수집 파이프라인을 구동하여 최신 조문을 RDB 및 ChromaDB 벡터 저장소에 동기화합니다.
    - law_name: 동기화할 법령명 (예: '근로기준법', '최저임금법', '상가임대차', '전체')
    """
    try:
        res = LawRAGService.sync_law_documents(db=None, target_law=law_name if law_name else "전체")
        return {
            "success": True,
            "data": res,
            "message": res.get("message", "법령 데이터 동기화가 완료되었습니다.")
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "message": f"법령 데이터 동기화 실패: {str(e)}"
        }



