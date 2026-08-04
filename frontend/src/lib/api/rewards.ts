// 포인트·상점 API (백엔드 B) — 할 일을 끝내면 코인이 쌓이고, 코인으로 브루를 꾸민다.
import { apiFetch } from './client';

/** 꾸미기 부위 — 같은 부위에는 하나만 착용된다 */
export type ItemSlot = 'pose' | 'background';

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

/** 적립 결과 — awarded가 0이면 이미 받은 항목이라 잔액이 그대로다 */
export type AwardResult = { awarded: number; balance: number };

/**
 * 자동 도출 할 일(재고 발주·서류 갱신·브루 추천)을 끝냈다고 알린다.
 *
 * 이 항목들은 조건에서 매번 새로 조립되므로 서버에 저장된 행이 없다 — 그래서 완료
 * API가 없고, 대신 대시보드가 쓰는 안정적인 id(stock-<재료id> 등)를 key로 보낸다.
 * 같은 key로 두 번 보내도 코인은 한 번만 쌓인다(서버가 막는다).
 */
export function awardDerivedTodo(
  key: string,
  title: string,
  token?: string | null,
): Promise<AwardResult> {
  return apiFetch<AwardResult>('/api/v1/rewards/todo-done', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ key, title }),
  });
}

/** 착용 중인 아이템만 가볍게 — 브루를 그리는 화면들이 쓴다 */
export function getEquipped(token?: string | null): Promise<EquippedItem[]> {
  return apiFetch<EquippedItem[]>('/api/v1/rewards/equipped', { headers: authHeader(token) });
}
