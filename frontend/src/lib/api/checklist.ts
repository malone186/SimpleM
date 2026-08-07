// 근무 체크리스트 API (백엔드 /api/v1/checklist) — 직원·사장 공유, 매일 초기화.
//
// 조회·토글은 직원도 한다(근무 루틴). 항목 등록·수정·삭제는 사장님만(백엔드 require_owner).
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type ChecklistItem = {
  id: number;
  label: string;
  sort_order: number;
  /** 오늘 체크됐는지 */
  done: boolean;
  /** 오늘 체크한 사람 (직원 이름 또는 '사장님') */
  done_by?: string | null;
  checked_at?: string | null;
};

/** 오늘 기준 체크리스트. 자정이 지나면 서버가 저절로 새 목록을 준다(날짜 기준). */
export async function listChecklist(token: string): Promise<ChecklistItem[]> {
  return apiFetch<ChecklistItem[]>('/api/v1/checklist', { headers: auth(token) });
}

/** 오늘 체크 토글 (직원·사장 공용) */
export async function toggleChecklist(
  token: string,
  itemId: number,
): Promise<{ id: number; done: boolean; done_by?: string | null }> {
  return apiFetch(`/api/v1/checklist/${itemId}/toggle`, { method: 'POST', headers: auth(token) });
}

// --- 사장님 전용: 항목 관리 ---
export async function addChecklistItem(token: string, label: string): Promise<ChecklistItem> {
  return apiFetch<ChecklistItem>('/api/v1/checklist/items', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ label }),
  });
}

export async function updateChecklistItem(
  token: string,
  itemId: number,
  patch: { label?: string; active?: boolean; sort_order?: number },
): Promise<ChecklistItem> {
  return apiFetch<ChecklistItem>(`/api/v1/checklist/items/${itemId}`, {
    method: 'PATCH', headers: auth(token), body: JSON.stringify(patch),
  });
}

export async function deleteChecklistItem(token: string, itemId: number): Promise<void> {
  await apiFetch<void>(`/api/v1/checklist/items/${itemId}`, { method: 'DELETE', headers: auth(token) });
}
