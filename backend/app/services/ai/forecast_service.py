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
행사 데이터: 매장 반경 내 행사를 세 소스에서 자동 수집한다 (한 곳이 죽어도 나머지로 계속).
  · 전국 — 네이버 뉴스·블로그 검색 + Gemini 정리 (기존 NAVER_*·GEMINI_API_KEY로 동작,
           별도 발급 불필요. 팝업·플리마켓까지 잡히지만 검색 기반이라 부스팅은 절반)
  · 전국 — 한국관광공사 TourAPI 축제·행사 (선택, .env TOUR_API_KEY = data.go.kr 무료 발급)
  · 서울 — 열린데이터광장 문화행사 (샘플 키로도 동작, SEOUL_OPENAPI_KEY로 수집량 확대)
  API가 놓친 행사는 events 파라미터로 직접 넣으면 부스팅(기본 +20%)한다.
"""

import logging
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Optional

from app.services.ai import warm_cache
from app.utils.datetime_kst import today_kst

# 매장 시간대 — Neon(timestamptz)은 sold_at을 UTC로 돌려주므로 시간대 집계 전 반드시 KST로 변환한다.
KST = timezone(timedelta(hours=9))


def _to_kst(dt: "datetime") -> "datetime":
    """tz-aware(UTC 등)면 KST로 변환, naive(과거 로컬 DB 데이터)는 이미 KST로 보고 그대로 둔다."""
    return dt.astimezone(KST) if dt.tzinfo is not None else dt

logger = logging.getLogger(__name__)

MIN_HISTORY_DAYS = 14        # 이 일수 미만의 판매 기록이면 예측을 제공하지 않는다
# '요즘'의 길이 — 최근 실적 평균을 낼 때 며칠을 볼지.
# 짧으면 하루 이벤트에 기준선이 휘둘리고, 길면 내리막을 늦게 알아챈다. 2주가 요일 한 바퀴다.
BASELINE_WINDOW_DAYS = 14
# 추세를 볼 때 앞뒤로 며칠씩 견줄지 — 요일 구성이 같아야 비교가 성립하므로 7일(한 바퀴)이다.
TREND_WINDOW_DAYS = 7
MENU_MIX_WINDOW_DAYS = 14    # 메뉴별 판매 비중(발주 소요량 계산)에 쓰는 최근 기간
DEFAULT_EVENT_BOOST = 20     # 수동 입력 행사 부스팅 기본값 (%)
AUTO_EVENT_BOOST = 10        # 자동 수집 행사 1건당 부스팅 (%) — 소규모 공연이 많아 보수적으로
SEARCH_EVENT_BOOST = 5       # 검색 기반(네이버+AI 정리) 행사 부스팅 (%) — 날짜 오탐 여지가 있어 절반
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
# DB 캐시(ai_warm_cache)에서 집어 올 때 받아들일 최대 나이 — 어차피 '같은 날 만든 것'만
# 인정하므로 하루면 충분하다. 낡았어도 즉시 보여 준 뒤 백그라운드로 다시 계산한다.
_FORECAST_WARM_TTL = 24 * 3600
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


def _warm_key(key: tuple) -> str:
    """DB 캐시 키 — 메모리 캐시 키(store, lat, lon, days)를 문자열로 편다."""
    store_id, lat, lon, days = key
    return f"forecast:{store_id}:{lat}:{lon}:{days}"


def peek_forecast_cache(store_id: str, lat: Optional[float] = None, lon: Optional[float] = None,
                        days: int = 7) -> Optional[tuple[dict, bool]]:
    """(캐시된 예측, 신선 여부)를 돌려준다. 캐시가 없거나 날짜가 지났으면 None.

    이 프로세스 메모리에 없으면 DB에 남겨 둔 값을 본다. Cloud Run은 트래픽이 없으면
    인스턴스를 내리기 때문에, 사장님이 아침에 앱을 처음 켤 때는 늘 메모리가 빈 인스턴스에
    걸려 SARIMAX 적합과 외부 API 왕복을 통째로 기다려야 했다(실측 7.0초).
    DB에서 집어 온 값은 '신선하지 않음'으로 돌려주므로, 부른 쪽(엔드포인트)이 즉시 응답한 뒤
    백그라운드 재계산을 걸어 다음 조회부터 최신이 된다.
    """
    key = _forecast_key(store_id, lat, lon, days)
    today_iso = datetime.now(KST).date().isoformat()

    hit = _forecast_cache.get(key)
    if hit:
        ts, made_on, result = hit
        # 자정을 넘긴 캐시는 '내일' 날짜가 밀려 있으므로 버린다
        if made_on == today_iso:
            return result, (time.time() - ts) < _FORECAST_FRESH_TTL
        return None

    warm = warm_cache.load(_warm_key(key), _FORECAST_WARM_TTL)
    if warm is None:
        return None
    data, _age = warm
    if not isinstance(data, dict) or data.get("made_on") != today_iso:
        return None
    result = data.get("result")
    if not isinstance(result, dict) or not result:
        return None
    return result, False


def peek_any_forecast_cache(store_id: str) -> Optional[tuple[dict, bool]]:
    """좌표를 몰라도 이 매장의 오늘자 예측 캐시를 찾아 돌려준다 (없으면 None).

    캐시 키에는 좌표가 들어간다. 부르는 쪽이 매장 등록 좌표를 정확히 맞추지 못하면
    (기기 GPS를 보냈다든지, 저장된 값이 반올림됐다든지) 캐시가 있는데도 못 찾는다.
    경영 리포트처럼 '있으면 얹고 없으면 마는' 부가 정보에는 정확한 키보다 이쪽이 맞다.
    같은 매장 캐시가 여럿이면 가장 최근 것을 쓴다.
    """
    today = datetime.now(KST).date().isoformat()
    hits = [(ts, result) for (sid, *_), (ts, made_on, result) in _forecast_cache.items()
            if sid == store_id and made_on == today]
    if not hits:
        return None
    ts, result = max(hits, key=lambda h: h[0])
    return result, (time.time() - ts) < _FORECAST_FRESH_TTL


def refresh_forecast_background(store_id: str, lat: Optional[float] = None,
                                lon: Optional[float] = None, days: int = 7) -> None:
    """예측을 백그라운드에서 재계산해 캐시를 갱신한다 (BackgroundTasks용, 실패는 로그만).

    이 매장에 맞는 예측 방식 선정(백테스트)도 여기서 하루 한 번 한다 — 사용자 응답 경로에
    두면 SARIMAX를 십수 번 다시 적합하는 비용을 사장님이 기다리게 된다.

    같은 키의 재계산이 이미 돌고 있으면 겹쳐 돌지 않는다."""
    key = _forecast_key(store_id, lat, lon, days)
    with _forecast_lock:
        if key in _forecast_inflight:
            return
        _forecast_inflight.add(key)
    try:
        select_forecast_method(store_id)   # 오늘 이미 골랐으면 캐시를 그대로 쓴다
        forecast(store_id, lat=lat, lon=lon, days=days)
    except ForecastError:
        pass  # 데이터 부족 등 — 다음 정식 호출이 같은 안내를 준다
    except Exception:
        logger.exception("예측 백그라운드 갱신 실패 (%s)", store_id)
    finally:
        with _forecast_lock:
            _forecast_inflight.discard(key)


def invalidate_forecast_cache(store_id: str) -> None:
    """해당 매장의 예측 캐시를 비운다 — 판매 기록처럼 원천 데이터가 바뀐 직후 호출.

    DB에 남긴 값까지 함께 지운다. 여기를 빠뜨리면 새 판매를 넣어도 다음 인스턴스가
    옛 예측을 집어 와서 "매출을 입력했는데 예측이 그대로"가 된다.
    """
    for k in [k for k in _forecast_cache if k[0] == store_id]:
        _forecast_cache.pop(k, None)
    warm_cache.drop_prefix(f"forecast:{store_id}:")

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
    daily = daily[daily.index.date < today_kst()]
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

def _forecast_sarimax(series, horizon: int, ctx=None):
    """SARIMAX(1,0,1)×(1,0,1,7) — 주간 계절성 시계열 예측. 실패하면 None.

    ctx는 외생변수(날씨·공휴일) 방식만 쓴다 — 모든 방식이 같은 시그니처를 갖도록
    받기만 하고 무시한다 (백테스트·forecast가 방식을 표에서 골라 동일하게 호출한다).
    """
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


def _forecast_seasonal(series, horizon: int, ctx=None):
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


LEVEL_WINDOW = 14  # '지금 매장 수준'을 볼 최근 유효 영업일 수


def _weekday_factors(series) -> dict[int, float]:
    """요일 계수 = (그날 값 ÷ 그 시기의 지역 수준)의 요일별 중앙값.

    요일 평균을 그냥 쓰면 매출 수준이 바뀐 구간이 섞였을 때 계수가 오염된다.
    지역 수준(중심 7일 이동 중앙값)으로 나눠 두면 수준 변화가 약분되어, 6월에 하루
    400잔 팔던 매장과 7월에 80잔 팔던 매장이 같은 '토요일은 평일의 0.6배' 계수를 준다.
    """
    import numpy as np

    s = series.astype(float)
    local = s.rolling(LOCAL_WINDOW, center=True, min_periods=3).median()
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(local.to_numpy() > 0, s.to_numpy() / local.to_numpy(), np.nan)
    weekdays = s.index.dayofweek.to_numpy()

    factors = {}
    for wd in range(7):
        m = (weekdays == wd) & ~np.isnan(ratio)
        factors[wd] = float(np.median(ratio[m])) if m.any() else 1.0
    return {wd: (f if f > 0 else 1.0) for wd, f in factors.items()}


def _forecast_local_level(series, horizon: int, ctx=None):
    """최근 수준(로버스트) × 요일 계수 — 매출 수준이 한 번 바뀐 매장에 강한 방식.

    SARIMAX는 학습 구간 전체의 평균으로 끌려가서, 리모델링·상권 변화·시드 교체처럼
    수준이 계단식으로 바뀐 데이터에서 옛 수준을 한참 끌고 온다(실측 bias +34%).
    여기서는 '지금 수준'을 최근 LEVEL_WINDOW일의 중앙값으로만 잡으므로 옛 구간이
    아무리 길어도 예측에 섞이지 않는다. 중앙값이라 하루짜리 이상치에도 흔들리지 않는다.
    """
    import numpy as np

    s = series.astype(float)
    if int(s.notna().sum()) < 7:
        return None  # 요일 계수를 만들 수 없다 — 호출자가 다른 방식으로 폴백한다

    factors = _weekday_factors(s)
    values = s.to_numpy(dtype=float)
    weekdays = s.index.dayofweek.to_numpy()

    # 요일 효과를 걷어낸 '수준' 표본 — 최근 것만 쓴다
    deseasonalized = [values[i] / factors[weekdays[i]]
                      for i in range(len(values)) if not np.isnan(values[i])]
    if not deseasonalized:
        return None
    level = float(np.median(deseasonalized[-LEVEL_WINDOW:]))

    last_day = series.index[-1]
    return [max(0.0, level * factors[(last_day + timedelta(days=i + 1)).dayofweek])
            for i in range(horizon)]


SHIFT_MIN_RATIO = 1.6     # 앞뒤 수준이 이 배수 이상 벌어지면 구조적 단절로 본다
SHIFT_WINDOW = 7          # 단절 판정에 쓸 앞뒤 비교 창
SHIFT_MIN_SEGMENT = 14    # 단절 이후 최소 이만큼 남아야 그 구간만으로 학습한다


def _detect_level_shift(series) -> Optional[int]:
    """매출 수준이 계단식으로 바뀐 가장 최근 지점의 인덱스. 없으면 None.

    리모델링·이전·경쟁점 개업·상권 변화처럼 매장의 기준 매출 자체가 바뀌면, 그 이전
    데이터는 더 이상 같은 매장의 이야기가 아니다. 그런데 시계열 모델은 학습 구간 전체
    평균으로 끌려가므로 옛 수준을 몇 주씩 끌고 온다 — 실측에서 이것 하나가 WAPE를
    18%에서 70%대로 밀어 올렸다. 피처를 아무리 더해도 고쳐지지 않는 종류의 오차다.

    앞뒤 SHIFT_WINDOW일의 중앙값을 비교해 SHIFT_MIN_RATIO배 이상 벌어지는 지점을 찾고,
    그런 지점이 여럿이면 '가장 최근' 것을 쓴다(지금 매장 상태에 가장 가까운 구간만 남긴다).
    중앙값으로 재기 때문에 하루짜리 이상치나 휴무에는 반응하지 않는다.
    """
    import numpy as np

    values = series.to_numpy(dtype=float)
    n = len(values)
    if n < SHIFT_WINDOW + SHIFT_MIN_SEGMENT:
        return None  # 잘라 봐야 학습할 게 안 남는다

    # 뒤에서부터 훑어 가장 최근 단절을 찾는다
    for t in range(n - SHIFT_MIN_SEGMENT, SHIFT_WINDOW - 1, -1):
        before = values[max(0, t - SHIFT_WINDOW):t]
        after = values[t:t + SHIFT_WINDOW]
        before, after = before[~np.isnan(before)], after[~np.isnan(after)]
        if len(before) < 3 or len(after) < 3:
            continue
        mb, ma = float(np.median(before)), float(np.median(after))
        if mb <= 0 or ma <= 0:
            continue
        if max(mb, ma) / min(mb, ma) >= SHIFT_MIN_RATIO:
            return t
    return None


def _truncate_at_level_shift(series):
    """가장 최근 레벨 단절 이후 구간만 남긴 시계열. 단절이 없으면 원본 그대로."""
    cut = _detect_level_shift(series)
    if cut is None:
        return series
    logger.info("매출 수준 단절 감지 — %s 이후 %d일만 학습에 사용",
                series.index[cut].date().isoformat(), len(series) - cut)
    return series.iloc[cut:]


def _forecast_blend_shift(series, horizon: int, ctx=None):
    """레벨 단절을 감지해 그 이후 구간만으로 앙상블 예측한다 (기본 경로)."""
    return _forecast_blend(_truncate_at_level_shift(series), horizon)


def _forecast_blend(series, horizon: int, ctx=None):
    """SARIMAX와 '최근 수준×요일 계수'의 평균.

    둘은 틀리는 방향이 다르다 — SARIMAX는 옛 수준을 끌고 와 과대예측하고, 지역 수준
    방식은 추세를 못 따라가 반응이 늦다. 오차가 상쇄되는 조합이라 단순 평균만으로도
    각각보다 나은 경우가 많다(예측 앙상블의 고전적 결과). 한쪽이 실패하면 나머지를 쓴다.
    """
    a = _forecast_sarimax(series, horizon)
    b = _forecast_local_level(series, horizon)
    if a is None:
        return b
    if b is None:
        return a
    return [(x + y) / 2 for x, y in zip(a, b)]


def _forecast_weekday_naive(series, horizon: int, ctx=None):
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
# 2.5) 외생변수 예측 — 과거 실측 날씨·공휴일을 모델 '입력'으로 학습한다
# ---------------------------------------------------------------------------
# 기존 날씨 반영은 예측이 끝난 뒤 고정 배율(비 -10%, 폭염 +5%)을 곱하는 사후 보정이라
# '이 매장이 비에 얼마나 민감한지'를 데이터에서 배우지 못한다. 여기서는 과거 실측
# 날씨(Open-Meteo 아카이브·최근 92일, 키 불필요)와 공휴일을 SARIMAX 외생변수로 넣어
# 매장별 민감도를 회귀로 학습한다. 이 방식(blend_exog)도 _METHODS에 등록만 하고,
# 채택 여부는 매장별 백테스트(select_forecast_method)가 결정한다 — 피처는 측정으로만
# 살아남는다 (실측: 날씨 반응이 없는 시드 매장에서는 기본 앙상블을 이기지 못한다).

RAIN_MM = 1.0        # 일 강수량이 이 이상이면 '비 온 날'
HOT_TEMP_C = 30.0    # 최고기온이 이 이상이면 '폭염일' (사후 보정과 같은 기준)
_weather_flags_cache: dict[tuple, tuple[float, dict]] = {}
_WEATHER_FLAGS_TTL = 6 * 3600


def _fetch_weather_flags(lat: float, lon: float, start: date, end: date) -> dict[str, tuple[bool, bool]]:
    """[start, end] 구간의 일별 (비 왔나, 폭염이었나) 플래그. 실패하면 빈 dict.

    과거는 실측을 쓴다 — 예보 API가 past_days=92까지 실측 병합값을 주므로 한 번에
    미래(예보)까지 같은 단위(precipitation_sum)로 받고, 그보다 오래된 구간만
    아카이브 API(ERA5, ~5일 지연)로 보충한다. 아카이브 값이 있으면 그쪽을 우선한다.
    """
    import requests

    key = (round(lat, 3), round(lon, 3), start.isoformat(), end.isoformat())
    hit = _weather_flags_cache.get(key)
    if hit and time.time() - hit[0] < _WEATHER_FLAGS_TTL:
        return hit[1]

    out: dict[str, tuple[bool, bool]] = {}

    def ingest(js: dict) -> None:
        d = js.get("daily") or {}
        times = d.get("time") or []
        precips = d.get("precipitation_sum") or []
        temps = d.get("temperature_2m_max") or []
        for i, iso in enumerate(times):
            if iso in out:
                continue  # 먼저 넣은(더 정확한) 소스를 우선한다
            precip = precips[i] if i < len(precips) else None
            tmax = temps[i] if i < len(temps) else None
            out[iso] = ((precip or 0) >= RAIN_MM,
                        tmax is not None and tmax >= HOT_TEMP_C)

    today = today_kst()
    daily_vars = "temperature_2m_max,precipitation_sum"
    # 1) 예보 API의 과거 병합 한계(92일)보다 오래된 구간 — 아카이브에서
    if start < today - timedelta(days=92):
        try:
            r = requests.get(
                "https://archive-api.open-meteo.com/v1/archive",
                params={"latitude": lat, "longitude": lon, "timezone": "Asia/Seoul",
                        "start_date": start.isoformat(),
                        "end_date": min(end, today - timedelta(days=6)).isoformat(),
                        "daily": daily_vars},
                timeout=8,
            )
            r.raise_for_status()
            ingest(r.json())
        except Exception:
            logger.warning("날씨 아카이브 조회 실패 — 최근 92일 실측만으로 계속", exc_info=True)
    # 2) 최근 과거(실측 병합) + 미래(예보) — 예보 API 한 번
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lon, "timezone": "Asia/Seoul",
                    "past_days": min(92, max(0, (today - start).days)),
                    "forecast_days": min(16, max(1, (end - today).days + 1)),
                    "daily": daily_vars},
            timeout=8,
        )
        r.raise_for_status()
        ingest(r.json())
    except Exception:
        logger.warning("날씨 이력 조회 실패 — 외생변수 없이 계속", exc_info=True)

    if out:
        _weather_flags_cache[key] = (time.time(), out)
    return out


def _store_coords(db, store_id: str) -> Optional[tuple[float, float]]:
    """매장 고정 좌표(users.store_lat/lon). 없으면 None — 날씨 외생변수를 포기한다."""
    try:
        from app.models.user import User

        row = (db.query(User.store_lat, User.store_lon)
               .filter(User.email == store_id).first())
        if row and row[0] is not None and row[1] is not None:
            return float(row[0]), float(row[1])
    except Exception:
        logger.warning("매장 좌표 조회 실패 (%s)", store_id, exc_info=True)
    return None


def _forecast_sarimax_exog(series, horizon: int, ctx=None):
    """SARIMAX + 외생변수(비·폭염·공휴일 더미). ctx에 날씨가 없거나 실패하면 None.

    백테스트에서는 검증 구간의 '미래' 날씨도 실측이 들어간다 — 완벽한 예보를 가정하는
    셈이라 약간 낙관적인 채점이지만, 1~7일 강수 예보 적중률이 높아 순위를 뒤집을
    수준은 아니다. 전 구간이 상수인 더미(예: 여름이라 폭염일이 없음)는 회귀가
    식별되지 않으므로 빼고 적합한다.
    """
    if not ctx or not ctx.get("flags"):
        return None
    import numpy as np

    flags = ctx["flags"]

    def row(d: date) -> list[float]:
        iso = d.isoformat()
        rain, hot = flags.get(iso, (False, False))
        return [1.0 if rain else 0.0, 1.0 if hot else 0.0,
                1.0 if holiday_name(iso) else 0.0]

    train_days = [d.date() for d in series.index]
    last = series.index[-1]
    future_days = [(last + timedelta(days=i + 1)).date() for i in range(horizon)]
    X = np.asarray([row(d) for d in train_days], dtype=float)
    Xf = np.asarray([row(d) for d in future_days], dtype=float)
    keep = [j for j in range(X.shape[1]) if float(X[:, j].std()) > 0]
    if not keep:
        return None  # 학습 구간에 비도 폭염도 공휴일도 없었다 — 배울 게 없다
    X, Xf = X[:, keep], Xf[:, keep]

    try:
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        model = SARIMAX(series.astype(float), exog=X, order=(1, 0, 1),
                        seasonal_order=(1, 0, 1, 7),
                        enforce_stationarity=False, enforce_invertibility=False)
        fitted = model.fit(disp=False, maxiter=200)
        pred = fitted.forecast(steps=horizon, exog=Xf)
        return [max(0.0, float(v)) for v in pred]
    except Exception:
        logger.warning("SARIMAX(외생변수) 적합 실패", exc_info=True)
        return None


def _forecast_blend_exog(series, horizon: int, ctx=None):
    """레벨단절 절단 + (외생변수 SARIMAX와 최근수준의 앙상블).

    날씨를 못 구하면 None을 돌려준다 — 조용히 blend_shift와 같은 값을 내면 방식 선정
    표에 같은 성적의 쌍둥이가 생겨 비교가 흐려진다. 폴백은 호출자가 명시적으로 한다.
    """
    s = _truncate_at_level_shift(series)
    a = _forecast_sarimax_exog(s, horizon, ctx)
    if a is None:
        return None
    b = _forecast_local_level(s, horizon)
    return a if b is None else [(x + y) / 2 for x, y in zip(a, b)]


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
# 3.5) 주변 행사 자동 수집 — 네이버 검색(전국) + TourAPI(전국) + 서울 열린데이터광장
# ---------------------------------------------------------------------------

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 좌표 사이 거리(km)."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def _cut_title(text: str, limit: int = 50) -> str:
    """행사 제목 길이 제한 — 단어 중간에서 자르지 않는다.

    그냥 [:40]으로 자르면 "…[행복맘껏time] 두 번째 일요"처럼 말이 끊긴 채 알림 제목과
    지도 카드에 그대로 나간다. 한도를 넘으면 마지막 공백까지만 남기고, 남는 게 너무
    짧아지면(한 단어가 긴 경우) 그냥 자른다.
    """
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space >= limit // 2 else cut).rstrip()


def _fetch_events_tourapi(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """한국관광공사 TourAPI(KorService2) 축제·행사 — **전국** 커버.
    TOUR_API_KEY(data.go.kr '한국관광공사 국문 관광정보 서비스 GW' 무료 발급) 필요.

    행사 기간(eventstartdate~eventenddate)이 예측 기간과 겹치고 매장 반경 안이면
    날짜별 이벤트로 펼친다. 진행 중인 장기 행사를 놓치지 않도록 120일 전 시작분부터 조회.
    실패하거나 키가 없으면 빈 목록 — 예측은 계속한다.
    """
    import requests

    api_key = os.getenv("TOUR_API_KEY", "").strip()
    if not api_key:
        return []
    # data.go.kr 마이페이지는 Encoding 키와 Decoding 키를 나란히 보여준다. Encoding 키
    # (…%2B…%3D%3D)를 그대로 넣으면 requests가 params를 인코딩하며 '%'를 '%25'로 한 번 더
    # 감싸 인증이 깨진다 — base64 키에 '%'가 들어갈 일은 없으므로 있으면 되돌린다.
    if "%" in api_key:
        import urllib.parse
        api_key = urllib.parse.unquote(api_key)
    try:
        r = requests.get(
            # KorService2/searchFestival2 — 구버전(KorService1/searchFestival1)은 2026-08-07
            # 실측에서 HTTP 400으로 응답이 끊겼다. 응답 필드명은 구버전과 동일해서
            # (title·eventstartdate·eventenddate·mapx·mapy·addr1) 아래 파싱은 그대로 쓴다.
            "https://apis.data.go.kr/B551011/KorService2/searchFestival2",
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
        title = _cut_title(row.get("title") or "행사")
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

    # 빈 문자열도 '없음'으로 본다 — env.yaml에 자리만 만들어 두고 값을 비워 두면
    # getenv의 기본값이 먹지 않아 URL이 ".../8088//json/..."이 되어 서울 행사가 통째로
    # 사라진다(샘플 키로라도 5건은 나오던 것이 0건이 된다).
    api_key = os.getenv("SEOUL_OPENAPI_KEY", "").strip() or "sample"
    limit = 5 if api_key == "sample" else 500
    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def fetch_day(d: str) -> list[dict[str, Any]]:
        try:
            # 경로 파라미터: 시작/끝/분류(공백=전체)/제목(공백=전체)/날짜
            r = requests.get(
                f"http://openapi.seoul.go.kr:8088/{api_key}/json/culturalEventInfo/1/{limit}/%20/%20/{d}",
                timeout=6,
            )
            return r.json().get("culturalEventInfo", {}).get("row", [])
        except Exception:
            logger.warning("행사 API 조회 실패 (%s) — 해당 일자 행사 없이 계속", d, exc_info=True)
            return []

    # 이 API는 날짜 하나당 호출 하나다. 지도 화면은 2주치를 물어보므로 순차로 돌면
    # 14번을 줄 세우게 된다 → 병렬로 던지고 결과는 날짜 순서대로 합친다(중복 판정 순서 유지).
    day_isos = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="seoul-event") as pool:
        per_day = list(pool.map(fetch_day, day_isos))

    for d, rows in zip(day_isos, per_day):
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
            title = _cut_title(row.get("TITLE") or "행사")
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


_EVENT_EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "start_date": {"type": "string"},   # YYYY-MM-DD
                    "end_date": {"type": "string"},     # YYYY-MM-DD
                    "place": {"type": "string"},        # 지오코딩 가능한 구체 장소
                },
                "required": ["name", "start_date", "end_date", "place"],
            },
        },
    },
    "required": ["events"],
}


def _fetch_events_naver(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """네이버 검색 + Gemini 정리 — **전국** 커버. 이미 있는 키(NAVER_*, GEMINI_*)로 동작한다.

    공공 API(TourAPI)는 data.go.kr 키가 있어야 하고 관 주도 축제 위주라 팝업·야시장·플리마켓
    같은 실제 손님을 몰고 오는 행사는 빠진다. 여기서는
      매장 지역명(역지오코딩) → 네이버 뉴스·블로그 검색 → Gemini가 (행사명·기간·장소)로 정리
      → 장소를 지오코딩해 반경 EVENT_RADIUS_KM 밖은 버림
    순으로 모은다. 검색 글에서 뽑은 값이라 날짜가 어긋날 수 있어 부스팅은 절반
    (SEARCH_EVENT_BOOST)만 준다. 키가 없거나 실패하면 빈 목록 — 예측은 계속한다.
    """
    from app.services.ai.nearby_cafe_service import _gemini_json, _search_naver, _strip_tags
    from app.services.ai.untrusted import quote_untrusted

    region = _reverse_geocode(lat, lon)
    if region.startswith("위도"):   # 역지오코딩 실패 — 검색 키워드를 만들 수 없다
        return []
    parts = region.split()
    sigungu = " ".join(parts[:2]) if len(parts) >= 2 else region
    dong = " ".join(parts[1:3]) if len(parts) >= 3 else sigungu
    end = start + timedelta(days=days - 1)

    # 검색 스니펫 수집 — 뉴스(최신 일정 공지)와 블로그(팝업·플리마켓 후기)를 함께 본다
    snippets: list[str] = []
    seen_titles: set[str] = set()
    for query, endpoint, sort in ((f"{sigungu} 축제 행사 일정", "news", "date"),
                                  (f"{dong} 축제 팝업 플리마켓", "blog", "date")):
        for it in _search_naver(endpoint, query, 10, sort):
            title = _strip_tags(it.get("title", ""))
            if not title or title in seen_titles:
                continue
            seen_titles.add(title)
            desc = _strip_tags(it.get("description", ""))
            pub = (it.get("pubDate") or it.get("postdate") or "")[:20]
            snippets.append(f"- [{pub}] {title} :: {desc}"[:400])
    if not snippets:
        return []

    prompt = (
        f"오늘은 {today_kst().isoformat()}, 매장 위치는 '{region}'이다.\n"
        f"아래는 이 지역 행사 관련 뉴스·블로그 검색 결과다. 여기서 "
        f"{start.isoformat()}~{end.isoformat()} 기간에 열리는 행사만 골라 정리하라.\n\n"
        "규칙:\n"
        "1. 글에 시작·종료 날짜가 명시된 행사만 넣는다. 날짜가 없거나 추측해야 하면 제외.\n"
        "2. 연도가 없으면 오늘 기준 가장 가까운 연도로 본다.\n"
        f"3. '{sigungu}' 안에서 열리는 행사만. 다른 지역 행사는 제외.\n"
        "4. 상설 전시장·카페·맛집 소개, 광고성 글, 온라인 전용 행사는 제외.\n"
        "5. place는 지오코딩할 수 있는 구체 장소명(공원·광장·역·거리·건물)으로. "
        "장소를 모르면 그 행사는 제외.\n"
        "6. 해당하는 행사가 없으면 events는 빈 배열로.\n\n"
        f"{quote_untrusted(chr(10).join(snippets[:30]), max_len=6000)}"
    )
    data = _gemini_json(prompt, _EVENT_EXTRACT_SCHEMA, timeout=20.0)
    if not data:
        return []

    events: list[dict[str, Any]] = []
    for row in (data.get("events") or [])[:8]:   # 지오코딩 호출을 아끼려고 상위 8건까지만
        name = _cut_title(str(row.get("name") or ""))
        place = str(row.get("place") or "").strip()[:30]
        if not (name and place):
            continue
        try:
            ev_start = date.fromisoformat(str(row.get("start_date")))
            ev_end = date.fromisoformat(str(row.get("end_date")))
        except (TypeError, ValueError):
            continue
        if ev_end < start or ev_start > end:
            continue
        # 한 달 넘게 이어지는 건 상설 전시·기간 프로모션에 가깝다 — 하루 손님을 몰아주지 않는다
        if (ev_end - ev_start).days > 30:
            continue
        # 장소가 행정구역명뿐이면(예: "서울특별시 서초구") 구청 좌표로 잡혀 반경 판정이 무의미하다
        if not re.sub(r"[가-힣A-Za-z0-9]+(?:특별시|광역시|특별자치시|특별자치도|[시군구도])(?=\s|$)",
                      "", place).strip():
            continue

        hit = geocode(f"{sigungu} {place}") or geocode(place)
        if not hit:
            continue
        dist = _haversine_km(lat, lon, hit["lat"], hit["lon"])
        if dist > EVENT_RADIUS_KM:
            continue
        for i in range(days):
            d = start + timedelta(days=i)
            if ev_start <= d <= ev_end:
                events.append({
                    "name": name,
                    "date": d.isoformat(),
                    "boost_pct": SEARCH_EVENT_BOOST,
                    "distance_km": round(dist, 1),
                    "place": place,
                    "source": "네이버 검색",
                    "lat": hit["lat"],
                    "lon": hit["lon"],
                })
    return events


def _event_key(ev: dict[str, Any]) -> tuple[str, str]:
    """중복 제거용 키 — 소스마다 띄어쓰기가 달라 공백을 없앤 제목 + 날짜로 본다."""
    return (re.sub(r"\s+", "", ev.get("name", "")), ev.get("date", ""))


def _fetch_nearby_events(lat: float, lon: float, start: date, days: int) -> list[dict[str, Any]]:
    """예측 기간 내 매장 반경 EVENT_RADIUS_KM의 행사를 날짜별로 수집한다.

    세 소스를 합친다 — 날짜·좌표가 정확한 순서대로 넣고 (제목, 날짜)로 중복을 제거한다.
      1) TourAPI 전국 축제 (TOUR_API_KEY 있을 때만)
      2) 서울 열린데이터광장 문화행사 (서울 매장 한정, 키 없이도 샘플 동작)
      3) 네이버 검색 + Gemini 정리 (전국, 기존 키로 동작 — 공공 API가 놓친 팝업·플리마켓)
    한 소스가 죽어도 나머지로 계속 간다.
    """
    cache_key = f"{round(lat, 3)},{round(lon, 3)},{start.isoformat()},{days}"
    cached = _event_cache.get(cache_key)
    if cached and time.time() - cached[0] < _EVENT_CACHE_TTL:
        return cached[1]

    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for fetch in (_fetch_events_tourapi, _fetch_events_seoul, _fetch_events_naver):
        try:
            found = fetch(lat, lon, start, days)
        except Exception:
            logger.warning("행사 수집 실패 (%s) — 나머지 소스로 계속", fetch.__name__, exc_info=True)
            continue
        for ev in found:
            key = _event_key(ev)
            if key in seen:
                continue
            seen.add(key)
            events.append(ev)

    _event_cache[cache_key] = (time.time(), events)
    return events


# ---------------------------------------------------------------------------
# 4) 일자별 보정 — 날씨·공휴일·행사
# ---------------------------------------------------------------------------

def _day_adjustment(day_iso: str, weather: dict, events: list[dict],
                    skip_weather: bool = False) -> tuple[float, list[str]]:
    """해당 일자의 보정 배율과 근거 목록을 돌려준다.

    skip_weather: 날씨를 이미 모델 외생변수로 학습한 방식(blend_exog)이 쓴다 —
    같은 비를 회귀로 한 번, 고정 배율로 또 한 번 반영하지 않기 위해서다.
    """
    factor, reasons = 1.0, []

    w = weather.get(day_iso)
    if w and skip_weather:
        if (w["precip_prob"] or 0) >= 60 or (w["temp_max"] or 0) >= 30:
            reasons.append("날씨 영향은 예측 모델이 과거 실측으로 학습해 반영")
    elif w:
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

def _order_recommendations(db, store_id: str, week_cups: float, days: int = 7) -> list[dict[str, Any]]:
    """예상 잔 수를 메뉴 비중으로 나누고 레시피로 재료 소요량을 계산해 발주를 추천한다.

    days는 week_cups가 **며칠치 합계인지**다. 예전엔 이 값을 받지 않고 무조건 7로 나눠서,
    forecast(days=14)로 부르면 소진일이 절반으로(재고 10,000g·실제 5일치가 2.5일로) 나오고
    발주량은 14일치가 추천됐다. days=1이면 반대로 소요가 1일치라 shortage가 0 이하가 되어
    발주 추천이 통째로 사라졌다. 화면·챗봇 모두 days를 사용자가 1~14로 지정할 수 있다.
    """
    from app.models.inventory import Ingredient, Recipe, Sale, Stock

    since = today_kst() - timedelta(days=MENU_MIX_WINDOW_DAYS)
    mix_rows = (
        db.query(Sale.menu_id, Sale.quantity)
        .filter(Sale.store_id == store_id,
                Sale.sold_at >= datetime.combine(since, dtime.min, tzinfo=KST))
        .all()
    )
    # 비중은 '건수'가 아니라 '잔 수'로 나눠야 한다. 한 건에 2잔씩 팔리는 메뉴와
    # 1잔씩 팔리는 메뉴가 같은 건수면 예전 계산은 50:50으로 봤지만 실제 소요는 67:33이라,
    # 많이 팔리는 쪽 재료를 그만큼 적게 발주했다.
    total = float(sum(q or 0 for _, q in mix_rows))
    if total <= 0:
        return []
    menu_share: dict[int, float] = {}
    for menu_id, qty in mix_rows:
        menu_share[menu_id] = menu_share.get(menu_id, 0) + (qty or 0) / total

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
        daily_use = needed / max(days, 1)
        shortage = needed + safety - current
        if shortage <= 0:
            continue  # 금주 소요 + 안전재고를 지금 재고로 감당 가능
        suggested = round(shortage, 1)
        recs.append({
            # 알림을 눌렀을 때 그 재료 화면으로 보내려면 이름만으로는 부족하다 (동명이인 재료·검색 실패)
            "ingredient_id": ing_id,
            "ingredient": ing.name,
            "unit": ing.unit,
            "current_quantity": current,
            "safety_quantity": safety,
            # 이름은 프론트 계약(forecast.ts)이라 유지한다. days≠7이면 7일치가 아니므로
            # 실제 며칠치인지 forecast_days로 함께 준다 — 화면·챗봇이 문구를 맞출 수 있게.
            "forecast_usage_7d": round(needed, 1),
            "forecast_days": days,
            "days_until_stockout": round(current / daily_use, 1) if daily_use > 0 else None,
            "suggested_quantity": suggested,
            "estimated_amount": round(suggested * ing.current_price),
            "reason": (f"{days}일 예상 소요 {round(needed, 1)}{ing.unit} "
                       f"대비 재고 {current}{ing.unit}"),
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

    since = (today_kst() - timedelta(days=60)).isoformat()
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

    since = (today_kst() - timedelta(days=60)).isoformat()
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

    today = today_kst()
    yesterday = today - timedelta(days=1)
    last_week = today - timedelta(days=7)

    rows = (
        db.query(Sale.sold_at, Sale.quantity, Sale.total_price)
        # sold_at은 timestamptz라 날짜 문자열을 주면 UTC 자정으로 캐스팅된다 — 그러면
        # 그날 KST 00:00~08:59 판매가 아예 조회되지 않아 '지난주 같은 요일' 비교 기준선만
        # 한쪽으로 눌린다(07시 오픈 카페는 오늘과 매출이 같아도 +33% 증가로 표시).
        # 이 파일 265행 주석이 같은 함정을 이미 지적하고 있다.
        .filter(Sale.store_id == store_id,
                Sale.sold_at >= datetime.combine(last_week, dtime.min, tzinfo=KST))
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
    "seasonal": ("요일평균×추세 (폴백)", _forecast_seasonal),
    "sarimax": ("SARIMAX(1,0,1)×(1,0,1,7) 단독", _forecast_sarimax),
    "local_level": ("최근 수준×요일 계수", _forecast_local_level),
    "blend": ("SARIMAX+최근수준 앙상블", _forecast_blend),
    "blend_shift": ("앙상블 + 레벨단절 절단 (현재 기본)", _forecast_blend_shift),
    "blend_exog": ("앙상블 + 날씨·공휴일 회귀 (레벨단절 절단)", _forecast_blend_exog),
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
        coords = _store_coords(db, store_id) if raw is not None else None
    if raw is None:
        raise ForecastError("판매 기록이 없어 백테스트할 수 없습니다.")

    # 외생변수(날씨·공휴일) 컨텍스트 — 좌표가 없거나 조회에 실패하면 None.
    # 그러면 blend_exog는 채점에서 빠지고(None 반환), 나머지 방식은 영향받지 않는다.
    ctx = None
    if coords:
        flags = _fetch_weather_flags(coords[0], coords[1],
                                     raw.index.min().date(), raw.index.max().date())
        if flags:
            ctx = {"flags": flags}

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
                cups_pred = fn(train_df["cups"], horizon, ctx)
                price = _recent_avg_price(train_df)
                pred = ([c * price for c in cups_pred]
                        if cups_pred is not None and price else None)
            else:
                pred = fn(train_df[target], horizon, ctx)
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
# 6.5) 매장별 예측 방식 자동 선정 — 어느 방식이 나은지는 매장마다 다르다
# ---------------------------------------------------------------------------

DEFAULT_METHOD = "blend_shift"   # 선정 전·자료 부족 시 쓰는 기본값 (최악의 경우가 가장 안전한 방식)
MIN_SWITCH_GAIN_PP = 1.0         # 기본값을 갈아치우려면 WAPE가 이만큼(%p)은 나아야 한다

# store_id → (선정한 날짜 ISO, 방식 키). 하루 한 번만 다시 고른다 —
# 백테스트는 SARIMAX를 fold 수만큼 다시 적합하므로 요청마다 돌릴 수 있는 비용이 아니다.
_method_cache: dict[str, tuple[str, str]] = {}


def peek_forecast_method(store_id: str) -> str:
    """이 매장에 쓸 예측 방식. 아직 고른 적 없으면 기본값 (절대 블로킹하지 않는다)."""
    hit = _method_cache.get(store_id)
    if hit and hit[0] == datetime.now(KST).date().isoformat():
        return hit[1]
    return DEFAULT_METHOD


def select_forecast_method(store_id: str) -> str:
    """백테스트를 돌려 이 매장에 가장 잘 맞는 예측 방식을 고르고 캐시한다.

    실측에서 방식 간 우열이 매장마다 뒤집혔다 — 매출 수준이 안정된 매장은 '요일평균×추세'가
    (잔 수 WAPE 12.5% vs 앙상블 12.6%), 수준이 한 번 바뀐 매장은 앙상블이 크게 앞섰다
    (18.0% vs 22.3%). 어느 하나를 정답으로 박아 두는 대신 매장 데이터에 물어본다.

    다만 근소한 차이로 갈아타면 그날그날 방식이 바뀌어 예측이 널뛴다. 기본값보다
    MIN_SWITCH_GAIN_PP 이상 나을 때만 바꾼다 — 노이즈를 쫓지 않기 위한 이력(hysteresis)이다.
    잔 수 기준으로만 고른다(매출은 잔 수 × 객단가로 파생되므로 같은 선택을 따라간다).

    채점 구간은 실제로 학습에 쓸 구간과 같아야 한다. 레벨 단절이 있는데 그 이전까지
    포함해 채점하면, '다시는 오지 않을 단절'에 우연히 잘 대응한 방식이 뽑힌다 — 실제로
    그렇게 뽑힌 SARIMAX 단독이 하루 61잔을 예측했다(같은 시점 실제 74잔, 기본값은 73잔).
    단절 이후가 채점하기에 너무 짧으면 고르지 않고 기본값을 쓴다.
    """
    today = datetime.now(KST).date().isoformat()
    hit = _method_cache.get(store_id)
    if hit and hit[0] == today:
        return hit[1]

    chosen = DEFAULT_METHOD
    try:
        from app.services.ai.document_service import _session

        with _session() as db:
            series = _load_daily_series(db, store_id)
        since = None
        if series is not None:
            shift_at = _detect_level_shift(series["cups"])
            if shift_at is not None:
                since = series.index[shift_at].date().isoformat()

        report = backtest(store_id, target="cups", horizon=7, folds=3, since=since)
        scored = [r for r in report["results"] if r["masked"] and not r.get("derived")]
        by_method = {r["method"]: r for r in scored}
        best = min(scored, key=lambda r: r["wape_pct"]) if scored else None
        base = by_method.get(DEFAULT_METHOD)
        if best and base and best["method"] != DEFAULT_METHOD:
            if base["wape_pct"] - best["wape_pct"] >= MIN_SWITCH_GAIN_PP:
                chosen = best["method"]
        elif best and not base:
            chosen = best["method"]
        logger.info("[%s] 예측 방식 선정: %s (기본 %s 대비 %s)", store_id, chosen, DEFAULT_METHOD,
                    f"{base['wape_pct'] - by_method[chosen]['wape_pct']:+.1f}%p"
                    if base and chosen in by_method else "비교 불가")
    except ForecastError:
        pass  # 자료가 부족해 채점을 못 한다 — 기본값을 쓴다
    except Exception:
        logger.exception("[%s] 예측 방식 선정 실패 — 기본값 사용", store_id)

    _method_cache[store_id] = (today, chosen)
    return chosen


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
                # 위와 같은 이유로 KST 경계를 명시한다. 예전엔 UTC 자정으로 잘려
                # 다음 달 1일 오전(KST) 매출이 조회에 섞이고, 아래 버킷 루프에 상한
                # 검사가 없어 '1일' 칸에 그대로 가산됐다(지난달을 볼 때만 터진다).
                Sale.sold_at >= datetime.combine(prev_first, dtime.min, tzinfo=KST),
                Sale.sold_at < datetime.combine(next_first, dtime.min, tzinfo=KST),
            )
            .all()
        )

    today = today_kst()
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
        # 상한(next_first)도 반드시 본다 — 하한만 검사하면 다음 달 1일 판매가 d.day == 1로
        # 이번 달 1일 칸에 얹힌다. 쿼리 경계를 KST로 고쳤어도 이 검사는 남겨 둔다
        # (조회 범위와 버킷 범위는 각각 스스로 옳아야 한다).
        if first <= d < next_first:
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
                "(POS 동기화 또는 매출 입력을 계속해 주세요)")

        # 예측 시작일은 실제 '내일'로 고정한다 — 마지막 판매일 다음 날로 잡으면
        # 매출 입력이 며칠 끊겼을 때 '내일 예측'이 과거 날짜의 예측이 되어버린다.
        # 공백(gap)만큼 예측 스텝을 더 뽑고, 실제 내일 이후 구간만 잘라 쓴다.
        # 기준은 '마지막으로 실제 판매가 있던 날' — 꼬리의 결측(휴무)을 마지막 날로 잡으면
        # 없는 공백을 만들어 낸다.
        last_sale_day = series.index[series["cups"].notna()][-1].date()
        # 모델은 시계열의 마지막 인덱스 다음 날부터 예측을 내놓는다. 꼬리가 결측(휴무)이면
        # 그 날짜는 마지막 '판매일'과 다르므로, 잘라낼 구간은 시계열 끝을 기준으로 세야 한다.
        series_end = series.index[-1].date()
        start = max(today_kst(), series_end) + timedelta(days=1)
        gap = (start - series_end).days - 1
        # '판매 공백'은 오늘 이전의 무판매일만 센다 — 시계열은 오늘(미완성 집계)을 항상
        # 제외하므로 start 기준으로 세면 어제까지 데이터가 멀쩡해도 매일 '1일 공백'이 찍힌다
        sales_gap = max(0, (today_kst() - last_sale_day).days - 1)
        if sales_gap > 90:
            raise ForecastError(
                f"마지막 판매 기록({last_sale_day.isoformat()})이 {sales_gap}일 전이라 예측 정확도를 보장할 수 없어요. "
                "매출 입력 또는 POS 동기화를 다시 시작하면 예측이 열립니다.")
        horizon = days + gap

        # 행사 수집은 예측 시작일이 정해진 지금 던진다 — SARIMAX 적합과 병렬로 돈다
        events_future = _external_pool.submit(_fetch_nearby_events, lat, lon, start, days)

        # 시계열 기본 예측 — 잔 수를 예측하고, 매출은 최근 객단가로 환산한다.
        #
        # 방식은 백테스트로 골랐다(2026-07-31, 안정 구간 기준 WAPE):
        #   SARIMAX 단독 22.9% / 요일평균 베이스라인 22.6% / SARIMAX+최근수준 앙상블 18.0%
        # SARIMAX 단독은 베이스라인조차 못 이겼고 -12.5%로 꾸준히 과소예측했다. 앙상블은
        # 두 방식이 반대 방향으로 틀리는 성질을 이용해 편향을 -1.3%까지 줄인다.
        #
        # 매출을 따로 적합하지 않는 이유는 정확도가 아니라 일관성이다(WAPE 차이는 0.2pp로
        # 사실상 동률). 독립으로 적합하면 두 예측이 서로 어긋나, 실제로 '15잔인데 16만원'
        # (잔당 11,500원, 실제 객단가 3,900원) 같은 값이 화면에 나갔다.
        #
        # 여기에 레벨 단절 절단을 얹는다 — 매출 수준이 계단식으로 바뀐 지점이 있으면 그
        # 이후만 학습한다. 단절이 없는 매장에서는 아무 일도 하지 않는다(백테스트 실측:
        # 안정 구간 17.9%/18.0%로 절단 전과 완전히 동일).
        # 어느 방식을 쓸지는 매장별로 백테스트가 고른다(select_forecast_method). 여기서는
        # 이미 골라 둔 결과만 읽는다 — 고르는 일은 SARIMAX를 여러 번 적합하므로 대시보드
        # 응답 경로에서 하면 안 된다. 백그라운드 갱신이 하루 한 번 다시 고른다.
        method_key = peek_forecast_method(store_id)
        method_label, method_fn = _METHODS.get(method_key, _METHODS[DEFAULT_METHOD])

        # 외생변수 방식이 선택된 매장만 과거 실측 날씨를 가져온다 (캐시 6시간).
        # 이 방식은 비·폭염·공휴일을 모델 안에서 배우므로, 아래 사후 날씨 보정은 건너뛴다
        # — 같은 비를 회귀로 한 번, 배율로 또 한 번 깎는 이중 반영을 막는다.
        ctx = None
        if method_key == "blend_exog":
            flags = _fetch_weather_flags(lat, lon, series.index.min().date(),
                                         start + timedelta(days=days))
            if flags:
                ctx = {"flags": flags}

        # 절단은 방식 안에서도 하지만(blend_shift), 학습 일수를 표시하려면 여기서도 알아야 한다
        shift_at = _detect_level_shift(series["cups"])
        train = series.iloc[shift_at:] if shift_at is not None else series

        cups_pred = method_fn(train["cups"], horizon, ctx)
        weather_in_model = method_key == "blend_exog" and cups_pred is not None
        model_name = f"{method_label} (학습 {valid_days}일)"
        if shift_at is not None:
            shift_day = series.index[shift_at].date().isoformat()
            model_name = (f"{method_label} (매출 수준 변화 감지 — {shift_day} 이후 "
                          f"{int(train['cups'].notna().sum())}일만 학습)")
        if cups_pred is None and method_key == "blend_exog":
            # 날씨를 못 구했거나 적합 실패 — 외생변수만 뺀 기본 앙상블로 물러선다
            cups_pred = _forecast_blend(train["cups"], horizon)
            model_name = f"{_METHODS[DEFAULT_METHOD][0]} (학습 {valid_days}일, 날씨 조회 실패 폴백)"
        if cups_pred is None:
            cups_pred = _forecast_seasonal(train["cups"], horizon)
            model_name = f"요일별 평균×추세 (학습 {valid_days}일, 폴백)"

        # 객단가도 절단 이후 구간에서 본다 — 단가 인상·메뉴 개편이 단절의 원인일 수 있다
        avg_price = _recent_avg_price(train)
        if avg_price:
            rev_pred = [c * avg_price for c in cups_pred]
        else:
            # 객단가를 못 구할 만큼 자료가 없으면(잔 수가 전부 0) 매출도 따로 예측한다
            rev_pred = (method_fn(train["revenue"], horizon, ctx)
                        or _forecast_seasonal(train["revenue"], horizon))
        # 마지막 판매일~내일 사이 공백 구간은 버리고 실제 내일부터 days개만 사용
        cups_pred = cups_pred[gap:]
        rev_pred = rev_pred[gap:]

        # 병렬로 돌던 외부 조회를 회수한다 (각자 내부에서 실패를 삼키므로 예외 없음)
        weather = weather_future.result()
        region = region_future.result()

        # 주변 행사 자동 수집(전국 검색·TourAPI·서울) + 사장님이 직접 알려준 행사 병합
        nearby_events = events_future.result()
        all_events = events + nearby_events

        # 일자별 날씨·공휴일·행사 보정
        week = []
        for i in range(days):
            d = start + timedelta(days=i)
            iso = d.isoformat()
            factor, reasons = _day_adjustment(iso, weather, all_events,
                                              skip_weather=weather_in_model)
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
        recommendations = _order_recommendations(db, store_id, week_cups, days=len(week))

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

        # 최근 실적 평균 — "요즘에 비해 내일은 어떤가"의 기준선.
        #
        # base_cups(모델 예측)와 cups(보정 후)의 비율만 보면 날씨·행사 보정만 잡힌다.
        # 예측은 매출 추세를 이미 따라가므로, 장사가 계속 내리막이어도 그 비율은 1에 가깝다.
        # 사장님이 정말 궁금한 건 '요즘 대비 내일'이라 실제 최근 평균을 따로 실어 보낸다.
        # 휴무로 마스킹된 날(NaN)은 평균에서 빠진다 — 쉰 날까지 세면 기준선이 내려앉는다.
        # 달력 기준 14일이 아니라 '영업한 날' 14일을 센다. 휴가나 공사로 한 주를 통째로
        # 쉰 매장은 달력으로 자르면 표본이 서너 날만 남아 기준선이 그날 운에 휘둘린다.
        valid_cups = series["cups"].dropna()
        recent = valid_cups.tail(BASELINE_WINDOW_DAYS)
        baseline = {
            "days": int(len(recent)),
            "avg_cups": round(float(recent.mean())) if len(recent) else 0,
        }

        # 추세 — 최근 한 주와 그 직전 한 주를 견준다.
        #
        # 왜 예측만으로는 부족한가: 모델은 며칠짜리 급락을 곧바로 '새로운 수준'으로 받아들이지
        # 않는다(그게 맞다 — 하루 이틀 흔들림마다 예측이 출렁이면 발주가 망가진다). 그래서
        # 매출이 반 토막 나도 내일 예측은 예전 수준 근처에 머물고, 예측만 보면 '평소와 비슷'이 된다.
        # 사장님이 체감하는 '요즘 장사 안된다'는 예측이 아니라 실적에 먼저 나타나므로 따로 싣는다.
        # 요일 구성을 맞추려고 앞뒤 모두 '영업한 날' 7일씩 본다.
        trend = None
        if len(valid_cups) >= TREND_WINDOW_DAYS * 2:
            recent_week = valid_cups.tail(TREND_WINDOW_DAYS)
            prev_week = valid_cups.iloc[-TREND_WINDOW_DAYS * 2:-TREND_WINDOW_DAYS]
            prev_avg = float(prev_week.mean())
            recent_avg = float(recent_week.mean())
            if prev_avg > 0:
                trend = {
                    "days": TREND_WINDOW_DAYS,
                    "recent_avg_cups": round(recent_avg),
                    "prev_avg_cups": round(prev_avg),
                    "change_pct": round((recent_avg / prev_avg - 1) * 100, 1),
                }

    result = {
        "store_id": store_id,
        "location": {"lat": lat, "lon": lon, "region": region},
        "model": model_name,
        "history_days": valid_days,       # 휴무·품절 의심일을 뺀 '학습에 쓴' 날 수
        "excluded_days": len(series) - valid_days,
        "today": today_actual,
        "baseline": baseline,             # 최근 실적 평균 — 홈 마스코트가 '요즘 대비'를 판단하는 기준
        "trend": trend,                   # 최근 한 주 vs 직전 한 주 — 예측이 아직 못 따라잡은 급락을 잡는다
        "tomorrow": week[0],
        "tomorrow_hourly": tomorrow_hourly,
        "tomorrow_hourly_24": tomorrow_hourly_24,
        "week": week,
        "week_total": {"cups": week_cups, "revenue": sum(d["revenue"] for d in week)},
        "order_recommendations": recommendations,
        "nearby_events": nearby_events,   # 자동 수집 (전국 네이버 검색·TourAPI + 서울 문화행사, 반경 3km)
        "events_applied": events,         # 사장님이 직접 입력한 행사
        "note": (f"마지막 판매 기록({last_sale_day.isoformat()}) 이후 {sales_gap}일의 공백을 건너뛰고 "
                 "실제 내일부터 예측했습니다. " if sales_gap > 0 else "")
                + (f"휴무·품절로 보이는 {len(series) - valid_days}일은 학습에서 제외했습니다. "
                   if valid_days < len(series) else "")
                + "시계열 예측에 날씨(강수 -10%, 폭염 +5%)·주변 행사(자동 +5~10%/건, 직접 입력 +20%) "
                "보정을 적용한 참고치입니다. 행사는 매장 반경 3km 안을 전국 기준으로 자동 수집하며"
                "(뉴스·블로그 검색, 한국관광공사 축제, 서울 문화행사), "
                "놓친 행사는 챗봇에 말하면 반영됩니다.",
    }
    if not events:  # 직접 입력 행사가 섞인 결과는 캐시하지 않는다 (대시보드 기본 호출만)
        made_on = datetime.now(KST).date().isoformat()
        _forecast_cache[cache_key] = (time.time(), made_on, result)
        # DB에도 한 벌 — 다음에 뜨는 인스턴스가 이 계산을 처음부터 다시 하지 않게 한다
        warm_cache.save(_warm_key(cache_key), {"made_on": made_on, "result": result})
    return result
