# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\curation_service.py
"""
[한글 주석]
공용 데이터베이스(roastery_beans.curation_snapshot) 기반 
나만의 원두 취향 큐레이터 알고리즘 매칭 추천 서비스
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from urllib.parse import quote

from app.models.roastery import RoasteryBean, Roastery


class CurationFilterRequest(BaseModel):
    caffeine: Optional[str] = "상관없음"  # "상관없음", "일반 원두", "디카페인"
    origin: Optional[str] = "전체"       # "전체", "에티오피아", "콜롬비아", "브라질", "케냐"
    process: Optional[str] = "전체"      # "전체", "워시드 (Washed)", "내추럴 (Natural)", "허니 (Honey)", "애너로빅 (무산소)"
    roast_level: Optional[str] = "전체"  # "전체", "라이트", "미디엄", "미디엄 다크", "다크"
    
    # 척도 (0=없음/상관없음, 1=낮음, 2=중간, 3=높음)
    acidity: Optional[int] = 0
    body: Optional[int] = 0
    sweetness: Optional[int] = 0
    bitterness: Optional[int] = 0


class CuratedBeanResponse(BaseModel):
    id: int
    name: str
    roastery_name: str
    price: int
    lowest_price: int
    country: Optional[str]
    thumbnail_url: Optional[str]
    product_url: Optional[str]
    match_score: int  # 매칭 점수 (0 ~ 100%)
    match_reason: str
    curation_snapshot: Optional[Dict[str, Any]]
    keywords: List[str]


def calculate_match_score(bean: RoasteryBean, req: CurationFilterRequest) -> tuple[int, str]:
    """
    [한글 주석]
    원두 스냅샷과 사용자 큐레이터 선택 조건 간의 취향 일치도 점수(0~100) 및 근거 사유를 계산합니다.
    """
    score = 100.0
    reasons = []

    # 1. 카페인 필터 검사
    if req.caffeine and req.caffeine != "상관없음":
        if req.caffeine == "디카페인" and not bean.decaf:
            return 0, "디카페인 미해당"
        elif req.caffeine == "일반 원두" and bean.decaf:
            return 0, "일반원두 미해당"
        else:
            reasons.append(f"{req.caffeine} 일치")

    # 2. 원산지 필터 검사
    if req.origin and req.origin != "전체":
        bean_country = bean.country or ""
        if req.origin not in bean_country and bean_country not in req.origin:
            score -= 30.0
        else:
            reasons.append(f"{req.origin} 원산지 일치")

    # 3. 가공 방식 필터 검사
    if req.process and req.process != "전체":
        bean_process = bean.process or ""
        proc_clean = req.process.split()[0]
        if proc_clean not in bean_process and bean_process not in proc_clean:
            score -= 20.0
        else:
            reasons.append(f"{proc_clean} 가공방식 일치")

    # 4. 척도 매칭 (산미, 바디감, 단맛, 쓴맛) 유클리드 거리 및 가중치
    snap = bean.curation_snapshot or {}
    scales = snap.get("scales", {})

    target_scales = {
        "acidity": req.acidity,
        "body": req.body,
        "sweetness": req.sweetness,
        "bitterness": req.bitterness
    }

    scale_reasons = []
    for scale_key, user_val in target_scales.items():
        if user_val is not None and user_val > 0:  # 사용자가 특정 척도를 원함
            bean_scale_info = scales.get(scale_key, {})
            bean_score = bean_scale_info.get("score") if isinstance(bean_scale_info, dict) else None

            if bean_score is not None:
                diff = abs(user_val - bean_score)
                score -= diff * 15.0
                if diff == 0:
                    scale_reasons.append(f"{scale_key} 부합")
            else:
                score -= 5.0

    final_score = max(10, min(99, int(score)))

    if not reasons and not scale_reasons:
        reason_str = "취향 성향 종합 부합 원두"
    else:
        reason_str = ", ".join(reasons + scale_reasons[:2])

    return final_score, reason_str


def curate_beans_by_preference(db: Session, req: CurationFilterRequest, limit: int = 20) -> List[CuratedBeanResponse]:
    """
    [한글 주석]
    공용 DB에서 큐레이터 조건에 맞는 원두 리스트를 매칭률 높은 순으로 추출하여 반환합니다.
    """
    beans = db.query(RoasteryBean).all()
    results = []

    for bean in beans:
        match_score, reason = calculate_match_score(bean, req)
        if match_score <= 0:
            continue

        lowest_price = bean.price or 15000
        roastery_name = bean.roastery.name if bean.roastery else "타이커피"

        keywords = []
        if bean.decaf:
            keywords.append("#디카페인")
        if bean.country:
            keywords.append(f"#{bean.country}")
        keywords.append(f"#{match_score}%일치")

        target_url = bean.product_url or f"https://search.shopping.naver.com/search/all?query={quote(bean.name)}"

        results.append(
            CuratedBeanResponse(
                id=bean.id,
                name=bean.name,
                roastery_name=roastery_name,
                price=bean.price or 15000,
                lowest_price=lowest_price,
                country=bean.country,
                thumbnail_url=bean.thumbnail_url,
                product_url=target_url,
                match_score=match_score,
                match_reason=reason,
                curation_snapshot=bean.curation_snapshot,
                keywords=keywords
            )
        )

    results.sort(key=lambda x: x.match_score, reverse=True)
    return results[:limit]
