"""주변 카페 유사도 채점 — 폴백이 '전부 같은 점수'로 무너지지 않는지 지킨다.

이 기능이 죽는 방식은 500이 아니라 '전 카페 53% 동점'이었다. 화면은 멀쩡히 뜨는데
유사도순 정렬이 거리순과 똑같아져 기능이 없는 것처럼 보인다. 그래서 테스트는
'응답이 오는가'가 아니라 '점수가 실제로 갈리는가'를 본다.

네트워크·DB를 타지 않는 순수 함수(_heuristic·_cafe_signals·_menu_stats)만 검증한다.
"""
from app.services.ai import cafe_similarity_service as css

# 내 카페: 커피 중심(디저트 3할), 메뉴 평균 5,100원대
MY = {"store_name": "테스트 카페", "biz_type": "카페", "menus": [],
      "avg_price": 5100, "dessert_ratio": 0.30, "review_view": None,
      "review_source": "unlinked"}

CAFES = [
    {"name": "동네커피 로스터리", "category": "카페,디저트>커피전문점", "distance_m": 100},
    {"name": "메가MGC커피 홍대점", "category": "카페,디저트>카페", "distance_m": 200},
    {"name": "폴바셋 합정점", "category": "카페,디저트>커피전문점", "distance_m": 300},
    {"name": "수상한베이글", "category": "카페,디저트>카페", "distance_m": 400},
    {"name": "홍대 만화카페 놀숲", "category": "카페,디저트>테마카페", "distance_m": 500},
    {"name": "카페 공명", "category": "음식점>카페,디저트", "distance_m": 600},
]


def test_폴백_채점은_카페마다_점수가_갈린다():
    """핵심 회귀: 예전 폴백은 모든 축을 50으로 박아 전부 53%가 나왔다."""
    rows = css._heuristic(CAFES, MY)
    totals = {r["total"] for r in rows}
    assert len(totals) >= 4, f"점수가 뭉쳤다(정렬 무의미): {[r['total'] for r in rows]}"
    assert max(totals) - min(totals) >= 20, f"점수 폭이 너무 좁다: {sorted(totals)}"


def test_테마공간이_동네카페보다_낮게_나온다():
    """만화카페는 커피를 팔아도 방문 목적이 다르다 — 경쟁 상대로 위에 오면 안 된다."""
    by = {r["name"]: r["total"] for r in css._heuristic(CAFES, MY)}
    assert by["홍대 만화카페 놀숲"] < by["카페 공명"]
    assert by["홍대 만화카페 놀숲"] < by["동네커피 로스터리"]


def test_저가_프랜차이즈는_가격축이_낮다():
    """메뉴는 겹쳐도 5,100원 매장과 저가 프랜차이즈는 지갑이 갈린다."""
    by = {r["name"]: r for r in css._heuristic(CAFES, MY)}
    assert by["메가MGC커피 홍대점"]["axes"]["price"] < by["동네커피 로스터리"]["axes"]["price"]


def test_일반_카테고리를_디저트_전문점으로_읽지_않는다():
    """네이버는 평범한 카페에도 '카페,디저트'를 붙인다. 이걸 디저트 전문으로 읽으면
    동네 카페가 전부 베이커리로 둔갑해 한 점수에 뭉쳤다(실측 13곳 중 7곳 동점)."""
    generic = css._cafe_signals({"name": "카페 공명", "category": "음식점>카페,디저트"})
    real = css._cafe_signals({"name": "수상한베이글", "category": "카페,디저트>카페"})
    assert generic["dessert_ratio"] < 0.5, "일반 카페를 디저트 전문으로 읽었다"
    assert real["dessert_ratio"] > 0.5, "베이글 전문점을 놓쳤다"


def test_메뉴_평균가는_옵션행을_빼고_낸다():
    """'샷추가 500원'까지 평균에 넣으면 객단가가 통째로 내려앉아 가격 축이 어긋난다."""
    menus = [{"name": "아메리카노", "price": 4000}, {"name": "라떼", "price": 5000},
             {"name": "샷추가", "price": 500}, {"name": "사이즈업", "price": 500}]
    avg, dessert = css._menu_stats(menus)
    assert avg == 4500, f"옵션 행이 평균에 섞였다: {avg}"
    assert dessert == 0.0


def test_메뉴가_없으면_가격축은_중립이다():
    """비교 근거가 없는데 점수를 지어내면 안 된다."""
    empty = {**MY, "avg_price": 0, "dessert_ratio": 0.0}
    for r in css._heuristic(CAFES, empty):
        assert r["axes"]["price"] == 50


def test_총점은_가중합_그대로다():
    """축 점수가 같으면 총점도 항상 같아야 한다(합산은 AI가 아니라 파이썬 몫)."""
    assert css._weighted_total(dict.fromkeys(css.WEIGHTS, 100)) == 100
    assert css._weighted_total(dict.fromkeys(css.WEIGHTS, 0)) == 0
    assert css._weighted_total({"menu": 100, "price": 0, "concept": 0,
                                "atmosphere": 0, "customers": 0}) == 30
