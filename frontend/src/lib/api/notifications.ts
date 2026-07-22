// [한글 주석: 관리자 공지사항 수신 및 조회 API 연동 모듈]
import { apiFetch } from './client';

export interface AdminNotification {
  id: number;
  title: string;
  body?: string;
  target?: string;
  date: string;
  author?: string;
}

/**
 * [한글 주석: 관리자가 발송한 사장님 전체/그룹 공지사항 목록을 백엔드에서 조회합니다]
 */
export async function getAdminNotifications(): Promise<AdminNotification[]> {
  try {
    const data = await apiFetch<AdminNotification[]>('/api/v1/admin/notifications');
    return data || [];
  } catch (error) {
    console.error('공지사항 조회 실패:', error);
    return [];
  }
}
