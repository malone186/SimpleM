// 카드 정산 API — 현금/카드사별 매출 입력, 수수료·입금 예정일 조회 (백엔드 /api/v1/settlement)
// POS 연동이 없는 매장이 매일 쓸 수 있는 최소 입력 경로다. 잔 수는 선택 입력.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type CardIssuer = {
  code: string;
  name: string;
  default_lag: number;
  lag: number; // 이 매장 기준 입금 소요 영업일
  color: string;
  selectable: boolean; // false면 화면 칩에 노출하지 않는다 (카드사 미지정 자리)
  customized?: boolean; // 사장님이 기본값에서 직접 고친 카드사
};

export type RevenueTier = {
  code: string;
  label: string;
  credit: number;
  check: number;
};

export type SettlementSettings = {
  // 한 번이라도 설정을 저장한 적이 있는지 — false면 설정 마법사를 먼저 띄운다
  configured?: boolean;
  revenue_tier: string;
  tier_label: string;
  credit_fee_pct: number;
  check_fee_pct: number;
  custom_credit_fee?: number | null;
  custom_check_fee?: number | null;
  lag_customized?: boolean;
  issuers: CardIssuer[];
  tiers: RevenueTier[];
};

// 서버가 응답하지 않을 때 쓰는 폴백. 구간 코드·요율은 반드시 백엔드
// (settlement_service.REVENUE_TIERS)와 같아야 한다 — 코드가 어긋나면 화면에서 고른
// 구간을 저장할 때 백엔드가 "알 수 없는 매출 구간"으로 400을 낸다.
export const DEFAULT_SETTLEMENT_SETTINGS: SettlementSettings = {
  configured: false,
  revenue_tier: 'small',
  tier_label: '영세 (연매출 3억 이하)',
  credit_fee_pct: 0.4,
  check_fee_pct: 0.15,
  tiers: [
    { code: 'small', label: '영세 (연매출 3억 이하)', credit: 0.4, check: 0.15 },
    { code: 'mid1', label: '중소1 (3억~5억)', credit: 1.05, check: 0.85 },
    { code: 'mid2', label: '중소2 (5억~10억)', credit: 1.2, check: 1.0 },
    { code: 'mid3', label: '중소3 (10억~30억)', credit: 1.45, check: 1.25 },
    { code: 'general', label: '일반 (30억 초과)', credit: 2.0, check: 1.5 },
    { code: 'custom', label: '직접 입력 (계약서 기준)', credit: 1.5, check: 1.2 },
  ],
  issuers: [
    { code: 'shinhan', name: '신한카드', default_lag: 2, lag: 2, color: '#1F4E9C', selectable: true },
    { code: 'kb', name: 'KB국민카드', default_lag: 2, lag: 2, color: '#6A5A48', selectable: true },
    { code: 'samsung', name: '삼성카드', default_lag: 2, lag: 2, color: '#1428A0', selectable: true },
    { code: 'hyundai', name: '현대카드', default_lag: 2, lag: 2, color: '#2C2C2C', selectable: true },
    { code: 'lotte', name: '롯데카드', default_lag: 2, lag: 2, color: '#B8272D', selectable: true },
    { code: 'hana', name: '하나카드', default_lag: 2, lag: 2, color: '#00857E', selectable: true },
    { code: 'woori', name: '우리카드', default_lag: 2, lag: 2, color: '#0067AC', selectable: true },
    { code: 'nh', name: 'NH농협카드', default_lag: 2, lag: 2, color: '#0A8A3C', selectable: true },
    { code: 'bc', name: 'BC카드', default_lag: 3, lag: 3, color: '#E8380D', selectable: true },
    { code: 'pay', name: '간편결제(페이)', default_lag: 3, lag: 3, color: '#F4B400', selectable: true },
    { code: 'unknown', name: '카드사 미지정', default_lag: 3, lag: 3, color: '#8C6F56', selectable: false },
  ],
};

// 최근 매출로 추정한 우대수수료율 구간 추천 (설정 마법사 1단계에서 사용)
export type TierSuggestion = {
  available: boolean;
  observed_days: number;
  reason?: string;
  recommended_tier?: string;
  tier_label?: string;
  credit_fee_pct?: number;
  check_fee_pct?: number;
  daily_avg?: number;
  annual_estimate?: number;
  confidence?: 'high' | 'medium' | 'low';
  basis?: string;
  note?: string;
};

// "이 금액이 언제 얼마로 들어오는지" 한 건 미리보기
export type SettlementPreview = CardDetail & {
  sale_date: string;
  deposit_weekday: string;
  calendar_days: number;
  skipped: { date: string; label: string; reason: string }[];
  tier_label: string;
};

export type CardDetail = {
  issuer: string;
  issuer_name: string;
  color: string;
  card_type: 'credit' | 'check';
  amount: number;
  cups: number | null;
  fee_pct: number;
  fee: number;
  net: number;
  lag: number;
  deposit_date: string;
};

export type DaySales = {
  date: string;
  cash: number;
  cash_cups: number | null;
  cards: CardDetail[];
  card_total: number;
  total: number;
  fee_total: number;
  net_total: number;
  cups: number | null;
  avg_price: number | null;
  has_entry: boolean;
};

export type DepositBucket = {
  deposit_date: string;
  weekday: string;
  gross: number;
  fee: number;
  net: number;
  settled: boolean;
  items: {
    issuer: string;
    issuer_name: string;
    color: string;
    card_type: 'credit' | 'check';
    sale_date: string;
    amount: number;
    fee: number;
    net: number;
  }[];
};

export type DepositSchedule = {
  today: string;
  schedule: DepositBucket[];
  next_deposit: DepositBucket | null;
  pending_net: number;
  pending_gross: number;
  pending_fee: number;
  this_week_net: number;
  fee_note: string;
};

export type SettlementSummary = {
  days: number;
  cash_total: number;
  card_total: number;
  total: number;
  fee_total: number;
  cash_ratio: number | null;
  today_total: number;
  last_week_same_day: number;
  last_week_change_pct: number | null;
  issuer_mix: { issuer: string; issuer_name: string; color: string; amount: number; ratio: number }[];
  daily: { date: string; cash: number; card: number; fee: number; total: number }[];
};

export type CardEntryInput = {
  issuer: string;
  amount: number;
  card_type?: 'credit' | 'check';
  cups?: number | null;
};

export const getSettlementSettings = (token: string) =>
  apiFetch<SettlementSettings>('/api/v1/settlement/settings', { headers: auth(token) });

export const updateSettlementSettings = (
  token: string,
  body: {
    revenue_tier?: string;
    custom_credit_fee?: number;
    custom_check_fee?: number;
    lag_overrides?: Record<string, number>;
  },
) =>
  apiFetch<SettlementSettings>('/api/v1/settlement/settings', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(body),
  });

export const getTierSuggestion = (token: string, lookbackDays = 90) =>
  apiFetch<TierSuggestion>(`/api/v1/settlement/tier-suggestion?lookback_days=${lookbackDays}`, {
    headers: auth(token),
  });

export const getSettlementPreview = (
  token: string,
  params: { amount: number; card_type?: 'credit' | 'check'; issuer?: string },
) => {
  const q = new URLSearchParams({
    amount: String(Math.max(0, Math.round(params.amount))),
    card_type: params.card_type ?? 'credit',
    issuer: params.issuer ?? '',
  });
  return apiFetch<SettlementPreview>(`/api/v1/settlement/preview?${q.toString()}`, {
    headers: auth(token),
  });
};

export const getDaySales = (token: string, date: string) =>
  apiFetch<DaySales>(`/api/v1/settlement/day?date=${date}`, { headers: auth(token) });

export const saveDaySales = (
  token: string,
  body: { date: string; cash: number; cash_cups?: number | null; cards: CardEntryInput[] },
) =>
  apiFetch<DaySales>('/api/v1/settlement/day', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });

export const getDeposits = (token: string, aheadDays = 21) =>
  apiFetch<DepositSchedule>(`/api/v1/settlement/deposits?ahead_days=${aheadDays}`, {
    headers: auth(token),
  });

export const getSettlementSummary = (token: string, days = 28) =>
  apiFetch<SettlementSummary>(`/api/v1/settlement/summary?days=${days}`, { headers: auth(token) });
