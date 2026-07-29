// 백엔드 B 담당 — 1대1 문의 API (백엔드 /api/v1/inquiries 연동)
// 관리자 답변 도착 감지(AlertsWatcher)와 설정 화면 '나의 문의 내역'이 공용으로 사용한다.
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

/** 내 문의 내역 조회 — 서버가 토큰 주인의 문의만 최신순으로 돌려준다.
 *
 *  예전엔 `?user_email=`에 이메일만 붙이면 인증 없이 남의 문의 전문과 관리자 답변까지
 *  읽을 수 있었다. 이제 이메일을 보내지 않고, 누구 것인지는 토큰이 정한다.
 */
export function listMyInquiries(token: string): Promise<Inquiry[]> {
  return apiFetch('/api/v1/inquiries', {
    headers: { Authorization: `Bearer ${token}` },
  });
}
