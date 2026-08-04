// 선제 인사이트 API 클라이언트
// 백엔드 /api/v1/chatbot/insights 연동 — 사장님이 묻기 전에 시스템이 찾아낸 "챙길 일".
//
// 저장된 알림 목록이 아니라 호출 시점에 매장 DB를 훑어 매번 새로 계산된 결과다.
// 조치를 끝내면 다음 호출에서 그 항목은 자연히 사라진다.
import { apiFetch } from './client';

/** 인사이트가 속한 영역 */
export type InsightCategory =
  | 'inventory'  // 재고 소진 예상, 단가 인상, 잠자는 재고
  | 'order'      // 진행 안 된 발주
  | 'document'   // 갱신 서류, 확정 안 한 명세서, 장부·실사표
  | 'tax'        // 신고 기한
  | 'sales'      // 매출 급락
  | 'staff'      // 주휴수당, 근로계약서
  | 'data'       // 판매 입력 누락, 레시피 없는 메뉴
  | 'market';    // 주변 상권 변화 — 경쟁 카페 개업·폐업

/** high=지금 조치, medium=이번 주, low=알아두면 좋음 */
export type InsightSeverity = 'high' | 'medium' | 'low';

export type Insight = {
  key: string;                  // 중복 제거·확인 처리에 쓰는 고유 키
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  action: string;               // 챗봇에게 그대로 말하면 처리되는 문구
  due_date: string | null;      // YYYY-MM-DD
  days_left: number | null;
};

export type InsightScan = {
  store_id: string;
  generated_at: string;
  count: number;
  high: number;
  medium: number;
  low: number;
  failed_scanners: string[];
  insights: Insight[];
};

const auth = (token?: string | null): Record<string, string> | undefined =>
  token ? { Authorization: `Bearer ${token}` } : undefined;

/** 지금 챙겨야 할 일 목록 (심각한 것부터 정렬) — 인증 필수 엔드포인트라 token이 없으면 401 */
export async function fetchInsights(token?: string | null): Promise<InsightScan> {
  return apiFetch<InsightScan>('/api/v1/chatbot/insights', { headers: auth(token) });
}

/**
 * 인사이트 확인 처리.
 * @param snoozeDays 0이면 영구 확인, 1 이상이면 그 일수만큼 숨겼다가 다시 알림
 */
export async function dismissInsight(key: string, snoozeDays = 0, token?: string | null): Promise<void> {
  await apiFetch(`/api/v1/chatbot/insights/${encodeURIComponent(key)}/dismiss`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ snooze_days: snoozeDays }),
  });
}
