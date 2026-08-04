// [주변 카페 상권 분석] 매장 고정 위치 반경의 경쟁 카페 수집 + AI 분석 (백엔드 B)
//
// 백엔드가 네이버 지역검색으로 카페를 모으고, 네이버 블로그 후기를 수집해 Gemini로 분석한다.
// 앱은 결과를 지도 마커 + 카드로 보여 준다. (좌표는 회원가입 지도 핀 = 계정에 등록된 매장 위치)
import { apiFetch } from './client';

export type NearbyCafe = {
  name: string;
  category: string;
  address: string;
  telephone: string;
  link: string;
  lat: number;
  lon: number;
  distance_m: number;
};

export type NearbyCafesResult = {
  region: string;
  radius_m: number;
  count: number;
  cafes: NearbyCafe[];
  cached?: boolean;
};

export type NeighborhoodInsight = {
  headline: string;
  competition_level: string;
  market_summary: string;
  trends: string[];
  opportunities: string[];
  threats: string[];
  actions: string[];
  watch_list: string[];
};

export type NeighborhoodResult = NearbyCafesResult & {
  insight: NeighborhoodInsight | null;
};

export type CafeAnalysis = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  signature_menus: string[];
  price_level: string;
  main_customers: string;
  atmosphere: string;
  sentiment: string;
  counter_strategy: string;
};

export type CafeReview = {
  title: string;
  snippet: string;
  link: string;
  date: string;
  blogger: string;
};

export type CafeAnalysisResult = {
  name: string;
  address: string;
  category: string;
  distance_m: number;
  review_count: number;
  reviews: CafeReview[];
  analysis: CafeAnalysis | null;
  // 내 카페 리뷰에서만 채워진다 — 아직 '내 가게'를 지정 안 했으면 linked=false
  linked?: boolean;
  place_name?: string;
  place_address?: string;
};

// '내 카페' 지정용 후보 (네이버 지역검색 결과)
export type CafeCandidate = {
  name: string;
  address: string;
  category: string;
  telephone: string;
  lat: number | null;
  lon: number | null;
  distance_m: number | null;
};

/** 상권 변화 한 건 — 새로 생긴 카페(opened) 또는 문 닫은 것으로 보이는 카페(closed) */
export type CafeChange = {
  kind: 'opened' | 'closed';
  name: string;
  address: string;
  category: string;
  distance_m: number;
  lat: number | null;
  lon: number | null;
  first_seen: string; // YYYY-MM-DD — 처음 검색에 잡힌 날
  last_seen: string;
  closed_on: string | null;
  place_key: string;
};

export type CafeChangesResult = {
  days: number;
  tracked: number;    // 지금 관측 중인 카페 수
  last_scan: string;  // 마지막으로 훑은 날 (빈 문자열이면 아직 관측 전)
  opened: CafeChange[];
  closed: CafeChange[];
  count: number;
};

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** 매장 반경 안의 카페 목록 (거리순). 좌표 생략 시 계정에 등록된 매장 위치 사용. */
export const getNearbyCafes = (token: string, radiusM = 1000, limit = 20) =>
  apiFetch<NearbyCafesResult>(
    `/api/v1/chatbot/nearby-cafes?radius_m=${radiusM}&limit=${limit}`,
    auth(token),
  );

/** 카페 목록 + 상권 AI 분석 (경쟁 밀도·트렌드·기회·위협·이번 주 실행안) */
export const getNeighborhoodInsight = (token: string, radiusM = 1000, limit = 20) =>
  apiFetch<NeighborhoodResult>(
    `/api/v1/chatbot/nearby-cafes/insight?radius_m=${radiusM}&limit=${limit}`,
    auth(token),
  );

/** 최근 상권 변화 — 새로 생긴 카페·문 닫은 카페.
 *
 * 서버가 매일 한 번 반경 1km를 훑어 쌓아 둔 관측 기록을 그대로 읽는다(즉시 응답).
 * 오늘 아직 안 훑었으면 서버가 백그라운드로 훑어 다음 조회부터 반영된다.
 * 관측을 막 시작한 매장은 비어 있는 게 정상 — 변화는 하루 뒤부터 잡힌다.
 */
export const getNearbyCafeChanges = (token: string, days = 30) =>
  apiFetch<CafeChangesResult>(`/api/v1/chatbot/nearby-cafes/changes?days=${days}`, auth(token));

/** 지정한 '내 카페'의 네이버 후기 + 분석. 아직 지정 안 했으면 linked=false로 온다. */
export const getMyCafeReviews = (token: string) =>
  apiFetch<CafeAnalysisResult>('/api/v1/chatbot/my-cafe/analysis', auth(token));

/** '내 카페' 지정용 후보 목록 (상호로 네이버 지역검색). query 생략 시 등록 상호로 검색. */
export const getMyCafeCandidates = (token: string, query = '') =>
  apiFetch<{ query: string; candidates: CafeCandidate[] }>(
    `/api/v1/chatbot/my-cafe/candidates${query ? `?query=${encodeURIComponent(query)}` : ''}`,
    auth(token),
  );

/** 후보 중 '이게 내 가게'를 지정 (이름+주소로 저장, 이후 그 장소로만 후기 조회). */
export const linkMyCafe = (token: string, place_name: string, place_address = '') =>
  apiFetch<{ linked: boolean; place_name: string; place_address: string }>(
    '/api/v1/chatbot/my-cafe/link',
    { method: 'POST', ...auth(token), body: JSON.stringify({ place_name, place_address }) },
  );

/** 내 카페 지정 해제 (다시 고를 수 있게) */
export const unlinkMyCafe = (token: string) =>
  apiFetch<{ linked: boolean }>('/api/v1/chatbot/my-cafe/link', { method: 'DELETE', ...auth(token) });

/** 경쟁 카페 한 곳의 네이버 후기 수집 + AI 분석 (지도 마커/카드를 눌렀을 때) */
export const getCafeAnalysis = (token: string, cafe: NearbyCafe, region = '') => {
  const params = new URLSearchParams({
    name: cafe.name,
    address: cafe.address,
    category: cafe.category,
    distance_m: String(cafe.distance_m),
    region,
  });
  return apiFetch<CafeAnalysisResult>(
    `/api/v1/chatbot/nearby-cafes/analysis?${params.toString()}`,
    auth(token),
  );
};
