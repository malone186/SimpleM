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

/** 로스터리 브랜드 요약 (원두에 딸려 오는 제조사 정보) */
export type RoasteryBrief = {
  id: number;
  name: string;
  thumbnail_url: string | null;
  roastery_info: string | null;
  file_path: string | null;
};

/** 로스터리 판매 원두 — 백엔드 roastery_beans 모델과 같은 필드 구성 */
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
  roastery: RoasteryBrief | null;
};

// GET /roastery/search가 돌려주는 항목 — 원두 모델 전체가 아니라 검색용으로 추린 형태다.
type BeanSearchItem = {
  id: number;
  name: string;
  roastery_id: number;
  roastery_name: string;
  price: number;
  price_per_gram: number | null;
  country: string | null;
  process: string | null;
  description: string | null;
  thumbnail_url: string | null;
  product_url: string;
  sold_out: boolean;
};

// 검색 응답에 decaf 컬럼이 실려 오지 않아 이름·설명에서 되짚는다.
// BeanNotepad의 카페인 설문이 이 값으로 갈리므로 없으면 디카페인 원두가 전부 일반으로 잡힌다.
// 백엔드(BeanSearchResultItem)가 decaf를 노출하면 이 추론은 지우고 그대로 받으면 된다.
const DECAF_HINTS = ['디카페인', '디카페', 'decaf', '스위스 워터', 'swiss water'];
const looksDecaf = (item: BeanSearchItem) => {
  const haystack = `${item.name} ${item.description ?? ''}`.toLowerCase();
  return DECAF_HINTS.some((hint) => haystack.includes(hint));
};

/**
 * 취향 큐레이션용 원두 목록.
 * 전용 목록 엔드포인트가 없어 원두 검색(GET /roastery/search)을 조건 없이 호출해 쓴다.
 * 검색 응답에 없는 필드(blend·gesha·best·new·date_added·naver_product_id)는
 * 모델 기본값으로 채운다 — 지금 화면에서 읽지 않는 값들이다.
 */
export async function listRoasteryBeans(token: string, limit = 20): Promise<RoasteryBean[]> {
  const res: { items?: BeanSearchItem[] } = await apiFetch(
    `/api/v1/roastery/search?limit=${limit}&sort_by=reviews`,
    { headers: auth(token) },
  );
  return (res.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    roastery_id: item.roastery_id,
    thumbnail_url: item.thumbnail_url,
    product_url: item.product_url,
    date_added: null,
    best: false,
    new: false,
    sold_out: item.sold_out,
    description: item.description,
    country: item.country,
    process: item.process,
    blend: false,
    decaf: looksDecaf(item),
    gesha: false,
    price_per_gram: item.price_per_gram,
    naver_product_id: null,
    roastery: {
      id: item.roastery_id,
      name: item.roastery_name,
      thumbnail_url: null,
      roastery_info: null,
      file_path: null,
    },
  }));
}

