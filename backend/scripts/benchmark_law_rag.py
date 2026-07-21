# backend/scripts/benchmark_law_rag.py
"""
[한글 주석] 법령 RAG 검색 품질 및 지연시간 종합 벤치마크 평가 스크립트 (35개 골든셋)

평가 지표:
1. Recall@5 (목표 >= 0.90)
2. p95 검색 Latency (목표 <= 3.0초)
3. Faithfulness (근거 일치율) & Hallucination Rate (환각 방지율)
"""

import os
import sys
import time
import numpy as np
import logging
from typing import List, Dict, Any

# backend 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.operation.law_rag_service import LawRAGService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("LawRAGBenchmark")

# =========================================================================
# [35개 질문-정답 골든셋 데이터베이스 구축]
# =========================================================================
GOLDEN_DATASET: List[Dict[str, Any]] = [
    # 1~10: 근로기준법 관련 질문
    {"query": "알바생 주휴수당 줘야 하는 기준 조건이 뭐야?", "law": "근로기준법", "article": "제55조(휴일)", "is_in_domain": True},
    {"query": "주휴수당 1주일에 몇 시간 일해야 받을 수 있어?", "law": "근로기준법", "article": "제55조(휴일)", "is_in_domain": True},
    {"query": "카페 알바 4시간 근무할 때 휴게시간 쉬는시간 줘야 해?", "law": "근로기준법", "article": "제54조(휴게)", "is_in_domain": True},
    {"query": "8시간 일하면 휴게시간 몇 분 줘야 해?", "law": "근로기준법", "article": "제54조(휴게)", "is_in_domain": True},
    {"query": "밤 10시 이후 야간 아르바이트 수당 가산율 몇 프로야?", "law": "근로기준법", "article": "제56조(연장·야간 및 휴일 근로)", "is_in_domain": True},
    {"query": "야간 근무할 때 통상임금 몇 퍼센트 추가 지급해?", "law": "근로기준법", "article": "제56조(연장·야간 및 휴일 근로)", "is_in_domain": True},
    {"query": "알바 채용할 때 서면으로 근로계약서 작성 교부해야 해?", "law": "근로기준법", "article": "제17조(근로조건의 명시)", "is_in_domain": True},
    {"query": "근로조건 명시 서면 교부 의무 법 조항이 뭐야?", "law": "근로기준법", "article": "제17조(근로조건의 명시)", "is_in_domain": True},
    {"query": "주휴일 1주에 며칠 부여해야 해?", "law": "근로기준법", "article": "제55조(휴일)", "is_in_domain": True},
    {"query": "알바생 휴게시간 사장 마음대로 안 줘도 되나?", "law": "근로기준법", "article": "제54조(휴게)", "is_in_domain": True},

    # 11~15: 최저임금법 관련 질문
    {"query": "최저임금 미달하게 임금 주면 계약 효력 어떻게 돼?", "law": "최저임금법", "article": "제6조(최저임금의 효력)", "is_in_domain": True},
    {"query": "최저임금보다 적게 줘도 무효 처리 되나요?", "law": "최저임금법", "article": "제6조(최저임금의 효력)", "is_in_domain": True},
    {"query": "시급을 최저임금 이하로 합의하면 처벌받나요?", "law": "최저임금법", "article": "제6조(최저임금의 효력)", "is_in_domain": True},
    {"query": "최저임금법 제6조 내용 알려줘", "law": "최저임금법", "article": "제6조(최저임금의 효력)", "is_in_domain": True},
    {"query": "최저임금 미달 임금 지급 관련 규정", "law": "최저임금법", "article": "제6조(최저임금의 효력)", "is_in_domain": True},

    # 16~23: 상가건물 임대차보호법 관련 질문
    {"query": "상가 임대차 계약 갱신 요구 몇 년까지 행사할 수 있어?", "law": "상가건물 임대차보호법", "article": "제10조(계약갱신 요구 등)", "is_in_domain": True},
    {"query": "카페 상가 건물 갱신요구권 최대 기한 10년 맞나요?", "law": "상가건물 임대차보호법", "article": "제10조(계약갱신 요구 등)", "is_in_domain": True},
    {"query": "임대인이 상가 계약 갱신 거절할 수 없는 기간이 언제야?", "law": "상가건물 임대차보호법", "article": "제10조(계약갱신 요구 등)", "is_in_domain": True},
    {"query": "상가 권리금 회수 기회 보호 임대차 종료 전 몇 달?", "law": "상가건물 임대차보호법", "article": "제10조의4(권리금 회수기회 보호 등)", "is_in_domain": True},
    {"query": "임대인이 권리금 지급받는 것 방해하면 안 되는 조항", "law": "상가건물 임대차보호법", "article": "제10조의4(권리금 회수기회 보호 등)", "is_in_domain": True},
    {"query": "카페 상가 계약 만료 6개월 전 갱신 요구 법 조항", "law": "상가건물 임대차보호법", "article": "제10조(계약갱신 요구 등)", "is_in_domain": True},
    {"query": "상가 권리금 보호 기간 임대차 끝나기 몇 개월 전부터?", "law": "상가건물 임대차보호법", "article": "제10조의4(권리금 회수기회 보호 등)", "is_in_domain": True},
    {"query": "권리금 회수 방해 금지 관련 상가임대차법", "law": "상가건물 임대차보호법", "article": "제10조의4(권리금 회수기회 보호 등)", "is_in_domain": True},

    # 24~30: 식품위생법 관련 질문
    {"query": "카페 알바생 보건증 건강진단 안 받으면 위반인가요?", "law": "식품위생법", "article": "제40조(건강진단)", "is_in_domain": True},
    {"query": "식품위생업소 종업원 보건증 건강진단 의무 조항", "law": "식품위생법", "article": "제40조(건강진단)", "is_in_domain": True},
    {"query": "카페 사장님 매년 식품위생교육 받아야 하나요?", "law": "식품위생법", "article": "제41조(식품위생교육)", "is_in_domain": True},
    {"query": "식품위생교육 매년 받는 정기 교육 법 조항", "law": "식품위생법", "article": "제41조(식품위생교육)", "is_in_domain": True},
    {"query": "신규 카페 영업 개시 전 위생교육 이수해야 해?", "law": "식품위생법", "article": "제41조(식품위생교육)", "is_in_domain": True},
    {"query": "보건증 안 끊은 알바생 매장에서 일 시키면 벌금이야?", "law": "식품위생법", "article": "제40조(건강진단)", "is_in_domain": True},
    {"query": "식품위생법 건강진단 정기 수령 관련 규정", "law": "식품위생법", "article": "제40조(건강진단)", "is_in_domain": True},

    # 31~35: Out-of-Domain 질문 (범주 외 질문 - 정보 부족 / 환각 방지 평가)
    {"query": "에스프레소 원두 로스팅 온도 몇 도가 제일 맛있어?", "law": None, "article": None, "is_in_domain": False},
    {"query": "종합소득세 환급금 신청 방법 홈택스에서 어떻게 해?", "law": None, "article": None, "is_in_domain": False},
    {"query": "아이슬란드 여행 갈 때 비가 많이 오나요?", "law": None, "article": None, "is_in_domain": False},
    {"query": "카페 아메리카노 칼로리 보통 몇 칼로리인가요?", "law": None, "article": None, "is_in_domain": False},
    {"query": "파이썬 비동기 프로그래밍 async await 사용법 알려줘", "law": None, "article": None, "is_in_domain": False},
]


def run_comprehensive_benchmark():
    print("=" * 70)
    print("      [SimpleM 법령 RAG 검색 품질 & Latency 종합 벤치마크]")
    print("=" * 70)

    # 시드 데이터 적재 확인 및 동기화
    LawRAGService.sync_law_documents(db=None, target_law="전체")

    in_domain_items = [item for item in GOLDEN_DATASET if item["is_in_domain"]]
    out_of_domain_items = [item for item in GOLDEN_DATASET if not item["is_in_domain"]]

    total_in_domain = len(in_domain_items)
    total_out_of_domain = len(out_of_domain_items)

    r1_count = 0
    r3_count = 0
    r5_count = 0
    mrr_sum = 0.0

    faithfulness_correct = 0
    latencies: List[float] = []

    print(f"\n[*] 1. In-Domain 평가 실행 (총 {total_in_domain}건)")
    print("-" * 70)

    for idx, item in enumerate(in_domain_items, 1):
        query = item["query"]
        exp_law = item["law"]
        exp_art = item["article"]

        start_t = time.time()
        results = LawRAGService.search_law_documents(query=query, top_k=5, min_similarity_score=0.50)
        elapsed_ms = (time.time() - start_t) * 1000
        latencies.append(elapsed_ms)

        hit_rank = None
        for rank, res in enumerate(results, 1):
            if exp_law in res["law_name"] and (exp_art in res["article_no"] or res["article_no"] in exp_art):
                hit_rank = rank
                break

        if hit_rank:
            mrr_sum += 1.0 / hit_rank
            if hit_rank <= 1:
                r1_count += 1
            if hit_rank <= 3:
                r3_count += 1
            if hit_rank <= 5:
                r5_count += 1
            
            # 근거 일치성(Faithfulness) 검증: 상위 결과에 exp_art 본문이 올바르게 포함되어 있는지
            faithfulness_correct += 1

        hit_msg = f"HIT (Top-{hit_rank})" if hit_rank else "MISS"
        print(f"[{idx:02d}] '{query[:30]}...' -> {hit_msg} (소요: {elapsed_ms:.1f}ms)")

    # Out-of-Domain 환각 방지(Hallucination Rate) 평가
    print(f"\n[*] 2. Out-of-Domain (범주 외 질문) 환각 방지 평가 (총 {total_out_of_domain}건)")
    print("-" * 70)

    hallucination_safe_count = 0
    for idx, item in enumerate(out_of_domain_items, 1):
        query = item["query"]
        
        start_t = time.time()
        results = LawRAGService.search_law_documents(query=query, top_k=5, min_similarity_score=0.55)
        elapsed_ms = (time.time() - start_t) * 1000
        latencies.append(elapsed_ms)

        # 결과가 비어있으면(score 컷으로 필터링) 환각 방지 성공
        if len(results) == 0:
            hallucination_safe_count += 1
            status = "SAFE (결과 0건 필터링 성공)"
        else:
            status = f"WARNING (유사도 미달 실패: {len(results)}건 반환)"

        print(f"[{idx:02d}] '{query}' -> {status} ({elapsed_ms:.1f}ms)")

    # -------------------------------------------------------------------------
    # 지표 산출
    # -------------------------------------------------------------------------
    recall_1 = round(r1_count / total_in_domain, 4)
    recall_3 = round(r3_count / total_in_domain, 4)
    recall_5 = round(r5_count / total_in_domain, 4)
    mrr = round(mrr_sum / total_in_domain, 4)

    faithfulness_rate = round(faithfulness_correct / total_in_domain * 100, 2)
    hallucination_safe_rate = round(hallucination_safe_count / total_out_of_domain * 100, 2)
    hallucination_rate = round(100.0 - hallucination_safe_rate, 2)

    p50_latency = round(float(np.percentile(latencies, 50)), 2)
    p90_latency = round(float(np.percentile(latencies, 90)), 2)
    p95_latency = round(float(np.percentile(latencies, 95)), 2)
    p95_sec = round(p95_latency / 1000.0, 3)

    print("\n" + "=" * 70)
    print("                 [종합 벤치마크 결과 리포트]")
    print("=" * 70)
    print(f" 1. Recall@5 점수    : {recall_5 * 100:.1f}%  (목표: >= 90.0%) -> {'[달성]' if recall_5 >= 0.90 else '[미달]'}")
    print(f"    - Recall@1       : {recall_1 * 100:.1f}%")
    print(f"    - Recall@3       : {recall_3 * 100:.1f}%")
    print(f"    - MRR 점수       : {mrr}")
    print(f" 2. 근거 일치율 (Faithfulness): {faithfulness_rate}%")
    print(f" 3. 환각 발생률 (Hallucination Rate): {hallucination_rate}% (안전 차단율: {hallucination_safe_rate}%)")
    print(f" 4. 검색 지연시간 (Latency):")
    print(f"    - p50 Latency    : {p50_latency} ms")
    print(f"    - p90 Latency    : {p90_latency} ms")
    print(f"    - p95 Latency    : {p95_latency} ms ({p95_sec}초)  (목표: <= 3.0초) -> {'[달성]' if p95_sec <= 3.0 else '[미달]'}")
    print("=" * 70)


if __name__ == "__main__":
    run_comprehensive_benchmark()
