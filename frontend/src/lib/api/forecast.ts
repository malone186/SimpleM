// AI 판매량 예측 API (백엔드 B의 /chatbot/forecast 연동)
// GPS 좌표를 보내면 그 지역 날씨·요일·공휴일 + POS 시계열로 익일/금주 판매량과 발주 추천을 준다.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiFetch } from './client';

// 회원가입 지도 핀으로 설정한 매장 위치 저장 키 (AuthScreen에서 기록)
export const STORE_LOCATION_KEY = 'simplem:storeLocation';

// 마지막으로 예측 API가 알려준 매장 위치 캐시 키 — 가입 핀이 없는 기기(재로그인 등)에서도
// 프로필 지도를 API 응답 전에 즉시 그릴 수 있게 한다
export const STORE_LOCATION_CACHE_KEY = 'simplem:lastStoreLocation';

export type StoredStoreLocation = { lat: number; lon: number; region?: string };

/** 로컬에 저장된 매장 위치를 즉시 반환 (가입 핀 → 예측 캐시 순). 없으면 null.
 * 네트워크를 전혀 타지 않으므로 지도 첫 렌더에 그대로 써도 된다. */
export async function getStoredStoreLocation(): Promise<StoredStoreLocation | null> {
  for (const key of [STORE_LOCATION_KEY, STORE_LOCATION_CACHE_KEY]) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw) as { lat?: number; lon?: number; region?: string };
      if (typeof saved.lat === 'number' && typeof saved.lon === 'number') {
        return { lat: saved.lat, lon: saved.lon, region: saved.region };
      }
    } catch {
      // 저장값이 깨졌으면 다음 후보로
    }
  }
  return null;
}

/** 예측 API가 확정한 위치를 캐시에 기록 — 다음 방문부터 지도가 즉시 뜬다. */
export async function cacheStoreLocation(loc: StoredStoreLocation): Promise<void> {
  try {
    await AsyncStorage.setItem(STORE_LOCATION_CACHE_KEY, JSON.stringify(loc));
  } catch {
    // 캐시 실패는 치명적이지 않으므로 무시
  }
}

export type ForecastDay = {
  date: string;
  weekday: string;
  base_cups: number;
  cups: number;
  revenue: number;
  weather: string | null;
  temp_max: number | null;
  precip_prob: number | null;
  adjustments: string[];
  holiday: string | null;
};

export type OrderRecommendation = {
  ingredient: string;
  unit: string;
  current_quantity: number;
  safety_quantity: number;
  forecast_usage_7d: number;
  days_until_stockout: number | null;
  suggested_quantity: number;
  estimated_amount: number;
  reason: string;
};

export type NearbyEvent = {
  name: string;
  date: string;
  boost_pct: number;
  distance_km: number;
  place: string;
  source: string;
};

export type HourlyForecast = {
  hour: string;
  cups: number;
  revenue: number;
};

// 시간(0~23시) 단위 판매 집계 — 오늘 실적·내일 24시간 예측 공용
export type HourlyPoint = {
  hour: number;
  cups: number;
  revenue: number;
};

export type TodayActuals = {
  date: string;
  cups: number;
  revenue: number;
  yesterday_revenue: number; // 어제 총매출 (증감률 비교용, 없으면 0)
  hourly: HourlyPoint[]; // 0~23시 실제 판매 집계
};

export type SalesForecast = {
  location: { lat: number; lon: number; region: string };
  model: string;
  history_days: number;
  today?: TodayActuals; // 오늘 실시간 실적 (경영 리포트와 같은 Sale 집계 기준)
  tomorrow: ForecastDay;
  tomorrow_hourly: HourlyForecast[];
  tomorrow_hourly_24?: HourlyPoint[]; // 내일 시간(0~23시)별 예측 분배
  week: ForecastDay[];
  week_total: { cups: number; revenue: number };
  order_recommendations: OrderRecommendation[];
  nearby_events: NearbyEvent[]; // 서울 문화행사 API 자동 수집 (매장 반경 3km)
  note: string;
};

// --- 월간 캘린더 (GET /chatbot/sales/calendar) ---

export type CalendarDay = {
  day: number; // 1~31
  date: string;
  cups: number;
  revenue: number;
  top_menus: { name: string; qty: number }[];
  peak_hour: number | null;
};

export type SalesCalendar = {
  year: number;
  month: number;
  month_total: { cups: number; revenue: number };
  prev_month_total: { cups: number; revenue: number }; // 전월 같은 경과일까지 합계
  change_pct: number | null;
  avg_price: number | null;
  peak_hour: number | null;
  days: CalendarDay[]; // 판매가 있는 날만 온다
};

/** 월간 캘린더용 일별 판매 집계 (기본: 이번 달). 실제 Sale 기록 기준. */
export const getSalesCalendar = (token: string, year?: number, month?: number) => {
  const params = new URLSearchParams();
  if (year) params.set('year', String(year));
  if (month) params.set('month', String(month));
  const qs = params.toString();
  return apiFetch<SalesCalendar>(`/api/v1/chatbot/sales/calendar${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

/** 익일·금주 판매량 예측. 판매 기록 14일 미만이면 409 에러(안내 메시지). */
export const getSalesForecast = (token: string, lat?: number, lon?: number, days = 7) => {
  const params = new URLSearchParams({ days: String(days) });
  if (lat !== undefined && lon !== undefined) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
  }
  return apiFetch<SalesForecast>(`/api/v1/chatbot/forecast?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

/** 매장 위치 좌표 — 회원가입 지도 핀으로 저장한 좌표가 있으면 최우선, 없으면 기기 GPS.
 * 웹은 브라우저 API, 폰은 expo-location. 거부/실패 시 null (서울 기준 예측).
 *
 * 실패는 null로 삼키되 이유는 반드시 한 줄 남긴다 — 예전엔 조용히 null이라
 * "위치가 안 나온다"가 권한 거부인지 차단인지 구분할 수 없었다.
 */
export async function getDevicePosition(): Promise<{ lat: number; lon: number } | null> {
  // 0. 가입 때 핀으로 확정한 매장 좌표가 있으면 그것이 곧 매장 위치다 (기기 GPS보다 정확)
  try {
    const raw = await AsyncStorage.getItem(STORE_LOCATION_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { lat?: number; lon?: number };
      if (typeof saved.lat === 'number' && typeof saved.lon === 'number') {
        return { lat: saved.lat, lon: saved.lon };
      }
    }
  } catch {
    // 저장값이 깨졌으면 무시하고 GPS로 진행
  }
  if (Platform.OS === 'web') {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      console.warn('[위치] 이 브라우저는 geolocation을 지원하지 않습니다 → 서울 기준으로 예측합니다');
      return null;
    }
    // 브라우저는 https 또는 localhost에서만 위치를 준다. LAN IP(192.168.x.x)로 열면
    // 권한 팝업조차 안 뜨고 조용히 실패하므로, 원인을 명시해 준다.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      console.warn(
        `[위치] 보안 컨텍스트가 아니라 브라우저가 위치를 차단했습니다 (${window.location.origin}). ` +
          'http://localhost 로 접속하거나 https를 쓰세요 → 지금은 서울 기준으로 예측합니다',
      );
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        (err) => {
          // 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
          console.warn(`[위치] 좌표를 못 받았습니다 (code=${err.code}: ${err.message}) → 서울 기준으로 예측합니다`);
          resolve(null);
        },
        // 첫 측위는 5초를 넘기는 경우가 흔해 10초로 둔다 (초과해도 앱은 서울 기준으로 계속 동작)
        { timeout: 10000, maximumAge: 600000 },
      );
    });
  }
  try {
    const Location = await import('expo-location');
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn(`[위치] 권한이 없습니다 (status=${status}) → 서울 기준으로 예측합니다`);
      return null;
    }
    const p = await Location.getCurrentPositionAsync({});
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  } catch (e) {
    console.warn(`[위치] 측위 실패: ${e instanceof Error ? e.message : e} → 서울 기준으로 예측합니다`);
    return null;
  }
}
