"""지출 항목을 성격별로 알아보는 공용 규칙 (경영 리포트 · 정산 공용)

지출(Expense)의 카테고리는 자유 입력이다 — 화면 플레이스홀더가 "예: 원두매입, 임대료"일
뿐이고 목록에서 고르는 구조가 아니다. 그래서 이름으로 알아보는 수밖에 없다.

두 가지를 가린다.

1. 고정비가 잡혀 있는가 (`has_fixed_cost`)
   임대료를 안 넣은 매장에서 '매출 - 재료비 - 인건비'를 순이익이라 부르면, 월세 200만원
   매장은 200만원을 벌고 있다고 믿게 된다. 실제 매장을 열어 보니 지출 15건이 전부
   원두매입·우유·소모품이고 임대료는 한 건도 없었다 — '지출이 있으니 고정비도 넣었겠지'는
   틀린 가정이다.
   못 알아본 쪽으로 틀리면 "임대료를 넣어 달라"는 안내가 한 번 더 뜨는 정도지만,
   반대로 틀리면 월세가 빠진 금액을 순이익이라 부르게 된다. 그래서 넉넉히 잡는다.

2. 재료 매입인가 (`is_material_purchase`)
   손익의 재료비를 레시피로 계산할 때, 같은 원두값을 지출로도 넣어 두면 두 번 빠진다.
   이쪽은 반대로 좁게 잡는다 — 잘못 빼면 실제로 나간 돈이 손익에서 사라지기 때문이다.
"""

from typing import Any, Iterable

# 고정비로 읽어야 하는 낱말 — 넉넉하게 잡는다(위 1번 참고)
FIXED_COST_WORDS = (
    "임대", "월세", "관리비", "공과", "전기", "수도", "가스", "난방",
    "통신", "인터넷", "보험", "세금", "부가세", "수수료", "렌탈", "렌트", "리스",
    "이자", "상환", "고정비", "구독", "정기결제", "청소", "방역", "음악", "저작권",
)

# 레시피 재료비와 겹치는 매입 낱말 — 좁게 잡는다(위 2번 참고).
# '소모품'은 넣지 않는다: 컵·뚜껑처럼 레시피에 든 것도 있지만 청소용품·비품도 같은 이름으로
# 들어와서, 빼 버리면 실제로 나간 돈이 손익에서 조용히 사라진다.
MATERIAL_PURCHASE_WORDS = (
    "원두", "우유", "유제품", "시럽", "재료", "식자재", "부자재", "매입", "농산", "청과",
)


def _norm(category: Any) -> str:
    return str(category or "").replace(" ", "")


def is_fixed_cost_category(category: Any) -> bool:
    """임대료·공과금처럼 매달 고정으로 나가는 항목인가."""
    n = _norm(category)
    return any(w in n for w in FIXED_COST_WORDS)


def is_material_purchase(category: Any) -> bool:
    """레시피 재료비와 겹치는 매입 항목인가 (원두·우유 등)."""
    n = _norm(category)
    return any(w in n for w in MATERIAL_PURCHASE_WORDS)


def has_fixed_cost(categories: Iterable[Any]) -> bool:
    """고정비 성격의 항목이 하나라도 있는지."""
    return any(is_fixed_cost_category(c) for c in categories)


# 손익분기 4칸(임대료/인건비/공과금/기타)에 지출 카테고리를 매핑할 낱말.
# 손익분기 자동 채우기가 쓴다 — 순서대로 먼저 걸리는 버킷으로 넣는다.
_BUCKET_WORDS = {
    "rent": ("임대", "월세", "관리비"),
    "labor": ("인건", "급여", "월급", "시급", "알바", "아르바이트"),
    "utilities": ("공과", "전기", "수도", "가스", "난방", "통신", "인터넷"),
    "other": ("보험", "세금", "부가세", "수수료", "렌탈", "렌트", "리스",
              "이자", "상환", "고정비", "구독", "정기결제", "청소", "방역", "음악", "저작권"),
}


def fixed_cost_bucket(category: Any) -> str | None:
    """지출 카테고리를 손익분기 칸(rent/labor/utilities/other)으로 분류. 고정비가 아니면 None.

    임대→임대료, 전기→공과금, 보험→기타처럼 나눈다. '관리비'가 '공과'보다 먼저 임대로 가게
    순서를 잡았다(전기'요금'관리비 같은 애매한 이름은 앞선 버킷 우선)."""
    n = _norm(category)
    for bucket, words in _BUCKET_WORDS.items():
        if any(w in n for w in words):
            return bucket
    return None
