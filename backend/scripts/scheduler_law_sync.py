# backend/scripts/scheduler_law_sync.py
"""
[한글 주석] 법령 데이터 정기 자동 갱신 스케줄러 스크립트

주 1회(예: 매주 월요일 새벽 3시) 국가법령정보센터 및 수집 파이프라인을 구동하여
content_hash 기반으로 변경되거나 개정된 조문을 감지하고 RDB/ChromaDB에 동기화합니다.
"""

import os
import sys
import time
import logging
from datetime import datetime

# backend 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import SessionLocal
from app.services.operation.law_rag_service import LawRAGService

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s"
)
logger = logging.getLogger("LawSyncScheduler")


def run_scheduled_law_sync():
    logger.info("=== [법령 정기 갱신 스케줄러 시작] ===")
    db = SessionLocal()
    try:
        start_time = time.time()
        result = LawRAGService.sync_law_documents(db=db, target_law="전체")
        elapsed = round(time.time() - start_time, 2)
        
        logger.info(f"동기화 성공 여부: {result['success']}")
        logger.info(f"수집 조문 건수: {result['total_fetched']}")
        logger.info(f"변경/신규 조문 건수: {result['total_updated_or_new']}")
        logger.info(f"ChromaDB 인덱싱 건수: {result['total_indexed']}")
        logger.info(f"소요 시간: {elapsed}초")
    except Exception as e:
        logger.exception(f"법령 정기 동기화 중 오류 발생: {str(e)}")
    finally:
        db.close()
        logger.info("=== [법령 정기 갱신 스케줄러 종료] ===")


if __name__ == "__main__":
    run_scheduled_law_sync()
