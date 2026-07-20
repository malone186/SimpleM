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
  total_sales: number;
  total_expense: number;
  total_payroll: number;
  net_profit: number;
  other_expense?: number;
  year_month?: string;
  period_start?: string;
  period_end?: string;
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
  period_start?: string;
  period_end?: string;
  total_work_hours: number;
  base_salary: number;
  weekly_holiday_allowance: number;
  estimated_salary: number;
  based_on_actual?: boolean;
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
/** 월별 손익 정산 (매출−비용−인건비). 연월을 기간으로 변환해 계산 API 호출 */
export async function getSettlement(yearMonth: string): Promise<Settlement> {
  const [y, m] = yearMonth.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const data = unwrap(
    await apiFetch<CommonResponse<Settlement | Settlement[]>>(
      '/api/v1/operation/settlements/calculate',
      {
        method: 'POST',
        body: JSON.stringify({
          period_start: `${yearMonth}-01`,
          period_end: `${yearMonth}-${String(lastDay).padStart(2, '0')}`,
        }),
      },
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

// ---------- 근무 스케줄 ----------
export type Schedule = {
  id: number;
  employee_id: number;
  start_time: string;
  end_time: string;
  date: string; // YYYY-MM-DD
  actual_start_time?: string | null;
  actual_end_time?: string | null;
};

/** 등록된 근무 스케줄 전체 조회 */
export async function listSchedules(): Promise<Schedule[]> {
  return unwrap(await apiFetch<CommonResponse<Schedule[]>>('/api/v1/operation/schedules'));
}

/** 근무 스케줄 등록 */
export async function createSchedule(body: {
  employee_id: number;
  start_time: string;
  end_time: string;
}): Promise<Schedule> {
  return unwrap(
    await apiFetch<CommonResponse<Schedule>>('/api/v1/operation/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

/** 근무 스케줄 시간 수정 */
export async function updateSchedule(
  id: number,
  body: { start_time?: string; end_time?: string },
): Promise<Schedule> {
  return unwrap(
    await apiFetch<CommonResponse<Schedule>>(`/api/v1/operation/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );
}

/** 근무 스케줄 삭제 */
export async function deleteSchedule(id: number): Promise<null> {
  return unwrap(
    await apiFetch<CommonResponse<null>>(`/api/v1/operation/schedules/${id}`, { method: 'DELETE' }),
  );
}

// ---------- 챗봇 / ERP 신규: 직원별 기피/불가 시간 & 스케줄 추천 ----------
export type EmployeeUnavailability = {
  id: number;
  employee_id: number;
  employee_name?: string;
  unavailability_type: 'weekly_recurring' | 'specific_date';
  day_of_week?: number;
  specific_date?: string;
  start_hour: number;
  end_hour: number;
  restriction_level: 'hard' | 'soft';
  reason?: string;
  created_at: string;
};

export type AssignedEmployee = {
  id: number;
  name: string;
  role: string;
  level: 'hard' | 'soft' | null;
};

export type HourlyRecommendation = {
  hour: number;
  predicted_sales: number;
  predicted_profit: number;
  recommended_employee_count: number;
  busy_level: 'PEAK' | 'HIGH' | 'NORMAL' | 'LOW';
  assigned_employees: AssignedEmployee[];
  unassigned_count: number;
};

export type ScheduleRecommendation = {
  target_date: string;
  hourly_recommendations?: HourlyRecommendation[];
  total_recommended_hours: number;
  estimated_payroll_cost: number;
  warnings?: string[];
  summary: string;
};

/** 직원 기피/불가 시간 등록 API */
export async function createUnavailability(
  token: string,
  body: {
    employee_id: number;
    unavailability_type: 'weekly_recurring' | 'specific_date';
    day_of_week?: number;
    specific_date?: string;
    start_hour: number;
    end_hour: number;
    restriction_level: 'hard' | 'soft';
    reason?: string;
  },
): Promise<EmployeeUnavailability> {
  return unwrap(
    await apiFetch<CommonResponse<EmployeeUnavailability>>('/api/v1/operation/unavailability', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(body),
    }),
  );
}

/** 직원 기피/불가 시간 목록 조회 API */
export async function listUnavailabilities(
  token: string,
  employeeId?: number,
): Promise<EmployeeUnavailability[]> {
  const q = employeeId ? `?employee_id=${employeeId}` : '';
  return unwrap(
    await apiFetch<CommonResponse<EmployeeUnavailability[]>>(`/api/v1/operation/unavailability${q}`, {
      headers: auth(token),
    }),
  );
}

/** 직원 기피/불가 시간 삭제 API */
export async function deleteUnavailability(token: string, unavailabilityId: number): Promise<void> {
  await apiFetch<CommonResponse<null>>(`/api/v1/operation/unavailability/${unavailabilityId}`, {
    method: 'DELETE',
    headers: auth(token),
  });
}

/** 알바 스케줄 추천 API (기피시간 반영) */
export async function getScheduleRecommendation(
  token: string,
  targetDate: string,
  storeId: string = 'store_gildong',
): Promise<ScheduleRecommendation> {
  return unwrap(
    await apiFetch<CommonResponse<ScheduleRecommendation>>('/api/v1/operation/schedules/recommend', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ target_date: targetDate, store_id: storeId }),
    }),
  );
}

/** AI 스케줄 추천 — 과거 매출 시간대 분석 기반 */
export async function recommendSchedule(body: {
  target_date: string;
  store_id?: string;
}): Promise<ScheduleRecommendation> {
  return unwrap(
    await apiFetch<CommonResponse<ScheduleRecommendation>>('/api/v1/operation/schedules/recommend', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}
