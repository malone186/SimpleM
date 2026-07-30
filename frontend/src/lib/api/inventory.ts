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

// --- [로스터리 원두 탐색 마켓 관련 타입 정의] ---

// 로스터리 업체 정보
export type Roastery = {
  id: number;
  name: string;
  thumbnail_url: string | null;
  roastery_info: string | null;
  file_path: string | null;
};

// 원두 상품 상세 정보
export type RoasteryBean = {
  id: number;
  name: string;
  price: number;
  roastery_id: number;
  thumbnail_url: string | null;
  product_url: string | null;
  date_added: string | null;
  best: boolean;
  new: boolean;
  sold_out: boolean;
  description: string | null;
  country: string | null;
  process: string | null;
  blend: boolean;
  decaf: boolean;
  gesha: boolean;
  price_per_gram: number | null;
  naver_product_id: string | null;
  roastery: Roastery | null;
};

// (삭제됨) DEFAULT_ROASTERY_BEANS — 서버 조회가 실패하면 지어낸 원두 5종을 대신 보여줬다.
// 원두 탐색 화면은 '어디가 더 싼가'를 보는 곳인데, 존재하지 않는 상품에 만들어낸 가격이
// 'BEST'/'NEW' 배지까지 달고 떴다. 화면 어디에도 샘플이라는 표시가 없어 실제 시세로 읽힌다.
// 값이 없으면 빈 목록을 주고, 화면이 "불러오지 못했다"고 말하게 한다.

/** [로스터리 원두 목록 조회] DB에 등록된 원두 상품 목록을 가져옵니다.
 *  조회에 실패하면 예외를 그대로 올린다 — 가격 비교 화면에서 지어낸 시세를 보여주느니
 *  못 불러왔다고 말하는 편이 낫다. */
export async function listRoasteryBeans(token?: string, limit = 10): Promise<RoasteryBean[]> {
  const list = await apiFetch<RoasteryBean[]>(
    `/api/v1/inventory/roastery-beans?limit=${limit}`,
    token ? { headers: auth(token) } : undefined,
  );
  return Array.isArray(list) ? list : [];
}


