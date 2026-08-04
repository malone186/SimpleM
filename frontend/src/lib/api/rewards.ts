// 포인트·상점 API (백엔드 B) — 할 일을 끝내면 코인이 쌓이고, 코인으로 브루를 꾸민다.
import { apiFetch } from './client';

/** 꾸미기 부위 — 같은 부위에는 하나만 착용된다 (부위가 다르면 함께 착용된다) */
export type ItemSlot = 'pose' | 'background' | 'frame';

export type ShopItem = {
  id: string;
  slot: ItemSlot;
  slot_label: string;
  name: string;
  emoji: string;
  price: number;
  desc: string;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
  /** 포즈 상품일 때만 — Brew의 mood 값 */
  mood?: string | null;
};

export type ShopState = {
  balance: number;
  items: ShopItem[];
};

export type PointHistoryItem = {
  id: number;
  delta: number; // 적립은 양수, 사용은 음수
  reason: string;
  reason_label: string;
  memo: string;
  created_at: string | null;
};

export type Wallet = {
  balance: number;
  total_earned: number;
  history: PointHistoryItem[];
};

/** 착용 중인 아이템. pose면 mood로 브루 그림 자체가 바뀌고, background면 뒤에 깔린다. */
export type EquippedItem = { id: string; slot: ItemSlot; emoji: string; mood?: string };

const authHeader = (token?: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

/** 코인 잔액 + 누적 적립 + 최근 내역 */
export function getWallet(token?: string | null): Promise<Wallet> {
  return apiFetch<Wallet>('/api/v1/rewards/wallet', { headers: authHeader(token) });
}

/** 상점 카탈로그 (보유·착용·구매가능 여부 포함) */
export function getShop(token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>('/api/v1/rewards/shop', { headers: authHeader(token) });
}

/** 아이템 구매 — 갱신된 상점 상태를 그대로 돌려주므로 재조회할 필요가 없다 */
export function buyItem(itemId: string, token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>(`/api/v1/rewards/shop/${itemId}/buy`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

/** 착용/해제 */
export function equipItem(itemId: string, equipped: boolean, token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>('/api/v1/rewards/equip', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ item_id: itemId, equipped }),
  });
}

/** 착용 중인 아이템만 가볍게 — 브루를 그리는 화면들이 쓴다 */
export function getEquipped(token?: string | null): Promise<EquippedItem[]> {
  return apiFetch<EquippedItem[]>('/api/v1/rewards/equipped', { headers: authHeader(token) });
}
