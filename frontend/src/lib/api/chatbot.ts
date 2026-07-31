// 프론트 B 담당 — 챗봇 대화 API (백엔드 멀티에이전트 두뇌 /chatbot/chat 연동)
import { apiFetch, API_BASE_URL } from './client';

// 백엔드 두뇌가 기대하는 이전 대화 형식 (Gemini 규격: user / model)
export type ChatHistoryItem = { role: 'user' | 'model'; text: string };

// 챗봇이 이번 턴에 생성/수정한 문서 전문 — 말풍선 아래 카드로 렌더링한다
export type ChatDocument = {
  id: string;
  kind: string; // purchase_order | stocktake_sheet | inspection_report | monthly_ledger | vat_reference | payslip | employment_contract | management_report
  title: string;
  period?: string | null;
  status?: string;
  content: Record<string, unknown>; // kind별로 스키마가 다르다 — 카드가 범용 렌더링
  created_at?: string;
};

export type ChatReply = { response: string; documents?: ChatDocument[] };

/** 챗봇 무료 사용량 — 하루 free_daily턴 무료, 광고 1회당 turns_per_ad턴 충전 */
export type ChatQuota = {
  date: string;
  used: number;
  granted: number;
  free_daily: number;
  remaining: number;
  ads_watched: number;
  turns_per_ad: number;
  can_watch_ad: boolean; // 하루 광고 상한에 걸리면 false — 광고를 권하지 말 것
};

/** 남은 턴이 없어 거절됐다 — 광고를 보면 충전할 수 있다 (다른 오류와 구분해야 해서 별도 타입) */
export class ChatQuotaExhaustedError extends Error {
  constructor(readonly quota: ChatQuota | null) {
    super('오늘 무료 대화 횟수를 다 썼어요.');
    this.name = 'ChatQuotaExhaustedError';
  }
}

const authHeader = (token?: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

/**
 * 챗봇에게 메시지를 보내고 답변을 받는다. 토큰을 주면 내 매장 데이터 기준으로 답한다.
 *
 * apiFetch를 쓰지 않고 직접 fetch하는 이유: 할당량 소진(429)을 다른 오류와 구분해
 * 광고 유도로 이어가야 하는데, apiFetch는 상태 코드를 문자열 메시지에 섞어버린다.
 * (client.ts는 공동 소유 파일이라 건드리지 않는다)
 */
export async function sendChatMessage(
  message: string,
  history: ChatHistoryItem[] = [],
  token?: string | null,
): Promise<ChatReply> {
  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ message, history }),
  });

  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    if (body?.detail?.quota_exhausted) {
      throw new ChatQuotaExhaustedError(body.detail.quota ?? null);
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === 'string' ? body.detail : '';
    throw new Error(detail ? `${res.status} · ${detail}` : `챗봇 응답 실패 (${res.status})`);
  }

  return res.json();
}

/** 남은 턴 조회 — 조회만으로는 소비되지 않는다. */
export function getChatQuota(token?: string | null): Promise<ChatQuota> {
  return apiFetch<ChatQuota>('/api/v1/chatbot/quota', { headers: authHeader(token) });
}

/** 광고를 끝까지 본 뒤 호출 — 턴을 충전한다. */
export function grantChatQuotaFromAd(token?: string | null): Promise<ChatQuota> {
  return apiFetch<ChatQuota>('/api/v1/chatbot/quota/ad-reward', {
    method: 'POST',
    headers: authHeader(token),
  });
}
