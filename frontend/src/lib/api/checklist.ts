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
  /** 담당 직원 — 사장님이 특정 알바에게 지정한 항목만 채워진다 */
  assigned_staff_id?: number | null;
  assigned_staff_name?: string | null;
  /** 일회성 항목 — 사장님 '할 일'을 보낸 것. 체크하면 다음 날 사라진다 */
  one_off?: boolean;
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

/** 항목 추가 (직원·사장 공용). assignedStaffId는 사장님이 특정 알바에게 지시할 때만.
 *  oneOff=true면 일회성 — 사장님 '할 일'을 보낸 것이라 체크하면 다음 날 되살아나지 않는다. */
export async function addChecklistItem(
  token: string,
  label: string,
  assignedStaffId?: number | null,
  oneOff?: boolean,
): Promise<ChecklistItem> {
  return apiFetch<ChecklistItem>('/api/v1/checklist/items', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      label,
      assigned_staff_id: assignedStaffId ?? null,
      one_off: oneOff ?? false,
    }),
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
