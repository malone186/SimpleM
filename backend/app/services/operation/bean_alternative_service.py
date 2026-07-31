"""원두 대체 추천 — "이 원두와 비슷한데 더 싼 것"

[한글 주석] 왜 취향 추천이 아니라 대체 추천인가:

  기존 curate API는 산미/바디 점수로 취향을 매칭한다. 그런데 그 점수의 원천인
  curation_snapshot이 현재 0건이라(리뷰 구조화 추출이 돌지 않음) 실제로는 동작하지 않는다.

  그리고 카페 사장님에게는 "당신 취향에 92% 맞아요"보다
  "지금 보는 원두와 맛은 비슷한데 잔당 200원 싸요"가 훨씬 직접적이다.
  발주는 취향이 아니라 원가로 결정되기 때문이다.

  이 추천은 실제로 채워진 데이터만 쓴다:
    g당 단가 99.7% / 원산지 80% / 가공방식 68% / 컵노트 38%

유사도 판정 근거(가중치):
  · 같은 원산지        +3  — 맛의 큰 틀을 정하는 요소
  · 같은 가공방식      +2  — 산미·단맛의 방향을 좌우
  · 컵노트 겹침        +1/개 (최대 +3) — 실제 풍미 표현이 겹치는 정도
  · 디카페인 여부 일치 +1  — 디카페인은 대체 불가한 조건에 가깝다
"""
import logging
import re
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.roastery import Roastery, RoasteryBean

logger = logging.getLogger(__name__)

# 1잔 추출 기준 원두량(g) — 절감액을 잔당으로 환산할 때 사용
GRAMS_PER_SHOT = 20

# 컵노트에서 의미 없는 조사·기호를 걷어내기 위한 분리 기준
_NOTE_SPLIT = re.compile(r"[,·/|]+")


def _parse_notes(text: Optional[str]) -> set:
    """컵노트 문자열을 비교 가능한 단어 집합으로 만든다.

    '플로럴, 자스민, 베르가못' → {'플로럴', '자스민', '베르가못'}
    """
    if not text:
        return set()
    parts = _NOTE_SPLIT.split(text)
    return {p.strip() for p in parts if len(p.strip()) >= 2}


def _similarity(base: RoasteryBean, cand: RoasteryBean,
                base_notes: set) -> tuple:
    """유사도 점수와 근거 문구를 계산한다."""
    score = 0
    reasons: List[str] = []

    if base.country and cand.country and base.country == cand.country:
        score += 3
        reasons.append(f"같은 원산지({cand.country})")

    if base.process and cand.process and base.process == cand.process:
        score += 2
        reasons.append(f"같은 가공방식({cand.process})")

    shared = base_notes & _parse_notes(cand.description)
    if shared:
        score += min(len(shared), 3)
        reasons.append(f"공통 풍미 {', '.join(sorted(shared)[:3])}")

    if bool(base.decaf) == bool(cand.decaf):
        score += 1
        if base.decaf:
            reasons.append("디카페인")

    return score, reasons


# [한글 주석] 절감률 상·하한.
#   상한(70%): 이보다 싸면 '대체품'이 아니라 아예 다른 등급의 제품이다.
#     실측 사례 — 17g짜리 게이샤 샘플(2,058원/g)에 일반 원두를 붙이니
#     "잔당 40,256원 절약(97.8%)"이라는 무의미한 추천이 나왔다.
#     20g 샷을 뽑을 수도 없는 17g 샘플과 비교한 결과다.
#   하한(3%): 이 정도 차이로 원두를 바꾸라고 권하는 건 소음이다.
_MAX_SAVING_PCT = 70.0
_MIN_SAVING_PCT = 3.0

# [한글 주석] 중량대 가드 — 소포장과 대용량을 비교하지 않기 위한 배수 범위.
#
#   실측 사례: 100g 소포장(65원/g)에 추천을 돌리니 1위~3위가 전부
#   1kg 대용량(19~20원/g)이었다. 절감률도 68~70%로 상한에 몰렸다.
#   소포장은 g당 단가가 원래 비싸므로, 중량을 무시하면 추천이
#   "더 싼 원두"가 아니라 "더 큰 봉지"만 찾아낸다.
#
#   그건 틀린 조언은 아니지만 이 기능이 답하려는 질문이 아니고,
#   무엇보다 진짜 원두 대 원두 대안을 목록 밖으로 밀어낸다.
#   0.5~2배로 묶어 같은 구매 단위 안에서 비교한다.
_MIN_WEIGHT_RATIO = 0.5
_MAX_WEIGHT_RATIO = 2.0


def _estimate_grams(bean: RoasteryBean) -> Optional[float]:
    """가격과 g당 단가로 포장 중량을 역산한다.

    [한글 주석] 중량 컬럼이 따로 없어 price / price_per_gram으로 구한다.
    price_per_gram 자체가 상품명의 중량 표기에서 계산된 값이라 역산이 성립한다.
    """
    if not bean.price or not bean.price_per_gram:
        return None
    return bean.price / bean.price_per_gram


def _no_result_message(base_grams: Optional[float], skipped_weight: int) -> str:
    """결과가 0건일 때 '왜 없는지'를 알려준다.

    [한글 주석] 그냥 "없습니다"라고만 하면 기능이 고장난 것처럼 보인다.
    중량대가 달라 걸러진 게 많으면 그 사실을 밝혀야 납득이 된다.
    """
    if skipped_weight and base_grams:
        return (
            f"이 원두({int(round(base_grams))}g)와 비슷한 용량의 대체 원두를 찾지 못했습니다. "
            f"용량이 크게 다른 {skipped_weight}개는 g당 단가 비교가 공정하지 않아 제외했습니다."
        )
    return "조건에 맞는 대체 원두를 찾지 못했습니다. (원산지·가공방식이 비슷하면서 더 싼 원두가 없음)"


def find_alternatives(
    db: Session,
    bean_id: int,
    limit: int = 5,
    min_similarity: int = 3,
) -> Optional[Dict[str, Any]]:
    """이 원두와 비슷하면서 더 저렴한 원두를 찾는다.

    [한글 주석] '더 싸다'의 기준은 절대가격이 아니라 g당 단가다.
    200g과 1kg의 절대가격을 비교하면 대용량이 무조건 비싸 보인다.

    min_similarity 미만은 버린다 — 원산지도 가공방식도 다른 원두를
    "대안"이라고 내밀면 추천이 아니라 소음이다.
    """
    base = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not base:
        return None
    if not base.price_per_gram:
        return {
            "bean_id": bean_id,
            "alternatives": [],
            "message": "이 원두는 g당 단가 정보가 없어 대체 추천을 계산할 수 없습니다.",
        }

    base_notes = _parse_notes(base.description)
    base_grams = _estimate_grams(base)

    # 후보군: g당 단가가 있고, 더 저렴하고, 자기 자신이 아닌 원두
    candidates = (
        db.query(RoasteryBean)
        .filter(RoasteryBean.id != bean_id)
        .filter(RoasteryBean.price_per_gram.isnot(None))
        .filter(RoasteryBean.price_per_gram < base.price_per_gram)
        .filter(RoasteryBean.sold_out.is_(False))
        .all()
    )

    scored: List[Dict[str, Any]] = []
    skipped_weight = 0
    for cand in candidates:
        # 같은 구매 단위끼리만 비교한다 (소포장 vs 대용량 비교 방지)
        if base_grams:
            cand_grams = _estimate_grams(cand)
            if cand_grams and not (
                base_grams * _MIN_WEIGHT_RATIO
                <= cand_grams
                <= base_grams * _MAX_WEIGHT_RATIO
            ):
                skipped_weight += 1
                continue

        score, reasons = _similarity(base, cand, base_notes)
        if score < min_similarity:
            continue

        saving_per_gram = base.price_per_gram - cand.price_per_gram
        saving_pct = saving_per_gram / base.price_per_gram * 100

        # 너무 싸면 대체품이 아니라 다른 등급, 너무 비슷하면 바꿀 이유가 없다.
        if saving_pct > _MAX_SAVING_PCT or saving_pct < _MIN_SAVING_PCT:
            continue

        scored.append({
            "bean": cand,
            "score": score,
            "reasons": reasons,
            "saving_per_gram": round(saving_per_gram, 2),
            "saving_per_shot": int(round(saving_per_gram * GRAMS_PER_SHOT)),
            "saving_pct": round(saving_pct, 1),
        })

    # 유사도 우선, 그다음 절감액 — 아무리 싸도 안 비슷하면 대안이 아니다
    scored.sort(key=lambda x: (x["score"], x["saving_per_gram"]), reverse=True)
    top = scored[:limit]

    # 로스터리 이름을 한 번에 조회 (N+1 방지)
    rids = {x["bean"].roastery_id for x in top}
    rmap = {
        r.id: r.name
        for r in db.query(Roastery).filter(Roastery.id.in_(rids)).all()
    } if rids else {}

    items = [
        {
            "id": x["bean"].id,
            "name": x["bean"].name,
            "roastery_name": rmap.get(x["bean"].roastery_id, ""),
            "price": x["bean"].price,
            "price_per_gram": x["bean"].price_per_gram,
            "grams": int(round(_estimate_grams(x["bean"]) or 0)) or None,
            "country": x["bean"].country,
            "process": x["bean"].process,
            "cup_notes": x["bean"].description,
            "product_url": x["bean"].product_url,
            "review_count": x["bean"].review_count,
            "avg_rating": x["bean"].avg_rating,
            "similarity": x["score"],
            "reasons": x["reasons"],
            "saving_per_gram": x["saving_per_gram"],
            "saving_per_shot": x["saving_per_shot"],
            "saving_pct": x["saving_pct"],
        }
        for x in top
    ]

    return {
        "bean_id": bean_id,
        "bean_name": base.name,
        "base_price_per_gram": base.price_per_gram,
        "base_grams": int(round(base_grams)) if base_grams else None,
        "grams_per_shot": GRAMS_PER_SHOT,
        "candidates_considered": len(candidates),
        "alternatives": items,
        "message": (
            f"비슷하면서 더 저렴한 원두 {len(items)}건"
            if items
            else _no_result_message(base_grams, skipped_weight)
        ),
    }
