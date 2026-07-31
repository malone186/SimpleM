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

export type StaffMember = {
  id: number;
  name: string;
  role: string;
  hourly_rate: number;
  /** 근무 달력에 등록된 이번 달 시간 (0이면 스케줄 없음) */
  scheduled_hours: number;
  profile: StaffProfile;
  cost: LaborCost;
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

export const listStaff = (token: string) =>
  apiFetch<StaffList>('/api/v1/staff', { headers: auth(token) });

export const saveStaffProfile = (
  token: string,
  employeeId: number,
  body: Partial<Omit<StaffProfile, 'employee_id' | 'unset'>>,
) =>
  apiFetch<StaffProfile>(`/api/v1/staff/${employeeId}/profile`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(body),
  });

export const getWeeklyPayroll = (token: string, weekStart?: string) =>
  apiFetch<WeeklyPayroll>(
    `/api/v1/staff/weekly-payroll${weekStart ? `?week_start=${weekStart}` : ''}`,
    { headers: auth(token) },
  );
