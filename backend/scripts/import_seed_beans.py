# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\import_seed_beans.py
"""
[한글 주석] 1단계: 원두 시드 데이터 일괄 적재 독립 실행 스크립트
CSV 또는 JSON 원두 데이터를 검증하여 PostgreSQL DB에 일괄 멱등 적재합니다.
사용법: python scripts/import_seed_beans.py [--file 파일경로]
"""

import sys
import os
import argparse
import logging

# 백엔드 루트 경로 추가
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import SessionLocal
from app.services.operation.seed_service import import_seed_roasteries_and_beans

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="원두 시드 데이터 일괄 적재 스크립트")
    parser.add_argument("--file", type=str, help="시드 파일 경로 (.json 또는 .csv)", default=None)
    args = parser.parse_args()

    logger.info("=== [1단계] 원두 시드 데이터 적재 시작 ===")
    db = SessionLocal()
    try:
        res = import_seed_roasteries_and_beans(db, beans_file=args.file)
        logger.info("결과: %s", res["message"])
        print(f"\n[성공] {res['message']}")
    except Exception as e:
        logger.error("시드 데이터 적재 중 오류 발생: %s", str(e))
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
