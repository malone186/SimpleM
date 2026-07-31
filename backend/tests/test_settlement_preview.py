"""카드 정산 설정 미리보기·구간 추천 단위 테스트 (백엔드 B)

DB 없이 확인할 수 있는 계산 부분만 본다. 사장님 화면에 그대로 뜨는 숫자라
'주말·공휴일을 건너뛰었는지'와 '수수료가 요율대로 떨어지는지'가 핵심이다.
"""

from datetime import date

import pytest

from app.services.ai import settlement_service as svc


@pytest.fixture
def fixed_settings(monkeypatch):
    """DB 대신 고정 설정을 쓰게 만든다 — 영세 구간(신용 0.4% / 체크 0.15%)."""
    settings = {
        "configured": True,
        "revenue_tier": "small",
        "tier_label": "영세 (연매출 3억 이하)",
        "credit_fee_pct": 0.4,
        "check_fee_pct": 0.15,
        "issuers": [
            {**i, "selectable": i.get("selectable", True), "lag": i["default_lag"],
             "customized": False}
            for i in svc.CARD_ISSUERS
        ],
        "tiers": svc.REVENUE_TIERS,
    }
    monkeypatch.setattr(svc, "get_settings", lambda store_id: settings)
    # 2026-08-15(광복절)만 있는 공휴일표로 고정 — 실제 연도 표에 흔들리지 않게
    monkeypatch.setattr(svc, "_holidays", lambda: {"2026-08-15": "광복절"})
    return settings


def test_preview_skips_weekend(fixed_settings):
    """금요일(2026-07-31) 결제 → 토·일을 건너뛰고 D+2 영업일은 화요일(8/4)."""
    r = svc.preview("store", amount=100_000, card_type="credit",
                    issuer="shinhan", sale_date="2026-07-31")

    assert r["deposit_date"] == "2026-08-04"
    assert r["deposit_weekday"] == "화"
    assert r["calendar_days"] == 4
    assert [k["reason"] for k in r["skipped"]] == ["토요일", "일요일"]


def test_preview_skips_public_holiday(fixed_settings):
    """8/14(금) 결제 → 광복절(토 8/15)과 일요일을 건너뛰어 8/18(화)."""
    r = svc.preview("store", amount=50_000, card_type="credit",
                    issuer="shinhan", sale_date="2026-08-14")

    assert r["deposit_date"] == "2026-08-18"
    assert "광복절" in [k["reason"] for k in r["skipped"]]


def test_preview_fee_follows_card_type(fixed_settings):
    """체크카드는 신용보다 낮은 요율이 적용되고, 실입금 = 결제액 − 수수료."""
    credit = svc.preview("store", amount=100_000, card_type="credit",
                         issuer="kb", sale_date="2026-07-31")
    check = svc.preview("store", amount=100_000, card_type="check",
                        issuer="kb", sale_date="2026-07-31")

    assert credit["fee"] == 400 and credit["net"] == 99_600
    assert check["fee"] == 150 and check["net"] == 99_850


def test_preview_unknown_issuer_falls_back(fixed_settings):
    """없는 카드사 코드가 와도 터지지 않고 기본 카드사로 계산한다."""
    r = svc.preview("store", amount=10_000, issuer="없는카드", sale_date="2026-07-31")
    assert r["issuer"] in {i["code"] for i in svc.CARD_ISSUERS}


def test_preview_rejects_bad_date(fixed_settings):
    with pytest.raises(svc.SettlementError):
        svc.preview("store", amount=10_000, sale_date="2026-13-99")


def test_add_business_days_lands_on_business_day(monkeypatch):
    monkeypatch.setattr(svc, "_holidays", lambda: {"2026-08-15": "광복절"})
    # 토요일에 days=0이면 그날이 아니라 다음 영업일(월)로 밀린다
    assert svc.add_business_days(date(2026, 8, 1), 0) == date(2026, 8, 3)
    assert svc.is_business_day(date(2026, 8, 15)) is False
