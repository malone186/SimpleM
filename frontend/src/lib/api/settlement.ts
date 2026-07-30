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
};

export type RevenueTier = {
  code: string;
  label: string;
  credit: number;
  check: number;
};

export type SettlementSettings = {
  revenue_tier: string;
  tier_label: string;
  credit_fee_pct: number;
  check_fee_pct: number;
  issuers: CardIssuer[];
  tiers: RevenueTier[];
};

export const DEFAULT_SETTLEMENT_SETTINGS: SettlementSettings = {
  revenue_tier: 'under_300m',
  tier_label: '영세 (3억원 이하)',
  credit_fee_pct: 0.5,
  check_fee_pct: 0.25,
  tiers: [
    { code: 'under_300m', label: '영세 (3억원 이하)', credit: 0.5, check: 0.25 },
    { code: '300m_500m', label: '중소1 (3억~5억원)', credit: 1.1, check: 0.85 },
    { code: '500m_1b', label: '중소2 (5억~10억원)', credit: 1.25, check: 1.0 },
    { code: '1b_3b', label: '중소3 (10억~30억원)', credit: 1.5, check: 1.25 },
    { code: 'general', label: '일반 가맹점', credit: 2.2, check: 1.5 },
  ],
  issuers: [
    { code: 'shinhan', name: '신한카드', default_lag: 2, lag: 2, color: '#0046FF', selectable: true },
    { code: 'kb', name: 'KB국민카드', default_lag: 2, lag: 2, color: '#FFBC00', selectable: true },
    { code: 'hyundai', name: '현대카드', default_lag: 2, lag: 2, color: '#000000', selectable: true },
    { code: 'samsung', name: '삼성카드', default_lag: 2, lag: 2, color: '#0A2540', selectable: true },
    { code: 'lotte', name: '롯데카드', default_lag: 2, lag: 2, color: '#ED1C24', selectable: true },
    { code: 'woori', name: '우리카드', default_lag: 2, lag: 2, color: '#0066B3', selectable: true },
    { code: 'hana', name: '하나카드', default_lag: 2, lag: 2, color: '#008485', selectable: true },
    { code: 'bc', name: 'BC/IBK', default_lag: 2, lag: 2, color: '#E60012', selectable: true },
  ],
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
