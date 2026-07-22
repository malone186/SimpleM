// 백엔드 B 담당 — 1대1 문의 API (백엔드 /api/v1/inquiries 연동)
// 사장님 본인 문의만 이메일로 필터해 가져온다. 관리자 답변 도착 감지(AlertsWatcher)와
// 설정 화면 '나의 문의 내역'이 공용으로 사용한다.
import { apiFetch } from './client';

export type Inquiry = {
  id: number;
  user_email: string;
  store_name: string;
  category: string;
  title: string;
  content: string;
  status: 'pending' | 'answered';
  answer: string | null;
  date: string;
};

/** 내 문의 내역 조회 — user_email 필터로 본인 것만 최신순 */
export function listMyInquiries(email: string): Promise<Inquiry[]> {
  return apiFetch(`/api/v1/inquiries?user_email=${encodeURIComponent(email)}`);
}
