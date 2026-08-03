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
    monkeypatch.setattr(fs, "_fetch_events_naver", lambda *a: [
        # 띄어쓰기만 다른 같은 행사 — 공백 무시 키로 중복 제거되어야 한다
        {"name": "겹치는축제", "date": "2026-08-01", "boost_pct": 5,
         "distance_km": 0.5, "place": "", "source": "네이버 검색",
         "lat": 37.57, "lon": 126.98},
        {"name": "골목 플리마켓", "date": "2026-08-01", "boost_pct": 5,
         "distance_km": 0.8, "place": "골목시장", "source": "네이버 검색",
         "lat": 37.57, "lon": 126.97},
    ])
    try:
        events = fs._fetch_nearby_events(37.5665, 126.9780, date(2026, 8, 1), 7)
    finally:
        fs._event_cache.clear()  # 몽키패치로 만든 결과가 6시간 캐시에 남지 않게
    names = [e["name"] for e in events]
    assert names.count("겹치는 축제") == 1        # (제목, 날짜) 중복 제거
    assert "겹치는축제" not in names               # 공백만 다른 중복도 제거
    assert "서울만 아는 공연" in names             # 서울 고유 행사는 유지
    assert "골목 플리마켓" in names                # 검색으로만 잡히는 행사는 추가


def test_nearby_events_survives_dead_source(monkeypatch):
    """한 소스가 예외를 던져도 나머지 소스 결과로 예측이 계속돼야 한다."""
    fs._event_cache.clear()

    def _boom(*a):
        raise RuntimeError("API down")

    monkeypatch.setattr(fs, "_fetch_events_tourapi", _boom)
    monkeypatch.setattr(fs, "_fetch_events_seoul", _boom)
    monkeypatch.setattr(fs, "_fetch_events_naver", lambda *a: [
        {"name": "살아남은 축제", "date": "2026-08-01", "boost_pct": 5,
         "distance_km": 0.3, "place": "광장", "source": "네이버 검색",
         "lat": 37.57, "lon": 126.98},
    ])
    try:
        events = fs._fetch_nearby_events(37.5665, 126.9780, date(2026, 8, 1), 7)
    finally:
        fs._event_cache.clear()
    assert [e["name"] for e in events] == ["살아남은 축제"]


# ---------------------------------------------------------------------------
# 3) 전국 행사 (네이버 검색 + Gemini 정리) — 키 발급 없이 도는 기본 소스
# ---------------------------------------------------------------------------

def _patch_naver_source(monkeypatch, extracted):
    """역지오코딩·네이버 검색·Gemini·지오코딩을 전부 가짜로 바꾼다 (외부 호출 없음)."""
    from app.services.ai import nearby_cafe_service as ncs

    monkeypatch.setattr(fs, "_reverse_geocode", lambda lat, lon: "서울특별시 중구 소공동")
    monkeypatch.setattr(ncs, "_search_naver", lambda *a, **kw: [
        {"title": "중구 <b>여름축제</b> 8월 1일 개막", "description": "시청 앞 광장에서 이틀간",
         "pubDate": "Fri, 24 Jul 2026 09:00:00 +0900"},
    ])
    monkeypatch.setattr(ncs, "_gemini_json", lambda *a, **kw: {"events": extracted})
    # 장소명 → 좌표: '시청'만 매장 근처, 나머지는 부산(반경 밖)
    monkeypatch.setattr(fs, "geocode", lambda q: (
        {"lat": 37.5700, "lon": 126.9800, "address": q, "name": q, "source": "test"}
        if "시청" in q else {"lat": 35.1531, "lon": 129.1187, "address": q,
                             "name": q, "source": "test"}
    ))


def test_naver_events_filters_by_radius_and_window(monkeypatch):
    _patch_naver_source(monkeypatch, [
        {"name": "시청앞 여름축제", "start_date": "2026-08-01", "end_date": "2026-08-02",
         "place": "서울시청 광장"},
        {"name": "부산 불꽃축제", "start_date": "2026-08-01", "end_date": "2026-08-01",
         "place": "광안리해수욕장"},                                   # 반경 밖
        {"name": "지난달 행사", "start_date": "2026-07-01", "end_date": "2026-07-03",
         "place": "서울시청 광장"},                                    # 예측 기간 밖
        {"name": "날짜 없는 행사", "start_date": "미정", "end_date": "미정",
         "place": "서울시청 광장"},                                    # 날짜 파싱 불가
        {"name": "상설 미디어아트 전시", "start_date": "2026-06-01", "end_date": "2026-12-31",
         "place": "서울시청 광장"},                                    # 한 달 초과 = 상설
        {"name": "장소가 구청뿐인 행사", "start_date": "2026-08-01", "end_date": "2026-08-01",
         "place": "서울특별시 중구"},                                  # 행정구역명뿐
    ])
    events = fs._fetch_events_naver(37.5665, 126.9780, date(2026, 8, 1), 7)

    assert {e["name"] for e in events} == {"시청앞 여름축제"}
    assert sorted(e["date"] for e in events) == ["2026-08-01", "2026-08-02"]
    assert all(e["source"] == "네이버 검색" for e in events)
    # 검색 기반이라 공공 API보다 보수적으로 부스팅한다
    assert all(e["boost_pct"] == fs.SEARCH_EVENT_BOOST < fs.AUTO_EVENT_BOOST for e in events)


def test_naver_events_skipped_without_region(monkeypatch):
    """역지오코딩이 실패하면(좌표 문자열) 검색 키워드를 못 만드니 조용히 건너뛴다."""
    monkeypatch.setattr(fs, "_reverse_geocode", lambda lat, lon: "위도 37.5665, 경도 126.9780")
    assert fs._fetch_events_naver(37.5665, 126.9780, date(2026, 8, 1), 7) == []
