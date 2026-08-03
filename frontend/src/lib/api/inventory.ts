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

// --- [발주 관련 타입 정의] ---

// 1. 발주서 내 상세 품목 한 줄의 타입
export type OrderItem = {
  id: number;
  ingredient_id: number;
  ingredient_name: string;                                           // 재료명 (예: 서울우유 1L)
  quantity: number;                                                  // 발주 신청 수량
  price_at_order: number;                                            // 발주 신청 당시의 단가
};

// 2. 발주서 전체 정보 타입
export type OrderDraft = {
  id: number;
  store_id: string;
  status: 'DRAFT' | 'CONFIRMED' | 'REJECTED';                        // DRAFT(초안), CONFIRMED(승인완료), REJECTED(반려)
  total_amount: number;                                              // 총 주문 예상 금액
  created_at: string;
  vendor: string;                                                    // 공급처명 (가상 필드)
  reason: string;                                                    // 발주 사유 (가상 필드)
  source: string;                                                    // 발주 생성 출처
  items: OrderItem[];                                                // 묶여 있는 상세 품목 목록
};

/** [발주 추천 초안 목록 조회 API 호출] 실시간 안전재고 미달 품목 기반 발주서 초안들을 가져옵니다. */
export function listOrderDrafts(token: string): Promise<OrderDraft[]> {
  return apiFetch('/api/v1/inventory/orders/drafts', { headers: auth(token) });
}

/** [발주 초안 승인 및 반려 API 호출] 사장님이 승인(CONFIRMED)하여 실제 창고 입고를 처리하거나, 반려(REJECTED)합니다. */
export function updateOrderStatus(
  token: string,
  orderId: number,
  status: 'CONFIRMED' | 'REJECTED',
): Promise<{ id: number; status: string; message: string }> {
  return apiFetch(`/api/v1/inventory/orders/${orderId}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ status }),
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


