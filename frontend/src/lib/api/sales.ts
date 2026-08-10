// 판매 수동 입력 API (백엔드 B의 /chatbot/sales 연동, 인증 필요)
// 등록한 판매는 Sale 테이블에 기록되어 대시보드·경영 리포트·예측에 바로 반영된다.
import { Platform } from 'react-native';
import { apiFetch, API_BASE_URL } from './client';

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

// 매출을 올린 '그 순간' 본전 달성을 확인해 준다 — 넘긴 날짜에 코인이 지급된다.
// 손익분기 미설정이거나 본전 미달이면 achieved가 빈 배열(coins 0).
export type BreakevenReward = {
  achieved: string[];   // 본전 넘긴 날짜(YYYY-MM-DD) 목록
  count: number;
  coins: number;
  goal?: number;
  latest?: string | null;
  balance?: number | null;
};

export type SalesRecordResult = {
  created: { menu_id: number; name: string; quantity: number; total_price: number }[];
  count: number;
  total: number;
  breakeven_reward?: BreakevenReward;
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

/** 메뉴별 기여이익 — 잔당 마진 × 실제 판매 잔 수 (원가율만으로는 안 보이는 '재료비 뺀 총액' — 고정비 차감 전) */
export type MenuContribution = {
  menu_id: number;
  name: string;
  selling_price: number;
  cost_price: number;
  cost_ratio: number | null;
  margin_per_cup: number;
  sold_qty: number;
  revenue: number;
  total_margin: number;
  margin_share: number;
  recipe_missing: boolean;
};

export type ContributionResult = {
  days: number;
  menus: MenuContribution[];
  total_margin: number;
  total_revenue: number;
  total_qty: number;
};

export const getMenuContribution = (token: string, days = 30) =>
  apiFetch<ContributionResult>(`/api/v1/chatbot/sales/contribution?days=${days}`, {
    headers: auth(token),
  });

// ── POS 매출 파일 임포트 (엑셀/CSV) ──
export type ImportPreviewRow = {
  menu_name: string;
  menu_id: number | null;
  matched_name: string | null;
  quantity: number;
  total_price: number | null;
  sold_at: string | null;
  warnings: string[];
};

// 미등록 메뉴 하나 — 저장에서 빠지므로 '한 번에 등록' 후보로 쓴다.
export type UnmatchedMenu = {
  name: string;
  rows: number;        // 이 메뉴가 나온 행 수
  quantity: number;    // 합계 수량
  amount: number;      // 합계 금액(= 이만큼 매출이 빠진다)
  suggested_price: number; // 등록 화면에 채워 넣을 판매가 제안(금액÷수량)
};

export type ImportPreview = {
  mapping: Record<string, any>;
  // 열 매핑에 어떤 엔진이 쓰였는지 — 'ai'(Gemini) | 'heuristic'(키워드). 실패 시 mapping_error에 사유.
  source?: 'ai' | 'heuristic';
  mapping_note?: string | null;
  mapping_error?: string | null;
  confidence?: number | null;
  rows: ImportPreviewRow[];
  summary: {
    total_rows: number;
    matched: number;
    unmatched: number;
    sum_amount: number;
    // 미등록 메뉴 때문에 저장에서 빠질 매출 총액 + 그 메뉴 목록(등록 후보)
    unmatched_amount: number;
    unmatched_menus: UnmatchedMenu[];
  };
};

/** POS 파일(엑셀/CSV) 업로드 → LLM이 열을 매핑해 미리보기 반환 (DB 저장 안 함) */
export async function previewSalesImport(
  file: { uri: string; mimeType?: string | null; fileName?: string | null },
  token: string,
): Promise<ImportPreview> {
  const form = new FormData();
  const name = file.fileName ?? 'sales.csv';
  const type = file.mimeType ?? 'text/csv';
  if (Platform.OS === 'web') {
    const blob = await (await fetch(file.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    form.append('file', { uri: file.uri, name, type } as unknown as Blob);
  }
  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/sales/import/preview`, {
    method: 'POST',
    headers: auth(token),
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `파일 분석 실패 (${res.status})`);
  }
  return res.json();
}

// 레시피 한 줄 — 재료 1개와 1잔당 소요량. 등록 시 함께 주면 재고 차감이 바로 연결된다.
export type RecipeLine = { ingredient_id: number; quantity: number };

export type RegisteredMenu = {
  name: string;
  menu_id: number;
  selling_price: number;
  created: boolean;
  recipe_added: number;        // 이번에 연결된 레시피 줄 수
  recipe_skipped: number[];    // 무시된 재료 id(남의 매장 재료·수량 이상)
  has_recipe: boolean;         // true면 이제 이 메뉴는 저장 시 재고가 차감된다
};

/** 파일에서 발견된 미등록 메뉴를 메뉴로 등록.
 *  recipe를 함께 주면 등록과 동시에 레시피가 연결돼 재고 차감까지 바로 동작한다.
 *  (재료 목록은 백엔드 A의 GET /inventory/ingredients 사용) */
export const registerImportMenus = (
  token: string,
  menus: { name: string; selling_price: number; recipe?: RecipeLine[] }[],
) =>
  apiFetch<{ menus: RegisteredMenu[] }>('/api/v1/chatbot/sales/import/register-menus', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ menus }),
  });

/** 미리보기에서 확인·수정한 행을 실제 매출로 저장 (Sale 기록 + 재고 차감) */
export const confirmSalesImport = (
  token: string,
  rows: { menu_id: number; quantity: number; total_price: number | null; sold_at: string | null }[],
) =>
  apiFetch<{ created: number; total: number; breakeven_reward?: BreakevenReward }>(
    '/api/v1/chatbot/sales/import/confirm', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ rows }),
    });
