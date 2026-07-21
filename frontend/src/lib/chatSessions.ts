// 챗봇 대화 세션 로컬 보관소 — AsyncStorage에 영구 저장한다.
// 백엔드 /chatbot/chat은 매 요청에 history를 함께 받는 무상태 구조라서
// 세션(새 채팅·과거 채팅) 관리는 기기 로컬에서 담당한다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ChatDocument } from './api/chatbot';

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
const MAX_SESSIONS = 50; // 오래된 세션은 자동 정리해 저장소가 무한히 크지 않게

/** 저장된 세션 전체 — 최근 수정 순으로 돌려준다. */
export async function loadSessions(): Promise<ChatSession[]> {
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

/** 세션 하나를 저장(신규/갱신). 최근 수정 순 유지 + 상한 초과분은 가장 오래된 것부터 삭제. */
export async function saveSession(session: ChatSession): Promise<void> {
  const list = await loadSessions();
  const next = [session, ...list.filter((s) => s.id !== session.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

/** 세션 하나 삭제. */
export async function deleteSession(id: string): Promise<void> {
  const list = await loadSessions();
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(list.filter((s) => s.id !== id)),
  ).catch(() => {});
}

/** 과거 채팅 전체 삭제. */
export async function clearSessions(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
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
