// [주변 행사] 매장 반경 3km에서 곧 열리는 축제·팝업·문화행사 + 대비 조언 (백엔드 B)
//
// 수집 소스는 판매 예측이 쓰는 것과 같다 — 한국관광공사 축제, 서울 열린데이터광장 문화행사,
// 네이버 뉴스·블로그 검색을 Gemini가 정리한 결과. 예측은 '날짜별 보정 행'을 쓰지만
// 여기서는 백엔드가 같은 행사를 하나로 묶어 기간(start_date~end_date)으로 내려 준다.
import { apiFetch } from './client';

export type NearbyEventItem = {
  name: string;
  /** 주최기관 — 이름 앞의 "[마포구립서강도서관]" 같은 대괄호를 서버가 떼어 따로 준다 */
  host?: string;
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

/** 행사 하나에 맞춘 AI 이벤트·준비 플랜 (행사 카드의 'AI 준비 플랜' 버튼) */
export type EventPlan = {
  headline: string;
  impact_level: string;      // 낮음 / 보통 / 높음
  expected_change: string;   // 손님이 어떻게 달라질지
  busy_window: string;       // 특히 붐빌 날짜·시간대
  promotions: { title: string; detail: string; why: string }[];
  menu_idea: string;         // 행사 기간 한정 메뉴
  prep_actions: string[];    // 미리 해 둘 일
  stock_prep: string[];      // 넉넉히 확보할 재료
  staffing: string;          // 인력 배치
  promo_copy: string;        // 그대로 쓸 홍보 문구
  cached?: boolean;
};

export type EventPlanResult = {
  event: NearbyEventItem;
  plan: EventPlan;
};

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** 매장 주변 행사 목록 + AI 대비 조언. 좌표는 계정에 등록된 매장 고정 위치를 쓴다. */
export const getNearbyEvents = (token: string, days = 14) =>
  apiFetch<NearbyEventsResult>(`/api/v1/chatbot/nearby-events?days=${days}`, auth(token));

/** 행사 하나에 맞춘 이벤트·준비 플랜을 AI가 짜 준다 (Gemini 1회, 12시간 캐시).
 *
 * 화면에 떠 있는 행사 카드를 그대로 실어 보낸다. 서버는 먼저 자기 수집 목록에서 같은 행사를
 * 찾아 그 값을 쓰고(거리·부스팅이 정확해진다), 못 찾으면 보낸 값으로 만든다.
 *
 * 이름만 보내던 시절엔 "목록에서 찾지 못했습니다"가 났다 — 행사 수집이 네이버 검색 + AI 정리라
 * 호출마다 이름이 조금씩 달라지고, 캐시도 서버 인스턴스별이라 방금 화면에 뜬 행사인데도
 * 플랜 요청은 빈손으로 돌아오는 일이 있었다.
 */
export const getEventPlan = (token: string, event: NearbyEventItem) =>
  apiFetch<EventPlanResult>('/api/v1/chatbot/nearby-events/plan', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: event.name,
      place: event.place ?? '',
      host: event.host ?? '',
      source: event.source ?? '',
      start_date: event.start_date ?? '',
      end_date: event.end_date ?? '',
      day_count: event.day_count ?? 1,
      distance_km: event.distance_km,
      boost_pct: event.boost_pct ?? 0,
      d_day: event.d_day ?? 0,
      ongoing: !!event.ongoing,
    }),
  });
