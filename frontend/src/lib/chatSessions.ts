// 챗봇 대화 세션 보관소 — 로그인 시 서버 DB(/chatbot/sessions)에 저장해
// 기기·브라우저가 바뀌어도 기록이 따라오고, 계정별로 분리된다.
// 비로그인이거나 서버가 죽어 있으면 기기 로컬(AsyncStorage)로 폴백하고,
// 로컬에만 남은 세션은 다음 성공 로드 때 서버로 자동 이관한다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ChatDocument } from './api/chatbot';
import { apiFetch } from './api/client';

// ChatbotScreen의 말풍선 메시지와 같은 모양 (docs: 그 턴에 생성된 문서 카드)
export type ChatMsg = { id: string; role: 'bot' | 'user'; text: string; docs?: ChatDocument[] };

export type ChatSession = {
  id: string;
  title: string; // 첫 사용자 질문에서 따온 제목
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'simplem:chatSessions';
const MAX_SESSIONS = 50; // 오래된 세션은 자동 정리해 저장소가 무한히 크지 않게 (서버도 같은 정책)

// ---------------------------------------------------------------------------
// 서버 보관소 — 백엔드 chat_sessions 테이블 (시각 필드만 snake_case ↔ camelCase 변환)
// ---------------------------------------------------------------------------

type ServerSession = {
  id: string;
  title: string;
  messages: ChatMsg[];
  created_at: number;
  updated_at: number;
};

const fromServer = (s: ServerSession): ChatSession => ({
  id: s.id,
  title: s.title,
  messages: s.messages,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

function upsertOnServer(session: ChatSession, token: string): Promise<ServerSession> {
  return apiFetch<ServerSession>(`/api/v1/chatbot/sessions/${session.id}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({
      title: session.title,
      messages: session.messages,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }),
  });
}

// ---------------------------------------------------------------------------
// 로컬(AsyncStorage) 보관소 — 비로그인·서버 장애 시 폴백
// ---------------------------------------------------------------------------

async function loadLocal(): Promise<ChatSession[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ChatSession[];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error('채팅 기록 복원 실패:', err);
    return [];
  }
}

async function saveLocal(session: ChatSession): Promise<void> {
  const list = await loadLocal();
  const next = [session, ...list.filter((s) => s.id !== session.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

async function deleteLocal(id: string): Promise<void> {
  const list = await loadLocal();
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(list.filter((s) => s.id !== id)),
  ).catch(() => {});
}

async function clearLocal(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

// ---------------------------------------------------------------------------
// 공개 API — 화면은 token만 넘기면 서버/로컬 분기를 몰라도 된다
// ---------------------------------------------------------------------------

/** 저장된 세션 전체 — 최근 수정 순. 로그인 시 서버 기준, 실패하면 로컬 폴백. */
export async function loadSessions(token?: string | null): Promise<ChatSession[]> {
  if (!token) return loadLocal();
  try {
    const server = (await apiFetch<ServerSession[]>('/api/v1/chatbot/sessions', {
      headers: authHeaders(token),
    })).map(fromServer);
    // 서버 도입 전(또는 오프라인 중) 로컬에만 쌓인 세션은 서버로 이관하고 로컬을 비운다
    const local = await loadLocal();
    const known = new Set(server.map((s) => s.id));
    const pending = local.filter((s) => !known.has(s.id));
    if (pending.length) await Promise.all(pending.map((s) => upsertOnServer(s, token)));
    if (local.length) await clearLocal(); // 이관 성공 후에만 — 실패 시 catch로 빠져 로컬 유지
    return [...pending, ...server].sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return loadLocal();
  }
}

/** 세션 하나를 저장(신규/갱신). 서버 실패 시 로컬에 남겨 다음 로드 때 이관되게 한다. */
export async function saveSession(session: ChatSession, token?: string | null): Promise<void> {
  if (token) {
    try {
      await upsertOnServer(session, token);
      return;
    } catch {
      // 서버 다운 등 — 로컬 폴백으로 이어짐
    }
  }
  await saveLocal(session);
}

/** 세션 하나 삭제 — 폴백으로 로컬에 남은 사본도 함께 지운다. */
export async function deleteSession(id: string, token?: string | null): Promise<void> {
  if (token) {
    await apiFetch(`/api/v1/chatbot/sessions/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }).catch(() => {});
  }
  await deleteLocal(id);
}

/** 과거 채팅 전체 삭제. */
export async function clearSessions(token?: string | null): Promise<void> {
  if (token) {
    await apiFetch('/api/v1/chatbot/sessions', {
      method: 'DELETE',
      headers: authHeaders(token),
    }).catch(() => {});
  }
  await clearLocal();
}

/** 첫 사용자 질문으로 세션 제목을 만든다 (너무 길면 자름). */
export function makeTitle(firstUserText: string): string {
  const t = firstUserText.trim().replace(/\s+/g, ' ');
  return t.length > 24 ? `${t.slice(0, 24)}…` : t || '새 채팅';
}

/** 목록에 보여줄 상대 시각 라벨 (오늘 HH:MM / 어제 / M월 D일). */
export function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '어제';
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
