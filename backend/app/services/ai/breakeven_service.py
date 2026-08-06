"""손익분기점 (백엔드 B) — 고정비를 입력하면 "얼마를 팔아야 본전인가"를 계산한다

왜 이 기능이 필요한가:
  사장님이 매달 보는 숫자는 '이번 달 매출'이다. 그런데 매출이 얼마여야 남는지를
  아는 사장님은 드물다. 임대료·인건비·공과금은 한 잔도 안 팔아도 매달 나가고,
  재료비·카드 수수료는 팔릴 때마다 따라 붙는다. 이 둘을 나눠 보지 않으면
  "매출은 늘었는데 왜 통장은 그대로지?"를 영영 설명할 수 없다.

계산 방법 (관리회계의 표준 CVP 분석):
  공헌이익률 = 1 − 변동비율
  손익분기 매출 = 고정비 ÷ 공헌이익률
  목표이익 달성 매출 = (고정비 + 목표이익) ÷ 공헌이익률

  잔 수로 바꿀 때는 객단가(최근 실제 판매 기준)로 나눈다. 일 목표는 한 달 영업일수로
  나눈다 — 월 목표는 너무 크게 느껴져서 행동으로 이어지지 않기 때문이다.

변동비율은 어디서 오나 (자동 → 수동 순서):
  1) 메뉴 레시피가 등록돼 있으면 최근 30일 실제 판매의 재료비율을 그대로 쓴다.
     (sales_service.menu_contribution — 판매량으로 가중된 실제 값이라 평균보다 정확하다)
  2) 카드 매출이 입력돼 있으면 카드 수수료율을 더한다. 수수료도 팔릴 때만 나가는
     엄연한 변동비인데, 이걸 빼면 손익분기점이 실제보다 낙관적으로 나온다.
  3) 둘 다 없으면 사장님이 직접 적은 값을 쓰고, 그것도 없으면 계산을 포기하고
     '입력이 필요하다'고 돌려준다. 근거 없는 기본값을 조용히 끼워 넣으면
     사장님은 그 숫자가 자기 매장 값인 줄 안다.

여기서 나오는 숫자는 '최근 판매 구조가 유지된다면'이라는 가정 위의 예상치다.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 고정비 항목 — 화면·챗봇이 같은 이름을 쓰도록 여기 한 곳에서 정의한다
FIXED_COST_FIELDS = ("rent", "labor", "utilities", "other")
FIXED_COST_LABELS = {
    "rent": "임대료·관리비",
    "labor": "고정 인건비",
    "utilities": "공과금(전기·가스·수도·통신)",
    "other": "기타 고정비(보험·리스·구독)",
}

# 한 달 영업일수 기본값 — 주 6일 영업 기준. 사장님이 고칠 수 있다.
DEFAULT_OPEN_DAYS = 26

# 변동비율이 이 값을 넘으면 입력 오류를 의심한다 (재료비가 매출의 90%인 카페는 없다)
_MAX_SANE_VARIABLE_RATIO = 95.0


class BreakevenError(ValueError):
    """손익분기점 계산 불가 (잘못된 입력)"""


def _session():
    from app.services.ai.document_service import _session as doc_session

    return doc_session()


# ---------------------------------------------------------------------------
# 고정비 입력 — 저장 / 조회
# ---------------------------------------------------------------------------

def get_fixed_costs(store_id: str) -> dict[str, Any]:
    """저장된 고정비. 한 번도 입력한 적 없으면 configured=False로 0을 돌려준다."""
    from app.models.ai import FixedCostSetting

    with _session() as db:
        row = db.get(FixedCostSetting, store_id)
        if row is None:
            return {
                "configured": False,
                **{f: 0 for f in FIXED_COST_FIELDS},
                "total": 0,
                "custom_variable_ratio": None,
                "open_days_per_month": DEFAULT_OPEN_DAYS,
                "memo": None,
                "labels": FIXED_COST_LABELS,
            }
        values = {f: int(getattr(row, f) or 0) for f in FIXED_COST_FIELDS}
        return {
            "configured": True,
            **values,
            "total": sum(values.values()),
            "custom_variable_ratio": float(row.custom_variable_ratio)
            if row.custom_variable_ratio is not None else None,
            "open_days_per_month": int(row.open_days_per_month or DEFAULT_OPEN_DAYS),
            "memo": row.memo,
            "labels": FIXED_COST_LABELS,
            "updated_at": row.updated_at,
        }


def save_fixed_costs(
    store_id: str,
    *,
    rent: Optional[int] = None,
    labor: Optional[int] = None,
    utilities: Optional[int] = None,
    other: Optional[int] = None,
    custom_variable_ratio: Optional[float] = None,
    open_days_per_month: Optional[int] = None,
    memo: Optional[str] = None,
) -> dict[str, Any]:
    """고정비 저장 — 보낸 항목만 바뀐다 (부분 수정)."""
    from app.models.ai import FixedCostSetting

    incoming = {"rent": rent, "labor": labor, "utilities": utilities, "other": other}
    for field, value in incoming.items():
        if value is not None and int(value) < 0:
            raise BreakevenError(f"{FIXED_COST_LABELS[field]}는 0 이상이어야 합니다.")

    if custom_variable_ratio is not None and not (0 <= float(custom_variable_ratio) < 100):
        raise BreakevenError("변동비율은 0 이상 100 미만(%)이어야 합니다.")

    if open_days_per_month is not None and not (1 <= int(open_days_per_month) <= 31):
        raise BreakevenError("한 달 영업일수는 1~31일 사이여야 합니다.")

    with _session() as db:
        row = db.get(FixedCostSetting, store_id)
        if row is None:
            row = FixedCostSetting(store_id=store_id)
            db.add(row)
        for field, value in incoming.items():
            if value is not None:
                setattr(row, field, int(value))
        if custom_variable_ratio is not None:
            row.custom_variable_ratio = float(custom_variable_ratio)
        if open_days_per_month is not None:
            row.open_days_per_month = int(open_days_per_month)
        if memo is not None:
            row.memo = memo or None
        db.commit()

    return get_fixed_costs(store_id)


def clear_custom_variable_ratio(store_id: str) -> dict[str, Any]:
    """직접 적은 변동비율을 지워 자동 계산으로 되돌린다."""
    from app.models.ai import FixedCostSetting

    with _session() as db:
        row = db.get(FixedCostSetting, store_id)
        if row is not None:
            row.custom_variable_ratio = None
            db.commit()
    return get_fixed_costs(store_id)


# ---------------------------------------------------------------------------
# 변동비율 — 실제 판매에서 뽑아낸다
# ---------------------------------------------------------------------------

def estimate_variable_ratio(store_id: str, days: int = 30) -> dict[str, Any]:
    """최근 판매에서 변동비율(%)을 추정한다 — 재료비율 + 카드 수수료율.

    재료비율은 판매량으로 가중된 실제 값이라 '메뉴 원가율 평균'보다 정확하다.
    (많이 팔리는 아메리카노와 어쩌다 한 잔 나가는 시그니처를 같은 무게로 세면
     실제 구조와 달라진다.)

    레시피가 하나도 없으면 재료비를 알 수 없으므로 material_available=False로
    돌려준다 — 이때 자동 계산은 포기하고 직접 입력을 받아야 한다.
    """
    from app.services.ai import sales_service

    material_pct: Optional[float] = None
    avg_ticket: Optional[int] = None
    monthly_revenue: Optional[int] = None
    covered_menus = 0

    try:
        contribution = sales_service.menu_contribution(store_id, days=days)
    except Exception:
        logger.exception("메뉴 기여이익 조회 실패 — 재료비율 자동 계산을 건너뜁니다")
        contribution = {}

    revenue = int(contribution.get("total_revenue") or 0)
    margin = int(contribution.get("total_margin") or 0)
    qty = int(contribution.get("total_qty") or 0)

    if revenue > 0:
        # 레시피가 없는 메뉴는 원가 0으로 잡혀 마진이 부풀려진다 — 그 메뉴가 매출의
        # 상당 부분을 차지하면 재료비율이 비현실적으로 낮게 나오므로 아예 쓰지 않는다.
        sold_menus = [m for m in contribution.get("menus", []) if m.get("sold_qty")]
        covered = [m for m in sold_menus if not m.get("recipe_missing")]
        covered_revenue = sum(int(m.get("revenue") or 0) for m in covered)
        covered_menus = len(covered)
        # 레시피가 걸린 메뉴가 매출의 절반은 넘어야 이 값을 신뢰할 수 있다
        if sold_menus and covered_revenue >= revenue * 0.5:
            material_pct = round((revenue - margin) / revenue * 100, 1)
        avg_ticket = round(revenue / qty) if qty else None
        # days일치 매출을 30일 기준으로 환산 (달마다 길이가 달라 비교가 어긋나지 않게)
        monthly_revenue = round(revenue / days * 30)

    # 카드 수수료 — 팔릴 때만 나가는 변동비다. 매출 대비 실효율로 잡는다.
    fee_pct: Optional[float] = None
    try:
        from app.services.ai import settlement_service

        summary = settlement_service.period_summary(store_id, days=28)
        total = int(summary.get("total") or 0)
        if total > 0:
            fee_pct = round(int(summary.get("fee_total") or 0) / total * 100, 2)
            # 메뉴별 판매를 안 넣고 결제수단별 총액만 입력하는 매장은 이쪽이 유일한
            # 매출 실적이다 (그런 매장은 잔 수를 안 세므로 객단가는 여전히 알 수 없다)
            if monthly_revenue is None:
                monthly_revenue = round(total / 28 * 30)
    except Exception:
        logger.exception("정산 요약 조회 실패 — 카드 수수료율을 변동비에서 제외합니다")

    parts: list[dict[str, Any]] = []
    if material_pct is not None:
        parts.append({"label": "재료비", "pct": material_pct, "source": f"최근 {days}일 실제 판매"})
    if fee_pct is not None:
        parts.append({"label": "카드 수수료", "pct": fee_pct, "source": "최근 28일 카드 매출"})

    ratio = round(sum(p["pct"] for p in parts), 2) if parts else None
    return {
        "ratio": ratio,
        "material_pct": material_pct,
        "card_fee_pct": fee_pct,
        "parts": parts,
        # 재료비를 못 구했으면 자동값만으로는 손익분기점을 못 낸다
        "material_available": material_pct is not None,
        "covered_menus": covered_menus,
        "avg_ticket": avg_ticket,
        "monthly_revenue": monthly_revenue,
        "days": days,
    }


# ---------------------------------------------------------------------------
# 손익분기점
# ---------------------------------------------------------------------------

def compute_breakeven(
    store_id: str,
    *,
    fixed_costs: Optional[dict[str, int]] = None,
    variable_cost_ratio: Optional[float] = None,
    target_profit: int = 0,
    open_days_per_month: Optional[int] = None,
    days: int = 30,
) -> dict[str, Any]:
    """손익분기점 계산.

    fixed_costs를 주면 그 값으로(저장하지 않고) 계산하고, 안 주면 저장된 값을 쓴다.
    variable_cost_ratio(%)를 주면 자동 추정 대신 그 값을 쓴다 — '재료비를 20%로
    낮추면 어떻게 되나' 같은 가정 계산에 그대로 쓸 수 있다.
    """
    saved = get_fixed_costs(store_id)

    if fixed_costs is None:
        costs = {f: int(saved.get(f) or 0) for f in FIXED_COST_FIELDS}
    else:
        costs = {f: max(0, int(fixed_costs.get(f) or 0)) for f in FIXED_COST_FIELDS}
    fixed_total = sum(costs.values())

    open_days = int(open_days_per_month or saved.get("open_days_per_month") or DEFAULT_OPEN_DAYS)
    open_days = max(1, min(open_days, 31))
    target_profit = max(0, int(target_profit or 0))

    estimate = estimate_variable_ratio(store_id, days=days)

    # 변동비율 결정 — 인자 > 저장된 직접 입력 > 자동 추정
    if variable_cost_ratio is not None:
        ratio, ratio_source = float(variable_cost_ratio), "manual"
    elif saved.get("custom_variable_ratio") is not None:
        ratio, ratio_source = float(saved["custom_variable_ratio"]), "saved"
    elif estimate["material_available"]:
        ratio, ratio_source = float(estimate["ratio"]), "auto"
    else:
        ratio, ratio_source = None, "unavailable"

    result: dict[str, Any] = {
        "fixed_costs": costs,
        "fixed_cost_labels": FIXED_COST_LABELS,
        "fixed_cost_total": fixed_total,
        "open_days_per_month": open_days,
        "target_profit": target_profit,
        "variable_cost_ratio": ratio,
        "variable_cost_source": ratio_source,
        "variable_breakdown": estimate["parts"],
        "avg_ticket": estimate["avg_ticket"],
        "current_monthly_revenue": estimate["monthly_revenue"],
        "computed": False,
        "needs": [],
    }

    # ── 계산할 수 없는 경우를 먼저 걸러 낸다. 반쪽짜리 숫자를 보여 주느니
    #    무엇을 더 입력해야 하는지 알려 주는 편이 낫다. ──
    if fixed_total <= 0:
        result["needs"].append("fixed_costs")
    if ratio is None:
        result["needs"].append("variable_cost_ratio")
    if result["needs"]:
        result["message"] = _needs_message(result["needs"], estimate)
        return result

    if ratio >= 100:
        result["message"] = (
            f"변동비율이 {ratio}%라 한 잔 팔 때마다 손해가 납니다. "
            "지금 구조로는 아무리 팔아도 본전을 넘길 수 없어요 — 재료 단가나 판매가를 먼저 손봐야 합니다."
        )
        result["impossible"] = True
        return result
    if ratio > _MAX_SANE_VARIABLE_RATIO:
        result["warning"] = (
            f"변동비율 {ratio}%는 카페 평균(30~40%)보다 훨씬 높습니다. "
            "재료 단가나 레시피 소요량이 잘못 입력되지 않았는지 확인해 주세요."
        )

    cm_ratio = round(100 - ratio, 2)                       # 공헌이익률 (%)
    breakeven_revenue = round(fixed_total / (cm_ratio / 100))
    target_revenue = round((fixed_total + target_profit) / (cm_ratio / 100)) if target_profit else breakeven_revenue

    result.update({
        "computed": True,
        "contribution_margin_ratio": cm_ratio,
        # 매출 1원당 남는 돈 — "커피 한 잔 5,000원 팔면 3,200원이 고정비 갚는 데 쓰인다"
        "breakeven_revenue": breakeven_revenue,
        "breakeven_daily_revenue": round(breakeven_revenue / open_days),
        "target_revenue": target_revenue,
        "target_daily_revenue": round(target_revenue / open_days),
    })

    avg_ticket = estimate["avg_ticket"]
    if avg_ticket and avg_ticket > 0:
        result["breakeven_cups"] = round(breakeven_revenue / avg_ticket)
        result["breakeven_daily_cups"] = round(breakeven_revenue / avg_ticket / open_days)
        if target_profit:
            result["target_daily_cups"] = round(target_revenue / avg_ticket / open_days)

    # ── 지금 어디쯤 와 있나 ──
    current = estimate["monthly_revenue"]
    if current:
        result["achievement_pct"] = round(current / breakeven_revenue * 100, 1)
        result["gap_to_breakeven"] = breakeven_revenue - current
        # 안전한계율 — 매출이 몇 % 줄어들 때까지 버틸 수 있나 (본전 위일 때만 의미가 있다)
        result["margin_of_safety_pct"] = (
            round((current - breakeven_revenue) / current * 100, 1) if current > breakeven_revenue else None
        )
        result["estimated_profit"] = round(current * cm_ratio / 100) - fixed_total

    result["message"] = _summary_message(result)
    return result


def _needs_message(needs: list[str], estimate: dict[str, Any]) -> str:
    if "fixed_costs" in needs and "variable_cost_ratio" in needs:
        return ("고정비와 변동비율이 모두 필요해요. 매달 나가는 임대료·인건비·공과금을 적고, "
                "메뉴 레시피를 등록하시면 재료비율은 실제 판매에서 자동으로 잡힙니다.")
    if "fixed_costs" in needs:
        return "한 잔도 안 팔아도 매달 나가는 돈(임대료·인건비·공과금)을 적어 주세요."
    if not estimate["material_available"] and estimate["covered_menus"] == 0:
        return ("메뉴 레시피가 등록되어 있지 않아 재료비를 알 수 없어요. "
                "레시피를 넣으시면 자동으로 계산되고, 급하면 변동비율(%)을 직접 적으셔도 됩니다.")
    return ("레시피가 걸린 메뉴의 매출 비중이 낮아 재료비율을 믿기 어려워요. "
            "나머지 메뉴 레시피를 채우시거나 변동비율(%)을 직접 적어 주세요.")


def _summary_message(r: dict[str, Any]) -> str:
    won = f"{r['breakeven_revenue']:,}원"
    daily = f"{r['breakeven_daily_revenue']:,}원"
    head = f"한 달에 {won}(하루 {daily})을 팔아야 본전입니다."
    if r.get("breakeven_daily_cups"):
        head += f" 객단가 {r['avg_ticket']:,}원 기준 하루 약 {r['breakeven_daily_cups']}잔이에요."

    current = r.get("current_monthly_revenue")
    if not current:
        return head + " 판매가 쌓이면 지금 얼마나 왔는지도 함께 알려 드릴게요."

    gap = r.get("gap_to_breakeven") or 0
    if gap > 0:
        return (f"{head} 최근 실적은 월 {current:,}원이라 {gap:,}원 모자랍니다 "
                f"(달성률 {r['achievement_pct']}%).")
    mos = r.get("margin_of_safety_pct")
    tail = f" 매출이 {mos}% 줄어도 적자로 넘어가지 않아요." if mos else ""
    return (f"{head} 최근 실적은 월 {current:,}원으로 본전을 넘겼고, "
            f"이대로면 월 {r.get('estimated_profit', 0):,}원이 남습니다.{tail}")
