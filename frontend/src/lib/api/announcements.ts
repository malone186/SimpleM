// 관리자 공지/알림 — 관리자 페이지에서 발송한 공지를 앱이 받아 홈 강아지 말풍선으로 전한다.
import { apiFetch } from './client';

export interface AdminAnnouncement {
  id: number;
  title: string;
  target?: string;
  date?: string;
  author?: string;
}

/** 관리자 공지 이력 조회 (최신 발송 공지를 마스코트 말풍선에 띄우는 용도) */
export const getAnnouncements = () => apiFetch<AdminAnnouncement[]>('/api/v1/admin/notifications');
