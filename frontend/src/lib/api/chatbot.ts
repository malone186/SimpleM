// 프론트 B 담당 — 챗봇 대화 API (백엔드 멀티에이전트 두뇌 /chatbot/chat 연동)
import { apiFetch } from './client';

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

/** 챗봇에게 메시지를 보내고 답변을 받는다. 토큰을 주면 내 매장 데이터 기준으로 답한다. */
export function sendChatMessage(
  message: string,
  history: ChatHistoryItem[] = [],
  token?: string | null,
): Promise<ChatReply> {
  return apiFetch<ChatReply>('/api/v1/chatbot/chat', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ message, history }),
  });
}
