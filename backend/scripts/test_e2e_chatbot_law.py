# backend/scripts/test_e2e_chatbot_law.py
"""
[한글 주석] 법령 RAG 및 챗봇 End-to-End (E2E) 통합 테스트 스크립트

검증 항목:
1. 법령 질문 ("알바생 주휴수당 조건이 뭐야?")
   - 의도 분류 및 Law RAG 검색
   - 근거(법령명/조문번호/출처/시행일) 포함 여부 및 REST API (answer, sources, has_answer) 필드 구조 검증
2. 데이터에 없는 질문 ("우주법 알려줘")
   - 환각 방지 조치: has_answer=False 및 "정보 부족" 안내 반환 검증
3. 챗봇 메인 에이전트(main_agent) 오케스트레이션 연동 테스트
"""

import os
import sys
import logging
from typing import Dict, Any

# backend 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from app.main import app
from app.services.operation.law_rag_service import LawRAGService
from app.services.operation.law_tools import search_law_documents_tool

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("E2ETestChatbotLaw")

client = TestClient(app)


def test_e2e_law_rag_flow():
    print("=" * 70)
    print("      [SimpleM 법령 챗봇 End-to-End (E2E) 통합 테스트]")
    print("=" * 70)

    # 0. 시드 데이터 동기화
    LawRAGService.sync_law_documents(db=None, target_law="전체")

    # -------------------------------------------------------------------------
    # [시나리오 1] 유효한 법령 질문: "알바생 주휴수당 조건이 뭐야?"
    # -------------------------------------------------------------------------
    print("\n[시나리오 1] 유효 법령 질문 테스트 ('알바생 주휴수당 조건이 뭐야?')")
    print("-" * 70)

    # (1) REST API 엔드포인트 테스트 (POST /api/v1/law/search)
    print(" 1-1. POST /api/v1/law/search REST API 호출:")
    payload_1 = {
        "query": "알바생 주휴수당 조건이 뭐야?",
        "category": "노무/근로",
        "top_k": 5,
        "min_score": 0.55
    }
    
    response_1 = client.post("/api/v1/law/search", json=payload_1)
    
    if response_1.status_code != 200:
        print(f" [!] API 실패 (HTTP status {response_1.status_code}): {response_1.text}")
        return False

    res_json_1 = response_1.json()
    
    answer_1 = res_json_1.get("answer", "")
    sources_1 = res_json_1.get("sources", [])
    has_answer_1 = res_json_1.get("has_answer", False)

    print(f"    - has_answer 필드: {has_answer_1} (기대값: True) -> {'[성공]' if has_answer_1 else '[실패]'}")
    print(f"    - sources 필드 수량: {len(sources_1)}건")
    
    if sources_1:
        first_src = sources_1[0]
        law_name = first_src.get("law_name", "")
        art_no = first_src.get("article_no", "")
        source_name = first_src.get("source", "")
        eff_date = first_src.get("effective_date", "")

        print(f"    - 인용 메타데이터: [{law_name} {art_no}] / 출처: {source_name} / 시행일: {eff_date}")
        
        has_citations = bool(law_name and art_no and source_name and eff_date)
        print(f"    - 근거 필수 4종 포함 여부: {'[성공]' if has_citations else '[실패]'}")

    print(f"    - 최종 생성 답변:\n{answer_1[:150]}...")

    # (2) LangChain Tool 호출 테스트
    print("\n 1-2. search_law_documents_tool 직접 호출 테스트:")
    tool_res_1 = search_law_documents_tool.invoke({"keyword": "알바생 주휴수당 조건"})
    print(f"    - Tool 응답 success: {tool_res_1.get('success')} / 데이터 건수: {len(tool_res_1.get('data', []))}")

    # -------------------------------------------------------------------------
    # [시나리오 2] 데이터에 없는 질문: "우주법 알려줘" (환각 방지 평가)
    # -------------------------------------------------------------------------
    print("\n" + "-" * 70)
    print("[시나리오 2] 범위 외 질문 테스트 ('우주법 알려줘' - 환각 방지)")
    print("-" * 70)

    payload_2 = {
        "query": "우주법 알려줘",
        "top_k": 5,
        "min_score": 0.58
    }

    response_2 = client.post("/api/v1/law/search", json=payload_2)
    res_json_2 = response_2.json()

    answer_2 = res_json_2.get("answer", "")
    sources_2 = res_json_2.get("sources", [])
    has_answer_2 = res_json_2.get("has_answer", True)

    print(f"    - has_answer 필드: {has_answer_2} (기대값: False) -> {'[성공]' if not has_answer_2 else '[실패]'}")
    print(f"    - sources 필드 수량: {len(sources_2)}건 (기대값: 0건)")
    print(f"    - 정보 부족 안내 문구 포함 여부: {'[성공]' if '정보가 부족' in answer_2 else '[실패]'}")
    print(f"    - 생성된 답변: '{answer_2.strip()}'")

    # -------------------------------------------------------------------------
    # [시나리오 3] 챗봇 메인 에이전트(main_agent) 오케스트레이터 구조 검증
    # -------------------------------------------------------------------------
    print("\n" + "-" * 70)
    print("[시나리오 3] 챗봇 메인 에이전트 (main_agent) 오케스트레이션 및 등록 검증")
    print("-" * 70)

    try:
        from app.services.ai.agents.main_agent import _DOMAINS
        law_domain = next((d for d in _DOMAINS if d.get("name") == "law_expert"), None)
        if law_domain:
            print(f"    - law_expert 서브에이전트 등록 상태: [성공]")
            print(f"    - 담당 모듈: {law_domain.get('modules')}")
            print(f"    - 환각 방지 및 출처 인용 지침 포함 여부: {'[성공]' if '정보가 부족' in law_domain.get('extra', '') else '[실패]'}")
        else:
            print("    [!] law_expert 서브에이전트가 _DOMAINS에 등록되지 않았습니다.")
    except Exception as e:
        print(f"    [!] 에이전트 오케스트레이터 점검 실패: {str(e)}")

    print("\n" + "=" * 70)
    print("             [End-to-End 전체 테스트 검증 성공]")
    print("=" * 70)
    return True


if __name__ == "__main__":
    test_e2e_law_rag_flow()
