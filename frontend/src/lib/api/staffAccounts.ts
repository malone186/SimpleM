// 직원 로그인 계정 API — 백엔드 /api/v1/staff-accounts/*
//
// [한글 주석] 계산대에 서는 사람은 대개 알바생인데, 사장님 계정에는
// 매출·정산·급여가 다 보여서 넘길 수 없다. 그래서 단골 차감만 되는 계정을 만든다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type StaffAccount = {
  id: number;
  name: string;
  login_id: string;
  is_active: boolean;
  employee_id: number | null;
  last_login_at: string | null;
  created_at: string;
};

export type StaffAccountCreated = {
  id: number;
  name: string;
  login_id: string;
  /** 이 값은 생성 직후 한 번만 내려온다 (서버는 해시만 저장) */
  initial_password: string;
  message: string;
  guide: string;
};

/** 지금 로그인한 주체가 사장님인지 직원인지 */
export type WhoAmI = {
  store_id: string;
  store_name: string | null;
  is_owner: boolean;
  staff_id: number | null;
  name: string | null;
};

export async function fetchStaffAccounts(token: string): Promise<StaffAccount[]> {
  return apiFetch<StaffAccount[]>('/api/v1/staff-accounts', { headers: auth(token) });
}

export async function createStaffAccount(
  token: string,
  payload: { name: string; login_id: string; employee_id?: number }
): Promise<StaffAccountCreated> {
  return apiFetch<StaffAccountCreated>('/api/v1/staff-accounts', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

/** 비밀번호 재발급 — 잊었거나 유출됐을 때. 응답에만 새 비밀번호가 담긴다. */
export async function resetStaffPassword(
  token: string, staffId: number
): Promise<{ password: string; message: string }> {
  return apiFetch(`/api/v1/staff-accounts/${staffId}/reset-password`, {
    method: 'POST',
    headers: auth(token),
  });
}

/**
 * 계정을 잠급니다 (퇴사 등).
 *
 * [한글 주석] 삭제가 아니라 잠금입니다. 이 직원이 처리한 차감 기록에서
 * '누가 했는지'를 되짚을 수 있어야 하기 때문입니다.
 */
export async function deactivateStaffAccount(
  token: string, staffId: number
): Promise<{ success: boolean; message: string }> {
  return apiFetch(`/api/v1/staff-accounts/${staffId}/deactivate`, {
    method: 'POST',
    headers: auth(token),
  });
}

export async function activateStaffAccount(
  token: string, staffId: number
): Promise<{ success: boolean; message: string }> {
  return apiFetch(`/api/v1/staff-accounts/${staffId}/activate`, {
    method: 'POST',
    headers: auth(token),
  });
}

export async function fetchWhoAmI(token: string): Promise<WhoAmI> {
  return apiFetch<WhoAmI>('/api/v1/staff-accounts/me', { headers: auth(token) });
}
