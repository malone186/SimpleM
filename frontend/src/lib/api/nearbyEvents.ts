// [주변 행사] 매장 반경 3km에서 곧 열리는 축제·팝업·문화행사 + 대비 조언 (백엔드 B)
//
// 수집 소스는 판매 예측이 쓰는 것과 같다 — 한국관광공사 축제, 서울 열린데이터광장 문화행사,
// 네이버 뉴스·블로그 검색을 Gemini가 정리한 결과. 예측은 '날짜별 보정 행'을 쓰지만
// 여기서는 백엔드가 같은 행사를 하나로 묶어 기간(start_date~end_date)으로 내려 준다.
import { apiFetch } from './client';
import type { PromotionDoc } from './marketing';

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

const jsonAuth = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

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
export const getEventPlan = async (token: string, event: NearbyEventItem) => {
  try {
    return await apiFetch<EventPlanResult>('/api/v1/chatbot/nearby-events/plan', {
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
  } catch (e) {
    // 405 = 아직 POST가 없는 서버(앱이 먼저 갱신된 배포 틈). 옛 경로로 한 번 더 시도한다 —
    // 이 창에서 "Method Not Allowed"만 뜨고 준비 플랜을 아예 못 보는 일을 막는다.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/\b405\b/.test(msg)) throw e;
    return apiFetch<EventPlanResult>(
      `/api/v1/chatbot/nearby-events/plan?name=${encodeURIComponent(event.name)}` +
        (event.start_date ? `&start_date=${event.start_date}` : ''),
      auth(token),
    );
  }
};

/** 행사 준비 항목을 홈 '오늘 할 일'에 담은 결과 */
export type EventTodoResult = {
  added: { id: number; title: string; due_date?: string | null }[];
  /** 이미 같은 할 일이 열려 있어 새로 만들지 않은 제목들 */
  skipped: string[];
  /** 서버가 잡아 준 기한 — 행사 전날(이미 지났으면 오늘) */
  due_date: string | null;
};

/**
 * 준비 플랜의 '해 둘 일'을 할 일 목록에 담는다 (여러 개를 한 번의 호출로).
 *
 * 시트를 닫으면 잊히던 준비 항목이 홈 화면 '오늘 할 일'에 기한과 함께 남는다.
 * 서버가 같은 할 일을 중복 생성하지 않으므로 두 번 눌러도 안전하다.
 */
export const addEventPrepTodos = (
  token: string,
  req: { items: string[]; eventName: string; startDate?: string },
) =>
  apiFetch<EventTodoResult>('/api/v1/chatbot/nearby-events/plan/todos', {
    method: 'POST',
    headers: jsonAuth(token),
    body: JSON.stringify({
      items: req.items,
      event_name: req.eventName,
      start_date: req.startDate ?? '',
    }),
  });

/**
 * 행사에 맞춘 홍보 문구 세트를 만든다 — 인스타 캡션·해시태그·이미지에 새길 슬로건까지.
 *
 * 플랜의 이벤트·한정 메뉴·한 줄 문구를 함께 보내야 홍보물이 방금 본 플랜과 같은 이야기를 한다
 * (안 보내면 카피라이터가 다른 이벤트를 지어낸다). 결과 문서는 홍보 보관함에도 남는다.
 * 이미지는 이어서 marketing.ts의 createPromotionImage(doc_id)로 만든다.
 */
export const createEventPromotion = (
  token: string,
  event: NearbyEventItem,
  plan: EventPlan | null,
  channel: 'instagram' | 'banner' = 'instagram',
) => {
  const promo = plan?.promotions?.[0];
  return apiFetch<{ doc: PromotionDoc; event: NearbyEventItem }>('/api/v1/chatbot/nearby-events/promo', {
    method: 'POST',
    headers: jsonAuth(token),
    body: JSON.stringify({
      event: {
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
      },
      promotion_title: promo?.title ?? '',
      promotion_detail: promo?.detail ?? '',
      menu_idea: plan?.menu_idea ?? '',
      busy_window: plan?.busy_window ?? '',
      promo_copy: plan?.promo_copy ?? '',
      channel,
    }),
  });
};

/** 준비 플랜을 그대로 복사·공유할 수 있는 글로 (직원 단톡방에 붙여넣는 용도) */
export const planToText = (event: NearbyEventItem, plan: EventPlan) => {
  const period = [event.start_date, event.end_date].filter(Boolean).join(' ~ ');
  // 빈 문자열은 '문단 사이 빈 줄', null은 '내용이 없어 빠진 줄' — 둘을 구분해야
  // 인력·재료가 없는 플랜에서도 문단 나눔이 살아남는다.
  const lines: (string | null)[] = [
    `[${event.name}] 행사 준비`,
    [period, event.place].filter(Boolean).join(' · '),
    '',
    plan.headline || null,
    plan.expected_change || null,
    plan.busy_window ? `붐빌 때: ${plan.busy_window}` : null,
    '',
    ...(plan.promotions ?? []).map((p) => `· ${p.title} — ${p.detail}`),
    plan.menu_idea ? `· 한정 메뉴: ${plan.menu_idea}` : null,
    '',
    '[행사 전에 해 둘 일]',
    ...(plan.prep_actions ?? []).map((t, i) => `${i + 1}. ${t}`),
    (plan.stock_prep ?? []).length ? `재료: ${(plan.stock_prep ?? []).join(', ')}` : null,
    plan.staffing ? `인력: ${plan.staffing}` : null,
    plan.promo_copy ? `\n홍보 문구: ${plan.promo_copy}` : null,
  ];
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
