// 할 일 목록 API (백엔드 B의 /api/v1/chatbot/todos 연동, 인증 필요)
//
// 여기 담기는 건 '누군가 명시적으로 적어둔' 할 일이다 — 사장님이 직접 입력했거나
// 챗봇(브루)이 대화 중 추가한 것. 재고 부족·서류 갱신처럼 조건에서 자동으로 도출되는
// 할 일은 서버에 저장하지 않고 대시보드가 재고·서류 API로 매번 조립한다
// (저장하면 재고를 채운 뒤에도 유령 항목이 남는다).
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type ServerTodo = {
  id: number;
  title: string;
  note?: string | null;
  /** owner = 사장님 직접 입력, ai = 브루가 대화 중 추가 (배지 표시용) */
  source: 'owner' | 'ai';
  done: boolean;
  due_date?: string | null;
  created_at?: string | null;
};

/** 미완료가 먼저, 기한 임박 순. 완료 항목은 12시간까지만 함께 온다 */
export async function listTodos(token: string): Promise<ServerTodo[]> {
  return apiFetch<ServerTodo[]>('/api/v1/chatbot/todos', { headers: auth(token) });
}

export async function createTodo(
  token: string,
  title: string,
  note?: string,
  dueDate?: string
): Promise<ServerTodo> {
  return apiFetch<ServerTodo>('/api/v1/chatbot/todos', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title, note: note ?? null, due_date: dueDate ?? null }),
  });
}

/** 보낸 필드만 바뀐다 — 완료 토글이 가장 흔한 용도 */
export async function updateTodo(
  token: string,
  id: number,
  patch: { title?: string; note?: string; due_date?: string; done?: boolean }
): Promise<ServerTodo> {
  return apiFetch<ServerTodo>(`/api/v1/chatbot/todos/${id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify(patch),
  });
}

export async function deleteTodo(token: string, id: number): Promise<void> {
  await apiFetch<void>(`/api/v1/chatbot/todos/${id}`, {
    method: 'DELETE',
    headers: auth(token),
  });
}
