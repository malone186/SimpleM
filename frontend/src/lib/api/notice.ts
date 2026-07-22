// 백엔드 B 담당 — 관리자 공지 수신 API (백엔드 /api/v1/admin/notifications/feed 연동, 인증 필요)
// 관리자 콘솔(admin_web)에서 발송한 공지를 로그인한 사장님 본인 몫만 증분(after_id)으로 받아온다.
import { apiFetch } from './client';

export type AdminNotice = {
  id: number;
  title: string;
  body: string;
  target: string;      // 표시용 라벨 (예: 전체 사장님, 특정 매장 (...))
  target_type: string; // all | premium | specific
  date: string;        // YYYY-MM-DD HH:MM
  author: string;
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 내 계정으로 온 새 관리자 공지 목록 — 마지막으로 받은 id 이후 것만 */
export function fetchNoticeFeed(token: string, afterId: number): Promise<AdminNotice[]> {
  return apiFetch(`/api/v1/admin/notifications/feed?after_id=${afterId}`, { headers: auth(token) });
}
