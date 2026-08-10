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
  // 서버가 앱 보고만으로는 충전하지 않는 모드(SSV 강제)일 때 true. 실패가 아니라
  // '아직'이다 — 구글의 검증 콜백이 서버에 도착하면 그때 충전된다.
  pending_verification?: boolean;
};

/** 남은 턴이 없어 거절됐다 — 광고를 보면 충전할 수 있다 (다른 오류와 구분해야 해서 별도 타입) */
export class ChatQuotaExhaustedError extends Error {
  constructor(readonly quota: ChatQuota | null) {
    super('오늘 무료 대화 횟수를 다 썼어요.');
    this.name = 'ChatQuotaExhaustedError';
  }
}

/**
 * 할당량 소진 오류인지 판정한다.
 *
 * `instanceof`만 쓰지 않는 이유: Metro Fast Refresh가 이 모듈만 다시 불러오면 클래스
 * 객체가 새로 만들어져, 화면이 들고 있던 예전 클래스와 동일성 비교가 실패한다. 그러면
 * 개발 중에만 광고 유도가 조용히 사라지고 일반 오류 문구가 뜬다 — 원인 찾기 매우 어렵다.
 */
export function isChatQuotaExhausted(e: unknown): e is ChatQuotaExhaustedError {
  return e instanceof ChatQuotaExhaustedError || (e as Error | null)?.name === 'ChatQuotaExhaustedError';
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
    if (__DEV__) console.log('[quota] 429 수신 — detail:', JSON.stringify(body?.detail));
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

/**
 * 광고를 끝까지 본 뒤 호출 — 턴을 충전한다.
 *
 * 서버가 SSV(구글 서버 사이드 검증) 강제 모드면 이 호출로는 충전되지 않고
 * pending_verification=true가 돌아온다. 그때는 잠시 뒤 쿼터를 다시 조회해야 한다
 * (waitForAdQuota가 그 대기를 대신한다).
 */
export function grantChatQuotaFromAd(token?: string | null): Promise<ChatQuota> {
  return apiFetch<ChatQuota>('/api/v1/chatbot/quota/ad-reward', {
    method: 'POST',
    headers: authHeader(token),
  });
}

/**
 * 광고 충전이 반영될 때까지 잠깐 기다린다 — 검증 콜백이 구글에서 서버로 오는 몇 초를 덮는다.
 *
 * 곧바로 충전된 경우(검증 강제가 아닌 서버)에는 첫 응답에서 끝나므로 대기가 없다.
 */
export async function waitForAdQuota(
  granted: ChatQuota,
  token?: string | null,
  tries = 5,
): Promise<ChatQuota> {
  if (!granted.pending_verification || granted.remaining > 0) return granted;

  let latest = granted;
  for (let i = 0; i < tries; i += 1) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      latest = await getChatQuota(token);
    } catch {
      // 일시적인 네트워크 오류 — 다음 회차에 다시 본다
      continue;
    }
    if (latest.remaining > 0) return latest;
  }
  return latest;
}
