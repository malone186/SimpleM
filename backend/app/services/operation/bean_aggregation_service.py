# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\bean_aggregation_service.py
"""
[한글 주석] 원두 단위 큐레이터 속성 집계 및 roastery_beans 스냅샷 캐시 갱신 서비스
- 척도(산미/바디감/단맛/쓴맛): null 제외 평균 반올림 (0~3) + 표본수
- 범주형(로스팅/가공방식/원산지/디카페인): 최빈값(Mode) 추출 (동률/근거부족 시 null)
- 표본수 N < 5건인 경우 reliability: "low" 상태 표기
- roastery_beans.curation_snapshot JSON 캐시 갱신
"""

import logging
from collections import Counter
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session

from app.models.roastery import RoasteryBean, BeanReview

logger = logging.getLogger(__name__)


def calculate_mode(values: List[Any]) -> Optional[Any]:
    """
    [한글 주석]
    리스트에서 최빈값(Mode)을 계산합니다. 동률이거나 데이터가 없으면 None을 반환합니다.
    """
    filtered = [v for v in values if v is not None and str(v).strip()]
    if not filtered:
        return None

    counts = Counter(filtered)
    most_common = counts.most_common(2)

    # 데이터가 1개만 있는 경우
    if len(most_common) == 1:
        return most_common[0][0]

    # 최빈값이 동률인 경우 -> 근거 미흡으로 null 처리
    if most_common[0][1] == most_common[1][1]:
        return None

    return most_common[0][0]


def aggregate_curation_for_bean(db: Session, bean_id: int) -> Dict[str, Any]:
    """
    [한글 주석]
    특정 원두(bean_id)에 속한 모든 bean_reviews 구조화 컬럼을 집계하여 스냅샷 딕셔너리를 생성합니다.
    """
    reviews = db.query(BeanReview).filter(
        BeanReview.bean_id == bean_id,
        BeanReview.processed == True
    ).all()

    if not reviews:
        return {
            "bean_id": bean_id,
            "sample_count": 0,
            "reliability": "none",
            "scales": {"acidity": None, "body": None, "sweetness": None, "bitterness": None},
            "categories": {"roast_level": None, "process": None, "origin": None, "caffeine": None}
        }

    sample_count = len(reviews)

    # 1. 척도 집계 (acidity, body, sweetness, bitterness)
    scale_names = ["acidity", "body", "sweetness", "bitterness"]
    scales_result = {}

    for s_name in scale_names:
        vals = [getattr(r, s_name) for r in reviews if getattr(r, s_name) is not None]
        if vals:
            avg_val = round(sum(vals) / len(vals))
            # 0~3 범위 제한
            clamped = max(0, min(3, avg_val))
            scales_result[s_name] = {
                "score": clamped,
                "sample_size": len(vals)
            }
        else:
            scales_result[s_name] = {
                "score": None,
                "sample_size": 0
            }

    # 2. 범주 집계 (roast_level, process, origin, caffeine)
    categories_result = {
        "roast_level": calculate_mode([r.roast_level for r in reviews]),
        "process": calculate_mode([r.process for r in reviews]),
        "origin": calculate_mode([r.origin for r in reviews]),
        "caffeine": calculate_mode([r.caffeine for r in reviews])
    }

    # 3. 신뢰도 지표 판별 (표본수 5건 미만인 경우 low)
    reliability = "high" if sample_count >= 5 else "low"

    snapshot_data = {
        "bean_id": bean_id,
        "sample_count": sample_count,
        "reliability": reliability,
        "scales": scales_result,
        "categories": categories_result
    }

    return snapshot_data


def update_bean_curation_snapshot(db: Session, bean_id: int) -> bool:
    """
    [한글 주석]
    특정 원두의 curation_snapshot 컬럼을 최신 집계 데이터로 갱신합니다.
    """
    try:
        bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
        if not bean:
            logger.warning("원두 (ID=%d)를 찾을 수 없어 큐레이션 스냅샷 갱신을 스킵합니다.", bean_id)
            return False

        snapshot = aggregate_curation_for_bean(db, bean_id)
        bean.curation_snapshot = snapshot
        db.commit()
        logger.info("원두 (ID=%d, %s) 큐레이션 스냅샷 갱신 성공 (표본: %d건, 신뢰도: %s)", bean_id, bean.name, snapshot["sample_count"], snapshot["reliability"])
        return True

    except Exception as e:
        db.rollback()
        logger.error("원두 (ID=%d) 큐레이션 스냅샷 갱신 실패: %s", bean_id, str(e))
        return False


def update_all_beans_curation_snapshots(db: Session) -> int:
    """
    [한글 주석]
    모든 원두에 대해 큐레이션 스냅샷 캐시를 일괄 갱신합니다.
    """
    beans = db.query(RoasteryBean).all()
    updated_count = 0
    for bean in beans:
        if update_bean_curation_snapshot(db, bean.id):
            updated_count += 1
    return updated_count
