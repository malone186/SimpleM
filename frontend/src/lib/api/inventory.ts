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

export const DEFAULT_ROASTERY_BEANS: RoasteryBean[] = [
  {
    id: 1,
    name: 'BG블렌드 (500g)',
    roastery_id: 1,
    price: 15000,
    product_url: 'https://mungmung.site/?q=BG블렌드',
    thumbnail_url: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=500',
    date_added: '2026-07-01',
    best: true,
    new: false,
    sold_out: false,
    description: '진하고 고소한 미디엄 다크 로스팅 블렌드',
    country: '에티오피아 / 브라질',
    process: '워시드',
    blend: true,
    decaf: false,
    gesha: false,
    price_per_gram: 30,
    naver_product_id: null,
    roastery: { id: 1, name: '타이커피', thumbnail_url: null, roastery_info: '타이커피 로스터리', file_path: null },
  },
  {
    id: 2,
    name: '에티오피아 예가체프 G1 (200g)',
    roastery_id: 2,
    price: 14000,
    product_url: 'https://mungmung.site/?q=에티오피아예가체프',
    thumbnail_url: 'https://images.unsplash.com/photo-1587734195503-904fca47e0e9?w=500',
    date_added: '2026-07-02',
    best: true,
    new: true,
    sold_out: false,
    description: '화사한 꽃향기와 상큼한 과일 아로마가 피어나는 싱글 오리진',
    country: '에티오피아',
    process: '내추럴',
    blend: false,
    decaf: false,
    gesha: false,
    price_per_gram: 70,
    naver_product_id: null,
    roastery: { id: 2, name: '가델로 커피', thumbnail_url: null, roastery_info: '가델로 커피 로스터리', file_path: null },
  },
  {
    id: 3,
    name: '콜롬비아 수프리모 (500g)',
    roastery_id: 3,
    price: 16500,
    product_url: 'https://mungmung.site/?q=콜롬비아수프리모',
    thumbnail_url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=500',
    date_added: '2026-07-03',
    best: false,
    new: false,
    sold_out: false,
    description: '부드러운 견과류 풍미와 단맛의 뛰어난 밸런스',
    country: '콜롬비아',
    process: '워시드',
    blend: false,
    decaf: false,
    gesha: false,
    price_per_gram: 33,
    naver_product_id: null,
    roastery: { id: 3, name: '모카 팩토리', thumbnail_url: null, roastery_info: '모카 팩토리', file_path: null },
  },
  {
    id: 4,
    name: '디카페인 딥 블렌드 (200g)',
    roastery_id: 1,
    price: 15500,
    product_url: 'https://mungmung.site/?q=디카페인딥블렌드',
    thumbnail_url: 'https://images.unsplash.com/photo-1611854779393-1b2da9d400fe?w=500',
    date_added: '2026-07-04',
    best: false,
    new: false,
    sold_out: false,
    description: '카페인 부담 없이 다크 초콜릿 풍미를 즐기는 특허 디카페인',
    country: '과테말라',
    process: '스위스 워터 Process',
    blend: true,
    decaf: true,
    gesha: false,
    price_per_gram: 77.5,
    naver_product_id: null,
    roastery: { id: 1, name: '타이커피', thumbnail_url: null, roastery_info: '타이커피', file_path: null },
  },
];

/** [로스터리 원두 목록 조회] DB에 등록된 원두 상품 목록을 가져옵니다 (실패 시 안전 샘플 폴백). */
export async function listRoasteryBeans(token?: string, limit = 10): Promise<RoasteryBean[]> {
  try {
    const list = await apiFetch<RoasteryBean[]>(`/api/v1/inventory/roastery-beans?limit=${limit}`, token ? { headers: auth(token) } : undefined);
    if (list && Array.isArray(list) && list.length > 0) return list;
  } catch (e) {
    console.warn('원두 목록 서버 조회 실패, 기본 샘플 원두 폴백:', e);
  }
  return DEFAULT_ROASTERY_BEANS;
}


