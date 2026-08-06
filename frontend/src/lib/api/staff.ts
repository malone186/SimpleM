// 직원 인건비 상세 API — 고용형태·보험·주휴수당까지 반영한 '실제 나가는 돈'
// (백엔드 /api/v1/staff. 이름·시급 등록 자체는 operation의 /employees가 담당)
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type EmploymentType = 'part_time' | 'part_time_15' | 'full_time' | 'manager';
export type InsuranceType = 'four' | 'two' | 'none';

export type StaffProfile = {
  employee_id: number;
  employment_type: EmploymentType;
  pay_type: 'hourly' | 'monthly';
  monthly_salary: number;
  weekly_hours: number;
  insurance: InsuranceType;
  weekly_holiday_pay: boolean;
  hired_on: string | null;
  memo: string | null;
  unset?: boolean; // 아직 상세를 채우지 않은 직원
  work_days?: string[];
  color?: string;
};

export type LaborCost = {
  weekly_hours: number;
  monthly_hours: number;
  /** 근무시간 근거 — schedule: 근무 달력 / profile: 직접 입력한 소정근로시간 / none: 아직 모름 */
  hours_source: 'schedule' | 'profile' | 'none';
  pay_type: 'hourly' | 'monthly';
  hourly_rate: number;
  effective_hourly: number;
  base_pay: number;
  weekly_holiday_pay: number;
  gross_pay: number;
  withholding_tax: number;
  net_pay: number;
  owner_insurance: Record<string, number>;
  owner_burden: number;
  total_cost: number;
  below_min_wage: boolean;
  min_wage: number;
  disclaimer: string;
};

/** 근무 가능 시간 한 칸 — day_of_week는 0=월 … 6=일 (백엔드 기피시간과 같은 규칙) */
export type AvailabilityWindow = {
  day_of_week: number;
  start_hour: number;
  end_hour: number;
};

export type StaffMember = {
  id: number;
  name: string;
  role: string;
  hourly_rate: number;
  /** 근무 달력에 등록된 이번 달 시간 (0이면 스케줄 없음) */
  scheduled_hours: number;
  profile: StaffProfile;
  /** "언제 일할 수 있어요?"의 답 — 달력에서 배정 가능한 사람을 뽑는 근거 */
  availability: AvailabilityWindow[];
  /** '월·수 09~14시' 같은 한 줄 요약 (서버가 만든다 — 화면·챗봇이 같은 문장을 쓰게) */
  availability_text: string;
  cost: LaborCost;
};

/** 달력의 근무 한 칸 */
export type Shift = {
  id: number;
  employee_id: number;
  name: string;
  role: string;
  date: string;
  start: string; // HH:MM
  end: string;   // HH:MM
  hours: number;
  /** 직원 대표 색 (없으면 화면이 팔레트에서 배정) */
  color: string | null;
  /** true=가능 시간 안 / false=가능 시간 밖 / null=가능 시간 미입력 */
  fits_availability: boolean | null;
};

export type CalendarDay = {
  date: string;
  weekday: number;      // 0=월
  weekday_label: string;
  shifts: Shift[];
  hours: number;
  available: {
    employee_id: number;
    name: string;
    role: string;
    color: string | null;
    windows: AvailabilityWindow[];
    already_assigned: boolean;
  }[];
};

export type StaffCalendar = {
  month: string;
  days: CalendarDay[];
  staff: {
    id: number;
    name: string;
    role: string;
    color: string | null;
    availability: AvailabilityWindow[];
    availability_text: string;
  }[];
  weekday_labels: string[];
};

export type StaffList = {
  staff: StaffMember[];
  month: string;
  total_gross: number;
  total_owner_burden: number;
  total_cost: number;
  total_hours: number;
  /** 근무시간을 아직 알 수 없는 직원 수 — 인건비가 0으로 보이는 이유를 설명할 때 쓴다 */
  unknown_hours_count: number;
  employment_types: { code: EmploymentType; label: string; note: string }[];
  insurance_types: { code: InsuranceType; label: string; note: string }[];
  min_wage: number;
};

export type WeeklyPayrollRow = {
  employee_id: number;
  name: string;
  role: string;
  hours: number;
  from_schedule: boolean;
  pay_type: 'hourly' | 'monthly';
  base_pay: number;
  weekly_holiday_pay: number;
  total: number;
};

export type WeeklyPayroll = {
  week_start: string;
  week_end: string;
  rows: WeeklyPayrollRow[];
  total: number;
  holiday_total: number;
  note: string;
};

/**
 * 등록 화면과 상세 화면이 함께 다루는 항목 — 두 화면이 같은 타입을 쓰게 해서
 * "추가할 땐 못 고르고 나중에 상세에서 또 고르는" 어긋남을 타입 단계에서 막는다.
 */
export type StaffEditable = {
  name: string;
  role: string;
  hourly_rate: number;
  /** 보낸 경우에만 통째로 교체된다 (빈 배열이면 가능 시간 전부 삭제) */
  availability: AvailabilityWindow[];
  /** 직원 대표 색 (#RRGGBB) — 달력의 점·선과 아바타를 같은 색으로 묶는다 */
  color: string;
  employment_type: EmploymentType;
  pay_type: 'hourly' | 'monthly';
  monthly_salary: number;
  weekly_hours: number;
  insurance: InsuranceType;
  weekly_holiday_pay: boolean;
  hired_on: string | null;
  memo: string | null;
};

/** 목록을 아직 못 불러왔을 때도 등록 화면이 같은 선택지를 보여줄 수 있게 두는 사본
 *  (문구·순서의 출처는 서버의 employment_types / insurance_types다) */
export const EMPLOYMENT_TYPE_FALLBACK: { code: EmploymentType; label: string; note: string }[] = [
  { code: 'part_time', label: '단시간 알바 (주 15시간 미만)', note: '주휴수당·4대보험 대상이 아니에요.' },
  { code: 'part_time_15', label: '알바 (주 15시간 이상)', note: '주휴수당이 발생하고 4대보험 가입 대상이에요.' },
  { code: 'full_time', label: '정규직 (주 40시간)', note: '주휴수당 포함, 4대보험 의무 가입입니다.' },
  { code: 'manager', label: '매니저 · 점장', note: '보통 월급제로 계약해요.' },
];

export const INSURANCE_TYPE_FALLBACK: { code: InsuranceType; label: string; note: string }[] = [
  { code: 'four', label: '4대보험', note: '사업주 부담이 임금의 약 10~11% 추가됩니다.' },
  { code: 'two', label: '2대보험 (고용·산재)', note: '단시간 근로자의 일반적인 형태예요.' },
  { code: 'none', label: '미가입 (3.3% 원천징수)', note: '사업소득 계약. 소급 징수될 수 있어요.' },
];

export const listStaff = (token: string) =>
  apiFetch<StaffList>('/api/v1/staff', { headers: auth(token) });

/** 직원 등록 + 고용 상세를 한 번에 — 응답은 목록 한 줄과 같은 모양이라 그대로 붙이면 된다 */
export const createStaff = (
  token: string,
  body: Partial<StaffEditable> & { name: string },
) =>
  apiFetch<StaffMember>('/api/v1/staff', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });

/** 이름·시급·직책과 고용 상세를 함께 저장하고, 다시 계산된 그 직원 한 줄을 돌려받는다 */
export const saveStaffProfile = (
  token: string,
  employeeId: number,
  body: Partial<StaffEditable>,
) =>
  apiFetch<StaffMember>(`/api/v1/staff/${employeeId}/profile`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(body),
  });

/** 근무 가능 시간만 따로 저장 (통째 교체) */
export const saveAvailability = (
  token: string,
  employeeId: number,
  availability: AvailabilityWindow[],
) =>
  apiFetch<{ employee_id: number; availability: AvailabilityWindow[]; availability_text: string }>(
    `/api/v1/staff/${employeeId}/availability`,
    { method: 'PUT', headers: auth(token), body: JSON.stringify({ availability }) },
  );

/** 월 근무 달력 — 날짜별 배정 근무 + 그날 근무 가능한 직원 */
export const getStaffCalendar = (token: string, month?: string) =>
  apiFetch<StaffCalendar>(`/api/v1/staff/calendar${month ? `?month=${month}` : ''}`, {
    headers: auth(token),
  });

export const addShift = (
  token: string,
  body: { employee_id: number; date: string; start: string; end: string },
) =>
  apiFetch<Shift>('/api/v1/staff/shifts', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });

/** 교대(담당 직원 교체)와 시간 변경 — employee_id를 보내면 그 근무를 다른 사람이 맡는다 */
export const updateShift = (
  token: string,
  shiftId: number,
  body: { employee_id?: number; date?: string; start?: string; end?: string },
) =>
  apiFetch<Shift>(`/api/v1/staff/shifts/${shiftId}`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(body),
  });

/** 근무 가능 시간 → 그 달 달력에 실제 근무로 채우기 (지난 날짜 제외, 중복은 건너뜀).
 *  같은 schedules 테이블을 쓰므로 '직원·스케줄'의 알바 근무 달력에도 그대로 나타난다. */
export const applyAvailability = (
  token: string,
  body: { month?: string; employee_id?: number } = {},
) =>
  apiFetch<{ month: string; created: number; skipped: number; shifts: Shift[] }>(
    '/api/v1/staff/shifts/apply-availability',
    { method: 'POST', headers: auth(token), body: JSON.stringify(body) },
  );

export const deleteShift = (token: string, shiftId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/staff/shifts/${shiftId}`, {
    method: 'DELETE',
    headers: auth(token),
  });

/** 요일 라벨 — 0=월 … 6=일 (서버와 같은 순서) */
export const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

export const getWeeklyPayroll = (token: string, weekStart?: string) =>
  apiFetch<WeeklyPayroll>(
    `/api/v1/staff/weekly-payroll${weekStart ? `?week_start=${weekStart}` : ''}`,
    { headers: auth(token) },
  );

// ---------------------------------------------------------------------------
// 월 급여·정산 배치 조회 — /operation/payroll/all의 빠른 대체
//
// 기존 경로는 서버가 직원 한 명마다 DB 왕복 5번을 반복해 직원 5명이면 5초가 걸렸고,
// 정산 계산은 내부에서 그걸 또 불러 '정산·급여' 카드가 10초 가까이 비어 있었다.
// /staff/monthly-payroll·month-settlement는 같은 숫자를 왕복 2~4번으로 만든다.
// 서버가 아직 옛 버전이면(404) 기존 경로로 폴백해 화면이 죽지 않게 한다.
// ---------------------------------------------------------------------------

/** /operation의 Payroll과 같은 모양 (프론트 화면 호환) */
export type MonthlyPayrollRow = {
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

export type MonthSettlement = {
  total_sales: number;
  total_expense: number;
  total_payroll: number;
  net_profit: number;
  year_month?: string;
  period_start?: string;
  period_end?: string;
  disclaimer?: string;
};

// 같은 화면의 여러 카드가 동시에 같은 달을 조회한다 — 진행 중인 요청은 하나로 합친다.
// (완료된 뒤에는 다시 부르면 새로 조회하므로 등록·수정 직후 갱신은 그대로 동작한다)
const inflight = new Map<string, Promise<unknown>>();
function shareInflight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const getMonthlyPayroll = (token: string, yearMonth?: string) =>
  shareInflight(`payroll:${yearMonth ?? ''}`, () =>
    apiFetch<MonthlyPayrollRow[]>(
      `/api/v1/staff/monthly-payroll${yearMonth ? `?year_month=${yearMonth}` : ''}`,
      { headers: auth(token) },
    ),
  );

/** 정산 + 직원별 급여를 요청 1번에 — '이번 달 정산·급여' 카드 전용 */
export const getMonthSettlement = (token: string, yearMonth?: string) =>
  shareInflight(`settlement:${yearMonth ?? ''}`, () =>
    apiFetch<{ settlement: MonthSettlement; payroll: MonthlyPayrollRow[] }>(
      `/api/v1/staff/month-settlement${yearMonth ? `?year_month=${yearMonth}` : ''}`,
      { headers: auth(token) },
    ),
  );
