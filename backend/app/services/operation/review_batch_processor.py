# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\review_batch_processor.py
"""
[한글 주석] 미처리 리뷰 증분 배치 적재 및 구조화 프로세서 모듈
- db.query(BeanReview).filter(BeanReview.processed == False) 증분 조회
- 텍스트 전처리 -> LLM 속성 구조화 추출 -> DB 컬럼 세팅 -> processed=True 커밋
- 영향을 받은 원두(bean_id)별 큐레이션 집계 스냅샷 캐시 자동 갱신
"""

import logging
from typing import Dict, Any, List, Set
from sqlalchemy.orm import Session

from app.models.roastery import BeanReview
from app.services.operation.review_preprocessing_service import preprocess_review_item
from app.services.operation.review_extraction_service import extract_curation_attributes_with_llm
from app.services.operation.bean_aggregation_service import update_bean_curation_snapshot

logger = logging.getLogger(__name__)


def process_unprocessed_reviews_batch(db: Session, batch_size: int = 50) -> Dict[str, Any]:
    """
    [한글 주석]
    DB에서 아직 처리되지 않은(processed=False) 새 리뷰 목록을 조회하여 배치 단위로 구조화 추출 및 적재를 수행합니다.
    """
    unprocessed_reviews = db.query(BeanReview).filter(
        BeanReview.processed == False
    ).limit(batch_size).all()

    if not unprocessed_reviews:
        logger.info("증분 처리할 미처리 리뷰가 없습니다.")
        return {
            "processed_count": 0,
            "affected_beans": 0,
            "message": "새로 증분 처리할 미처리 리뷰가 없습니다."
        }

    affected_bean_ids: Set[int] = set()
    success_count = 0

    for review in unprocessed_reviews:
        try:
            # 1. 텍스트 전처리
            prep_info = preprocess_review_item({
                "content": review.content,
                "source_url": review.source_url
            })

            # 2. LLM 큐레이터 속성 추출 (숏 리뷰인 경우 스킵 후 기본 감성만)
            extraction = extract_curation_attributes_with_llm(
                cleaned_review_text=prep_info["cleaned_content"],
                is_short=prep_info["is_short"]
            )

            # 3. BeanReview DB 객체 구조화 컬럼 업데이트
            review.acidity = extraction.acidity
            review.body = extraction.body
            review.sweetness = extraction.sweetness
            review.bitterness = extraction.bitterness

            review.roast_level = extraction.roast_level
            review.process = extraction.process
            review.origin = extraction.origin
            review.caffeine = extraction.caffeine

            review.sentiment = extraction.sentiment
            if extraction.keywords:
                review.keywords = extraction.keywords
            review.evidence = extraction.evidence

            # 증분 처리 완료 플래그 세팅
            review.processed = True

            affected_bean_ids.add(review.bean_id)
            success_count += 1

        except Exception as e:
            logger.error("리뷰 (ID=%d) 구조화 추출 중 오류 발생: %s", review.id, str(e))
            # 처리 중 예외 발생 시 파이프라인 무한 재시도 방지를 위해 감성만 세팅 후 처리 완료
            review.processed = True

    try:
        db.commit()
        logger.info("총 %d건 리뷰 구조화 배치 처리 및 DB 커밋 성공!", success_count)
    except Exception as e:
        db.rollback()
        logger.error("리뷰 배치 DB 커밋 실패: %s", str(e))
        return {
            "processed_count": 0,
            "affected_beans": 0,
            "message": f"DB 커밋 실패: {str(e)}"
        }

    # 4. 영향을 받은 원두들의 curation_snapshot 일괄 갱신
    for b_id in affected_bean_ids:
        update_bean_curation_snapshot(db, b_id)

    return {
        "processed_count": success_count,
        "affected_beans": len(affected_bean_ids),
        "message": f"총 {success_count}건 리뷰 증분 적재 및 {len(affected_bean_ids)}개 원두 스냅샷 갱신 완료!"
    }
