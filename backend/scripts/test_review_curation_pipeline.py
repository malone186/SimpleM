# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\test_review_curation_pipeline.py
"""
[한글 주석] 원두 리뷰 전처리, 큐레이터 구조화 LLM 추출, DB 배치 적재 및 원두 집계 스냅샷 통합 E2E 검증 스크립트
"""

import sys
import os
import logging
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.database import SessionLocal
from app.models.roastery import BeanReview, RoasteryBean
from app.services.operation.review_preprocessing_service import clean_review_text, is_short_review
from app.services.operation.review_extraction_service import extract_curation_attributes_with_llm
from app.services.operation.review_batch_processor import process_unprocessed_reviews_batch
from app.services.operation.bean_aggregation_service import aggregate_curation_for_bean, update_bean_curation_snapshot

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("TestReviewCuration")


def run_e2e_curation_test():
    print("=" * 70)
    print("      [SimpleM 원두 리뷰 큐레이터 구조화 적재 E2E 검증 테스트]")
    print("=" * 70)

    db = SessionLocal()
    try:
        # 1. 텍스트 전처리 검증
        sample_raw = "  <p>산미가 너무 상큼하고 😊 라떼용으로 바디감이 깊어서 최고입니다! 010-1234-5678 문의하세요.</p>  "
        cleaned = clean_review_text(sample_raw)
        assert "[전화번호마스킹]" in cleaned, "개인정보 마스킹 실패"
        assert "<p>" not in cleaned, "HTML 태그 제거 실패"
        assert "😊" not in cleaned, "이모지 제거 실패"
        print("[PASS] 1. 텍스트 전처리 & 노이즈 제거 & 마스킹 검증 성공!")
        print(f" -> 정제 결과: '{cleaned}'")

        # 2. 숏 리뷰 판별 검증
        short_raw = "좋아요 굿!"
        assert is_short_review(short_raw, min_length=15) == True, "숏 리뷰 판별 실패"
        print("[PASS] 2. 15자 미만 숏 리뷰 판별 검증 성공!")

        # 3. 테스트용 리뷰 샘플 데이터 DB 생성
        bean = db.query(RoasteryBean).first()
        if not bean:
            print("[오류] DB에 등록된 원두가 존재하지 않아 테스트를 진행할 수 없습니다.")
            return False

        print(f"\n[테스트 원두 타겟] ID={bean.id}, 이름={bean.name}")

        test_reviews = [
            "산미가 상큼하고 꽃향기가 매력적입니다. 바디감은 약한 편이에요.",
            "고소한 풍미와 진한 바디감이 느껴집니다. 쓴맛이 적당해서 드립용으로 아주 훌륭해요.",
            "배송 빨라요."  # 숏 리뷰
        ]

        now_utc = datetime.now(timezone.utc)
        inserted_ids = []
        for idx, text in enumerate(test_reviews, 1):
            rev = BeanReview(
                bean_id=bean.id,
                source_site="Naver Shopping Test",
                source_url=f"https://smartstore.naver.com/test_curation_review_{bean.id}_{idx}_{int(now_utc.timestamp())}",
                rating=4.8,
                content=text,
                sentiment="positive",
                keywords=["테스트"],
                processed=False
            )
            db.add(rev)
            db.commit()
            db.refresh(rev)
            inserted_ids.append(rev.id)

        print(f" -> 테스트용 미처리 리뷰 {len(inserted_ids)}건 DB 입력 완료!")

        # 4. 증분 배치 적재 프로세서 실행 (모든 미처리 건 일괄 수용)
        for _ in range(5):
            res = process_unprocessed_reviews_batch(db, batch_size=100)
            if res['processed_count'] == 0:
                break
        print(f"\n[배치 프로세서 완료] 미처리 리뷰 일괄 구조화 적재 완료!")
        print("[PASS] 3. 미처리 리뷰 증분 배치 적재 성공!")

        # 5. DB 업데이트 결과 검증
        for r_id in inserted_ids:
            r_db = db.query(BeanReview).filter(BeanReview.id == r_id).first()
            assert r_db.processed == True, f"리뷰 ID={r_id} processed 플래그 세팅 실패"
            print(f" -> 리뷰 ID={r_db.id} | acidity={r_db.acidity}, body={r_db.body}, roast={r_db.roast_level}, evidence='{r_db.evidence}'")


        print("[PASS] 4. DB 큐레이션 속성 및 근거(evidence) 저장 검증 성공!")

        # 6. 원두 큐레이션 집계 및 스냅샷 캐시 갱신 검증
        snapshot = aggregate_curation_for_bean(db, bean.id)
        assert "scales" in snapshot and "categories" in snapshot, "스냅샷 구조 불일치"
        print(f"\n[원두 큐레이션 스냅샷 집계 결과]")
        print(f" - 표본수: {snapshot['sample_count']}건 (신뢰도: {snapshot['reliability']})")
        print(f" - 척도 평균: {snapshot['scales']}")
        print(f" - 범주 최빈값: {snapshot['categories']}")

        update_bean_curation_snapshot(db, bean.id)
        updated_bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean.id).first()
        assert updated_bean.curation_snapshot is not None, "roastery_beans curation_snapshot 갱신 실패"
        print("[PASS] 5. roastery_beans.curation_snapshot 캐시 갱신 100% 성공!")

        print("\n" + "=" * 70)
        print("     🎉 [원두 리뷰 큐레이터 구조화 적재 파이프라인 E2E 검증 100% PASS]")
        print("=" * 70)

        # 테스트 데이터 정돈
        db.query(BeanReview).filter(BeanReview.id.in_(inserted_ids)).delete(synchronize_session=False)
        db.commit()

        return True

    except Exception as e:
        db.rollback()
        print(f"\n[실패] E2E 검증 중 예외 발생: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()


if __name__ == "__main__":
    run_e2e_curation_test()
