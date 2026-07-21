# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\run_review_curation_pipeline.py
"""
[한글 주석] 미처리 원두 리뷰 증분 배치 처리 및 원두 큐레이션 스냅샷 갱신 러너 스크립트
"""

import sys
import os
import logging

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import SessionLocal
from app.services.operation.review_batch_processor import process_unprocessed_reviews_batch

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ReviewCurationRunner")


def main():
    print("=" * 70)
    print("   ☕ SimpleM 원두 리뷰 전처리 및 큐레이터 구조화 배치 적재 파이프라인")
    print("=" * 70)

    db = SessionLocal()
    try:
        res = process_unprocessed_reviews_batch(db, batch_size=100)
        print("\n[실행 결과 요약]")
        print(f" - 처리된 증분 리뷰 건수: {res['processed_count']}건")
        print(f" - 스냅샷이 갱신된 원두 수: {res['affected_beans']}개")
        print(f" - 메시지: {res['message']}")
    except Exception as e:
        print(f"[오류] 파이프라인 실행 중 예외 발생: {e}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
