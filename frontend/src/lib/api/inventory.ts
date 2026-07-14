// 프론트 A 담당 — 재고 API (백엔드 /api/v1/inventory 연동, 인증 필요)
import { apiFetch } from './client';

export type StockItem = {
  ingredient_id: number;
  name: string;
  unit: string;
  current_price: number;
  current_quantity: number;
  safety_quantity: number;
  updated_at: string;
};

export type Ingredient = {
  id: number;
  name: string;
  unit: string;
  current_price: number;
  store_id: string;
  created_at: string;
  updated_at: string | null;
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 내 매장 재고 현황 (재료명·단위·단가 + 실시간 수량) */
export function listStocks(token: string): Promise<StockItem[]> {
  return apiFetch('/api/v1/inventory/stocks', { headers: auth(token) });
}

/** 재료 직접 등록 (재고는 0으로 시작) */
export function createIngredient(
  token: string,
  body: { name: string; unit: string; current_price: number },
): Promise<Ingredient> {
  return apiFetch('/api/v1/inventory/ingredients', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
}

/** 재고 수량 조정 — 입고는 양수, 차감/폐기는 음수 */
export function adjustStock(
  token: string,
  body: { ingredient_id: number; quantity_change: number; description?: string },
) {
  return apiFetch('/api/v1/inventory/stocks/adjust', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
}
