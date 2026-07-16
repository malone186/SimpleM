// 프론트 B 담당 — 운영 API (백엔드 /api/v1/operation 연동)
// 백엔드 응답은 CommonResponse { success, data, message } 래핑 → unwrap 해서 data만 반환
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type CommonResponse<T> = { success: boolean; data: T; message: string };

/** CommonResponse에서 data만 꺼내되, success=false면 message로 에러 throw */
function unwrap<T>(res: CommonResponse<T>): T {
  if (!res || res.success === false) {
    throw new Error(res?.message ?? '요청이 실패했습니다.');
  }
  return res.data;
}

// ---------- 타입 ----------
export type TaxLine = { name: string; amount: number; basis: string };
export type TaxFiling = {
  name: string;
  due_date: string;
  dday: number;
  status: string;
  note: string;
};
export type TaxEstimate = {
  period: string;
  tax_type: string;
  total_revenue: number;
  total_expense: number;
  taxable_base: number;
  vat: number;
  income_tax: number;
  withholding_tax: number;
  total_tax: number;
  lines: TaxLine[];
  filing_schedule: TaxFiling[];
  next_filing: TaxFiling | null;
  summary: string;
  disclaimer: string;
};

export type Settlement = {
  year_month: string;
  total_sales: number;
  total_expense: number;
  total_payroll: number;
  net_profit: number;
  other_expense?: number;
  calculated_at?: string;
  disclaimer?: string;
};

export type Forecast = {
  target_date: string;
  predicted_sales: number;
  predicted_quantity: number;
  engine: string;
  evidence_summary: string;
};

export type Expense = {
  id: number;
  store_id: string;
  amount: number;
  category: string;
  description: string | null;
  expense_date: string;
  created_at: string;
};

export type Payroll = {
  employee_id: number;
  employee_name: string;
  role: string;
  hourly_rate: number;
  year_month: string;
  total_work_hours: number;
  base_salary: number;
  weekly_holiday_allowance: number;
  total_salary: number;
  based_on_actual: boolean;
};

// ---------- 세무 ----------
/** 세무 예상 계산 — DB 매출·비용 자동집계 (인증 필요, 로그인 매장 기준) */
export async function getTaxEstimate(
  token: string,
  yearMonth: string,
  taxType: 'general' | 'simplified' = 'general',
): Promise<TaxEstimate> {
  return unwrap(
    await apiFetch<CommonResponse<TaxEstimate>>(
      `/api/v1/operation/tax/estimate?year_month=${yearMonth}&tax_type=${taxType}`,
      { headers: auth(token) },
    ),
  );
}

/** 세무 예상 계산 — 매출·비용 직접 입력 (인증 불필요) */
export async function estimateTaxManual(body: {
  period: string;
  total_revenue: number;
  total_expense: number;
  tax_type?: 'general' | 'simplified';
}): Promise<TaxEstimate> {
  return unwrap(
    await apiFetch<CommonResponse<TaxEstimate>>('/api/v1/operation/tax/estimate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

// ---------- 정산 ----------
/** 월별 손익 정산 (매출−비용−인건비). 백엔드가 목록으로 반환하면 첫 항목을 사용 */
export async function getSettlement(yearMonth: string): Promise<Settlement> {
  const data = unwrap(
    await apiFetch<CommonResponse<Settlement | Settlement[]>>(
      `/api/v1/operation/settlements?year_month=${yearMonth}`,
    ),
  );
  const item = Array.isArray(data) ? data[0] : data;
  if (!item) throw new Error('정산 데이터가 없습니다.');
  return item;
}

// ---------- 판매예측 ----------
/** 판매 예측 (ARIMA + DB 자동집계, 데이터 부족 시 이동평균 폴백) */
export async function forecastSales(body: {
  target_date: string;
  store_id?: string;
  has_event?: boolean;
  engine?: 'arima' | 'average';
}): Promise<Forecast> {
  return unwrap(
    await apiFetch<CommonResponse<Forecast>>('/api/v1/operation/forecast/sales', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

// ---------- 지출 ----------
/** 지출 등록 (정산·세무의 비용 데이터 소스) */
export async function createExpense(
  token: string,
  body: { amount: number; category: string; expense_date: string; description?: string },
): Promise<Expense> {
  return unwrap(
    await apiFetch<CommonResponse<Expense>>('/api/v1/operation/expenses', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(body),
    }),
  );
}

/** 지출 목록 조회 */
export async function listExpenses(token: string, yearMonth?: string): Promise<Expense[]> {
  const q = yearMonth ? `?year_month=${yearMonth}` : '';
  return unwrap(
    await apiFetch<CommonResponse<Expense[]>>(`/api/v1/operation/expenses${q}`, {
      headers: auth(token),
    }),
  );
}

// ---------- 급여 ----------
/** 등록된 모든 직원의 해당 월 예상 급여 목록 (실근무 우선, 없으면 계획시간 기준) */
export async function listPayroll(yearMonth: string): Promise<Payroll[]> {
  return unwrap(
    await apiFetch<CommonResponse<Payroll[]>>(`/api/v1/operation/payroll/all?year_month=${yearMonth}`),
  );
}
