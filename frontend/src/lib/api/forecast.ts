// AI 판매량 예측 API (백엔드 B의 /chatbot/forecast 연동)
// GPS 좌표를 보내면 그 지역 날씨·요일·공휴일 + POS 시계열로 익일/금주 판매량과 발주 추천을 준다.
import { Platform } from 'react-native';

import { apiFetch } from './client';

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

/** 기기 GPS 좌표 — 웹은 브라우저 API, 폰은 expo-location. 거부/실패 시 null (서울 기준 예측). */
export async function getDevicePosition(): Promise<{ lat: number; lon: number } | null> {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { timeout: 5000, maximumAge: 600000 },
      );
    });
  }
  try {
    const Location = await import('expo-location');
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({});
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  } catch {
    return null;
  }
}
