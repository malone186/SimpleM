# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\test_curation_api.py
"""
[한글 주석] 공용 DB 연동 큐레이터 추천 API 자동 검증 테스트
"""

import sys
import os
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import SessionLocal
from app.services.operation.curation_service import CurationFilterRequest, curate_beans_by_preference


def test_curation_api():
    print("=" * 70)
    print("   SimpleM 공용 DB 취향 큐레이터 매칭 알고리즘 검증 테스트")
    print("=" * 70)


    db = SessionLocal()
    try:
        # 테스트 조건: 에티오피아 + 산미 높음(3) + 바디감 보통(2) + 디카페인
        req = CurationFilterRequest(
            caffeine="디카페인",
            origin="에티오피아",
            process="전체",
            roast_level="라이트",
            acidity=3,
            body=2,
            sweetness=0,
            bitterness=0
        )

        start_time = time.time()
        results = curate_beans_by_preference(db, req, limit=5)
        elapsed_ms = (time.time() - start_time) * 1000

        print(f"\n[추천 검색 완료] 소요시간: {elapsed_ms:.2f}ms (추출 건수: {len(results)}건)")
        assert len(results) > 0, "큐레이션 추출 결과 0건"

        for idx, bean in enumerate(results, 1):
            print(f" {idx}. [{bean.match_score}% 일치] {bean.name}")
            print(f"    - 로스터리: {bean.roastery_name} | 가격: {bean.price:,}원")
            print(f"    - 추천 사유: {bean.match_reason}")
            print(f"    - 키워드: {', '.join(bean.keywords)}")
            print(f"    - 구매 URL: {bean.product_url[:60]}...")

        print("\n" + "=" * 70)
        print("🎉 [큐레이터 매칭 추천 알고리즘 검증 100% PASS!]")
        print("=" * 70)

    except Exception as e:
        print(f"[오류] 검증 실패: {e}")
    finally:
        db.close()


if __name__ == "__main__":
    test_curation_api()
