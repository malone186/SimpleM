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

