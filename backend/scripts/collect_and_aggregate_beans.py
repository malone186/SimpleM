# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\collect_and_aggregate_beans.py
"""
[한글 주석] 2단계 & 3단계: 외부 판매처/가격/리뷰 수집 및 원두 집계 스냅샷 갱신 독립 실행 스크립트
외부 웹 수집 -> 배치 Upsert 적재 -> 감성 분석/키워드 추출 -> 원두 스냅샷 갱신 순으로 동작합니다.
사용법: python scripts/collect_and_aggregate_beans.py
"""

import sys
import os
import logging

# 백엔드 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import SessionLocal
from app.services.operation.bean_collection_service import run_collection_pipeline_for_all_beans
from app.services.operation.bean_review_service import update_all_bean_review_summaries

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def main():
    logger.info("=== [2단계 & 3단계] 원두 데이터 외부 수집 및 집계 스냅샷 갱신 시작 ===")
    db = SessionLocal()
    try:
        # 1. 판매처 오퍼 및 리뷰 외부 수집 & 배치 Upsert
        logger.info("1) 외부 사이트 수집 및 DB 배치 Upsert 진행 중...")
        collect_res = run_collection_pipeline_for_all_beans(db)
        logger.info("수집 결과: %s", collect_res["message"])

        # 2. 감성 분석 / 대표 키워드 및 원두 집계 스냅샷 갱신
        logger.info("2) 원두 집계 스냅샷(평점/긍정비율/키워드) 갱신 중...")
        aggregate_res = update_all_bean_review_summaries(db)
        logger.info("집계 결과: %s", aggregate_res["message"])

        print(f"\n[성공] 데이터 수집 및 집계 스냅샷 갱신이 완료되었습니다!")
        print(f" - 오퍼 Upsert: {collect_res.get('upserted_offers', 0)}건")
        print(f" - 리뷰 Upsert: {collect_res.get('upserted_reviews', 0)}건")
        print(f" - 갱신된 원두 수: {aggregate_res.get('updated_beans', 0)}개")

    except Exception as e:
        logger.error("수집 및 집계 실행 도중 에러 발생: %s", str(e))
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
