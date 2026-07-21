"""AI 판매량 예측 (백엔드 B) — AI-3

워크플로우:
  GPS(매장 위치) → 지역 날씨(Open-Meteo, 키 불필요) + 요일·공휴일 + 주변 행사(수동 입력/부스팅)
  + POS 판매 데이터(Sale) → 시계열 모델로 기본 예측 → 날씨·행사 보정
  → 익일·금주 예상 판매량 → 레시피 기반 재료 소요량 → 발주 추천

모델: SARIMAX(1,0,1)×(1,0,1,7) — 주 7일 계절성 시계열. statsmodels가 없거나 수렴 실패 시
      요일별 평균(최근 가중) × 추세 폴백. 둘 다 '단순 예측 + 이벤트 부스팅' 원칙을 따른다.

전제: 최소 MIN_HISTORY_DAYS일치 판매 데이터가 있어야 예측을 제공한다 (미달 시 안내).
행사 데이터: 서울 열린데이터광장 문화행사 API에서 매장 반경 내 행사를 자동 수집한다
  (샘플 키로도 동작, .env에 SEOUL_OPENAPI_KEY를 넣으면 수집량이 늘어난다 — 무료 즉시 발급).
  서울 외 지역이나 API가 놓친 행사는 events 파라미터로 직접 넣으면 부스팅(기본 +20%)한다.
"""

import logging
import math
import os
import time
from datetime import date, timedelta
from typing import Any, Optional

logger = logging.getLogger(__name__)

MIN_HISTORY_DAYS = 14        # 이 일수 미만의 판매 기록이면 예측을 제공하지 않는다
MENU_MIX_WINDOW_DAYS = 14    # 메뉴별 판매 비중(발주 소요량 계산)에 쓰는 최근 기간
DEFAULT_EVENT_BOOST = 20     # 수동 입력 행사 부스팅 기본값 (%)
AUTO_EVENT_BOOST = 10        # 자동 수집 행사 1건당 부스팅 (%) — 소규모 공연이 많아 보수적으로
MAX_EVENT_FACTOR = 1.3       # 행사가 겹쳐도 하루 최대 +30%까지만
EVENT_RADIUS_KM = 3.0        # 매장 반경 몇 km까지를 '주변 행사'로 볼지
DEFAULT_LAT, DEFAULT_LON = 37.5665, 126.9780  # 위치 미제공 시 서울시청 기준

_event_cache: dict[str, tuple[float, list[dict]]] = {}  # 행사 조회 캐시 (6시간)
_EVENT_CACHE_TTL = 6 * 3600
_naver_local_auth_failed = [False]  # 네이버 지역 검색 키 인증 실패 시 True — 매 검색마다 401 재시도 방지
_ncp_geocode_auth_failed = [False]  # NCP 지오코딩 미구독/인증 실패 시 True — 재시도 방지

# 2026년 대한민국 공휴일 (하드코딩 — 매년 갱신 필요, 대체공휴일 포함)
KR_HOLIDAYS_2026 = {
    "2026-01-01": "신정", "2026-02-16": "설 연휴", "2026-02-17": "설날",
    "2026-02-18": "설 연휴", "2026-03-01": "삼일절", "2026-03-02": "삼일절 대체",
    "2026-05-05": "어린이날", "2026-05-24": "부처님오신날", "2026-05-25": "부처님오신날 대체",
    "2026-06-06": "현충일", "2026-08-15": "광복절", "2026-08-17": "광복절 대체",
    "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴",
    "2026-10-03": "개천절", "2026-10-05": "개천절 대체", "2026-10-09": "한글날",
    "2026-12-25": "성탄절",
}

WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]

# Open-Meteo weather_code → 한글 날씨
_WEATHER_KO = [
    ((0,), "맑음"), ((1, 2, 3), "구름"), ((45, 48), "안개"),
    (tuple(range(51, 68)), "비"), (tuple(range(71, 78)), "눈"),
    ((80, 81, 82), "소나기"), ((85, 86), "눈"), ((95, 96, 99), "뇌우"),
]


class ForecastError(ValueError):
    """예측 불가 (데이터 부족·입력 오류)"""


def _weather_label(code: int) -> str:
    for codes, label in _WEATHER_KO:
        if code in codes:
            return label
    return "흐림"


# ---------------------------------------------------------------------------
# 1) POS 판매 시계열 로드
# ---------------------------------------------------------------------------

def _load_daily_series(db, store_id: str):
    """일별 (판매 잔 수, 매출) 시계열을 만든다. 기록 없는 날은 0으로 채운다 (휴무 가정)."""
    import pandas as pd

    from app.models.inventory import Sale

    rows = (
        db.query(Sale.sold_at, Sale.quantity, Sale.total_price)
        .filter(Sale.store_id == store_id)
        .order_by(Sale.sold_at)
        .all()
    )
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["sold_at", "quantity", "total_price"])
    df["day"] = pd.to_datetime(df["sold_at"]).dt.date
    daily = df.groupby("day").agg(cups=("quantity", "sum"), revenue=("total_price", "sum"))
    daily.index = pd.to_datetime(daily.index)
    # 오늘은 하루가 끝나지 않아 미완성 집계다 — 학습에 넣으면 '판매가 급감한 날'로 오인해
    # 내일 예측을 끌어내리므로 시계열에서 제외한다 (오늘 실적은 _today_actuals가 따로 담당)
    daily = daily[daily.index.date < date.today()]
    if daily.empty:
        return None
    # 첫 판매일~마지막 판매일 사이 비는 날을 0으로 — 시계열 연속성 확보
    full = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    return daily.reindex(full, fill_value=0)


# ---------------------------------------------------------------------------
# 2) 시계열 예측 — SARIMAX 우선, 요일 계절성 폴백
# ---------------------------------------------------------------------------

def _forecast_sarimax(series, horizon: int):
    """SARIMAX(1,0,1)×(1,0,1,7) — 주간 계절성 시계열 예측. 실패하면 None."""
    try:
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        model = SARIMAX(series.astype(float), order=(1, 0, 1), seasonal_order=(1, 0, 1, 7),
                        enforce_stationarity=False, enforce_invertibility=False)
        fitted = model.fit(disp=False, maxiter=200)
        pred = fitted.forecast(steps=horizon)
        return [max(0.0, float(v)) for v in pred]
    except Exception:
        logger.warning("SARIMAX 적합 실패 — 요일 계절성 폴백 사용", exc_info=True)
        return None


def _forecast_seasonal(series, horizon: int):
    """폴백: 요일별 평균(최근 2주는 2배 가중) × 최근 추세(직전 2주 / 그 전 2주, 0.7~1.3 클립)."""
    import numpy as np

    values = series.to_numpy(dtype=float)
    weekdays = series.index.dayofweek.to_numpy()
    n = len(values)
    weights = np.ones(n)
    weights[-14:] = 2.0  # 최근 2주 가중

    wd_mean = {}
    for wd in range(7):
        mask = weekdays == wd
        wd_mean[wd] = (np.average(values[mask], weights=weights[mask])
                       if mask.any() else float(values.mean()))

    trend = 1.0
    if n >= 28:
        recent, prev = values[-14:].mean(), values[-28:-14].mean()
        if prev > 0:
            trend = float(np.clip(recent / prev, 0.7, 1.3))

    last_day = series.index[-1]
    return [max(0.0, wd_mean[(last_day + timedelta(days=i + 1)).dayofweek] * trend)
            for i in range(horizon)]


# ---------------------------------------------------------------------------
# 3) 날씨·위치 (Open-Meteo / Nominatim — 둘 다 키 불필요)
# ---------------------------------------------------------------------------

def _fetch_weather(lat: float, lon: float, days: int) -> dict[str, dict[str, Any]]:
    """일자별 날씨 예보. 실패해도 예측은 계속한다 (보정만 생략)."""
    import requests

    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lon, "timezone": "Asia/Seoul",
                    "forecast_days": min(days + 1, 16),
                    "daily": "weather_code,temperature_2m_max,precipitation_probability_max"},
            timeout=8,
        )
        r.raise_for_status()
        d = r.json()["daily"]
        return {
            d["time"][i]: {
                "condition": _weather_label(int(d["weather_code"][i])),
                "temp_max": d["temperature_2m_max"][i],
                "precip_prob": d["precipitation_probability_max"][i],
            }
            for i in range(len(d["time"]))
        }
    except Exception:
        logger.warning("날씨 조회 실패 — 날씨 보정 없이 예측", exc_info=True)
        return {}


def _reverse_geocode(lat: float, lon: float) -> str:
    """좌표 → 지역 이름 (표시용). 실패하면 좌표 문자열."""
    import requests

    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"lat": lat, "lon": lon, "format": "json", "accept-language": "ko", "zoom": 14},
            headers={"User-Agent": "SimpleM-cafe-app/1.0"},
            timeout=5,
        )
        addr = r.json().get("address", {})
        parts = [addr.get(k) for k in ("city", "borough", "suburb", "quarter") if addr.get(k)]
        return " ".join(parts[:3]) or r.json().get("display_name", "")[:40]
    except Exception:
        return f"위도 {lat:.4f}, 경도 {lon:.4f}"


def _geocode_naver_local(q: str) -> Optional[dict[str, Any]]:
    """네이버 지역 검색 API — developers.naver.com 키가 있을 때만 동작 (현재 키는 NCP용이라 스킵됨)."""
    import re

    import requests

    cid = os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec) or _naver_local_auth_failed[0]:
        return None
    try:
        r = requests.get(
            "https://openapi.naver.com/v1/search/local.json",
            params={"query": q, "display": 1},
            headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec},
            timeout=5,
        )
        if r.status_code in (401, 403):
            # 현재 키는 NCP용이라 openapi.naver.com 인증이 안 된다 — 프로세스 생존 동안 재시도하지 않음
            _naver_local_auth_failed[0] = True
            logger.info("네이버 지역 검색 인증 실패(%s) — 이후 무료 지오코더만 사용", r.status_code)
            return None
        r.raise_for_status()
        items = r.json().get("items", [])
        if items:
            it = items[0]
            lat, lon = int(it["mapy"]) / 1e7, int(it["mapx"]) / 1e7  # WGS84 × 1e7
            name = re.sub(r"<[^>]+>", "", it.get("title", ""))
            if lat and lon:
                return {
                    "lat": lat, "lon": lon,
                    "address": it.get("roadAddress") or it.get("address") or name,
                    "name": name, "source": "naver_local",
                }
    except Exception:
        logger.warning("네이버 지역 검색 지오코딩 실패", exc_info=True)
    return None


def _geocode_ncp(q: str) -> Optional[dict[str, Any]]:
    """NCP(네이버 클라우드) Geocoding API — 도로명/지번 주소 전용 (기관명 검색은 안 됨).
    NCP 콘솔에서 Maps > Geocoding 구독이 활성화된 키가 있을 때만 동작한다."""
    import requests

    cid = os.getenv("NCP_MAPS_CLIENT_ID") or os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NCP_MAPS_CLIENT_SECRET") or os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec) or _ncp_geocode_auth_failed[0]:
        return None
    try:
        r = requests.get(
            "https://maps.apigw.ntruss.com/map-geocode/v2/geocode",
            params={"query": q},
            headers={"x-ncp-apigw-api-key-id": cid, "x-ncp-apigw-api-key": csec},
            timeout=5,
        )
        if r.status_code in (401, 403):
            # 콘솔에서 Geocoding 구독을 켜지 않은 키 — 프로세스 생존 동안 재시도하지 않음
            _ncp_geocode_auth_failed[0] = True
            logger.info("NCP 지오코딩 미구독/인증 실패(%s) — 이후 무료 지오코더 사용", r.status_code)
            return None
        r.raise_for_status()
        addresses = r.json().get("addresses", [])
        if addresses:
            a = addresses[0]
            return {
                "lat": float(a["y"]), "lon": float(a["x"]),
                "address": a.get("roadAddress") or a.get("jibunAddress") or q,
                "name": "", "source": "ncp_geocode",
            }
    except Exception:
        logger.warning("NCP 지오코딩 실패 (query=%s)", q, exc_info=True)
    return None


def _geocode_nominatim(q: str) -> Optional[dict[str, Any]]:
    """Nominatim — 도로명주소·정식 지명에 강하다. 전체 문자열이 안 맞으면
    앞쪽 광역 지명을 하나씩 떼며 재시도한다 ('부산 해운대구 우동 센텀시티' → '우동 센텀시티')."""
    import requests

    tokens = q.split()
    variants = [q] + [" ".join(tokens[i:]) for i in range(1, min(len(tokens), 4))]
    for variant in variants:
        try:
            r = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": variant, "format": "json", "accept-language": "ko",
                        "countrycodes": "kr", "limit": 1, "addressdetails": 1},
                headers={"User-Agent": "SimpleM-cafe-app/1.0"},
                timeout=5,
            )
            data = r.json()
            if not data:
                continue
            hit = data[0]
            a = hit.get("address", {})
            # 한국식 주소 순서로 조립 (시/도 → 구/군 → 동/읍 → 도로명 → 번지)
            parts = [a.get("province") or a.get("state") or a.get("city"),
                     a.get("borough") or a.get("county") or a.get("city_district"),
                     a.get("suburb") or a.get("quarter") or a.get("town") or a.get("village"),
                     a.get("road"), a.get("house_number")]
            seen: list[str] = []
            for p in parts:
                if p and p not in seen:
                    seen.append(p)
            address = " ".join(seen) or hit.get("display_name", "")[:80]
            name = hit.get("name") or ""
            # 검색어가 기관/상호명일 때만 이름을 주소 끝에 붙인다 ('명동성당' → '... 명동길 명동대성당').
            # 순수 도로명주소 검색이면 그 지번의 엉뚱한 건물명이 붙는 걸 막는다.
            if name and (name in variant or variant in name):
                address = f"{address} {name}".strip()
            return {
                "lat": float(hit["lat"]), "lon": float(hit["lon"]),
                "address": address, "name": name,
                "source": "nominatim",
            }
        except Exception:
            logger.warning("Nominatim 지오코딩 실패 (query=%s)", variant, exc_info=True)
    return None


def _geocode_photon(q: str) -> Optional[dict[str, Any]]:
    """Photon(OSM) — 접두어·퍼지 매칭이 되어 '협성대'→'협성대학교'처럼 축약 명칭을 잘 찾는다.
    후보 중 이름이 검색어로 시작/일치하는 것을 우선하고, 자전거 대여소 같은 부속 시설은 피한다."""
    import requests

    try:
        r = requests.get(
            "https://photon.komoot.io/api/",
            params={"q": q, "limit": 5, "bbox": "124,33,132,39"},  # 한반도 영역으로 제한
            headers={"User-Agent": "SimpleM-cafe-app/1.0"},
            timeout=6,
        )
        feats = r.json().get("features", [])
        if not feats:
            return None

        def score(f: dict) -> tuple:
            props = f.get("properties", {})
            name = props.get("name") or ""
            exact = name == q
            prefix = name.startswith(q)
            minor = props.get("osm_value") in ("bicycle_rental", "vending_machine", "parking")
            return (exact, prefix, not minor)  # True가 앞서도록 내림차순 정렬에 사용

        best = max(feats, key=score)
        props = best.get("properties", {})
        lon_p, lat_p = best["geometry"]["coordinates"][:2]
        name = props.get("name") or ""
        region_parts: list[str] = []
        for key in ("state", "city", "county", "district"):
            v = props.get(key)
            if v and v not in region_parts:
                region_parts.append(v)
        address = " ".join(region_parts + ([name] if name else [])) or name
        return {
            "lat": float(lat_p), "lon": float(lon_p),
            "address": address, "name": name, "source": "photon",
        }
    except Exception:
        logger.warning("Photon 지오코딩 실패 (query=%s)", q, exc_info=True)
    return None


def geocode(query: str) -> Optional[dict[str, Any]]:
    """주소/상호/기관명 → 좌표 (회원가입 지도 핀 검색용).

    주소형 검색어('...로 26', '...동')는 Nominatim을, '협성대' 같은 명칭형 검색어는
    접두어 매칭이 되는 Photon을 먼저 시도한다. 네이버 지역 검색은 유효한
    developers.naver.com 키가 들어오면 자동으로 최우선 활성화된다.
    """
    q = (query or "").strip()
    if not q:
        return None

    hit = _geocode_naver_local(q)
    if hit:
        return hit

    # 숫자(번지)나 행정구역/도로명 접미어가 있으면 주소형으로 본다
    looks_like_address = any(ch.isdigit() for ch in q) or any(
        t[-1] in "시구군동읍면리로길가" for t in q.split() if t)
    # NCP Geocoding은 주소 전용이라 주소형 검색어에만 시도한다 (구독 활성화 시 자동 사용)
    engines = ([_geocode_ncp, _geocode_nominatim, _geocode_photon] if looks_like_address
               else [_geocode_photon, _geocode_nominatim])
    for engine in engines:
        hit = engine(q)
        if hit:
            return hit
    return None


# ---------------------------------------------------------------------------
# 3.5) 주변 행사 자동 수집 — 서울 열린데이터광장 문화행사 API
# ---------------------------------------------------------------------------

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 좌표 사이 거리(km)."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def _fetch_nearby_events(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """예측 기간 내 매장 반경 EVENT_RADIUS_KM의 문화행사를 날짜별로 수집한다.

    키가 없으면 '샘플 키'(호출당 5건)로 동작하고, .env의 SEOUL_OPENAPI_KEY(무료 즉시 발급)를
    넣으면 호출당 최대 500건까지 훑는다. 서울 지역만 커버 — 그 외는 수동 입력으로 보완.
    실패해도 예측은 계속한다.
    """
    import requests

    cache_key = f"{round(lat, 3)},{round(lon, 3)},{start.isoformat()},{days}"
    cached = _event_cache.get(cache_key)
    if cached and time.time() - cached[0] < _EVENT_CACHE_TTL:
        return cached[1]

    api_key = os.getenv("SEOUL_OPENAPI_KEY", "sample")
    limit = 5 if api_key == "sample" else 500
    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        try:
            # 경로 파라미터: 시작/끝/분류(공백=전체)/제목(공백=전체)/날짜
            r = requests.get(
                f"http://openapi.seoul.go.kr:8088/{api_key}/json/culturalEventInfo/1/{limit}/%20/%20/{d}",
                timeout=6,
            )
            rows = r.json().get("culturalEventInfo", {}).get("row", [])
        except Exception:
            logger.warning("행사 API 조회 실패 (%s) — 해당 일자 행사 없이 계속", d, exc_info=True)
            continue
        for row in rows:
            try:
                elat, elon = float(row.get("LAT") or 0), float(row.get("LOT") or 0)
            except (TypeError, ValueError):
                continue
            if not elat or not elon:
                continue
            dist = _haversine_km(lat, lon, elat, elon)
            if dist > EVENT_RADIUS_KM:
                continue
            title = (row.get("TITLE") or "행사").strip()[:40]
            if (title, d) in seen:
                continue
            seen.add((title, d))
            events.append({
                "name": title,
                "date": d,
                "boost_pct": AUTO_EVENT_BOOST,
                "distance_km": round(dist, 1),
                "place": (row.get("PLACE") or "").strip()[:30],
                "source": "서울 열린데이터광장",
                "lat": elat,
                "lon": elon,
            })
    _event_cache[cache_key] = (time.time(), events)
    return events


# ---------------------------------------------------------------------------
# 4) 일자별 보정 — 날씨·공휴일·행사
# ---------------------------------------------------------------------------

def _day_adjustment(day_iso: str, weather: dict, events: list[dict]) -> tuple[float, list[str]]:
    """해당 일자의 보정 배율과 근거 목록을 돌려준다."""
    factor, reasons = 1.0, []

    w = weather.get(day_iso)
    if w:
        if (w["precip_prob"] or 0) >= 60:
            factor *= 0.90
            reasons.append(f"{w['condition']} 예보(강수확률 {w['precip_prob']}%) → -10%")
        if (w["temp_max"] or 0) >= 30:
            factor *= 1.05
            reasons.append(f"최고기온 {w['temp_max']}°C 폭염 → 아이스 음료 수요 +5%")

    holiday = KR_HOLIDAYS_2026.get(day_iso)
    if holiday:
        reasons.append(f"공휴일({holiday}) — 상권 특성에 따라 변동 가능")

    # 행사 부스팅 — 여러 건이 겹쳐도 하루 최대 MAX_EVENT_FACTOR까지만
    event_factor = 1.0
    for ev in events:
        if not ev.get("date") or ev["date"] == day_iso:
            boost = float(ev.get("boost_pct", DEFAULT_EVENT_BOOST))
            event_factor *= 1 + boost / 100
            near = f" ({ev['distance_km']}km)" if ev.get("distance_km") is not None else ""
            reasons.append(f"행사 '{ev.get('name', '주변 행사')}'{near} → +{boost:.0f}%")
    if event_factor > MAX_EVENT_FACTOR:
        event_factor = MAX_EVENT_FACTOR
        reasons.append(f"행사 다수 — 부스팅 상한 +{(MAX_EVENT_FACTOR - 1) * 100:.0f}% 적용")
    factor *= event_factor

    return factor, reasons


# ---------------------------------------------------------------------------
# 5) 발주 추천 — 예측 판매량 → 레시피 소요량 → 재고 대비 부족분
# ---------------------------------------------------------------------------

def _order_recommendations(db, store_id: str, week_cups: float) -> list[dict[str, Any]]:
    """금주 예상 잔 수를 메뉴 비중으로 나누고 레시피로 재료 소요량을 계산해 발주를 추천한다."""
    from app.models.inventory import Ingredient, Menu, Recipe, Sale, Stock

    since = (date.today() - timedelta(days=MENU_MIX_WINDOW_DAYS)).isoformat()
    mix_rows = (
        db.query(Sale.menu_id, Menu.name)
        .join(Menu, Sale.menu_id == Menu.id)
        .filter(Sale.store_id == store_id, Sale.sold_at >= since)
        .all()
    )
    if not mix_rows:
        return []
    total = len(mix_rows)
    menu_share: dict[int, float] = {}
    for menu_id, _ in mix_rows:
        menu_share[menu_id] = menu_share.get(menu_id, 0) + 1 / total

    # 메뉴별 예상 잔 수 × 레시피 소요량 → 재료별 7일 예상 소요량
    usage: dict[int, float] = {}
    for menu_id, share in menu_share.items():
        cups = week_cups * share
        for recipe in db.query(Recipe).filter(Recipe.menu_id == menu_id).all():
            usage[recipe.ingredient_id] = usage.get(recipe.ingredient_id, 0) + cups * recipe.quantity

    recs = []
    for ing_id, needed in usage.items():
        ing = db.get(Ingredient, ing_id)
        stock = db.query(Stock).filter(Stock.ingredient_id == ing_id).first()
        if ing is None or stock is None:
            continue
        current, safety = stock.current_quantity, stock.safety_quantity
        daily_use = needed / 7
        shortage = needed + safety - current
        if shortage <= 0:
            continue  # 금주 소요 + 안전재고를 지금 재고로 감당 가능
        suggested = round(shortage, 1)
        recs.append({
            "ingredient": ing.name,
            "unit": ing.unit,
            "current_quantity": current,
            "safety_quantity": safety,
            "forecast_usage_7d": round(needed, 1),
            "days_until_stockout": round(current / daily_use, 1) if daily_use > 0 else None,
            "suggested_quantity": suggested,
            "estimated_amount": round(suggested * ing.current_price),
            "reason": f"금주 예상 소요 {round(needed, 1)}{ing.unit} 대비 재고 {current}{ing.unit}",
        })
    recs.sort(key=lambda r: (r["days_until_stockout"] is None, r["days_until_stockout"]))
    return recs


def _load_hourly_shares(db, store_id: str, target_weekday: int) -> dict[str, float]:
    """
    최근 60일간 동일 요일(target_weekday)의 판매 시간대(09시, 12시, 15시, 18시) 비중을 구한다.
    자료가 없으면 균등 분배(각 25%) 또는 디폴트 비중을 사용한다.
    """
    import pandas as pd
    from datetime import date, timedelta
    from app.models.inventory import Sale

    since = (date.today() - timedelta(days=60)).isoformat()
    rows = (
        db.query(Sale.sold_at, Sale.quantity)
        .filter(Sale.store_id == store_id, Sale.sold_at >= since)
        .all()
    )
    if not rows:
        return {"09시": 0.1, "12시": 0.4, "15시": 0.3, "18시": 0.2}

    df = pd.DataFrame(rows, columns=["sold_at", "quantity"])
    df["sold_at"] = pd.to_datetime(df["sold_at"])
    df["weekday"] = df["sold_at"].dt.weekday
    df["hour"] = df["sold_at"].dt.hour

    # 해당 요일 데이터만 추출
    df_day = df[df["weekday"] == target_weekday]
    if df_day.empty:
        df_day = df  # 해당 요일 데이터가 없으면 전체 평균 사용

    # 시간대별 카테고리화
    # 09시: 00시 ~ 11시 미만
    # 12시: 11시 ~ 14시 미만
    # 15시: 14시 ~ 17시 미만
    # 18시: 17시 ~ 24시 이하
    def categorize_hour(h):
        if h < 11: return "09시"
        elif h < 14: return "12시"
        elif h < 17: return "15시"
        else: return "18시"

    df_day["hour_bin"] = df_day["hour"].apply(categorize_hour)
    grouped = df_day.groupby("hour_bin")["quantity"].sum()
    total_qty = grouped.sum()

    if total_qty == 0:
        return {"09시": 0.25, "12시": 0.25, "15시": 0.25, "18시": 0.25}

    shares = {}
    for h_bin in ["09시", "12시", "15시", "18시"]:
        shares[h_bin] = float(grouped.get(h_bin, 0) / total_qty)

    return shares


# 시간별 자료가 없을 때 쓰는 카페 기본 판매 곡선 (0~23시, 합계 1.0) — 점심·오후 피크
_DEFAULT_HOUR_PROFILE = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0.06, 0.07, 0.09, 0.13, 0.11, 0.10, 0.09, 0.08, 0.07, 0.08, 0.07, 0.05,
    0, 0, 0,
]


def _hourly_profile(db, store_id: str, target_weekday: int) -> list[float]:
    """최근 60일 동일 요일의 시간(0~23시)별 판매 비중. 자료가 없으면 기본 곡선."""
    import pandas as pd
    from app.models.inventory import Sale

    since = (date.today() - timedelta(days=60)).isoformat()
    rows = (
        db.query(Sale.sold_at, Sale.quantity)
        .filter(Sale.store_id == store_id, Sale.sold_at >= since)
        .all()
    )
    if not rows:
        return list(_DEFAULT_HOUR_PROFILE)

    df = pd.DataFrame(rows, columns=["sold_at", "quantity"])
    df["sold_at"] = pd.to_datetime(df["sold_at"])
    df_day = df[df["sold_at"].dt.weekday == target_weekday]
    if df_day.empty:
        df_day = df
    grouped = df_day.groupby(df_day["sold_at"].dt.hour)["quantity"].sum()
    total = float(grouped.sum())
    if total <= 0:
        return list(_DEFAULT_HOUR_PROFILE)
    return [float(grouped.get(h, 0)) / total for h in range(24)]


def _today_actuals(db, store_id: str) -> dict[str, Any]:
    """오늘 실제 판매 실적 — 총액·잔 수·시간(0~23시)별 집계 + 어제 총매출(증감 비교용).

    대시보드 '오늘 실시간' 그래프용. 기록이 없으면 전부 0 — 경영 리포트와 같은 기준이라
    리포트가 0원인데 그래프만 매출이 있는 것처럼 보이는 불일치가 생기지 않는다.
    """
    from datetime import datetime
    from app.models.inventory import Sale

    today = date.today()
    yesterday_iso = (today - timedelta(days=1)).isoformat()

    rows = (
        db.query(Sale.sold_at, Sale.quantity, Sale.total_price)
        .filter(Sale.store_id == store_id, Sale.sold_at >= yesterday_iso)
        .all()
    )
    hourly = [{"hour": h, "cups": 0, "revenue": 0} for h in range(24)]
    cups = revenue = yesterday_revenue = 0
    for sold_at, qty, price in rows:
        try:
            dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        except ValueError:
            continue
        if dt.date() == today:
            cups += qty
            revenue += price
            hourly[dt.hour]["cups"] += qty
            hourly[dt.hour]["revenue"] += price
        else:
            yesterday_revenue += price
    return {
        "date": today.isoformat(),
        "cups": round(cups),
        "revenue": round(revenue),
        "yesterday_revenue": round(yesterday_revenue),
        "hourly": [{"hour": h["hour"], "cups": round(h["cups"]), "revenue": round(h["revenue"])} for h in hourly],
    }


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def sales_calendar(store_id: str, year: int, month: int) -> dict[str, Any]:
    """월간 캘린더용 일별 판매 집계 — 대시보드 월간 뷰가 쓴다.

    일별 매출·잔 수·베스트 메뉴·피크 시간대와 월 합계를 실제 Sale 기록으로 집계한다.
    전월 비교는 '같은 경과일까지'만 합산한다 — 진행 중인 달을 전월 전체와 비교하면
    항상 감소로 보이기 때문 (report_service의 비교 원칙과 동일).
    """
    from datetime import datetime
    from app.models.inventory import Menu, Sale
    from app.services.ai.document_service import _session

    first = date(year, month, 1)
    next_first = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    prev_first = date(year - 1, 12, 1) if month == 1 else date(year, month - 1, 1)

    with _session() as db:
        rows = (
            db.query(Sale.sold_at, Sale.quantity, Sale.total_price, Menu.name)
            .outerjoin(Menu, Sale.menu_id == Menu.id)
            .filter(
                Sale.store_id == store_id,
                Sale.sold_at >= prev_first.isoformat(),
                Sale.sold_at < next_first.isoformat(),
            )
            .all()
        )

    today = date.today()
    prev_cutoff_day = today.day if (year, month) == (today.year, today.month) else 31

    days: dict[int, dict[str, Any]] = {}
    month_cups = month_rev = 0.0
    prev_cups = prev_rev = 0.0
    for sold_at, qty, price, menu_name in rows:
        try:
            dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        except ValueError:
            continue
        d = dt.date()
        if d >= first:
            day = days.setdefault(d.day, {"date": d.isoformat(), "cups": 0.0, "revenue": 0.0,
                                          "menus": {}, "hours": {}})
            day["cups"] += qty
            day["revenue"] += price
            if menu_name:
                day["menus"][menu_name] = day["menus"].get(menu_name, 0) + qty
            day["hours"][dt.hour] = day["hours"].get(dt.hour, 0) + qty
            month_cups += qty
            month_rev += price
        elif d.day <= prev_cutoff_day:
            prev_cups += qty
            prev_rev += price

    out_days = []
    for day_num in sorted(days):
        d = days[day_num]
        top = sorted(d["menus"].items(), key=lambda kv: -kv[1])[:2]
        peak_hour = max(d["hours"], key=d["hours"].get) if d["hours"] else None
        out_days.append({
            "day": day_num,
            "date": d["date"],
            "cups": round(d["cups"]),
            "revenue": round(d["revenue"]),
            "top_menus": [{"name": name, "qty": round(q)} for name, q in top],
            "peak_hour": peak_hour,
        })

    # 월 대표 피크 시간대 = 일별 피크 시간의 최빈값
    peaks = [d["peak_hour"] for d in out_days if d["peak_hour"] is not None]
    month_peak = max(set(peaks), key=peaks.count) if peaks else None

    return {
        "year": year,
        "month": month,
        "month_total": {"cups": round(month_cups), "revenue": round(month_rev)},
        "prev_month_total": {"cups": round(prev_cups), "revenue": round(prev_rev)},
        "change_pct": round((month_rev - prev_rev) / prev_rev * 100, 1) if prev_rev else None,
        "avg_price": round(month_rev / month_cups) if month_cups else None,
        "peak_hour": month_peak,
        "days": out_days,
    }


def forecast(store_id: str, lat: Optional[float] = None, lon: Optional[float] = None,
             days: int = 7, events: Optional[list[dict]] = None) -> dict[str, Any]:
    """익일·금주 판매량 예측 + 발주 추천.

    lat/lon: 매장 GPS 좌표 (프론트가 기기 위치를 전달; 없으면 서울 기준).
    events: [{"name": "벚꽃 축제", "date": "2026-07-19"(생략 시 전체), "boost_pct": 20}]
    """
    from app.services.ai.document_service import _session

    days = max(1, min(int(days), 14))
    lat = lat if lat is not None else DEFAULT_LAT
    lon = lon if lon is not None else DEFAULT_LON
    events = events or []

    with _session() as db:
        series = _load_daily_series(db, store_id)
        if series is None or len(series) < MIN_HISTORY_DAYS:
            have = 0 if series is None else len(series)
            raise ForecastError(
                f"판매 데이터가 {have}일치뿐이라 아직 예측을 제공할 수 없어요. "
                f"최소 {MIN_HISTORY_DAYS}일의 판매 기록이 쌓이면 예측이 열립니다. "
                "(POS 동기화 또는 판매 입력을 계속해 주세요)")

        # 예측 시작일은 실제 '내일'로 고정한다 — 마지막 판매일 다음 날로 잡으면
        # 판매 입력이 며칠 끊겼을 때 '내일 예측'이 과거 날짜의 예측이 되어버린다.
        # 공백(gap)만큼 예측 스텝을 더 뽑고, 실제 내일 이후 구간만 잘라 쓴다.
        last_sale_day = series.index[-1].date()
        start = max(date.today(), last_sale_day) + timedelta(days=1)
        gap = (start - last_sale_day).days - 1
        if gap > 90:
            raise ForecastError(
                f"마지막 판매 기록({last_sale_day.isoformat()})이 {gap}일 전이라 예측 정확도를 보장할 수 없어요. "
                "판매 입력 또는 POS 동기화를 다시 시작하면 예측이 열립니다.")
        horizon = days + gap

        # 시계열 기본 예측 (잔 수·매출 각각)
        model_name = f"SARIMAX(1,0,1)×(1,0,1,7) 주간 계절성 (학습 {len(series)}일)"
        cups_pred = _forecast_sarimax(series["cups"], horizon)
        rev_pred = _forecast_sarimax(series["revenue"], horizon) if cups_pred else None
        if cups_pred is None or rev_pred is None:
            model_name = f"요일별 평균×추세 (학습 {len(series)}일, 폴백)"
            cups_pred = _forecast_seasonal(series["cups"], horizon)
            rev_pred = _forecast_seasonal(series["revenue"], horizon)
        # 마지막 판매일~내일 사이 공백 구간은 버리고 실제 내일부터 days개만 사용
        cups_pred = cups_pred[gap:]
        rev_pred = rev_pred[gap:]

        weather = _fetch_weather(lat, lon, days)
        region = _reverse_geocode(lat, lon)

        # 주변 행사 자동 수집(서울 문화행사 API) + 사장님이 직접 알려준 행사 병합
        nearby_events = _fetch_nearby_events(lat, lon, start, days)
        all_events = events + nearby_events

        # 일자별 날씨·공휴일·행사 보정
        week = []
        for i in range(days):
            d = start + timedelta(days=i)
            iso = d.isoformat()
            factor, reasons = _day_adjustment(iso, weather, all_events)
            w = weather.get(iso, {})
            week.append({
                "date": iso,
                "weekday": WEEKDAY_KO[d.weekday()],
                "base_cups": round(cups_pred[i]),
                "cups": round(cups_pred[i] * factor),
                "revenue": round(rev_pred[i] * factor),
                "weather": w.get("condition"),
                "temp_max": w.get("temp_max"),
                "precip_prob": w.get("precip_prob"),
                "adjustments": reasons,
                "holiday": KR_HOLIDAYS_2026.get(iso),
            })

        week_cups = sum(d["cups"] for d in week)
        recommendations = _order_recommendations(db, store_id, week_cups)

        # 내일의 시간대별 예측 (Top-down 분배)
        tomorrow_date = start
        tomorrow_weekday = tomorrow_date.weekday()
        shares = _load_hourly_shares(db, store_id, tomorrow_weekday)

        tomorrow_cups = week[0]["cups"]
        tomorrow_revenue = week[0]["revenue"]

        tomorrow_hourly = []
        allocated_cups = 0
        allocated_revenue = 0
        
        # 09시, 12시, 15시 (앞선 3개 시간대 분배)
        for h_bin in ["09시", "12시", "15시"]:
            c_val = round(tomorrow_cups * shares[h_bin])
            r_val = round(tomorrow_revenue * shares[h_bin])
            allocated_cups += c_val
            allocated_revenue += r_val
            tomorrow_hourly.append({
                "hour": h_bin,
                "cups": c_val,
                "revenue": r_val
            })
            
        # 18시 (마지막 시간대: 총량에서 차감한 잔여값 할당으로 반올림 누적 오차 완전 보정)
        tomorrow_hourly.append({
            "hour": "18시",
            "cups": max(0, tomorrow_cups - allocated_cups),
            "revenue": max(0, tomorrow_revenue - allocated_revenue)
        })

        # 내일 24시간 상세 분배 — 대시보드가 '현재 시각 기준 내일 같은 시각' 예측을 그릴 때 쓴다.
        # 누적 목표치에서 직전 할당분을 빼는 방식이라 반올림 오차가 특정 시간에 몰리지 않는다.
        profile = _hourly_profile(db, store_id, tomorrow_weekday)
        tomorrow_hourly_24 = []
        cum_share = 0.0
        alloc_c = alloc_r = 0
        for h in range(24):
            cum_share += profile[h]
            c_target = round(tomorrow_cups * min(cum_share, 1.0))
            r_target = round(tomorrow_revenue * min(cum_share, 1.0))
            tomorrow_hourly_24.append({
                "hour": h,
                "cups": max(0, c_target - alloc_c),
                "revenue": max(0, r_target - alloc_r),
            })
            alloc_c, alloc_r = c_target, r_target

        # 오늘 실시간 실적 (경영 리포트와 동일한 Sale 기준 집계)
        today_actual = _today_actuals(db, store_id)

    return {
        "store_id": store_id,
        "location": {"lat": lat, "lon": lon, "region": region},
        "model": model_name,
        "history_days": len(series),
        "today": today_actual,
        "tomorrow": week[0],
        "tomorrow_hourly": tomorrow_hourly,
        "tomorrow_hourly_24": tomorrow_hourly_24,
        "week": week,
        "week_total": {"cups": week_cups, "revenue": sum(d["revenue"] for d in week)},
        "order_recommendations": recommendations,
        "nearby_events": nearby_events,   # 자동 수집 (서울 문화행사, 반경 3km)
        "events_applied": events,         # 사장님이 직접 입력한 행사
        "note": (f"마지막 판매 기록({last_sale_day.isoformat()}) 이후 {gap}일의 공백을 건너뛰고 "
                 "실제 내일부터 예측했습니다. " if gap > 0 else "")
                + "시계열 예측에 날씨(강수 -10%, 폭염 +5%)·주변 행사(자동 +10%/건, 직접 입력 +20%) "
                "보정을 적용한 참고치입니다. 행사 자동 수집은 서울 지역(반경 3km) 문화행사 기준이며, "
                "그 외 지역이나 놓친 행사는 챗봇에 말하면 반영됩니다.",
    }
