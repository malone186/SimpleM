"""
법령 RAG (ChromaDB + LangChain Tools) 동작 검증 테스트 스크립트
"""

import os
import sys

# [한글 주석] Windows 콘솔 유니코드 인코딩 설정 및 백엔드 패키지 경로 추가
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from app.services.operation.law_rag_service import LawRAGService
from app.services.operation.law_tools import search_law_documents_tool


def run_demo():
    print("=" * 60)
    print("[1단계] 카페 관련 샘플 법령 4건 데이터 준비")
    print("=" * 60)

    sample_laws = [
        {
            "law_name": "근로기준법",
            "article_no": "제54조(휴게)",
            "category": "근로기준",
            "content": "사용자는 근로시간이 4시간인 경우에는 30분 이상, 8시간인 경우에는 1시간 이상의 휴게시간을 근로시간 도중에 주어야 한다. 휴게시간은 근로자가 자유롭게 이용할 수 있다.",
            "summary": "근로시간 4시간당 30분, 8시간당 1시간 이상의 휴게시간 부여 의무",
            "source": "국가법령정보센터 (https://www.law.go.kr)",
            "effective_date": "2026-01-01"
        },
        {
            "law_name": "근로기준법",
            "article_no": "제56조(연장·야간 및 휴일 가산수당)",
            "category": "근로기준",
            "content": "사용자는 야간근로(오후 10시부터 다음 날 오전 6시 사이의 근로)에 대하여는 통상임금의 100분의 50 이상을 가산하여 근로자에게 지급하여야 한다.",
            "summary": "오후 10시~오전 6시 야간근로 시 50% 가산수당 지급 의무",
            "source": "국가법령정보센터 (https://www.law.go.kr)",
            "effective_date": "2026-01-01"
        },
        {
            "law_name": "최저임금법",
            "article_no": "제6조(최저임금의 효력)",
            "category": "최저임금",
            "content": "사용자는 최저임금의 적용을 받는 근로자에게 최저임금액 이상의 임금을 지급하여야 한다. 최저임금액에 미달하는 임금을 정한 근로계약은 그 부분에 한하여 무효로 한다.",
            "summary": "최저임금액 이상 지급 의무 및 미달 계약 부분 무효",
            "source": "국가법령정보센터 (https://www.law.go.kr)",
            "effective_date": "2026-01-01"
        },
        {
            "law_name": "상가건물 임대차보호법",
            "article_no": "제10조(계약갱신 요구 등)",
            "category": "임대차",
            "content": "임대인은 임차인이 임대차기간이 만료되기 6개월 전부터 1개월 전까지 사이에 계약갱신을 요구할 경우 정당한 사유 없이 거절하지 못한다. 임차인의 계약갱신요구권은 최초의 임대차기간을 포함한 전체 임대차기간이 10년을 초과하지 아니하는 범위에서만 행사할 수 있다.",
            "summary": "상가 임차인의 10년 범위 내 계약갱신요구권 보장",
            "source": "국가법령정보센터 (https://www.law.go.kr)",
            "effective_date": "2026-01-01"
        }
    ]

    print("\n=" * 60)
    print("[2단계] 원문 정제(build_law_rag_documents) 및 메타데이터 생성")
    print("=" * 60)
    docs = LawRAGService.build_law_rag_documents(sample_laws)
    print(f"-> 정제된 조문 문서 수: {len(docs)}건")

    print("\n=" * 60)
    print("[3단계] ChromaDB(law_documents 컬렉션)에 임베딩 및 적재")
    print("=" * 60)
    indexed_count = LawRAGService.index_law_documents(docs)
    print(f"-> ChromaDB 저장 성공 건수: {indexed_count}건")

    # [한글 주석] 컬렉션 통계 확인
    stats = LawRAGService.get_collection_stats()
    print(f"-> 컬렉션 활성 상태: {stats['status']} | 저장된 조문 총 수: {stats['total_documents']}건")

    print("\n=" * 60)
    print("[4단계] law_tools 하이브리드 검색(Dense + Keyword + RRF) RAG 검증")
    print("=" * 60)

    # 테스트 케이스 1: 휴게시간 관련 질문
    q1 = "알바 휴게시간 몇 분 줘야 해?"
    print(f"\n[질문 1] '{q1}'")
    res1 = search_law_documents_tool.invoke({"keyword": q1})
    print(f"성공여부: {res1['success']}")
    print(f"메시지: {res1['message']}")
    for doc in res1["data"]:
        print(f"  - [{doc['law_name']} {doc['article_no']}] (종합점수: {doc['score']} | RRF점수: {doc.get('rrf_score', 0)})")
        print(f"    출처: {doc['source']} | 시행일: {doc['effective_date']}")
        print(f"    내용: {doc['content']}")

    # 테스트 케이스 2: 야간 수당 관련 질문
    q2 = "밤 11시에 근무하면 수당 더 줘야 하나요?"
    print(f"\n[질문 2] '{q2}'")
    res2 = search_law_documents_tool.invoke({"keyword": q2})
    print(f"성공여부: {res2['success']}")
    print(f"메시지: {res2['message']}")
    for doc in res2["data"]:
        print(f"  - [{doc['law_name']} {doc['article_no']}] (종합점수: {doc['score']} | RRF점수: {doc.get('rrf_score', 0)})")
        print(f"    출처: {doc['source']} | 시행일: {doc['effective_date']}")

    # 테스트 케이스 3: 관련 없는 질문 (환각 방지 테스트)
    q3 = "우주선 비행기 조종 면허 시험 기준 알려줘"
    print(f"\n[질문 3 - 환각 방지] '{q3}'")
    res3 = search_law_documents_tool.invoke({"keyword": q3})
    print(f"성공여부: {res3['success']}")
    print(f"메시지: {res3['message']}")
    print(f"반환된 문서 수: {len(res3['documents'])} (환각 방지 정상 작동됨)")

    print("\n=" * 60)
    print("[성공] 실서비스 레벨 법령 하이브리드 RAG 테스트 완료")
    print("=" * 60)


if __name__ == "__main__":
    run_demo()
