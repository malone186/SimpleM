// 손익분기점 API (백엔드 B의 /api/v1/breakeven 연동, 인증 필요)
//
// 고정비(한 잔도 안 팔아도 나가는 돈)는 매장당 한 벌만 저장한다. 변동비율(재료비 +
// 카드 수수료)은 최근 판매에서 서버가 자동으로 뽑고, 레시피가 없는 매장만 직접 적는다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 고정비 항목 키 — 화면 입력칸 순서도 이걸 따른다 */
export const FIXED_COST_FIELDS = ['rent', 'labor', 'utilities', 'other'] as const;
export type FixedCostField = (typeof FIXED_COST_FIELDS)[number];

export type FixedCosts = {
  /** false면 아직 한 번도 저장한 적 없는 매장 — 화면은 안내 문구를 먼저 띄운다 */
  configured: boolean;
  rent: number;
  labor: number;
  utilities: number;
  other: number;
  total: number;
  /** 직접 적은 변동비율(%). null이면 판매 데이터에서 자동으로 뽑는다 */
  custom_variable_ratio: number | null;
  open_days_per_month: number;
  memo: string | null;
  labels: Record<FixedCostField, string>;
  updated_at?: string;
};

/** 변동비 한 줄 — "재료비 32.4% (최근 30일 실제 판매)" */
export type VariablePart = { label: string; pct: number; source: string };

export type Breakeven = {
  fixed_costs: Record<FixedCostField, number>;
  fixed_cost_labels: Record<FixedCostField, string>;
  fixed_cost_total: number;
  open_days_per_month: number;
  target_profit: number;
  variable_cost_ratio: number | null;
  /** auto=판매에서 자동 · saved=저장된 직접 입력 · manual=이번 계산에만 · unavailable=계산 불가 */
  variable_cost_source: 'auto' | 'saved' | 'manual' | 'unavailable';
  variable_breakdown: VariablePart[];
  avg_ticket: number | null;
  current_monthly_revenue: number | null;

  /** false면 아래 숫자들이 없다 — needs에 무엇이 부족한지 담겨 온다 */
  computed: boolean;
  needs: ('fixed_costs' | 'variable_cost_ratio')[];
  message: string;
  /** 변동비율이 100%를 넘어 아무리 팔아도 본전이 안 되는 구조 */
  impossible?: boolean;
  /** 변동비율이 상식 밖으로 높을 때 (입력 오류 의심) */
  warning?: string;

  contribution_margin_ratio?: number;
  breakeven_revenue?: number;
  breakeven_daily_revenue?: number;
  target_revenue?: number;
  target_daily_revenue?: number;
  breakeven_cups?: number;
  breakeven_daily_cups?: number;
  target_daily_cups?: number;

  achievement_pct?: number;
  gap_to_breakeven?: number;
  margin_of_safety_pct?: number | null;
  estimated_profit?: number;
};

export type SaveResult = { fixed_costs: FixedCosts; breakeven: Breakeven };

/** 저장된 고정비 기준 손익분기점. target_profit을 주면 '이만큼 남기려면'으로 바뀐다 */
export function getBreakeven(token: string, targetProfit = 0): Promise<Breakeven> {
  const q = targetProfit > 0 ? `?target_profit=${targetProfit}` : '';
  return apiFetch<Breakeven>(`/api/v1/breakeven${q}`, { headers: auth(token) });
}

export function getFixedCosts(token: string): Promise<FixedCosts> {
  return apiFetch<FixedCosts>('/api/v1/breakeven/fixed-costs', { headers: auth(token) });
}

// 고정비 자동 제안 — 지난 지출·급여에서 4칸을 미리 채운다 (온보딩 벽 낮추기)
export type FixedCostSuggestion = {
  suggested: Record<FixedCostField, number>;
  sources: Partial<Record<FixedCostField, string>>; // 값이 있는 칸만: "지난 지출 (임대료)" 등
  labels: Record<FixedCostField, string>;
  has_any: boolean;
  open_days_per_month: number;
};

export function suggestFixedCosts(token: string): Promise<FixedCostSuggestion> {
  return apiFetch<FixedCostSuggestion>('/api/v1/breakeven/fixed-costs/suggest', { headers: auth(token) });
}

/** 보낸 항목만 바뀐다. 저장 후 다시 계산한 손익분기점까지 함께 온다 */
export function saveFixedCosts(
  token: string,
  patch: Partial<Record<FixedCostField, number>> & {
    custom_variable_ratio?: number | null;
    open_days_per_month?: number;
    memo?: string;
  },
): Promise<SaveResult> {
  return apiFetch<SaveResult>('/api/v1/breakeven/fixed-costs', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(patch),
  });
}

/** 직접 적은 변동비율을 지우고 자동 계산으로 되돌린다 */
export function clearVariableRatio(token: string): Promise<SaveResult> {
  return apiFetch<SaveResult>('/api/v1/breakeven/fixed-costs/variable-ratio', {
    method: 'DELETE',
    headers: auth(token),
  });
}

/** 저장하지 않고 가정만 바꿔 계산 — 목표이익 슬라이더·'만약에' 계산에 쓴다 */
export function simulateBreakeven(
  token: string,
  body: Partial<Record<FixedCostField, number>> & {
    variable_cost_ratio?: number;
    target_profit?: number;
    open_days_per_month?: number;
  },
): Promise<Breakeven> {
  return apiFetch<Breakeven>('/api/v1/breakeven/simulate', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
}
