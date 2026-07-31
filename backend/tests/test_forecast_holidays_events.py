# -*- coding: utf-8 -*-
"""판매 예측 보정 데이터 테스트 (백엔드 B) — 공휴일 자동 계산 · 전국 행사 수집

공휴일이 2026 하드코딩이던 시절엔 해가 바뀌면 조용히 보정이 사라졌다.
여기서는 라이브러리가 임의 연도(음력·대체공휴일 포함)를 계산하는지와,
전국 행사(TourAPI)가 반경·기간 필터를 지키고 서울 소스와 중복 없이 합쳐지는지를 본다.
"""
from datetime import date

from app.services.ai import forecast_service as fs


# ---------------------------------------------------------------------------
# 1) 공휴일 — 연도 무관 자동 계산
# ---------------------------------------------------------------------------

def test_kr_holidays_multi_year():
    h26 = fs.kr_holidays(2026)
    assert h26["2026-02-17"].strip() != ""          # 설날 (음력)
    assert "2026-05-25" in h26                       # 부처님오신날 대체공휴일
    # 하드코딩이 없는 미래 연도도 자동 계산된다 — 매년 갱신 불필요
    h27 = fs.kr_holidays(2027)
    assert "2027-01-01" in h27 and any(k.startswith("2027-02") for k in h27)  # 신정 + 설 연휴


def test_holiday_name_lookup():
    assert fs.holiday_name("2026-12-25") is not None
    assert fs.holiday_name("2026-07-31") is None
    assert fs.holiday_name("not-a-date") is None


def test_settlement_business_days_cross_year():
    """카드 입금 영업일 계산이 올해·내년 공휴일을 함께 본다 (연말 입금이 내년으로 넘어가는 경우)."""
    from app.services.ai import settlement_service as ss

    holidays = ss._holidays()
    this_year, next_year = date.today().year, date.today().year + 1
    assert any(k.startswith(str(this_year)) for k in holidays)
    assert any(k.startswith(str(next_year)) for k in holidays)
    assert ss.is_business_day(date(next_year, 1, 1)) is False  # 신정


# ---------------------------------------------------------------------------
# 2) 전국 행사 (TourAPI) — 반경·기간 필터, 서울 소스와 병합 시 중복 제거
# ---------------------------------------------------------------------------

def _tourapi_payload():
    # 매장(서울시청 37.5665, 126.9780) 기준: 1km 안 행사 1건 + 부산(반경 밖) 1건
    return {"response": {"body": {"items": {"item": [
        {"title": "시청앞 여름축제", "addr1": "서울 중구",
         "mapy": "37.5700", "mapx": "126.9800",
         "eventstartdate": "20260801", "eventenddate": "20260802"},
        {"title": "부산 불꽃축제", "addr1": "부산 수영구",
         "mapy": "35.1531", "mapx": "129.1187",
         "eventstartdate": "20260801", "eventenddate": "20260801"},
    ]}}}}


class _FakeResp:
    status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return _tourapi_payload()


def test_tourapi_radius_and_date_expansion(monkeypatch):
    monkeypatch.setenv("TOUR_API_KEY", "test-key")
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **kw: _FakeResp())

    events = fs._fetch_events_tourapi(37.5665, 126.9780, date(2026, 8, 1), 7)
    # 부산은 반경 3km 밖이라 빠지고, 서울 행사만 이틀치(8/1·8/2)로 펼쳐진다
    assert {e["name"] for e in events} == {"시청앞 여름축제"}
    assert sorted(e["date"] for e in events) == ["2026-08-01", "2026-08-02"]
    assert all(e["source"] == "한국관광공사 TourAPI" for e in events)


def test_tourapi_skipped_without_key(monkeypatch):
    monkeypatch.delenv("TOUR_API_KEY", raising=False)
    assert fs._fetch_events_tourapi(37.5665, 126.9780, date(2026, 8, 1), 7) == []


def test_nearby_events_merges_and_dedupes(monkeypatch):
    fs._event_cache.clear()
    monkeypatch.setattr(fs, "_fetch_events_tourapi", lambda *a: [
        {"name": "겹치는 축제", "date": "2026-08-01", "boost_pct": 10,
         "distance_km": 0.5, "place": "", "source": "한국관광공사 TourAPI",
         "lat": 37.57, "lon": 126.98},
    ])
    monkeypatch.setattr(fs, "_fetch_events_seoul", lambda *a: [
        {"name": "겹치는 축제", "date": "2026-08-01", "boost_pct": 10,
         "distance_km": 0.5, "place": "", "source": "서울 열린데이터광장",
         "lat": 37.57, "lon": 126.98},
        {"name": "서울만 아는 공연", "date": "2026-08-01", "boost_pct": 10,
         "distance_km": 1.2, "place": "", "source": "서울 열린데이터광장",
         "lat": 37.56, "lon": 126.97},
    ])
    try:
        events = fs._fetch_nearby_events(37.5665, 126.9780, date(2026, 8, 1), 7)
    finally:
        fs._event_cache.clear()  # 몽키패치로 만든 결과가 6시간 캐시에 남지 않게
    names = [e["name"] for e in events]
    assert names.count("겹치는 축제") == 1        # (제목, 날짜) 중복 제거
    assert "서울만 아는 공연" in names             # 서울 고유 행사는 유지
