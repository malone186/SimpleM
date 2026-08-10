// 문서 content(JSON)의 영문 키·값 → 사장님용 한글 표기 (공용)
// 챗봇 문서 카드(DocumentCard) · 서류 자동화 화면(DocumentScreen) · 인쇄 HTML이 모두 이 맵을 쓴다.
// 새 문서 종류를 만들면 여기에 키만 추가하면 모든 화면에 한글로 나온다.

export const FIELD_LABELS: Record<string, string> = {
  // 공통
  date: '작성일',
  items: '품목',
  name: '이름',
  unit: '단위',
  period: '기간',
  status: '상태',
  quantity: '수량',
  total: '합계',
  memo: '메모',
  // 발주서·재고
  total_estimated: '예상 발주 총액',
  current_quantity: '현재 수량',
  safety_quantity: '최소 보유량',
  suggested_quantity: '제안 수량',
  unit_price: '단가',
  estimated_amount: '예상 금액',
  book_quantity: '장부 수량',
  counted_quantity: '실사 수량',
  difference: '차이',
  // 검수확인서
  inspection_date: '검수일',
  vendor: '거래처',
  delivery_date: '납품일',
  condition: '상태',
  inspector_sign: '검수자 서명',
  source_document: '원본 문서',
  spec: '규격',
  // 장부
  purchases: '매입 내역',
  sales: '매출 내역',
  doc_type: '문서 종류',
  subtotal: '공급가액',
  tax: '세액',
  menu: '메뉴',
  total_price: '금액',
  purchase_total: '매입 합계',
  sales_total: '매출 합계',
  balance: '수지 (매출-매입)',
  // 임금명세서·임금대장
  employee_name: '직원',
  hourly_wage: '시급',
  work_hours: '근무시간',
  hours_source: '집계 방식',
  earnings: '지급 내역',
  base_pay: '기본급',
  weekly_holiday_pay: '주휴수당',
  weekly_avg_hours: '주 평균 시간',
  gross: '지급 총액',
  deductions: '공제 내역',
  withholding_rate: '공제율',
  withholding: '공제액',
  net_pay: '실지급액',
  calculation: '계산식',
  entries: '내역',
  year: '연도',
  total_gross: '지급 총액 합계',
  total_net: '실지급 합계',
  payslip_id: '명세서 번호',
  // 부가세 참고자료
  estimated_sales_vat: '매출세액(추정)',
  purchase_subtotal: '매입 공급가액',
  purchase_tax: '매입세액',
  purchase_document_count: '매입 문서 수',
  estimated_payable_vat: '납부세액(추정)',
  // 근로계약서
  start: '시작',
  end: '종료',
  employer: '사업주',
  employee: '근로자',
  contract_period: '계약 기간',
  workplace: '근무 장소',
  duties: '업무 내용',
  working_conditions: '근로 조건',
  work_days_per_week: '주 근무일',
  work_hours_per_day: '일 근무시간',
  weekly_hours: '주 근무시간',
  rest: '휴게',
  weekly_holiday: '주휴일',
  annual_leave: '연차',
  wage: '임금',
  payment_day: '지급일',
  payment_method: '지급 방법',
  social_insurance: '4대보험',
  signatures: '서명',
  // 경영 리포트 (management_report)
  period_type: '리포트 종류',
  highlights: '핵심 요약',
  cups: '판매 잔 수',
  prev_total: '이전 기간 매출',
  change_pct: '증감률',
  daily_trend: '일별 매출',
  top_menus: '베스트 메뉴',
  document_count: '매입 문서 수',
  expenses: '기타 지출',
  by_category: '카테고리별 지출',
  category: '카테고리',
  amount: '금액',
  labor: '인건비',
  scheduled_hours: '스케줄 근무시간',
  estimated_cost: '인건비 추정',
  employee_count: '근무 직원 수',
  shift_count: '근무 건수',
  profit: '수익 추정',
  total_cost: '총 비용',
  estimated_profit: '추정 수익',
  margin_pct: '이익률',
  inventory: '재고 현황',
  ingredient_count: '등록 재료 수',
  total_value: '보유 재고 금액',
  low_stock: '곧 떨어질 재료',
  orders: '발주 진행',
  open_count: '진행 중 발주',
  open_amount: '발주 예상 금액',
  compliance_alerts: '기한 임박 서류',
  ai_advice: '브루의 조언',
  ai_actions: '지금 할 수 있는 일',
  // 경영 리포트 — 재료 원가(레시피 기준)
  cogs: '재료값 (팔린 메뉴 기준)',
  theoretical: '재료값 합계',
  cost_ratio: '매출 대비 재료값',
  coverage_pct: '레시피 반영 매출 비율',
  uncovered_menus: '레시피 없는 메뉴',
  uncovered_count: '레시피 없는 메뉴 수',
  worst_margin_menus: '재료값 비중 높은 메뉴',
  loss_amount: '실사에서 줄어든 금액',
  loss_pct: '재료값 대비 감소 비율',
  loss_items: '많이 줄어든 재료',
  revenue: '매출',
  cost: '금액',
  // 경영 리포트 — 영업 리듬
  rhythm: '영업 리듬',
  hourly: '시간대별 매출',
  hourly_cost: '시간대별 인건비',
  weekday: '요일별 매출',
  peak_hours: '가장 바쁜 시간',
  negative_hours: '인건비가 매출보다 큰 시간',
  best_weekday: '가장 좋은 요일',
  worst_weekday: '가장 낮은 요일',
  avg_total: '하루 평균 매출',
  days: '일수',
  hour: '시간대',
  gap: '모자란 금액',
  // 경영 리포트 — 다음 기간 전망
  outlook: '다음 기간 전망',
  expected_revenue: '예상 매출',
  expected_cups: '예상 판매 잔 수',
  expected_daily_avg: '하루 평균 예상 매출',
  recent_daily_avg: '최근 하루 평균 매출',
  busiest: '가장 바쁠 날',
  order_recommendations: '발주 제안',
  // 경영 리포트 — 손익 상세
  basis: '재료값 계산 기준',
  material_cost: '재료비',
  material_overlap_excluded: '지출과 겹쳐 뺀 재료 매입',
  cash_total_cost: '실제 나간 돈 합계',
  cash_balance: '현금 기준 남은 돈',
  avg_ticket: '잔당 평균 금액',
  evidence: '근거',
  action: '할 일',
  title: '제목',
  screen: '이동 화면',
  // 갱신 서류
  expiry_date: '만료일',
  remind_before_days: '알림 시작(일 전)',
  days_left: '남은 일수',
};

// 화면에 절대 보여주지 않는 내부 관리용 키 — 조언 캐시 무효화용 해시·타임스탬프 등.
// 여기 안 걸러지면 챗봇 카드·서류 화면에 ai_advice_hash 같은 영문 키가 그대로 노출된다.
export const HIDDEN_FIELDS = new Set([
  'ai_advice_hash', 'ai_advice_at', 'ai_advice_version',
  // 경영 리포트의 내부 판정 플래그 — 문장(note·하이라이트)으로 이미 풀어서 안내한다
  'reliable', 'fixed_cost_missing', 'stale', 'model',
]);

// kind별 표시 순서 — 사장님이 먼저 봐야 하는 것(핵심 요약·조언)을 위로.
// 목록에 없는 키는 원래 순서대로 뒤에 붙는다.
export const KIND_FIELD_ORDER: Record<string, string[]> = {
  management_report: [
    'period_type', 'period', 'highlights', 'ai_advice', 'ai_actions', 'outlook',
    'sales', 'profit', 'cogs', 'rhythm',
    'purchases', 'expenses', 'labor', 'inventory', 'orders', 'compliance_alerts',
  ],
};

/** content를 화면 표시용 [키, 값] 목록으로 — 내부 키 제거 + kind별 순서 적용 */
export function visibleEntries(
  content: Record<string, unknown>,
  kind?: string,
): [string, unknown][] {
  const entries = Object.entries(content).filter(([k]) => !HIDDEN_FIELDS.has(k));
  const order = kind ? KIND_FIELD_ORDER[kind] : undefined;
  if (!order) return entries;
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  // sort는 안정 정렬이라 순서 목록에 없는 키끼리는 원래 순서를 유지한다
  return entries.sort(([a], [b]) => rank(a) - rank(b));
}

// 영문 상태값 → 한글 (weekly → 주간 등)
export const VALUE_LABELS: Record<string, Record<string, string>> = {
  period_type: { daily: '일간', weekly: '주간', monthly: '월간' },
  basis: { recipe: '팔린 메뉴의 레시피', purchase: '확정한 명세서' },
  // ai_actions의 이동 화면 — 서류 화면·인쇄에서 영문 라우트명 대신 화면 이름으로
  screen: {
    Menu: '메뉴 관리', Cost: '원가 분석', Inventory: '재고',
    Staff: '직원 · 스케줄', Document: '서류 자동화', Marketing: '홍보 스튜디오',
    SalesInput: '매출 입력',
  },
  status: {
    draft: '초안', confirmed: '확정', rejected: '반려',
    ok: '정상', due_soon: '갱신 임박', expired: '만료',
    DRAFT: '초안', PENDING: '승인 대기', CONFIRMED: '확정', REJECTED: '반려',
  },
};

// 금액 키는 '원'을 붙여 읽기 쉽게
export const MONEY_KEYS = new Set([
  'total_estimated', 'unit_price', 'estimated_amount', 'subtotal', 'tax', 'total',
  'total_price', 'purchase_total', 'sales_total', 'balance', 'hourly_wage', 'base_pay',
  'weekly_holiday_pay', 'gross', 'withholding', 'net_pay', 'estimated_sales_vat',
  'purchase_subtotal', 'purchase_tax', 'estimated_payable_vat', 'total_gross', 'total_net',
  'prev_total', 'estimated_cost', 'total_cost', 'estimated_profit', 'total_value',
  'open_amount', 'amount', 'theoretical', 'loss_amount', 'revenue', 'cost',
  'avg_total', 'gap', 'expected_revenue', 'expected_daily_avg', 'recent_daily_avg',
  'material_cost', 'material_overlap_excluded', 'cash_total_cost', 'cash_balance',
  'avg_ticket',
]);

// 퍼센트 키는 '%'를 붙인다
export const PERCENT_KEYS = new Set([
  'change_pct', 'margin_pct', 'withholding_rate', 'saving_pct',
  'cost_ratio', 'coverage_pct', 'loss_pct',
]);

// 숫자 키에 단위를 붙여 읽기 쉽게 (판매 잔 수 128 → 128잔)
export const UNIT_KEYS: Record<string, string> = {
  cups: '잔',
  days_left: '일',
  remind_before_days: '일',
  scheduled_hours: '시간',
  work_hours: '시간',
  weekly_avg_hours: '시간',
  work_days_per_week: '일',
  work_hours_per_day: '시간',
  weekly_hours: '시간',
  employee_count: '명',
  shift_count: '건',
  document_count: '건',
  purchase_document_count: '건',
  ingredient_count: '종',
  open_count: '건',
  expected_cups: '잔',
  days: '일',
  hour: '시',
};

// 백엔드 weekday()는 0=월 — JS Date의 0=일과 다르니 섞어 쓰지 말 것
const PY_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

export const labelFor = (key: string): string => FIELD_LABELS[key] ?? key;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// "2026-08-03" → "8월 3일(월)" (올해가 아니면 연도 포함) — 사장님용 한글 날짜 표기
const koreanDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const year = y === new Date().getFullYear() ? '' : `${y}년 `;
  return `${year}${m}월 ${d}일(${WEEKDAYS[dt.getDay()]})`;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/;

/** 값을 사장님이 읽기 좋은 문자열로 — 금액 콤마+원, 퍼센트, 단위, 날짜·영문 상태값 한글화 */
export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  // 영업 리듬의 요일 번호(0=월)는 숫자 그대로 보여주면 못 읽는다
  if (key === 'weekday' && typeof v === 'number' && v >= 0 && v <= 6) {
    return `${PY_WEEKDAYS[v]}요일`;
  }
  if (typeof v === 'number') {
    const n = v.toLocaleString('ko-KR');
    if (MONEY_KEYS.has(key)) return `${n}원`;
    if (PERCENT_KEYS.has(key)) return `${n}%`;
    if (UNIT_KEYS[key]) return `${n}${UNIT_KEYS[key]}`;
    return n;
  }
  if (typeof v === 'string') {
    const mapped = VALUE_LABELS[key]?.[v];
    if (mapped) return mapped;
    if (DATE_RE.test(v)) return koreanDate(v);
    const month = v.match(MONTH_RE);
    if (month) return `${Number(month[1])}년 ${Number(month[2])}월`;
    const range = v.match(RANGE_RE);
    if (range) return `${koreanDate(range[1])} ~ ${koreanDate(range[2])}`;
    return v;
  }
  // 배열·객체는 원래 DocumentCard가 섹션으로 펼쳐 렌더링한다. 여기까지 오면(인쇄 HTML 등
  // 재귀하지 않는 경로) "[object Object]" 대신 최소한 읽을 수 있는 요약으로 대체한다.
  if (Array.isArray(v)) return v.length ? `${v.length}건` : '—';
  if (typeof v === 'object') return '—';
  return String(v);
}
