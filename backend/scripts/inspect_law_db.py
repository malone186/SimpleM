# backend/scripts/inspect_law_db.py
"""
[한글 주석] 법령 데이터 적재 상태 및 동기화 진단 스크립트

1. RDB(law_articles) 및 ChromaDB(law_documents) 적재 문서 수 카운트
2. 샘플 3건의 메타데이터 (law_name, article_no, source, effective_date) 검증
3. sync_law_documents() 실행을 통한 content_hash 변경분 재임베딩 확인
"""

import os
import sys
import logging
from typing import Dict, Any

# backend 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import SessionLocal, Base, engine
from app.models.law import LawArticle
from app.services.operation.law_rag_service import LawRAGService, LAW_COLLECTION_NAME, CHROMA_DB_DIR

try:
    import chromadb
except ImportError:
    chromadb = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("InspectLawDB")


def inspect_db_status():
    print("=" * 65)
    print("        [SimpleM 법령 RDB & ChromaDB 적재 상태 진단 리포트]")
    print("=" * 65)

    # 0. 테이블 자동 생성 (테이블이 없을 경우 대비)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    
    # --- 1. RDB law_articles 카운트 및 샘플 3건 조회 ---
    try:
        rdb_count = db.query(LawArticle).count()
        print(f"\n[1] RDB (law_articles 테이블) 적재 현황:")
        print(f"    - 총 적재 레코드 수: {rdb_count}건")

        rdb_samples = db.query(LawArticle).limit(3).all()
        if rdb_samples:
            print("    - RDB 샘플 메타데이터 (3건):")
            for i, art in enumerate(rdb_samples, 1):
                print(f"      ({i}) [{art.law_name} {art.article_no}] 카테고리: {art.category} / 출처: {art.source} / 시행일: {art.effective_date}")
        else:
            print("    - RDB 샘플 데이터 없음 (0건)")
    except Exception as e:
        print(f"    [!] RDB 조회 실패 / DB 연결 오류: {str(e)}")
        rdb_count = 0

    # --- 2. ChromaDB law_documents 카운트 및 샘플 3건 조회 ---
    print(f"\n[2] ChromaDB ({LAW_COLLECTION_NAME} 컬렉션) 적재 현황:")
    chroma_count = 0
    if chromadb is None:
        print("    [!] chromadb 라이브러리가 설치되어 있지 않거나 import 실패했습니다.")
    elif not os.path.exists(CHROMA_DB_DIR):
        print(f"    [!] ChromaDB 디렉토리({CHROMA_DB_DIR})가 아직 생성되지 않았습니다.")
    else:
        try:
            client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
            collection = client.get_collection(name=LAW_COLLECTION_NAME)
            chroma_count = collection.count()
            print(f"    - 총 적재 벡터 수: {chroma_count}건")

            peek_res = collection.peek(limit=3)
            if peek_res and peek_res.get("metadatas"):
                print("    - ChromaDB 샘플 메타데이터 (3건):")
                for idx, meta in enumerate(peek_res["metadatas"], 1):
                    law_name = meta.get("law_name", "미지정")
                    article_no = meta.get("article_no", "미지정")
                    source = meta.get("source", "미지정")
                    eff_date = meta.get("effective_date", "미지정")
                    print(f"      ({idx}) [{law_name} {article_no}] 출처: {source} / 시행일: {eff_date}")
            else:
                print("    - ChromaDB 샘플 데이터 없음 (0건)")
        except Exception as e:
            print(f"    [!] ChromaDB 컬렉션 조회 실패: {str(e)}")

    # --- 3. sync_law_documents() 실행 및 변경분 재임베딩 동작 확인 ---
    print("\n[3] sync_law_documents() 동기화 파이프라인 1회 구동:")
    try:
        sync_result = LawRAGService.sync_law_documents(db=db, target_law="전체")
        print(f"    - 수집 총건수: {sync_result.get('total_fetched', 0)}건")
        print(f"    - RDB 신규/갱신 건수: {sync_result.get('total_updated_or_new', 0)}건")
        print(f"    - ChromaDB 재임베딩 건수: {sync_result.get('total_indexed', 0)}건")
        print(f"    - 응답 메시지: {sync_result.get('message', '')}")
    except Exception as e:
        print(f"    [!] 동기화 실행 중 에러 발생: {str(e)}")

    # --- 4. 동기화 후 최종 카운트 재조회 ---
    try:
        post_rdb_count = db.query(LawArticle).count()
        print(f"\n[4] 동기화 후 최종 검증:")
        print(f"    - RDB 최종 레코드 수: {post_rdb_count}건")
        
        if chromadb and os.path.exists(CHROMA_DB_DIR):
            client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
            coll = client.get_collection(name=LAW_COLLECTION_NAME)
            print(f"    - ChromaDB 최종 벡터 수: {coll.count()}건")
    except Exception as e:
        print(f"    [!] 최종 검증 재조회 실패: {str(e)}")
    finally:
        db.close()

    print("=" * 65)


if __name__ == "__main__":
    inspect_db_status()
