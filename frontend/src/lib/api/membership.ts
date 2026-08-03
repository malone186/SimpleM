// 단골 회원 · 선불 충전 API 클라이언트 — 백엔드 /api/v1/membership/*
import { apiFetch } from './client';

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

export async function searchCustomers(query?: string): Promise<Customer[]> {
  const q = query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : '';
  return apiFetch<Customer[]>(`/api/v1/membership/customers${q}`);
}

export async function createCustomer(payload: {
  phone: string;
  name?: string;
  memo?: string;
}): Promise<Customer> {
  return apiFetch<Customer>('/api/v1/membership/customers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchTransactions(customerId: number): Promise<Transaction[]> {
  return apiFetch<Transaction[]>(`/api/v1/membership/customers/${customerId}/transactions`);
}

// --- 충전 상품 ---

export async function fetchChargePlans(): Promise<ChargePlan[]> {
  return apiFetch<ChargePlan[]>('/api/v1/membership/plans');
}

export async function createChargePlan(payload: {
  pay_amount: number;
  credit_amount: number;
}): Promise<ChargePlan> {
  return apiFetch<ChargePlan>('/api/v1/membership/plans', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteChargePlan(planId: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/v1/membership/plans/${planId}`, { method: 'DELETE' });
}

// --- 잔액 변동 ---

/**
 * 충전합니다.
 *
 * [한글 주석] 돈은 우리가 받지 않습니다. 카페가 카드단말기·현금으로 직접 받고
 * 여기엔 '얼마가 적립됐는지'만 기록합니다.
 */
export async function chargeBalance(
  customerId: number,
  payload: { charge_plan_id?: number; pay_amount?: number; credit_amount?: number; memo?: string }
): Promise<BalanceResult> {
  return apiFetch<BalanceResult>(`/api/v1/membership/customers/${customerId}/charge`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function useBalance(
  customerId: number,
  payload: { amount: number; memo?: string }
): Promise<BalanceResult> {
  return apiFetch<BalanceResult>(`/api/v1/membership/customers/${customerId}/use`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- 집계 ---

export async function fetchPrepaidSummary(days = 30): Promise<PrepaidSummary> {
  return apiFetch<PrepaidSummary>(`/api/v1/membership/summary?days=${days}`);
}

export async function fetchChurnRisk(limit = 20): Promise<ChurnRiskCustomer[]> {
  return apiFetch<ChurnRiskCustomer[]>(`/api/v1/membership/churn-risk?limit=${limit}`);
}

export async function reconcileBalances(): Promise<ReconcileResult> {
  return apiFetch<ReconcileResult>('/api/v1/membership/reconcile');
}
