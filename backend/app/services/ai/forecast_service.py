"""AI 판매량 예측 (백엔드 B) — AI-3

워크플로우:
  GPS(매장 위치) → 지역 날씨(Open-Meteo, 키 불필요) + 요일·공휴일 + 주변 행사(수동 입력/부스팅)
  + POS 판매 데이터(Sale) → 시계열 모델로 기본 예측 → 날씨·행사 보정
  → 익일·금주 예상 판매량 → 레시피 기반 재료 소요량 → 발주 추천

위치(지오코딩·역지오코딩)는 네이버 지도(NCP Maps)만 사용한다 — 무료 지오코더 폴백 없음.
NCP 콘솔에서 Maps > Geocoding / Reverse Geocoding 구독이 켜진 키가 필수다.

모델: SARIMAX(1,0,1)×(1,0,1,7) — 주 7일 계절성 시계열. statsmodels가 없거나 수렴 실패 시
      요일별 평균(최근 가중) × 추세 폴백. 둘 다 '단순 예측 + 이벤트 부스팅' 원칙을 따른다.

전제: 최소 MIN_HISTORY_DAYS일치 판매 데이터가 있어야 예측을 제공한다 (미달 시 안내).
행사 데이터: 매장 반경 내 행사를 두 소스에서 자동 수집한다.
  · 전국 — 한국관광공사 TourAPI 축제·행사 (.env TOUR_API_KEY, data.go.kr 무료 발급)
  · 서울 — 열린데이터광장 문화행사 (샘플 키로도 동작, SEOUL_OPENAPI_KEY로 수집량 확대)
  API가 놓친 행사는 events 파라미터로 직접 넣으면 부스팅(기본 +20%)한다.
"""

import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

# 매장 시간대 — Neon(timestamptz)은 sold_at을 UTC로 돌려주므로 시간대 집계 전 반드시 KST로 변환한다.
KST = timezone(timedelta(hours=9))


def _to_kst(dt: "datetime") -> "datetime":
    """tz-aware(UTC 등)면 KST로 변환, naive(과거 로컬 DB 데이터)는 이미 KST로 보고 그대로 둔다."""
    return dt.astimezone(KST) if dt.tzinfo is not None else dt

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

# 예측 결과 캐시 (stale-while-revalidate) — 대시보드가 열릴 때마다 SARIMAX 2회 적합과
# 외부 API(날씨·지오코딩·행사)를 다시 도는 것을 막는다. fresh TTL 안이면 그대로 쓰고,
# 지났어도 같은 날 만든 결과면 즉시 돌려준 뒤 백그라운드로 재계산한다(엔드포인트가 담당).
# 자정을 넘긴 캐시는 '내일' 날짜가 밀려 있으므로 버린다.
_forecast_cache: dict[tuple, tuple[float, str, dict]] = {}  # key → (ts, 생성일 ISO, result)
_FORECAST_FRESH_TTL = 5 * 60
_forecast_inflight: set[tuple] = set()
_forecast_lock = threading.Lock()

# 날씨·역지오코딩·행사 등 외부 HTTP를 SARIMAX 적합과 겹쳐 도는 공용 스레드풀
# (모듈 전역 재사용 — 호출마다 만들면 예외 경로에서 유휴 스레드가 샌다)
_external_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="forecast-ext")


def _forecast_key(store_id: str, lat: Optional[float], lon: Optional[float], days: int) -> tuple:
    """캐시 키 — 미제공 좌표는 서울 기본값으로, GPS 미세 흔들림은 소수 3자리(~110m)로 흡수."""
    lat = DEFAULT_LAT if lat is None else lat
    lon = DEFAULT_LON if lon is None else lon
    return (store_id, round(lat, 3), round(lon, 3), max(1, min(int(days), 14)))


def peek_forecast_cache(store_id: str, lat: Optional[float] = None, lon: Optional[float] = None,
                        days: int = 7) -> Optional[tuple[dict, bool]]:
    """(캐시된 예측, 신선 여부)를 돌려준다. 캐시가 없거나 날짜가 지났으면 None."""
    hit = _forecast_cache.get(_forecast_key(store_id, lat, lon, days))
    if not hit:
        return None
    ts, made_on, result = hit
    if made_on != datetime.now(KST).date().isoformat():
        return None
    return result, (time.time() - ts) < _FORECAST_FRESH_TTL


def refresh_forecast_background(store_id: str, lat: Optional[float] = None,
                                lon: Optional[float] = None, days: int = 7) -> None:
    """예측을 백그라운드에서 재계산해 캐시를 갱신한다 (BackgroundTasks용, 실패는 로그만).

    같은 키의 재계산이 이미 돌고 있으면 겹쳐 돌지 않는다."""
    key = _forecast_key(store_id, lat, lon, days)
    with _forecast_lock:
        if key in _forecast_inflight:
            return
        _forecast_inflight.add(key)
    try:
        forecast(store_id, lat=lat, lon=lon, days=days)
    except ForecastError:
        pass  # 데이터 부족 등 — 다음 정식 호출이 같은 안내를 준다
    except Exception:
        logger.exception("예측 백그라운드 갱신 실패 (%s)", store_id)
    finally:
        with _forecast_lock:
            _forecast_inflight.discard(key)


def invalidate_forecast_cache(store_id: str) -> None:
    """해당 매장의 예측 캐시를 비운다 — 판매 기록처럼 원천 데이터가 바뀐 직후 호출."""
    for k in [k for k in _forecast_cache if k[0] == store_id]:
        _forecast_cache.pop(k, None)

# 대한민국 공휴일 — holidays 라이브러리로 연도 무관 자동 계산 (음력·대체공휴일 포함).
# 아래 2026 하드코딩은 라이브러리 미설치 환경의 폴백으로만 남긴다.
_holiday_cache: dict[int, dict[str, str]] = {}


def kr_holidays(*years: int) -> dict[str, str]:
    """요청한 연도들의 공휴일 {'YYYY-MM-DD': 이름}. 설·추석·부처님오신날 같은 음력
    공휴일과 대체공휴일까지 자동 계산되므로 매년 갱신할 필요가 없다."""
    out: dict[str, str] = {}
    for y in years:
        if y not in _holiday_cache:
            try:
                import holidays as _hol

                _holiday_cache[y] = {d.isoformat(): name
                                     for d, name in _hol.KR(years=y, language="ko").items()}
            except Exception:
                logger.warning("holidays 라이브러리 사용 불가 — 2026 하드코딩 폴백", exc_info=True)
                _holiday_cache[y] = {k: v for k, v in KR_HOLIDAYS_2026.items()
                                     if k.startswith(str(y))}
        out.update(_holiday_cache[y])
    return out


def holiday_name(day_iso: str) -> Optional[str]:
    """해당 날짜(YYYY-MM-DD)가 공휴일이면 이름, 아니면 None."""
    try:
        return kr_holidays(int(day_iso[:4])).get(day_iso)
    except ValueError:
        return None


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

def _load_daily_series(db, store_id: str, mask_abnormal: bool = True):
    """일별 (판매 잔 수, 매출) 시계열을 만든다.

    기록 없는 날은 0으로 메워 연속성을 확보하되, 그 0은 '매출이 0이었던 영업일'이 아니라
    대개 휴무다. mask_abnormal=True면 휴무·품절 의심일을 결측(NaN)으로 되돌린다
    (_mask_abnormal_days 참고). 백테스트에서 마스킹 전/후를 비교하려고 끌 수 있게 남겨 둔다.
    """
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
    # sold_at은 Neon(timestamptz)에서 UTC로 온다 — KST로 옮기지 않으면 오전 9시 이전 판매가
    # 전날로 밀려 일별 집계가 통째로 어긋난다 (시간대별 집계와 같은 기준을 쓴다)
    df["day"] = pd.to_datetime(
        df["sold_at"].map(lambda d: _to_kst(d).replace(tzinfo=None) if isinstance(d, datetime) else d)
    ).dt.date
    daily = df.groupby("day").agg(cups=("quantity", "sum"), revenue=("total_price", "sum"))
    daily.index = pd.to_datetime(daily.index)
    # 오늘은 하루가 끝나지 않아 미완성 집계다 — 학습에 넣으면 '판매가 급감한 날'로 오인해
    # 내일 예측을 끌어내리므로 시계열에서 제외한다 (오늘 실적은 _today_actuals가 따로 담당)
    daily = daily[daily.index.date < date.today()]
    if daily.empty:
        return None
    # 첫 판매일~마지막 판매일 사이 비는 날을 0으로 — 시계열 연속성 확보
    full = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    daily = daily.reindex(full, fill_value=0)
    return _mask_abnormal_days(daily)[0] if mask_abnormal else daily


# ---------------------------------------------------------------------------
# 1.5) 비정상 영업일 마스킹 — 휴무·품절로 '못 판' 날은 수요가 0이었던 게 아니다
# ---------------------------------------------------------------------------

ABNORMAL_RATIO = 0.35   # 그 시기 그 요일에 기대되는 양의 이 비율 미만이면 정상 영업으로 안 본다
MAX_MASK_RATIO = 0.25   # 이 비율을 넘게 지워야 한다면 판정이 틀린 것으로 보고 마스킹을 접는다
LOCAL_WINDOW = 7        # 지역 수준(level) 추정에 쓰는 이동 중앙값 창 — 7일이면 요일을 한 바퀴 돈다
MIN_WEEKDAY_SAMPLES = 3  # 요일 비율 중앙값을 신뢰하려면 같은 요일이 최소 이만큼은 있어야 한다


def _mask_abnormal_days(daily) -> tuple[Any, list[str]]:
    """휴무(판매 0)·품절/장애 의심일을 결측(NaN)으로 바꾼 시계열과 그 날짜 목록을 돌려준다.

    reindex가 빈 날을 0으로 채우기 때문에 휴무일이 '매출 0인 영업일'로 학습된다.
    주 1회 정기휴무 매장이면 그 요일 평균이 통째로 눌려서, 모델을 아무리 바꿔도
    해당 요일 예측이 구조적으로 낮게 나온다 — 피처를 더 넣어서 고칠 수 있는 문제가 아니다.
    SARIMAX(상태공간)는 결측을 결측으로 다루므로 NaN이 0보다 항상 낫다.

    판정 기준을 '전체 기간의 같은 요일 중앙값'으로 잡으면 안 된다. 매출 수준이 한 번
    크게 바뀐 매장(신규 오픈 후 안정화, 리모델링, 경쟁점 개업, 성수기/비수기)에서는
    낮은 쪽 구간이 통째로 '이상일'로 찍혀 데이터의 절반이 날아간다 — 실제로 이 저장소의
    데모 데이터에서 그렇게 오판했다.

    그래서 두 단계로 정규화한다:
      1) 지역 수준 = 중심 7일 이동 중앙값 (요일 효과가 한 바퀴 안에서 상쇄된다)
      2) 요일 비율 = 그날 판매 / 지역 수준 → 수준 변화와 무관한 값이 된다
    이 비율이 같은 요일의 평소 비율 대비 ABNORMAL_RATIO 미만이면 품절·단축영업으로 본다.
    판매 0인 날은 근거가 확실하므로 비율과 무관하게 항상 지운다.

    마스킹이 전체의 MAX_MASK_RATIO를 넘으면 기준이 매장 현실과 안 맞는다는 뜻이므로
    0인 날만 지우고 물러선다 (저매출·신규 매장을 통째로 지워버리는 사고 방지).
    """
    import numpy as np

    masked = daily.copy().astype(float)
    cups = masked["cups"].to_numpy(dtype=float)
    weekdays = masked.index.dayofweek.to_numpy()

    drop = cups <= 0  # 휴무 — 근거가 확실하므로 항상 지운다
    suspect = np.zeros(len(cups), dtype=bool)

    # 1) 지역 수준 — 판매 0인 날을 뺀 값으로 중심 이동 중앙값 (구간 양끝은 min_periods로 완화)
    level_src = masked["cups"].where(~drop)
    level = level_src.rolling(LOCAL_WINDOW, center=True, min_periods=3).median().to_numpy(dtype=float)

    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where((level > 0) & ~drop, cups / level, np.nan)

    # 2) 요일별 평소 비율과 비교 — 비율끼리 재므로 매출 수준이 바뀌어도 판정이 흔들리지 않는다
    for wd in range(7):
        same_wd = (weekdays == wd) & ~drop & ~np.isnan(ratio)
        if same_wd.sum() < MIN_WEEKDAY_SAMPLES:
            continue  # 표본이 적으면 중앙값을 못 믿는다 — 판정하지 않는다
        typical = float(np.median(ratio[same_wd]))
        if typical <= 0:
            continue
        suspect |= same_wd & (ratio < typical * ABNORMAL_RATIO)

    combined = drop | suspect
    if combined.sum() > len(cups) * MAX_MASK_RATIO:
        logger.info("비정상일 판정이 %d/%d일로 과도 — 판매 0인 날만 결측 처리",
                    int(combined.sum()), len(cups))
        combined = drop

    masked.loc[combined, ["cups", "revenue"]] = np.nan
    return masked, [d.date().isoformat() for d in masked.index[combined]]


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
    """폴백: 요일별 평균(최근 2주는 2배 가중) × 최근 추세(직전 2주 / 그 전 2주, 0.7~1.3 클립).

    휴무·품절로 결측(NaN) 처리된 날은 평균·추세 계산에서 통째로 빼야 한다 — 0으로 세면
    그 요일 평균이 눌리고, NaN을 그냥 넣으면 평균 전체가 NaN이 된다.
    """
    import numpy as np

    values = series.to_numpy(dtype=float)
    weekdays = series.index.dayofweek.to_numpy()
    n = len(values)
    weights = np.ones(n)
    weights[-14:] = 2.0  # 최근 2주 가중
    valid = ~np.isnan(values)
    overall = float(np.mean(values[valid])) if valid.any() else 0.0

    wd_mean = {}
    for wd in range(7):
        mask = (weekdays == wd) & valid
        wd_mean[wd] = (float(np.average(values[mask], weights=weights[mask]))
                       if mask.any() else overall)

    def _window_mean(lo: int, hi: Optional[int]) -> float:
        """구간 평균 — 결측을 뺀 값들로만 계산한다 (전부 결측이면 0)."""
        chunk = values[lo:hi] if hi is not None else values[lo:]
        ok = ~np.isnan(chunk)
        return float(chunk[ok].mean()) if ok.any() else 0.0

    trend = 1.0
    if n >= 28:
        recent, prev = _window_mean(-14, None), _window_mean(-28, -14)
        if prev > 0:
            trend = float(np.clip(recent / prev, 0.7, 1.3))

    last_day = series.index[-1]
    return [max(0.0, wd_mean[(last_day + timedelta(days=i + 1)).dayofweek] * trend)
            for i in range(horizon)]


def _forecast_weekday_naive(series, horizon: int):
    """베이스라인: 최근 4주 같은 요일의 평균 (결측 제외).

    모델 평가의 기준선이다. SARIMAX가 이것보다 못하면 시계열 모델을 쓸 이유가 없다 —
    백테스트가 실제로 그 질문에 답하라고 두는 비교군.
    """
    import numpy as np

    values = series.to_numpy(dtype=float)
    weekdays = series.index.dayofweek.to_numpy()
    valid = ~np.isnan(values)
    overall = float(np.mean(values[valid])) if valid.any() else 0.0

    last_day = series.index[-1]
    out = []
    for i in range(horizon):
        wd = (last_day + timedelta(days=i + 1)).dayofweek
        mask = (weekdays == wd) & valid
        recent = values[mask][-4:]  # 최근 4주치 같은 요일
        out.append(float(recent.mean()) if len(recent) else overall)
    return out


# ---------------------------------------------------------------------------
# 3) 날씨 — Open-Meteo (키 불필요)
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
    """좌표 → 지역 이름 (표시용) — 네이버 지도(NCP Reverse Geocoding) 전용.
    실패하면 좌표 문자열 (다른 지도 서비스 폴백 없음)."""
    import requests

    cid = os.getenv("NCP_MAPS_CLIENT_ID") or os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NCP_MAPS_CLIENT_SECRET") or os.getenv("NAVER_CLIENT_SECRET", "")
    if cid and csec:
        try:
            r = requests.get(
                "https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc",
                params={"coords": f"{lon},{lat}", "output": "json", "orders": "admcode"},
                headers={"x-ncp-apigw-api-key-id": cid, "x-ncp-apigw-api-key": csec},
                timeout=5,
            )
            r.raise_for_status()
            results = r.json().get("results", [])
            if results:
                region = results[0].get("region", {})
                parts = [region.get(f"area{i}", {}).get("name") for i in (1, 2, 3)]
                name = " ".join(p for p in parts if p)
                if name:
                    return name
        except Exception:
            logger.warning("네이버 역지오코딩 실패 (NCP Maps Reverse Geocoding 구독 확인 필요)",
                           exc_info=True)
    return f"위도 {lat:.4f}, 경도 {lon:.4f}"


def reverse_geocode_address(lat: float, lon: float) -> Optional[str]:
    """좌표 → 도로명주소 (회원가입 지도 핀용) — 네이버 지도(NCP Reverse Geocoding) 전용.

    표시용 지역명만 주는 `_reverse_geocode`와 달리 도로명까지 붙여 준다.
    roadaddr(도로명)가 없으면 admcode(행정동)로 내려가고, 둘 다 없으면 None.
    OSM(Nominatim) 폴백 없음 — 실패 시 사용자가 주소를 직접 입력한다.
    """
    import requests

    cid = os.getenv("NCP_MAPS_CLIENT_ID") or os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NCP_MAPS_CLIENT_SECRET") or os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec):
        return None
    try:
        r = requests.get(
            "https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc",
            params={"coords": f"{lon},{lat}", "output": "json", "orders": "roadaddr,admcode"},
            headers={"x-ncp-apigw-api-key-id": cid, "x-ncp-apigw-api-key": csec},
            timeout=5,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
    except Exception:
        logger.warning("네이버 역지오코딩(주소) 실패 — NCP Maps 구독 확인 필요", exc_info=True)
        return None

    # roadaddr가 있으면 도로명까지, 없으면 행정구역명만
    for want in ("roadaddr", "admcode"):
        for res in results:
            if res.get("name") != want:
                continue
            region = res.get("region", {})
            parts = [region.get(f"area{i}", {}).get("name") for i in (1, 2, 3)]
            if want == "roadaddr":
                land = res.get("land", {})
                road = land.get("name")
                num = land.get("number1")
                if num and land.get("number2"):
                    num = f"{num}-{land['number2']}"
                parts += [road, num]
            name = " ".join(p for p in parts if p)
            if name:
                return name
    return None


def _geocode_naver_local(q: str) -> Optional[dict[str, Any]]:
    """네이버 지역 검색 API — 상호·기관명에 강하다 (developers.naver.com '검색 API' 키 필요)."""
    import re

    import requests

    cid = os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec):
        return None
    try:
        r = requests.get(
            "https://openapi.naver.com/v1/search/local.json",
            params={"query": q, "display": 1},
            headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec},
            timeout=5,
        )
        if r.status_code in (401, 403):
            logger.warning("네이버 지역 검색 인증 실패(%s) — developers.naver.com 검색 API 키 필요", r.status_code)
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
    NCP 콘솔에서 Maps > Geocoding 구독이 활성화된 키가 필요하다."""
    import requests

    cid = os.getenv("NCP_MAPS_CLIENT_ID") or os.getenv("NAVER_CLIENT_ID", "")
    csec = os.getenv("NCP_MAPS_CLIENT_SECRET") or os.getenv("NAVER_CLIENT_SECRET", "")
    if not (cid and csec):
        return None
    try:
        r = requests.get(
            "https://maps.apigw.ntruss.com/map-geocode/v2/geocode",
            params={"query": q},
            headers={"x-ncp-apigw-api-key-id": cid, "x-ncp-apigw-api-key": csec},
            timeout=5,
        )
        if r.status_code in (401, 403):
            logger.warning("NCP 지오코딩 인증 실패(%s) — 콘솔에서 Maps > Geocoding 구독 확인 필요", r.status_code)
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


def geocode(query: str) -> Optional[dict[str, Any]]:
    """주소/상호/기관명 → 좌표 (회원가입 지도 핀 검색용) — 네이버 지도 전용.

    네이버 지역 검색(상호·기관명, developers.naver.com 키) → NCP Geocoding(도로명/지번 주소)
    순으로 조회한다. 무료 지오코더(Nominatim/Photon) 폴백은 제거됨 — 네이버 키가
    유효하지 않으면 결과 없음으로 처리된다.
    """
    q = (query or "").strip()
    if not q:
        return None

    for engine in (_geocode_naver_local, _geocode_ncp):
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


def _fetch_events_tourapi(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """한국관광공사 TourAPI 축제·행사 — **전국** 커버. TOUR_API_KEY(data.go.kr 무료 발급) 필요.

    행사 기간(eventstartdate~eventenddate)이 예측 기간과 겹치고 매장 반경 안이면
    날짜별 이벤트로 펼친다. 진행 중인 장기 행사를 놓치지 않도록 120일 전 시작분부터 조회.
    실패하거나 키가 없으면 빈 목록 — 예측은 계속한다.
    """
    import requests

    api_key = os.getenv("TOUR_API_KEY", "")
    if not api_key:
        return []
    try:
        r = requests.get(
            "https://apis.data.go.kr/B551011/KorService1/searchFestival1",
            params={"serviceKey": api_key, "MobileOS": "ETC", "MobileApp": "brewnote",
                    "_type": "json", "numOfRows": 1000, "pageNo": 1, "arrange": "A",
                    "eventStartDate": (start - timedelta(days=120)).strftime("%Y%m%d")},
            timeout=8,
        )
        r.raise_for_status()
        body = r.json().get("response", {}).get("body", {})
        items = (body.get("items") or {}).get("item", [])
    except Exception:
        logger.warning("TourAPI 행사 조회 실패 — 전국 행사 없이 계속", exc_info=True)
        return []

    events: list[dict[str, Any]] = []
    for row in items if isinstance(items, list) else [items]:
        try:
            elat, elon = float(row.get("mapy") or 0), float(row.get("mapx") or 0)
            ev_start = datetime.strptime(str(row.get("eventstartdate")), "%Y%m%d").date()
            ev_end = datetime.strptime(str(row.get("eventenddate")), "%Y%m%d").date()
        except (TypeError, ValueError):
            continue
        if not elat or not elon:
            continue
        dist = _haversine_km(lat, lon, elat, elon)
        if dist > EVENT_RADIUS_KM:
            continue
        title = (row.get("title") or "행사").strip()[:40]
        for i in range(days):
            d = start + timedelta(days=i)
            if ev_start <= d <= ev_end:
                events.append({
                    "name": title,
                    "date": d.isoformat(),
                    "boost_pct": AUTO_EVENT_BOOST,
                    "distance_km": round(dist, 1),
                    "place": (row.get("addr1") or "").strip()[:30],
                    "source": "한국관광공사 TourAPI",
                    "lat": elat,
                    "lon": elon,
                })
    return events


def _fetch_events_seoul(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """서울 열린데이터광장 문화행사 — 서울 한정 보조 소스 (샘플 키로도 동작).

    키가 없으면 '샘플 키'(호출당 5건)로 동작하고, .env의 SEOUL_OPENAPI_KEY(무료 즉시 발급)를
    넣으면 호출당 최대 500건까지 훑는다. 실패해도 예측은 계속한다.
    """
    import requests

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
    return events


def _fetch_nearby_events(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """예측 기간 내 매장 반경 EVENT_RADIUS_KM의 행사를 날짜별로 수집한다.

    전국은 TourAPI(TOUR_API_KEY 필요), 서울은 열린데이터광장(키 없이도 샘플 동작)으로
    수집해 (제목, 날짜) 기준으로 합친다 — 서울 매장은 두 소스가 겹칠 수 있어 중복 제거.
    """
    cache_key = f"{round(lat, 3)},{round(lon, 3)},{start.isoformat()},{days}"
    cached = _event_cache.get(cache_key)
    if cached and time.time() - cached[0] < _EVENT_CACHE_TTL:
        return cached[1]

    events = _fetch_events_tourapi(lat, lon, start, days)
    seen = {(e["name"], e["date"]) for e in events}
    for ev in _fetch_events_seoul(lat, lon, start, days):
        if (ev["name"], ev["date"]) not in seen:
            seen.add((ev["name"], ev["date"]))
            events.append(ev)

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

    holiday = holiday_name(day_iso)
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
    df["sold_at"] = pd.to_datetime(df["sold_at"].map(lambda d: _to_kst(d).replace(tzinfo=None) if isinstance(d, datetime) else d))
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
    df["sold_at"] = pd.to_datetime(df["sold_at"].map(lambda d: _to_kst(d).replace(tzinfo=None) if isinstance(d, datetime) else d))
    df_day = df[df["sold_at"].dt.weekday == target_weekday]
    if df_day.empty:
        df_day = df
    grouped = df_day.groupby(df_day["sold_at"].dt.hour)["quantity"].sum()
    total = float(grouped.sum())
    if total <= 0:
        return list(_DEFAULT_HOUR_PROFILE)
    return [float(grouped.get(h, 0)) / total for h in range(24)]


def _today_actuals(db, store_id: str) -> dict[str, Any]:
    """오늘 실제 판매 실적 — 총액·잔 수·시간별 집계 + 어제/지난주 같은 요일 총매출.

    비교 기준을 두 개 준다. 어제 대비는 요일 효과(월요일이 원래 한산하다) 때문에
    사장님 체감과 어긋나기 쉬워서, 화면 기본 표시는 '지난주 같은 요일 대비'를 쓴다.
    어제 값은 참고용으로 남겨 둔다.

    기록이 없으면 전부 0 — 경영 리포트와 같은 기준이라, 리포트가 0원인데 그래프만
    매출이 있는 것처럼 보이는 불일치가 생기지 않는다.
    """
    from datetime import datetime
    from app.models.inventory import Sale

    today = date.today()
    yesterday = today - timedelta(days=1)
    last_week = today - timedelta(days=7)

    rows = (
        db.query(Sale.sold_at, Sale.quantity, Sale.total_price)
        .filter(Sale.store_id == store_id, Sale.sold_at >= last_week.isoformat())
        .all()
    )
    hourly = [{"hour": h, "cups": 0, "revenue": 0} for h in range(24)]
    cups = revenue = yesterday_revenue = last_week_revenue = 0
    for sold_at, qty, price in rows:
        try:
            dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        except ValueError:
            continue
        dt = _to_kst(dt)
        d = dt.date()
        if d == today:
            cups += qty
            revenue += price
            hourly[dt.hour]["cups"] += qty
            hourly[dt.hour]["revenue"] += price
        elif d == yesterday:
            yesterday_revenue += price
        elif d == last_week:
            last_week_revenue += price
    return {
        "date": today.isoformat(),
        "cups": round(cups),
        "revenue": round(revenue),
        "yesterday_revenue": round(yesterday_revenue),
        "last_week_revenue": round(last_week_revenue),
        "hourly": [{"hour": h["hour"], "cups": round(h["cups"]), "revenue": round(h["revenue"])} for h in hourly],
    }


# ---------------------------------------------------------------------------
# 6) 백테스트 — "그래서 예측이 얼마나 맞는가"를 숫자로 답한다
# ---------------------------------------------------------------------------

# 예측 방식별 함수 — 백테스트는 이 표를 그대로 돌려 서로 비교한다
_METHODS = {
    "weekday_naive": ("최근 4주 같은 요일 평균 (베이스라인)", _forecast_weekday_naive),
    "seasonal": ("요일평균×추세 (현재 폴백)", _forecast_seasonal),
    "sarimax": ("SARIMAX(1,0,1)×(1,0,1,7) (현재 기본)", _forecast_sarimax),
}


AVG_PRICE_WINDOW = 14  # 객단가를 볼 최근 기간(유효 영업일 기준)


def _recent_avg_price(df, window: int = AVG_PRICE_WINDOW) -> Optional[float]:
    """최근 영업일의 객단가(매출÷잔 수). 결측일은 빼고 센다. 계산 불가면 None.

    개별 날의 객단가를 평균내지 않고 '매출 합 ÷ 잔 수 합'을 쓴다 — 한산한 날의
    튀는 객단가가 평균을 흔드는 것을 막는다.
    """
    import numpy as np

    cups = df["cups"].to_numpy(dtype=float)
    rev = df["revenue"].to_numpy(dtype=float)
    ok = ~np.isnan(cups) & ~np.isnan(rev) & (cups > 0)
    if not ok.any():
        return None
    c, r = cups[ok][-window:], rev[ok][-window:]
    total_cups = float(c.sum())
    return float(r.sum()) / total_cups if total_cups > 0 else None


# 채점 지표는 WAPE(가중절대백분율오차) = Σ|실제-예측| / Σ실제 를 주지표로 쓴다.
# MAPE는 매출이 작은 날에서 분모가 작아져 값이 폭주하므로(한산한 날 하나가 전체 평균을
# 지배한다) 카페 일매출 평가에 맞지 않는다. bias는 부호를 살린 오차로, 모델이 꾸준히
# 과대예측(+)인지 과소예측(-)인지를 본다 — WAPE와 절댓값이 같으면 한 방향으로만 틀렸다는 뜻.


def backtest(store_id: str, horizon: int = 7, folds: int = 4,
             target: str = "revenue", min_train: Optional[int] = None,
             since: Optional[str] = None) -> dict[str, Any]:
    """롤링 오리진 백테스트 — 과거 시점으로 돌아가 실제로 맞혔는지 채점한다.

    시계열은 미래를 훔쳐보기 쉬워서(전체 데이터로 적합한 뒤 그 안을 예측하면 항상 잘 맞는다)
    학습 구간을 fold마다 잘라 뒤로 밀며 평가한다. 각 fold는 cut일까지만 학습하고
    그 다음 horizon일을 예측한 뒤, 실제값과 비교한다.

    비교군을 셋 둔다 — 베이스라인(요일 평균)·현재 폴백·SARIMAX. 그리고 각각을
    '비정상일 마스킹 전/후'로 돌려서, 휴무일을 0으로 학습하는 게 실제로 얼마나
    손해인지까지 같은 표에서 보이게 한다.

    채점 대상 날짜는 항상 마스킹된 실제값이다 — 휴무일은 어떤 모델도 맞힐 수 없고,
    맞혔다고 쳐주면(0을 예측한 모델이 유리해져) 순위가 뒤집힌다.

    since: 'YYYY-MM-DD' 이후만 평가한다. 매장 매출 수준이 한 번 크게 바뀐 경우
      (리모델링·이전·상권 변화, 또는 시드 데이터 교체) 그 이전 구간을 넣으면 오차가
      모델 성능이 아니라 그 단절을 재게 된다 — 끊긴 지점부터 다시 재라고 두는 파라미터.
    min_train: 학습 최소 일수. 기본은 주간 계절성을 4주기 보는 28일이다.
    """
    from app.services.ai.document_service import _session

    if target not in ("revenue", "cups"):
        raise ForecastError("target은 revenue 또는 cups만 됩니다.")
    horizon = max(1, min(int(horizon), 14))

    with _session() as db:
        raw = _load_daily_series(db, store_id, mask_abnormal=False)
    if raw is None:
        raise ForecastError("판매 기록이 없어 백테스트할 수 없습니다.")

    if since:
        raw = raw[raw.index >= since]
        if raw.empty:
            raise ForecastError(f"{since} 이후 판매 기록이 없습니다.")

    masked, masked_days = _mask_abnormal_days(raw)
    n = len(raw)
    # 주간 계절성을 최소 4주기는 보고 학습해야 의미가 있다 (호출자가 줄일 수는 있게 둔다)
    min_train = MIN_HISTORY_DAYS * 2 if min_train is None else max(horizon, int(min_train))
    if n < min_train + horizon:
        raise ForecastError(
            f"판매 기록이 {n}일치라 백테스트를 못 합니다. "
            f"최소 {min_train + horizon}일(학습 {min_train} + 검증 {horizon})이 필요해요.")

    folds = max(1, min(int(folds), (n - min_train) // horizon))
    cuts = [n - horizon * k for k in range(folds, 0, -1)]

    import numpy as np

    # 평가 대상 조합 — (방식, 마스킹 여부, 객단가 환산 여부)
    # 매출은 '매출을 직접 예측'과 '잔 수 예측 × 최근 객단가' 두 갈래를 모두 잰다.
    # 지금 코드는 잔 수와 매출을 각각 따로 적합해서 서로 어긋난다(실측: 14잔인데 16만원 =
    # 잔당 11,500원, 실제 객단가는 3,900원). 어느 쪽이 나은지는 취향이 아니라 측정 대상이다.
    variants = [(key, use_mask, False) for key in _METHODS for use_mask in (True, False)]
    if target == "revenue":
        variants += [(key, True, True) for key in _METHODS]

    results: list[dict[str, Any]] = []
    for key, use_mask, derived in variants:
        label, fn = _METHODS[key]
        if derived:
            label += " × 최근 객단가"
        source = masked if use_mask else raw
        abs_err = actual_sum = signed_err = 0.0
        scored_days = 0
        failed = False
        for cut in cuts:
            train_df = source.iloc[:cut]
            truth = masked[target].iloc[cut:cut + horizon].to_numpy(dtype=float)
            if derived:
                cups_pred = fn(train_df["cups"], horizon)
                price = _recent_avg_price(train_df)
                pred = ([c * price for c in cups_pred]
                        if cups_pred is not None and price else None)
            else:
                pred = fn(train_df[target], horizon)
            if pred is None:  # SARIMAX 수렴 실패 — 이 조합은 평가에서 제외한다
                failed = True
                break
            p = np.asarray(pred, dtype=float)
            ok = ~np.isnan(truth) & ~np.isnan(p)
            if not ok.any():
                continue
            abs_err += float(np.abs(truth[ok] - p[ok]).sum())
            signed_err += float((p[ok] - truth[ok]).sum())
            actual_sum += float(truth[ok].sum())
            scored_days += int(ok.sum())
        if failed or actual_sum <= 0:
            continue
        results.append({
            "method": key,
            "label": label,
            "masked": use_mask,
            "derived": derived,   # 매출을 '잔 수 × 객단가'로 환산했는지
            "wape_pct": round(abs_err / actual_sum * 100, 1),
            "bias_pct": round(signed_err / actual_sum * 100, 1),
            "mae": round(abs_err / scored_days) if scored_days else None,
            "scored_days": scored_days,
        })

    if not results:
        raise ForecastError("채점 가능한 구간이 없어 백테스트 결과를 만들지 못했습니다.")

    results.sort(key=lambda r: r["wape_pct"])
    best = results[0]

    # 마스킹이 실제로 이득인지 — 같은 방식끼리만 비교해야 의미가 있다
    by_key = {(r["method"], r["masked"], r["derived"]): r for r in results}
    mask_gains = []
    for key in _METHODS:
        on, off = by_key.get((key, True, False)), by_key.get((key, False, False))
        if on and off:
            mask_gains.append({
                "method": key,
                "wape_masked": on["wape_pct"],
                "wape_raw": off["wape_pct"],
                "gain_pp": round(off["wape_pct"] - on["wape_pct"], 1),  # 양수면 마스킹이 이득
            })

    # 매출을 직접 예측하는 것과 '잔 수 × 객단가'로 환산하는 것 중 어느 쪽이 나은지
    derive_gains = []
    if target == "revenue":
        for key in _METHODS:
            direct, via_cups = by_key.get((key, True, False)), by_key.get((key, True, True))
            if direct and via_cups:
                derive_gains.append({
                    "method": key,
                    "wape_direct": direct["wape_pct"],
                    "wape_via_cups": via_cups["wape_pct"],
                    "gain_pp": round(direct["wape_pct"] - via_cups["wape_pct"], 1),
                })

    return {
        "store_id": store_id,
        "target": target,
        "horizon_days": horizon,
        "folds": folds,
        "since": since,
        "min_train": min_train,
        "history_days": n,
        "abnormal_days": len(masked_days),
        "abnormal_dates": masked_days[-20:],  # 최근 20건만 (전부 실으면 응답이 길어진다)
        "results": results,
        "best": best,
        "mask_gain": mask_gains,
        "derive_gain": derive_gains,
        "note": (
            "WAPE는 낮을수록 정확합니다(Σ|실제-예측|/Σ실제). bias가 양수면 과대예측, "
            "음수면 과소예측입니다. masked=true는 휴무·품절 의심일을 학습에서 뺀 경우이고, "
            "gain_pp가 양수면 그만큼 오차가 줄었다는 뜻입니다. "
            "카페 일매출은 본래 변동이 커서 WAPE 15~25%면 실용 수준, 30% 이상이면 "
            "학습 기간이 부족하거나 반영 안 된 요인(프로모션·휴무)이 있다는 신호입니다."
        ),
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
        dt = _to_kst(dt)
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

    cache_key = _forecast_key(store_id, lat, lon, days)
    days = max(1, min(int(days), 14))
    lat = lat if lat is not None else DEFAULT_LAT
    lon = lon if lon is not None else DEFAULT_LON
    events = events or []

    # 날씨·역지오코딩은 좌표만 있으면 되므로 지금 바로 백그라운드로 던져 두고,
    # 그동안 DB 로드와 SARIMAX 적합(CPU)을 돌린다 — 직렬로 기다리던 외부 HTTP가 겹쳐진다.
    weather_future = _external_pool.submit(_fetch_weather, lat, lon, days)
    region_future = _external_pool.submit(_reverse_geocode, lat, lon)

    with _session() as db:
        series = _load_daily_series(db, store_id)
        # 휴무·품절 의심일은 결측이라 '학습에 쓸 수 있는 날'은 전체 길이가 아니라 유효일 수다
        valid_days = 0 if series is None else int(series["cups"].notna().sum())
        if series is None or valid_days < MIN_HISTORY_DAYS:
            raise ForecastError(
                f"판매 데이터가 {valid_days}일치뿐이라 아직 예측을 제공할 수 없어요. "
                f"최소 {MIN_HISTORY_DAYS}일의 판매 기록이 쌓이면 예측이 열립니다. "
                "(POS 동기화 또는 판매 입력을 계속해 주세요)")

        # 예측 시작일은 실제 '내일'로 고정한다 — 마지막 판매일 다음 날로 잡으면
        # 판매 입력이 며칠 끊겼을 때 '내일 예측'이 과거 날짜의 예측이 되어버린다.
        # 공백(gap)만큼 예측 스텝을 더 뽑고, 실제 내일 이후 구간만 잘라 쓴다.
        # 기준은 '마지막으로 실제 판매가 있던 날' — 꼬리의 결측(휴무)을 마지막 날로 잡으면
        # 없는 공백을 만들어 낸다.
        last_sale_day = series.index[series["cups"].notna()][-1].date()
        # 모델은 시계열의 마지막 인덱스 다음 날부터 예측을 내놓는다. 꼬리가 결측(휴무)이면
        # 그 날짜는 마지막 '판매일'과 다르므로, 잘라낼 구간은 시계열 끝을 기준으로 세야 한다.
        series_end = series.index[-1].date()
        start = max(date.today(), series_end) + timedelta(days=1)
        gap = (start - series_end).days - 1
        sales_gap = (start - last_sale_day).days - 1
        if sales_gap > 90:
            raise ForecastError(
                f"마지막 판매 기록({last_sale_day.isoformat()})이 {sales_gap}일 전이라 예측 정확도를 보장할 수 없어요. "
                "판매 입력 또는 POS 동기화를 다시 시작하면 예측이 열립니다.")
        horizon = days + gap

        # 행사 수집은 예측 시작일이 정해진 지금 던진다 — SARIMAX 적합과 병렬로 돈다
        events_future = _external_pool.submit(_fetch_nearby_events, lat, lon, start, days)

        # 시계열 기본 예측 (잔 수·매출 각각)
        model_name = f"SARIMAX(1,0,1)×(1,0,1,7) 주간 계절성 (학습 {valid_days}일)"
        cups_pred = _forecast_sarimax(series["cups"], horizon)
        rev_pred = _forecast_sarimax(series["revenue"], horizon) if cups_pred else None
        if cups_pred is None or rev_pred is None:
            model_name = f"요일별 평균×추세 (학습 {valid_days}일, 폴백)"
            cups_pred = _forecast_seasonal(series["cups"], horizon)
            rev_pred = _forecast_seasonal(series["revenue"], horizon)
        # 마지막 판매일~내일 사이 공백 구간은 버리고 실제 내일부터 days개만 사용
        cups_pred = cups_pred[gap:]
        rev_pred = rev_pred[gap:]

        # 병렬로 돌던 외부 조회를 회수한다 (각자 내부에서 실패를 삼키므로 예외 없음)
        weather = weather_future.result()
        region = region_future.result()

        # 주변 행사 자동 수집(서울 문화행사 API) + 사장님이 직접 알려준 행사 병합
        nearby_events = events_future.result()
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
                "holiday": holiday_name(iso),
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

    result = {
        "store_id": store_id,
        "location": {"lat": lat, "lon": lon, "region": region},
        "model": model_name,
        "history_days": valid_days,       # 휴무·품절 의심일을 뺀 '학습에 쓴' 날 수
        "excluded_days": len(series) - valid_days,
        "today": today_actual,
        "tomorrow": week[0],
        "tomorrow_hourly": tomorrow_hourly,
        "tomorrow_hourly_24": tomorrow_hourly_24,
        "week": week,
        "week_total": {"cups": week_cups, "revenue": sum(d["revenue"] for d in week)},
        "order_recommendations": recommendations,
        "nearby_events": nearby_events,   # 자동 수집 (전국 TourAPI + 서울 문화행사, 반경 3km)
        "events_applied": events,         # 사장님이 직접 입력한 행사
        "note": (f"마지막 판매 기록({last_sale_day.isoformat()}) 이후 {sales_gap}일의 공백을 건너뛰고 "
                 "실제 내일부터 예측했습니다. " if sales_gap > 0 else "")
                + (f"휴무·품절로 보이는 {len(series) - valid_days}일은 학습에서 제외했습니다. "
                   if valid_days < len(series) else "")
                + "시계열 예측에 날씨(강수 -10%, 폭염 +5%)·주변 행사(자동 +10%/건, 직접 입력 +20%) "
                "보정을 적용한 참고치입니다. 행사는 매장 반경 3km의 전국 축제·행사(한국관광공사)와 "
                "서울 문화행사를 자동 수집하며, 놓친 행사는 챗봇에 말하면 반영됩니다.",
    }
    if not events:  # 직접 입력 행사가 섞인 결과는 캐시하지 않는다 (대시보드 기본 호출만)
        _forecast_cache[cache_key] = (time.time(), datetime.now(KST).date().isoformat(), result)
    return result
