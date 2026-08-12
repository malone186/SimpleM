"""손익분기점 계산 테스트 (백엔드 B)

여기서 지키려는 건 세 가지다.
  1) CVP 공식이 맞는가 — 고정비 ÷ 공헌이익률. 소수점 반올림으로 조용히 어긋나면
     사장님은 "본전이라는데 왜 적자지?"를 겪는다.
  2) 계산할 수 없을 때 0이나 무한대를 뱉지 않고 '무엇이 없는지' 말하는가.
     반쪽짜리 숫자를 보여 주면 그걸 믿고 가격을 정한다.
  3) 변동비율이 100%를 넘는(팔수록 손해) 구조에서 음수 매출을 만들지 않는가.
"""
import pytest

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import engine
from app.models.ai import FixedCostSetting
from app.services.ai import breakeven_service as bes

# 운영에서는 app.main이 기동할 때 create_all로 만든다(ai 도메인 테이블은 전부 같은 방식).
# 테스트는 app.main을 부르지 않으므로 이 테이블만 직접 만들어 둔다.
FixedCostSetting.__table__.create(bind=engine, checkfirst=True)

STORE = "breakeven-test@test.com"

FIXED = {"rent": 2_000_000, "labor": 3_000_000, "utilities": 500_000, "other": 500_000}
FIXED_TOTAL = 6_000_000


@pytest.fixture(autouse=True)
def _clean():
    """이 테스트가 만든 고정비 행만 지운다 — 실제 매장 설정은 건드리지 않는다."""
    from app.models.ai import FixedCostSetting

    def _wipe():
        with bes._session() as db:
            db.query(FixedCostSetting).filter(FixedCostSetting.store_id == STORE).delete()
            db.commit()
        # 서비스를 거치지 않고 행을 직접 지웠으니 캐시도 손으로 버려야 한다.
        # (앱은 save_fixed_costs·clear_custom_variable_ratio가 알아서 버린다)
        bes.drop_ratio_cache(STORE)

    _wipe()
    yield
    _wipe()


def test_breakeven_follows_cvp_formula():
    """고정비 600만 · 변동비율 40% → 공헌이익률 60% → 본전 매출 1,000만원."""
    r = bes.compute_breakeven(STORE, fixed_costs=FIXED, variable_cost_ratio=40)

    assert r["computed"] is True
    assert r["fixed_cost_total"] == FIXED_TOTAL
    assert r["contribution_margin_ratio"] == 60
    assert r["breakeven_revenue"] == 10_000_000
    # 하루 목표 = 월 목표 ÷ 영업일수 (기본 26일)
    assert r["open_days_per_month"] == bes.DEFAULT_OPEN_DAYS
    assert r["breakeven_daily_revenue"] == round(10_000_000 / bes.DEFAULT_OPEN_DAYS)


def test_target_profit_raises_required_revenue():
    """월 300만원을 남기려면 (고정비+목표이익) ÷ 공헌이익률만큼 팔아야 한다."""
    r = bes.compute_breakeven(
        STORE, fixed_costs=FIXED, variable_cost_ratio=40, target_profit=3_000_000
    )

    assert r["breakeven_revenue"] == 10_000_000          # 본전은 그대로
    assert r["target_revenue"] == 15_000_000             # 900만 ÷ 0.6
    assert r["target_revenue"] > r["breakeven_revenue"]


def test_open_days_changes_only_daily_target():
    """영업일수는 월 목표를 바꾸지 않고 하루치 나눗셈만 바꾼다."""
    monthly = bes.compute_breakeven(STORE, fixed_costs=FIXED, variable_cost_ratio=40)
    fewer = bes.compute_breakeven(
        STORE, fixed_costs=FIXED, variable_cost_ratio=40, open_days_per_month=20
    )

    assert fewer["breakeven_revenue"] == monthly["breakeven_revenue"]
    assert fewer["breakeven_daily_revenue"] == round(10_000_000 / 20)
    assert fewer["breakeven_daily_revenue"] > monthly["breakeven_daily_revenue"]


def test_missing_fixed_costs_asks_instead_of_zero():
    """고정비가 0이면 '본전 0원'이 아니라 무엇이 필요한지 돌려준다."""
    r = bes.compute_breakeven(STORE, fixed_costs={}, variable_cost_ratio=40)

    assert r["computed"] is False
    assert "fixed_costs" in r["needs"]
    assert "breakeven_revenue" not in r
    assert r["message"]


def test_missing_variable_ratio_asks_instead_of_guessing():
    """레시피도 없고 직접 입력도 없으면 임의의 기본값을 끼워 넣지 않는다."""
    r = bes.compute_breakeven(STORE, fixed_costs=FIXED)

    # 판매 이력이 없는 신규 매장이므로 자동 추정이 불가능하다
    assert r["computed"] is False
    assert "variable_cost_ratio" in r["needs"]
    assert r["variable_cost_source"] == "unavailable"


def test_variable_ratio_over_100_is_impossible_not_negative():
    """변동비율 110% — 아무리 팔아도 본전이 안 된다. 음수 매출을 만들면 안 된다."""
    r = bes.compute_breakeven(STORE, fixed_costs=FIXED, variable_cost_ratio=110)

    assert r["computed"] is False
    assert r.get("impossible") is True
    assert "breakeven_revenue" not in r
    assert "손해" in r["message"]


def test_saved_fixed_costs_are_used_when_none_passed():
    """저장해 두면 그 다음부터는 인자 없이 물어도 같은 답이 나온다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40)

    saved = bes.get_fixed_costs(STORE)
    assert saved["configured"] is True
    assert saved["total"] == FIXED_TOTAL

    r = bes.compute_breakeven(STORE)
    assert r["computed"] is True
    assert r["variable_cost_source"] == "saved"
    assert r["breakeven_revenue"] == 10_000_000


def test_partial_save_keeps_other_fields():
    """임대료만 고쳐도 나머지 항목이 0으로 사라지지 않는다."""
    bes.save_fixed_costs(STORE, **FIXED)
    bes.save_fixed_costs(STORE, rent=2_500_000)

    saved = bes.get_fixed_costs(STORE)
    assert saved["rent"] == 2_500_000
    assert saved["labor"] == FIXED["labor"]
    assert saved["total"] == FIXED_TOTAL + 500_000


def test_clearing_custom_ratio_returns_to_auto():
    """직접 적은 변동비율을 지우면 자동 계산 경로로 돌아간다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40)
    assert bes.compute_breakeven(STORE)["variable_cost_source"] == "saved"

    bes.clear_custom_variable_ratio(STORE)
    assert bes.get_fixed_costs(STORE)["custom_variable_ratio"] is None
    # 판매 이력이 없는 매장이라 자동도 불가 → 무엇이 필요한지 알려 준다
    assert bes.compute_breakeven(STORE)["variable_cost_source"] == "unavailable"


@pytest.mark.parametrize("bad", [-1, 100, 150])
def test_save_rejects_out_of_range_ratio(bad):
    with pytest.raises(bes.BreakevenError):
        bes.save_fixed_costs(STORE, custom_variable_ratio=bad)


def test_save_rejects_negative_cost():
    with pytest.raises(bes.BreakevenError):
        bes.save_fixed_costs(STORE, rent=-1000)


# ---------------------------------------------------------------------------
# 리포트 — 기간에 맞춘 목표
# ---------------------------------------------------------------------------

def test_period_target_scales_to_the_period():
    """월 개념인 손익분기점을 일간 리포트에 그대로 실으면 하루에 그만큼 팔라는 말이 된다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)

    daily = bes.period_target(STORE, "daily")
    weekly = bes.period_target(STORE, "weekly")
    monthly = bes.period_target(STORE, "monthly")

    assert monthly["target_revenue"] == 10_000_000
    assert daily["target_revenue"] == round(10_000_000 / 25)
    # 한 달 25일 영업이면 한 주는 약 6일
    assert weekly["open_days"] == round(25 / 4.345)
    assert weekly["target_revenue"] == daily["target_revenue"] * weekly["open_days"]
    assert daily["target_revenue"] < weekly["target_revenue"] < monthly["target_revenue"]


def test_period_target_reports_gap_and_achievement():
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)

    behind = bes.period_target(STORE, "monthly", actual_sales=6_000_000)
    assert behind["achieved_pct"] == 60.0
    assert behind["gap"] == 4_000_000
    assert "남았" in behind["message"]

    ahead = bes.period_target(STORE, "monthly", actual_sales=12_000_000)
    assert ahead["gap"] == -2_000_000        # 음수 = 초과 달성
    assert "넘겼" in ahead["message"]
    assert "-" not in ahead["message"]       # 음수 부호가 문구로 새면 안 된다


def test_period_target_says_what_is_missing_instead_of_zero():
    """고정비가 없으면 '목표 0원'이 아니라 무엇을 넣어야 하는지 돌려준다."""
    r = bes.period_target(STORE, "weekly", actual_sales=1_000_000)
    assert r["computed"] is False
    assert "fixed_costs" in r["needs"]
    assert "target_revenue" not in r


# ---------------------------------------------------------------------------
# 할 일 — '달성 가능한' 미션
# ---------------------------------------------------------------------------

def test_mission_asks_for_setup_when_nothing_entered():
    m = bes.daily_mission(STORE)
    assert m["mode"] == "setup"
    assert "설정" in m["title"]


def test_mission_keeps_goal_when_already_reachable(monkeypatch):
    """요즘 실적이 목표를 넘고 있으면 '유지'가 미션이다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)
    target = round(10_000_000 / 25)   # 하루 40만원

    # 객단가 5,000원에 하루 100잔 = 50만원 → 목표를 이미 넘는다
    monkeypatch.setattr(bes, "_recent_daily_cups", lambda _sid: 100.0)
    monkeypatch.setattr(bes, "compute_breakeven", _with_ticket(5_000))

    m = bes.daily_mission(STORE)
    assert m["mode"] == "keep"
    assert f"{target:,}" in m["title"]


def test_mission_gives_full_goal_when_gap_is_small(monkeypatch):
    """조금만 더 하면 닿는 거리면 목표를 그대로 준다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)

    # 하루 목표 40만원, 요즘 36만원(-10%) → 닿을 만하다
    monkeypatch.setattr(bes, "_recent_daily_cups", lambda _sid: 72.0)
    monkeypatch.setattr(bes, "compute_breakeven", _with_ticket(5_000))

    m = bes.daily_mission(STORE)
    assert m["mode"] == "target"
    assert "만 더" in m["subtitle"]


def test_mission_steps_down_when_goal_is_far(monkeypatch):
    """하루 15만원 파는 매장에 '40만원 파세요'는 미션이 아니라 통보다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)

    # 요즘 하루 15만원 — 목표의 37%뿐이라 한 걸음짜리로 바뀌어야 한다
    monkeypatch.setattr(bes, "_recent_daily_cups", lambda _sid: 30.0)
    monkeypatch.setattr(bes, "compute_breakeven", _with_ticket(5_000))

    m = bes.daily_mission(STORE)
    assert m["mode"] == "step"
    # 한 걸음 목표는 요즘(15만)보다 크고 본전(40만)보다 작아야 한다
    step = int(m["title"].replace(",", "").split("원")[0].split()[-1])
    assert 150_000 < step < 400_000
    # 최종 목표는 사라지지 않고 보조줄에 남는다
    assert "400,000" in m["subtitle"]


def test_mission_shows_target_only_when_history_unknown(monkeypatch):
    """실적을 모르면 '조금만 더'라고 말할 근거가 없다 — 목표만 알려 준다."""
    bes.save_fixed_costs(STORE, **FIXED, custom_variable_ratio=40, open_days_per_month=25)
    monkeypatch.setattr(bes, "_recent_daily_cups", lambda _sid: None)

    m = bes.daily_mission(STORE)
    assert m["mode"] == "target"
    assert "본전" in m["title"]


def _with_ticket(price: int):
    """compute_breakeven 결과에 객단가만 끼워 넣는 대역 — 판매 이력 없이 잔 수 환산을 시험한다."""
    real = bes.compute_breakeven

    def patched(store_id, **kwargs):
        out = real(store_id, **kwargs)
        out["avg_ticket"] = price
        return out

    return patched


# ---------------------------------------------------------------------------
# HTTP 계약 — 계산이 맞아도 화면이 못 읽으면 소용이 없다
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    """require_owner만 테스트 매장으로 바꿔 끼운다 — 라우팅·직렬화가 검증 대상이다."""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from app.core.auth import require_owner
    from app.main import app

    app.dependency_overrides[require_owner] = lambda: SimpleNamespace(email=STORE)
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_owner, None)


def test_http_put_then_get_roundtrip(client):
    r = client.put("/api/v1/breakeven/fixed-costs",
                   json={**FIXED, "custom_variable_ratio": 40, "open_days_per_month": 25})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fixed_costs"]["total"] == FIXED_TOTAL
    assert body["breakeven"]["breakeven_revenue"] == 10_000_000
    assert body["breakeven"]["breakeven_daily_revenue"] == round(10_000_000 / 25)

    got = client.get("/api/v1/breakeven")
    assert got.status_code == 200
    assert got.json()["breakeven_revenue"] == 10_000_000


def test_http_simulate_keeps_unsent_costs(client):
    """임대료만 바꿔 보내도 인건비·공과금이 0으로 사라지지 않아야 한다."""
    client.put("/api/v1/breakeven/fixed-costs", json={**FIXED, "custom_variable_ratio": 40})

    r = client.post("/api/v1/breakeven/simulate", json={"rent": 3_000_000})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fixed_costs"]["labor"] == FIXED["labor"]
    assert body["fixed_cost_total"] == FIXED_TOTAL + 1_000_000
    # 저장은 그대로 — 시뮬레이션이 원본을 건드리면 안 된다
    assert client.get("/api/v1/breakeven/fixed-costs").json()["rent"] == FIXED["rent"]


def test_http_simulate_target_profit(client):
    client.put("/api/v1/breakeven/fixed-costs", json={**FIXED, "custom_variable_ratio": 40})

    r = client.post("/api/v1/breakeven/simulate", json={"target_profit": 3_000_000})
    assert r.status_code == 200, r.text
    assert r.json()["target_revenue"] == 15_000_000


def test_http_rejects_bad_ratio(client):
    r = client.put("/api/v1/breakeven/fixed-costs", json={"custom_variable_ratio": 150})
    assert r.status_code == 422  # pydantic이 먼저 막는다 (lt=100)
