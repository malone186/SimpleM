"""메뉴 개선안 점검 챗봇 도구 (백엔드 B)

사장님이 "아메리카노 500원 올려도 될까?"라고 물으면 감으로 답하지 않고, 실제 판매·원가로
계산해서 "판매가 13.9%(52잔)까지 줄어도 본전"이라고 답하게 하는 도구다.

돈이 걸린 변경(가격 인상·메뉴 단종)이라 도구는 계산만 한다 — 실제 반영은 화면에서
사장님이 '적용' 버튼을 눌러야 일어난다 (propose_ 접두어 원칙과 같은 이유).

store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import menu_review_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def review_menu_changes(store_id: str, changes: str) -> str:
    """메뉴를 바꾸려는 안(가격 조정·신메뉴·단종·원가 절감)을 실제 판매·원가 데이터로 점검한다.
    "아메리카노 500원 올려도 될까?", "이 메뉴 빼도 돼?", "이렇게 바꿔봤는데 괜찮아?",
    "6000원짜리 신메뉴 넣으면 어때?" 같은 질문에 쓴다. 저장은 하지 않는다 (계산만).

    changes에는 바꾸려는 내용을 쉼표로 구분해 적는다:
      "아메리카노 4500"          → 판매가를 4,500원으로
      "아메리카노 500원 인상"     → 지금 가격에서 500원 올림
      "-바닐라라떼"              → 바닐라라떼를 뺌 (단종)
      "+흑임자라떼 6000"         → 6,000원짜리 신메뉴 추가
      "아메리카노 원가 800"       → 재료를 바꿔 원가가 800원이 되는 안
    예: "아메리카노 4500, -바닐라라떼, +흑임자라떼 6000"

    돌려주는 값에서 가장 중요한 건 breakeven_drop_pct(가격을 올릴 때 판매량이 이만큼
    줄어도 본전인 한계)와 monthly_delta(한 달 남는 돈의 변화)다."""
    parsed, unparsed = menu_review_service.parse_change_spec(changes)
    if not parsed:
        return ("무엇을 어떻게 바꾸는지 읽지 못했습니다. "
                "'아메리카노 4500' 또는 '-바닐라라떼' 형식으로 다시 적어 주세요.")
    try:
        # 대화 중에는 총평을 따로 만들지 않는다 — 브루가 직접 말로 정리하는 편이 자연스럽고
        # LLM 호출도 한 번 아낀다
        result = menu_review_service.review(store_id, parsed, comment=False)
    except menu_review_service.MenuReviewError as e:
        return str(e)
    if unparsed:
        result["ignored"] = unparsed
    return _dump(result)


@tool
def suggest_menu_improvements(store_id: str, include_new_menu: bool = True) -> str:
    """메뉴를 어떻게 개선하면 좋을지 매장 숫자를 훑어 먼저 찾아 준다 — 팔수록 손해인 메뉴의
    적정 가격, 재료비 비중이 높은 메뉴의 인상 폭, 30일간 안 나간 메뉴 정리, 신메뉴 아이디어.
    "메뉴 개선 좀 추천해줘", "뭘 바꾸면 좋을까?", "메뉴 어떻게 손보면 돼?", "신메뉴 뭐 넣을까?"
    같은 요청에 쓴다. 사장님이 이미 바꿀 안을 정했으면 review_menu_changes를 쓴다.

    각 제안에는 why(왜 이걸 권하는지), monthly_delta(한 달 남는 돈의 변화),
    breakeven_drop_pct(가격을 올릴 때 판매량이 이만큼 줄어도 본전)가 함께 온다.
    actionable=false인 항목(원가 미등록 안내)은 바로 적용할 수 없는 안내이므로
    '이것부터 해야 한다'는 뜻으로 전한다. 저장은 하지 않는다 (계산만)."""
    try:
        return _dump(menu_review_service.recommend(store_id, include_new=include_new_menu))
    except menu_review_service.MenuReviewError as e:
        return str(e)


@tool
def check_menu_lineup(store_id: str) -> str:
    """지금 메뉴 구성이 괜찮은지 점검한다 — 팔수록 손해인 메뉴, 재료비 비중이 높은 메뉴,
    이익이 한두 메뉴에 몰려 있는지를 본다. "메뉴 구성 어때?", "메뉴 좀 봐줘",
    "정리할 메뉴 있어?" 같은 질문에 쓴다. 바꾸려는 안이 정해져 있으면 review_menu_changes를 쓴다."""
    from app.services.ai import sales_service

    data = sales_service.menu_contribution(store_id, days=30)
    menus = [m for m in (data.get("menus") or []) if m.get("is_active", True)]
    if not menus:
        return "등록된 메뉴가 없습니다. 메뉴판 사진으로 먼저 등록하시면 점검할 수 있습니다."

    priced = [m for m in menus if not m["recipe_missing"]]
    losing = [m["name"] for m in priced if m["margin_per_cup"] <= 0]
    heavy = [{"name": m["name"], "cost_ratio": m["cost_ratio"]}
             for m in priced if (m["cost_ratio"] or 0) >= menu_review_service.COST_RATIO_WARN]
    dead = [m["name"] for m in menus if m["sold_qty"] == 0]
    top3 = sorted(priced, key=lambda m: -m["total_margin"])[:3]
    total = sum(m["total_margin"] for m in priced)

    return _dump({
        "기간": "최근 30일",
        "메뉴수": len(menus),
        "원가_미등록": [m["name"] for m in menus if m["recipe_missing"]],
        "팔수록_손해": losing,
        "재료비_비중_높음": heavy,
        "최근30일_판매없음": dead,
        "이익_상위3": [{"name": m["name"], "total_margin": m["total_margin"]} for m in top3],
        "상위3_이익비중_퍼센트": round(sum(m["total_margin"] for m in top3) / total * 100, 1)
                                if total > 0 else None,
        "평균_객단가": round(data["total_revenue"] / data["total_qty"]) if data.get("total_qty") else 0,
    })


TOOLS = [check_menu_lineup, review_menu_changes, suggest_menu_improvements]
