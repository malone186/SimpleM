# backend/app/services/operation/eval_law_rag.py
"""
[한글 주석] 법령 RAG 검색 평가 스크립트 (Recall@k 및 MRR 측정)

골든셋(질문 - 정답 조문) 데이터를 기반으로 하이브리드 검색의 
Recall@1, Recall@3, Recall@5 및 MRR(Mean Reciprocal Rank)을 정량 평가합니다.
"""

import os
import sys

# 프로젝트 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from app.services.operation.law_rag_service import LawRAGService

# [골든셋 평가 데이터]
GOLDEN_SET = [
    {
        "query": "알바생 주휴수당 줘야 하는 기준 조건이 뭐야?",
        "expected_law": "근로기준법",
        "expected_article": "제55조(휴일)"
    },
    {
        "query": "아르바이트 야간 근무 수당 계산 몇 퍼센트 가산돼?",
        "expected_law": "근로기준법",
        "expected_article": "제56조(연장·야간 및 휴일 근로)"
    },
    {
        "query": "카페 알바 4시간 일하면 쉬는시간 얼마나 줘야 해?",
        "expected_law": "근로기준법",
        "expected_article": "제54조(휴게)"
    },
    {
        "query": "상가 임대차 계약 갱신 몇 년까지 요구할 수 있어?",
        "expected_law": "상가건물 임대차보호법",
        "expected_article": "제10조(계약갱신 요구 등)"
    },
    {
        "query": "알바생 보건증 건강진단 안 받으면 식품위생법 위반이야?",
        "expected_law": "식품위생법",
        "expected_article": "제40조(건강진단)"
    }
]


def evaluate_law_rag():
    print("=" * 60)
    print("      [SimpleM 법령 RAG 하이브리드 검색 성능 평가 (Recall@k)]")
    print("=" * 60)

    # 1. 시드 데이터 적재 확인 및 동기화
    sync_res = LawRAGService.sync_law_documents(db=None, target_law="전체")
    print(f"[*] 데이터 동기화 완료: {sync_res['message']}")
    print("-" * 60)

    total = len(GOLDEN_SET)
    r1_count = 0
    r3_count = 0
    r5_count = 0
    mrr_sum = 0.0

    for idx, item in enumerate(GOLDEN_SET, start=1):
        query = item["query"]
        exp_law = item["expected_law"]
        exp_art = item["expected_article"]

        results = LawRAGService.search_law_documents(query=query, top_k=5, min_similarity_score=0.40)
        
        hit_rank = None
        for rank, res in enumerate(results, start=1):
            if exp_law in res["law_name"] and (exp_art in res["article_no"] or res["article_no"] in exp_art):
                hit_rank = rank
                break

        status = f"HIT (Top-{hit_rank})" if hit_rank else "MISS"
        print(f"[{idx}] 질문: '{query}'")
        print(f"    - 기대 정답: [{exp_law} {exp_art}]")
        print(f"    - 평가 결과: {status}")

        if hit_rank:
            mrr_sum += 1.0 / hit_rank
            if hit_rank <= 1:
                r1_count += 1
            if hit_rank <= 3:
                r3_count += 1
            if hit_rank <= 5:
                r5_count += 1
        print("-" * 60)

    recall_1 = round(r1_count / total * 100, 2)
    recall_3 = round(r3_count / total * 100, 2)
    recall_5 = round(r5_count / total * 100, 2)
    mrr = round(mrr_sum / total, 4)

    print("============================================================")
    print("                    [최종 평가 리포트]")
    print(f" - 총 테스트 케이스: {total}건")
    print(f" - Recall@1 : {recall_1}% ({r1_count}/{total})")
    print(f" - Recall@3 : {recall_3}% ({r3_count}/{total})")
    print(f" - Recall@5 : {recall_5}% ({r5_count}/{total})")
    print(f" - MRR (Mean Reciprocal Rank): {mrr}")
    print("============================================================")


if __name__ == "__main__":
    evaluate_law_rag()
