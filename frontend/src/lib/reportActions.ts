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
