# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\interactive_rag_chat.py
"""
[한글 주석] 실데이터 기반 원두 챗봇 RAG & 상품 검색 대화형 테스트 스크립트
"""

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import SessionLocal
from app.schemas.bean_rag import BeanRAGChatRequest
from app.services.operation.bean_rag_service import generate_grounded_answer_service
from app.schemas.product_search import ProductSearchQuery
from app.services.operation.product_search_service import search_products_service


def run_interactive_test():
    print("=" * 75)
    print("   ☕ SimpleM 원두 챗봇 RAG & 최저가 검색 인터랙티브 테스트 시뮬레이터")
    print("   종료하려면 'exit' 또는 'q'를 입력하세요.")
    print("=" * 75)

    db = SessionLocal()
    try:
        while True:
            print("\n[모드 선택] 1. 원두 AI 추천 챗봇 | 2. 원두 상품 최저가/대체추천 검색 | (q: 종료)")
            mode = input("선택 (1/2): ").strip()
            
            if mode.lower() in ["exit", "q", "quit"]:
                print("테스트 시뮬레이터를 종료합니다.")
                break

            if mode == "1":
                q = input("\n[AI 챗봇 질문 입력] 예: '에티오피아 원두 1만원대 추천해줘' -> ").strip()
                if not q:
                    continue
                
                req = BeanRAGChatRequest(question=q, top_k=3)
                res = generate_grounded_answer_service(db, req)
                
                print("\n" + "-" * 60)
                print(f"[🤖 AI Grounded 답변]\n{res.answer}")
                print("-" * 60)
                print(f" - 참작 원두 ID: {res.grounding.bean_ids}")
                print(f" - 참조 리뷰 수: {res.grounding.review_count}건")
                print(f" - 정보 출처: {res.grounding.sources}")
                print(f" - 평균 평점: {res.grounding.avg_rating}점")
                print(f" - 답변 신뢰도 점수 (Confidence): {res.confidence}")
                print(f" - 고지 문구: {res.disclaimer}")

            elif mode == "2":
                q = input("\n[상품 검색어 입력] 예: '에티오피아' 또는 '블루마운틴' -> ").strip()
                if not q:
                    continue
                
                query_params = ProductSearchQuery(q=q, sort="price_asc", page=1, page_size=3)
                res = search_products_service(db, query_params)
                
                print("\n" + "-" * 60)
                print(f"[🛒 상품 검색 결과] (총 {res.total_count}건 | 품절 전용 여부: {res.has_out_of_stock_only})")
                print("-" * 60)
                for idx, item in enumerate(res.items, 1):
                    stock_str = "재고있음" if item.in_stock else "품절"
                    print(f" [{idx}] {item.bean_name} ({item.source_site}) | 가격: {item.price:,}원 | 재고: {stock_str} | 평점: {item.rating}")
                
                if res.alternatives:
                    print("\n [💡 재고 없음 대체 추천 (Alternatives)]")
                    for idx, alt in enumerate(res.alternatives, 1):
                        print(f"  ({idx}) {alt.name} ({alt.roastery_name}) | 가격: {alt.price:,}원 | 사유: {alt.reason}")

    finally:
        db.close()


if __name__ == "__main__":
    run_interactive_test()
