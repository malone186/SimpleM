// POS 실시간 연동 API — 매장별 Square 연결 관리·즉시 동기화 (백엔드 /api/v1/pos)
// 웹훅(실시간) + 자동 폴링(안전망) 조합이라, 여기서는 연결 저장과 수동 동기화만 다룬다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type PosConnection = {
  connected: boolean;
  provider?: string | null;
  environment?: string | null;
  access_token_masked?: string | null;
  webhook_configured?: boolean;
  webhook_url?: string | null;
  merchant_id?: string | null;
  auto_sync?: boolean | null;
  last_synced_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
};

export type PosSyncResult = {
  orders_seen: number;
  orders_synced: number;
  orders_skipped_duplicate: number;
  sales_created: number;
  total_amount: number;
  unmatched_items: { name: string; quantity: number }[];
};

export const getPosConnection = (token: string) =>
  apiFetch<PosConnection>('/api/v1/pos/connection', { headers: auth(token) });

export const savePosConnection = (
  token: string,
  body: {
    provider: string;
    environment: string;
    access_token: string;
    webhook_signature_key?: string | null;
    auto_sync: boolean;
  },
) =>
  apiFetch<PosConnection>('/api/v1/pos/connection', {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const deletePosConnection = (token: string) =>
  apiFetch<void>('/api/v1/pos/connection', { method: 'DELETE', headers: auth(token) });

export const syncPosNow = (token: string, hours?: number) =>
  apiFetch<PosSyncResult>(`/api/v1/pos/sync-now${hours ? `?hours=${hours}` : ''}`, {
    method: 'POST',
    headers: auth(token),
  });
