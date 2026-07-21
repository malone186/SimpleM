# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\test_bean_rag_pipeline.py
"""
[한글 주석] 원두 챗봇 RAG 고도화 파이프라인 E2E 통합 테스트 스크립트
1. 하이브리드 검색 (벡터유사도 50% + 속성 30% + 신뢰도 20%) 테스트
2. Grounded LLM 답변 생성, Grounding 근거 및 Confidence 점수 검증
3. 미존재 원두 질의 시 환각 방지(Information Deficiency Fallback) 검증
4. collected_at 기준 증분 색인 트리거 API 테스트
사용법: python scripts/test_bean_rag_pipeline.py
"""

import sys
import os
import logging

# 백엔드 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from app.main import app

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("TestBeanRAGPipeline")

client = TestClient(app)


def test_bean_rag_pipeline():
    print("=" * 75)
    print("        [SimpleM 원두 챗봇 RAG 고도화 파이프라인 E2E 통합 테스트]")
    print("=" * 75)

    # -------------------------------------------------------------------------
    # [시나리오 1] 원두 챗봇 자연어 질의응답 (Grounded 답변 + Grounding + Confidence)
    # -------------------------------------------------------------------------
    print("\n[시나리오 1] 자연어 원두 질의응답 ('산미 적고 고소한 1만원대 원두 추천해줘')")
    print("-" * 75)
    
    payload1 = {
        "question": "산미 적고 고소한 1만원대 원두 추천해줘",
        "top_k": 5
    }
    response1 = client.post("/api/v1/operation/beans/chat", json=payload1)
    assert response1.status_code == 200, f"API 실패: {response1.text}"
    res_data1 = response1.json()

    print(f"- 응답 성공 여부: {res_data1['success']}")
    print(f"- 메세지: {res_data1['message']}")

    
    chat_data = res_data1["data"]
    print(f"\n[AI 답변 내용]\n{chat_data['answer']}")
    print(f"\n[Grounding 근거 정보]")
    print(f" - 참작 원두 ID: {chat_data['grounding']['bean_ids']}")
    print(f" - 참조 리뷰 수: {chat_data['grounding']['review_count']}건")
    print(f" - 정보 출처: {chat_data['grounding']['sources']}")
    print(f" - 평균 평점: {chat_data['grounding']['avg_rating']}점")
    print(f" - 답변 신뢰도 점수(Confidence): {chat_data['confidence']}")
    print(f" - 고지 문구: {chat_data['disclaimer']}")

    assert chat_data["confidence"] > 0.0, "신뢰도 점수가 0보다 커야 합니다."
    assert "참고용" in chat_data["disclaimer"], "참고용 문구가 포함되어야 합니다."

    # -------------------------------------------------------------------------
    # [시나리오 2] 하이브리드 검색 Top-K 결과 및 가중합 점수 검증
    # -------------------------------------------------------------------------
    print("\n\n[시나리오 2] 원두 하이브리드 검색 ('에티오피아 내추럴')")
    print("-" * 75)

    payload2 = {
        "query": "에티오피아 내추럴",
        "limit": 3
    }
    response2 = client.post("/api/v1/operation/beans/search", json=payload2)
    assert response2.status_code == 200, f"API 실패: {response2.text}"
    res_data2 = response2.json()

    search_data = res_data2["data"]
    print(f" - 검색된 총 개수: {search_data['total_count']}개")
    for idx, item in enumerate(search_data["items"], 1):
        print(f" [{idx}] {item['name']} | 가격: {item['price']:,}원 | 원산지: {item['country']} | 가공: {item['process']} | 하이브리드점수: {item['hybrid_score']}")

    # -------------------------------------------------------------------------
    # [시나리오 3] 미존재 데이터 질의 시 환각 방지(Fallback) 검증
    # -------------------------------------------------------------------------
    print("\n\n[시나리오 3] 미존재 데이터 환각 방지 검증 ('우주 은하수 판타지 블렌드')")
    print("-" * 75)

    payload3 = {
        "question": "우주 은하수 판타지 블렌드 얼마야?",
        "top_k": 3
    }
    response3 = client.post("/api/v1/operation/beans/chat", json=payload3)
    assert response3.status_code == 200
    res_data3 = response3.json()
    chat_data3 = res_data3["data"]

    print(f"[AI 답변 내용]\n{chat_data3['answer']}")
    print(f" - 신뢰도 점수: {chat_data3['confidence']}")
    
    assert "부족" in chat_data3["answer"] or "정보가 부족" in chat_data3["answer"], "환각 방지 답변이 반환되어야 합니다."
    assert chat_data3["confidence"] == 0.0, "미존재 데이터 시 신뢰도가 0.0이어야 합니다."

    # -------------------------------------------------------------------------
    # [시나리오 4] collected_at 시각 기준 증분 색인 트리거 테스트
    # -------------------------------------------------------------------------
    print("\n\n[시나리오 4] 증분 색인 트리거 API 테스트 (POST /api/v1/operation/rag/reindex)")
    print("-" * 75)

    response4 = client.post("/api/v1/operation/rag/reindex?full_reindex=false")
    assert response4.status_code == 200
    res_data4 = response4.json()
    reindex_data = res_data4["data"]

    print(f" - 증분 색인 성공 여부: {reindex_data['success']}")
    print(f" - 추가 색인된 리뷰 건수: {reindex_data['indexed_count']}건")
    print(f" - 결과 메세지: {reindex_data['message']}")

    print("\n" + "=" * 75)
    print("      [원두 챗봇 RAG 고도화 E2E 통합 테스트 성공적으로 완료!]")
    print("=" * 75)



if __name__ == "__main__":
    test_bean_rag_pipeline()
