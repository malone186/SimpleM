// [주변 행사] 매장 반경 3km에서 곧 열리는 축제·팝업·문화행사 + 대비 조언 (백엔드 B)
//
// 수집 소스는 판매 예측이 쓰는 것과 같다 — 한국관광공사 축제, 서울 열린데이터광장 문화행사,
// 네이버 뉴스·블로그 검색을 Gemini가 정리한 결과. 예측은 '날짜별 보정 행'을 쓰지만
// 여기서는 백엔드가 같은 행사를 하나로 묶어 기간(start_date~end_date)으로 내려 준다.
import { apiFetch } from './client';

export type NearbyEventItem = {
  name: string;
  place: string;
  source: string; // "한국관광공사 TourAPI" / "서울 열린데이터광장" / "네이버 검색"
  start_date: string; // YYYY-MM-DD (조회 기간 안에서의 시작일)
  end_date: string;
  dates: string[];
  day_count: number;
  distance_km: number | null;
  lat: number | null;
  lon: number | null;
  boost_pct: number; // 예측에 적용되는 매출 부스팅(%)
  d_day: number; // 시작까지 남은 일수 (0 = 오늘)
  ongoing: boolean; // 오늘 열리는 중인지
  tip?: string; // 행사별 AI 대응 한 줄 (조언 생성 실패 시 없음)
};

export type NearbyEventInsight = {
  headline: string;
  impact_level: string; // 낮음 / 보통 / 높음
  summary: string;
  peak_days: string[];
  actions: string[];
  event_tips: { name: string; tip: string }[];
};

export type NearbyEventsResult = {
  today: string;
  days: number;
  radius_km: number;
  count: number;
  region?: string;
  events: NearbyEventItem[];
  insight: NearbyEventInsight | null;
  cached?: boolean;
};

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** 매장 주변 행사 목록 + AI 대비 조언. 좌표는 계정에 등록된 매장 고정 위치를 쓴다. */
export const getNearbyEvents = (token: string, days = 14) =>
  apiFetch<NearbyEventsResult>(`/api/v1/chatbot/nearby-events?days=${days}`, auth(token));
