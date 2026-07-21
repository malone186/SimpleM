# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\index_beans_vectorstore.py
"""
[한글 주석] 4단계: ChromaDB 벡터스토어 전체/증분 색인 독립 실행 스크립트
쌓인 리뷰 및 원두 속성을 최초 1회 전체 색인하고, 이후에는 collected_at 기준 증분 색인합니다.
사용법: python scripts/index_beans_vectorstore.py [--full]
"""

import sys
import os
import argparse
import logging

# 백엔드 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import SessionLocal
from app.services.operation.bean_review_service import index_reviews_to_chromadb

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="ChromaDB 벡터스토어 리뷰/속성 색인 스크립트")
    parser.add_argument("--full", action="store_true", help="최초 1회 전체 재색인 실행 여부 (기본값: False 증분 색인)")
    args = parser.parse_args()

    mode_str = "전체 재색인" if args.full else "증분 색인 (Incremental Indexing)"
    logger.info("=== [4단계] ChromaDB 벡터스토어 색인 시작 (%s) ===", mode_str)

    db = SessionLocal()
    try:
        res = index_reviews_to_chromadb(db, full_reindex=args.full)
        logger.info("색인 결과: %s", res["message"])
        print(f"\n[성공] ChromaDB 색인이 완료되었습니다! ({mode_str})")
        print(f" - 색인된 리뷰 건수: {res.get('indexed_count', 0)}건")
    except Exception as e:
        logger.error("ChromaDB 색인 실행 중 오류 발생: %s", str(e))
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
