// 단골 회원 · 선불 충전 API 클라이언트 — 백엔드 /api/v1/membership/*
import { apiFetch } from './client';

// [한글 주석] 팀 공통 패턴 — 화면에서 useAuth()의 token을 받아 넘긴다.
// apiFetch는 토큰을 자동으로 붙이지 않는다(공동 소유 파일이라 고정).
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type Customer = {
  id: number;
  phone: string;
  phone_masked: string;      // 010-****-5678 — 목록에는 이걸 쓴다
  name: string | null;
  balance: number;
  memo: string | null;
  is_active: boolean;
  created_at: string;
  visit_count: number;
  last_visit_at: string | null;
  days_since_visit: number | null;
};

export type ChargePlan = {
  id: number;
  pay_amount: number;
  credit_amount: number;
  bonus_amount: number;
  discount_rate: number;     // 적립액 기준 실질 할인율(%)
  is_active: boolean;
};

export type Transaction = {
  id: number;
  tx_type: 'CHARGE' | 'USE' | 'REFUND' | 'ADJUST';
  tx_label: string;
  amount: number;
  balance_after: number;
  paid_amount: number | null;
  memo: string | null;
  created_at: string;
};

/** 충전·차감 직후 응답 — 문자 문구까지 함께 온다 */
export type BalanceResult = {
  customer_id: number;
  customer_name: string | null;
  phone: string;
  balance: number;
  transaction: Transaction;
  sms_text: string;          // 사장님 폰 문자앱에 채울 문구
  balance_url: string;
};

/** 선수금 현황 — 매출과 분리된 부채 집계 */
export type PrepaidSummary = {
  customer_count: number;
  active_balance_total: number;  // 아직 안 쓴 잔액 = 갚아야 할 빚
  charged_total: number;         // 실제 현금 유입
  credited_total: number;        // 적립된 총액
  used_total: number;            // 매출로 인식된 부분
  refunded_total: number;        // 환불액 — 매출이 아니라 현금 유출
  net_cash_in: number;           // 실제 남은 현금 (충전 - 환불)
  bonus_given: number;           // 나간 보너스 = 실질 할인 총액
  period_days: number;
};

export type ChurnRiskCustomer = {
  customer_id: number;
  name: string | null;
  phone: string;
  phone_masked: string;
  balance: number;
  visit_count: number;
  median_interval_days: number;
  days_since_visit: number;
  overdue_ratio: number;         // 평소 주기의 몇 배나 지났는지
  sms_text: string;
  balance_url: string;
};

export type ReconcileResult = {
  checked: number;
  mismatch_count: number;
  ok: boolean;
  mismatches: {
    customer_id: number;
    name: string | null;
    phone_masked: string;
    cached_balance: number;
    ledger_balance: number;
    diff: number;
  }[];
};

// --- 회원 ---

export async function searchCustomers(token: string, query?: string): Promise<Customer[]> {
  const q = query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : '';
  return apiFetch<Customer[]>(`/api/v1/membership/customers${q}`, { headers: auth(token) });
}

export async function createCustomer(token: string, payload: {
  phone: string;
  name?: string;
  memo?: string;
}): Promise<Customer> {
  return apiFetch<Customer>('/api/v1/membership/customers', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

export async function fetchTransactions(token: string, customerId: number): Promise<Transaction[]> {
  return apiFetch<Transaction[]>(`/api/v1/membership/customers/${customerId}/transactions`, { headers: auth(token) });
}

/** 환불 기준액 — 보너스를 뺀 '실제 낸 돈' 기준 */
export type RefundEstimate = {
  balance: number;
  suggested: number;       // 권장 환불액
  paid_ratio: number;
  bonus_excluded: number;  // 보너스라 제외되는 몫
};

export async function fetchRefundEstimate(token: string, customerId: number): Promise<RefundEstimate> {
  return apiFetch<RefundEstimate>(
    `/api/v1/membership/customers/${customerId}/refund-estimate`, { headers: auth(token) });
}

/**
 * 잔액을 현금으로 환불합니다.
 *
 * [한글 주석] 선불충전은 상품권에 준해 규제받고 일정 조건에서 환불 의무가 있습니다.
 * 보정(ADJUST)으로 때우면 장부에서 환불인지 실수 정정인지 구분되지 않습니다.
 */
export async function refundBalance(
  token: string, customerId: number, payload: { amount: number; memo?: string }
): Promise<BalanceResult> {
  return apiFetch<BalanceResult>(`/api/v1/membership/customers/${customerId}/refund`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

/** 선불 고객 실질 원가율 */
export type CostAnalysis = {
  period_days: number;
  discount_rate: number;          // 실효 충전 할인율(%)
  prepaid_sales: number;
  prepaid_cost: number;
  list_cost_rate: number;         // 메뉴판 기준
  real_cost_rate: number;         // 충전 할인까지 반영 — 이게 진짜
  normal_cost_rate: number | null; // 일반 판매 비교군
  gap: number | null;
  items: {
    menu_id: number;
    name: string;
    count: number;
    sales: number;
    cost: number;
    list_cost_rate: number;
    real_cost_rate: number;
  }[];
  unknown_count: number;          // 메뉴 없이 금액만 차감한 건
  unknown_sales: number;
  has_data: boolean;
};

/**
 * 선불 회원제가 남는 장사인지 판단하는 숫자입니다.
 *
 * [한글 주석] 메뉴판 원가율만 보면 충전 보너스로 깎인 몫이 안 보입니다.
 * 3,000원 커피(원가 900원)는 원가율 30%지만, 16.7% 할인된 잔액으로 샀다면
 * 실제로 받은 돈은 2,500원이라 실질 원가율은 36%입니다.
 */
export async function fetchCostAnalysis(token: string, days = 90): Promise<CostAnalysis> {
  return apiFetch<CostAnalysis>(`/api/v1/membership/cost-analysis?days=${days}`, {
    headers: auth(token),
  });
}

/** 계산대 QR — 손님이 자기 폰으로 찍는다 */
export type StoreQr = {
  token: string;
  url: string;
  svg: string;          // 인쇄해도 안 깨지도록 SVG로 받는다
  store_name: string | null;
  guide: string;
};

/** 손님이 QR을 찍고 누른 결제 요청 */
export type CheckIn = {
  checkin_id: number;
  customer_id: number;
  name: string | null;
  phone: string;
  phone_masked: string;
  balance: number;
  waited_minutes: number;
  /** PAYMENT: 잔액으로 결제 요청 · SIGNUP: QR로 직접 등록한 신규 손님 */
  kind: 'PAYMENT' | 'SIGNUP';
  is_signup: boolean;
};

export async function fetchStoreQr(token: string): Promise<StoreQr> {
  return apiFetch<StoreQr>('/api/v1/membership/store-qr', { headers: auth(token) });
}

/**
 * 결제 요청 대기 목록을 가져옵니다.
 *
 * [한글 주석] 손님이 계산대 QR을 찍고 '결제 요청'을 누르면 여기 뜹니다.
 * 직원이 구두로 이름·번호를 묻지 않아도 누구인지 알 수 있습니다.
 */
export async function fetchCheckIns(token: string): Promise<CheckIn[]> {
  return apiFetch<CheckIn[]>('/api/v1/membership/checkins', { headers: auth(token) });
}

export async function dismissCheckIn(token: string, checkinId: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/v1/membership/checkins/${checkinId}/dismiss`, {
    method: 'POST',
    headers: auth(token),
  });
}

/** 차감용 메뉴 버튼 */
export type QuickMenu = { id: number; name: string; price: number };

/**
 * 차감할 때 누를 메뉴 목록을 가져옵니다.
 *
 * [한글 주석] 금액을 손으로 치는 대신 메뉴를 누르게 합니다.
 * 차감은 방문할 때마다 일어나므로 여기서 몇 초를 줄이는 게 실제로 큽니다.
 */
export async function fetchQuickMenus(token: string): Promise<QuickMenu[]> {
  return apiFetch<QuickMenu[]>('/api/v1/membership/quick-menus', { headers: auth(token) });
}

// --- 충전 상품 ---

export async function fetchChargePlans(token: string): Promise<ChargePlan[]> {
  return apiFetch<ChargePlan[]>('/api/v1/membership/plans', { headers: auth(token) });
}

export async function createChargePlan(token: string, payload: {
  pay_amount: number;
  credit_amount: number;
}): Promise<ChargePlan> {
  return apiFetch<ChargePlan>('/api/v1/membership/plans', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

export async function deleteChargePlan(token: string, planId: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/v1/membership/plans/${planId}`, { method: 'DELETE', headers: auth(token) });
}

// --- 잔액 변동 ---

/**
 * 충전합니다.
 *
 * [한글 주석] 돈은 우리가 받지 않습니다. 카페가 카드단말기·현금으로 직접 받고
 * 여기엔 '얼마가 적립됐는지'만 기록합니다.
 */
export async function chargeBalance(
  token: string,
  customerId: number,
  payload: { charge_plan_id?: number; pay_amount?: number; credit_amount?: number; memo?: string }
): Promise<BalanceResult> {
  return apiFetch<BalanceResult>(`/api/v1/membership/customers/${customerId}/charge`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

export async function useBalance(
  token: string,
  customerId: number,
  // [한글 주석] menu_id는 원가 분석에 쓴다. 메모(이름)만으로는 메뉴명이 바뀌거나
  // 비슷한 메뉴가 있을 때 엉뚱한 원가가 붙는다.
  payload: { amount: number; memo?: string; menu_id?: number }
): Promise<BalanceResult> {
  return apiFetch<BalanceResult>(`/api/v1/membership/customers/${customerId}/use`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

// --- 집계 ---

export async function fetchPrepaidSummary(token: string, days = 30): Promise<PrepaidSummary> {
  return apiFetch<PrepaidSummary>(`/api/v1/membership/summary?days=${days}`, { headers: auth(token) });
}

export async function fetchChurnRisk(token: string, limit = 20): Promise<ChurnRiskCustomer[]> {
  return apiFetch<ChurnRiskCustomer[]>(`/api/v1/membership/churn-risk?limit=${limit}`, { headers: auth(token) });
}

export async function reconcileBalances(token: string): Promise<ReconcileResult> {
  return apiFetch<ReconcileResult>('/api/v1/membership/reconcile', { headers: auth(token) });
}
