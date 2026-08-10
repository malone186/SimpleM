// AI 경영 리포트의 액션 제안(ai_actions) — 백엔드 report_service의 screen enum을
// 실제 네비게이션 라우트로 잇는 단일 지점. 홈 카드와 챗봇 문서 카드가 같이 쓴다.
export type ReportAction = {
  title: string;
  evidence?: string;
  action: string;
  screen: string;
};

// 백엔드 enum(Menu/Cost/Inventory/Staff/Document/Marketing/SalesInput) → 라우트 이름.
// Staff는 '직원 근무 일정'을 뜻하므로 스케줄을 고치는 Operation 화면으로 보낸다
// (Staff 라우트는 인건비 정산 화면이라 근무 시간을 조정할 수 없다).
const SCREEN_ROUTES: Record<string, string> = {
  Menu: 'Menu',
  Cost: 'Cost',
  Inventory: 'Inventory',
  Staff: 'Operation',
  Document: 'Document',
  Marketing: 'Marketing',
  SalesInput: 'SalesInput',
};

/** 브루의 조언(ai_advice)을 화면에 그릴 줄 목록으로.
 *
 * 새 형식은 "1. …\n2. …"의 번호 매긴 줄이라 줄바꿈으로 나누고 번호 접두어는 뗀다
 * (번호는 렌더링 쪽에서 인덱스로 다시 붙인다 — 텍스트 파싱에 기대지 않기 위해).
 * 구형식(한 문단)은 문장 끝(…요./…다.)에서 끊어 같은 목록 모양으로 맞춘다 —
 * 쿼터 소진으로 옛 조언이 보존된 동안에도 카드가 문단 덩어리로 보이지 않게. */
export function parseAdviceLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/^\d+\.\s*/, ''))
    .filter(Boolean);
  if (lines.length !== 1) return lines;
  // 소수점(52.6%)은 건드리지 않도록 '요./다. + 공백'만 문장 경계로 본다
  return lines[0]
    .replace(/([요다]\.)\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** content.ai_actions를 화면에서 쓸 수 있는 액션 목록으로 정리 (라우트 없는 항목은 버린다) */
export function parseReportActions(raw: unknown): (ReportAction & { route: string })[] {
  if (!Array.isArray(raw)) return [];
  const out: (ReportAction & { route: string })[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const { title, evidence, action, screen } = a as Record<string, unknown>;
    const route = typeof screen === 'string' ? SCREEN_ROUTES[screen] : undefined;
    if (!route || typeof title !== 'string' || typeof action !== 'string') continue;
    out.push({
      title,
      action,
      evidence: typeof evidence === 'string' ? evidence : undefined,
      screen: screen as string,
      route,
    });
  }
  return out;
}
