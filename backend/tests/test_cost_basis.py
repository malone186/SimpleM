"""지출 항목 성격 판정 (경영 리포트 · 정산 공용)

지출 카테고리는 자유 입력이라 이름으로 알아볼 수밖에 없다. 두 방향의 오판이 값이
다르다는 게 이 규칙의 전부다 — 고정비는 넉넉히, 재료 매입은 좁게.
"""
import pytest

from app.services import cost_basis


@pytest.mark.parametrize("category", [
    "임대료", "월세", "관리비", "전기요금", "수도세", "가스비", "인터넷",
    "4대보험", "카드수수료", "정수기렌탈", "구독료", "저작권료", "방역",
    " 임 대 료 ",           # 띄어쓰기를 넣어도 같은 항목이다
])
def test_fixed_cost_categories(category):
    assert cost_basis.is_fixed_cost_category(category) is True


@pytest.mark.parametrize("category", ["원두매입", "우유/유제품", "소모품", "회식비", ""])
def test_non_fixed_cost_categories(category):
    assert cost_basis.is_fixed_cost_category(category) is False


@pytest.mark.parametrize("category", ["원두매입", "우유/유제품", "시럽", "식자재", "부자재"])
def test_material_purchase_categories(category):
    assert cost_basis.is_material_purchase(category) is True


@pytest.mark.parametrize("category", ["임대료", "인건비", "회식비", "소모품"])
def test_not_material_purchase(category):
    """'소모품'은 일부러 뺐다 — 컵·뚜껑도 있지만 청소용품·비품도 같은 이름으로 들어온다.
    빼 버리면 실제로 나간 돈이 손익에서 조용히 사라진다."""
    assert cost_basis.is_material_purchase(category) is False


def test_has_fixed_cost_needs_only_one():
    assert cost_basis.has_fixed_cost(["원두매입", "소모품", "임대료"]) is True
    assert cost_basis.has_fixed_cost(["원두매입", "소모품"]) is False
    assert cost_basis.has_fixed_cost([]) is False


def test_none_and_missing_categories_are_safe():
    """카테고리가 비어도 터지지 않는다 — 자유 입력이라 빈 값이 들어올 수 있다."""
    assert cost_basis.is_fixed_cost_category(None) is False
    assert cost_basis.is_material_purchase(None) is False
    assert cost_basis.has_fixed_cost([None, ""]) is False


# --- 손익분기 자동 채우기용 버킷 분류 ---

import pytest as _pytest


@_pytest.mark.parametrize("category,bucket", [
    ("임대료", "rent"), ("월세", "rent"), ("건물 관리비", "rent"),
    ("인건비", "labor"), ("직원 급여", "labor"), ("알바 시급", "labor"),
    ("전기요금", "utilities"), ("수도세", "utilities"), ("가스비", "utilities"),
    ("통신비", "utilities"), ("인터넷", "utilities"),
    ("화재보험", "other"), ("정수기 렌탈", "other"), ("음악 저작권료", "other"),
    ("카드수수료", "other"), ("구독료", "other"),
    ("원두매입", None), ("소모품", None), ("회식비", None), ("", None),
])
def test_fixed_cost_bucket(category, bucket):
    assert cost_basis.fixed_cost_bucket(category) == bucket


def test_관리비는_공과보다_임대로_먼저_간다():
    """'관리비'는 임대료 버킷 — 전기'요금관리비' 같은 애매한 이름이 공과로 새지 않게."""
    assert cost_basis.fixed_cost_bucket("관리비") == "rent"
