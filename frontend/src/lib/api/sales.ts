// 판매 수동 입력 API (백엔드 B의 /chatbot/sales 연동, 인증 필요)
// 등록한 판매는 Sale 테이블에 기록되어 대시보드·경영 리포트·예측에 바로 반영된다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type MenuItem = {
  id: number;
  name: string;
  selling_price: number;
};

export type RecentSale = {
  id: number;
  name: string;
  quantity: number;
  total_price: number;
  sold_at: string;
};

export type SalesRecordResult = {
  created: { menu_id: number; name: string; quantity: number; total_price: number }[];
  count: number;
  total: number;
};

/** 판매 가능한 메뉴 목록 (백엔드 A의 /inventory/menus) */
export const listMenus = (token: string) =>
  apiFetch<MenuItem[]>('/api/v1/inventory/menus', { headers: auth(token) });

/** 판매 등록 — Sale 기록 + 레시피 기준 재고 자동 차감 */
export const recordSales = (token: string, items: { menu_id: number; quantity: number }[]) =>
  apiFetch<SalesRecordResult>('/api/v1/chatbot/sales', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ items }),
  });

/** 최근 판매 내역 */
export const listRecentSales = (token: string, limit = 10) =>
  apiFetch<RecentSale[]>(`/api/v1/chatbot/sales/recent?limit=${limit}`, { headers: auth(token) });
