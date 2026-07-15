// 서류 자동화 API (백엔드 B의 /api/v1/chatbot/documents·compliance 연동, 인증 필요)
import { apiFetch } from './client';

export type DocumentKind =
  | 'purchase_order'
  | 'stocktake_sheet'
  | 'inspection_report'
  | 'monthly_ledger'
  | 'vat_reference'
  | 'payslip'
  | 'employment_contract';

export const KIND_LABELS: Record<DocumentKind, string> = {
  purchase_order: '발주서',
  stocktake_sheet: '재고실사표',
  inspection_report: '검수확인서',
  monthly_ledger: '매입·매출 장부',
  vat_reference: '부가세 참고자료',
  payslip: '임금명세서',
  employment_contract: '근로계약서',
};

export type GeneratedDocument = {
  id: string;
  kind: DocumentKind;
  title: string;
  period: string | null;
  status: string;
  content: Record<string, unknown>;
  created_at: string;
};

export type ComplianceItem = {
  id: number;
  name: string;
  expiry_date: string;
  remind_before_days: number;
  memo: string | null;
  days_left: number;
  status: 'ok' | 'due_soon' | 'expired';
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = <T,>(token: string, path: string, body?: unknown) =>
  apiFetch<T>(path, { method: 'POST', headers: auth(token), body: body ? JSON.stringify(body) : undefined });

/** 발주서 초안 — 안전재고 이하 재료 자동 추출 */
export const createPurchaseOrder = (token: string) =>
  post<GeneratedDocument>(token, '/api/v1/chatbot/documents/purchase-order');

/** 재고실사표 — 장부상 수량이 채워진 실사 시트 */
export const createStocktakeSheet = (token: string) =>
  post<GeneratedDocument>(token, '/api/v1/chatbot/documents/stocktake');

/** 매입·매출 장부 (월 집계) */
export const createMonthlyLedger = (token: string, year: number, month: number) =>
  post<GeneratedDocument>(token, `/api/v1/chatbot/documents/ledger?year=${year}&month=${month}`);

/** 부가세 신고 참고자료 (기간 집계, 참고용) */
export const createVatReference = (token: string, startDate: string, endDate: string) =>
  post<GeneratedDocument>(
    token,
    `/api/v1/chatbot/documents/vat-reference?start_date=${startDate}&end_date=${endDate}`,
  );

/** 임금명세서 초안 — 근무 스케줄 자동 집계 */
export const createPayslip = (
  token: string,
  body: { employee_name: string; year: number; month: number; hourly_wage?: number; work_hours?: number },
) => post<GeneratedDocument>(token, '/api/v1/chatbot/documents/payslip', body);

/** 근로계약서 초안 */
export const createContract = (
  token: string,
  body: {
    employee_name: string;
    start_date: string;
    hourly_wage: number;
    work_days_per_week?: number;
    work_hours_per_day?: number;
    end_date?: string;
    duties?: string;
  },
) => post<GeneratedDocument>(token, '/api/v1/chatbot/documents/contract', body);

/** 생성된 문서 목록 */
export const listDocuments = (token: string, kind?: DocumentKind) =>
  apiFetch<GeneratedDocument[]>(
    `/api/v1/chatbot/documents${kind ? `?kind=${kind}` : ''}`,
    { headers: auth(token) },
  );

/** 갱신 서류(보건증·위생교육·계약) 등록 */
export const addCompliance = (
  token: string,
  body: { name: string; expiry_date: string; remind_before_days?: number; memo?: string },
) => post<ComplianceItem>(token, '/api/v1/chatbot/compliance', body);

/** 갱신 서류 전체 목록 (만료까지 남은 일수 포함) */
export const listCompliance = (token: string) =>
  apiFetch<ComplianceItem[]>('/api/v1/chatbot/compliance', { headers: auth(token) });

export const deleteCompliance = (token: string, id: number) =>
  apiFetch<{ deleted: number }>(`/api/v1/chatbot/compliance/${id}`, { method: 'DELETE', headers: auth(token) });
