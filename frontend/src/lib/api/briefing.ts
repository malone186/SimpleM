// 오늘의 브루 브리핑 API 클라이언트 (백엔드 B의 /api/v1/chatbot/briefing)
//
// 아침에 푸시로 도착하는 것과 **같은 내용**이다. 어제 얼마 벌었는지, 오늘 누가 나오는지,
// 지금 가장 급한 세 가지가 무엇인지를 한 장으로 정리해 준다.
// 서버가 매장별로 하루 한 번 만들어 캐시하므로 여러 번 불러도 같은 답이 온다.
import { apiFetch } from './client';

import type { Insight } from './insights';

/** 브리핑에 실리는 우선순위 — 인사이트와 같은 근거를 쓴다 (알림·할 일과 말이 어긋나지 않게) */
export type BriefingPriority = Pick<
  Insight,
  'key' | 'category' | 'severity' | 'title' | 'body' | 'action' | 'due_date'
>;

export type Briefing = {
  date: string;                 // YYYY-MM-DD
  weekday: string;              // 월 ~ 일
  headline: string;             // 오늘을 한 줄로 ("어제보다 12% 오른 하루")
  message: string;              // 2~3문장 브리핑 본문
  facts: {
    yesterday: string;
    yesterday_sales: {
      total: number;
      prev_total: number;
      change_pct: number | null;
      best_menu: { name: string; qty: number } | null;
    };
    staff: { name: string; span: string }[];
    deposit: { net: number; date: string } | null;
  };
  priorities: BriefingPriority[];
  insight_count: number;
  high_count: number;
  engine: 'ai' | 'rule';        // ai=Gemini 문장, rule=키 없거나 실패해 규칙 문장
  generated_at: string;
  cached?: boolean;
};

/** 오늘의 브리핑. refresh=true면 서버 캐시를 버리고 다시 만든다 (수 초 걸릴 수 있다) */
export async function fetchBriefing(token?: string | null, refresh = false): Promise<Briefing> {
  return apiFetch<Briefing>(`/api/v1/chatbot/briefing${refresh ? '?refresh=true' : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}
