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
from app.services.operation.bean_aggregation_service import update_all_beans_curation_snapshots

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ReviewCurationRunner")


def main():
    print("=" * 70)
    print("   SimpleM 전체 원두 리뷰 일괄 전처리 & 큐레이터 구조화 DB 적재 파이프라인")
    print("=" * 70)


    db = SessionLocal()
    try:
        total_processed = 0
        total_affected_beans = 0

        print("\n[1단계] 미처리 리뷰 일괄 전처리 & LLM 구조화 적재 시작...")
        while True:
            res = process_unprocessed_reviews_batch(db, batch_size=100)
            if res['processed_count'] == 0:
                break
            total_processed += res['processed_count']
            total_affected_beans += res['affected_beans']
            print(f" -> 배치 처리 완료: 리뷰 {res['processed_count']}건 추가 구조화 적재됨 (누적: {total_processed}건)")

        print(f"\n[2단계] 전체 원두 큐레이션 스냅샷 캐시 일괄 갱신 중...")
        updated_beans = update_all_beans_curation_snapshots(db)

        print("\n" + "=" * 70)
        print(f" [성공] 공용 DB 전체 적재 완료!")
        print(f"  - 총 구조화 적재된 리뷰: {total_processed}건")
        print(f"  - 큐레이션 스냅샷 갱신 원두: {updated_beans}개")
        print("=" * 70)

    except Exception as e:
        print(f"[오류] 파이프라인 실행 중 예외 발생: {e}")
    finally:
        db.close()


if __name__ == "__main__":
    main()

