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
  // 갱신 서류
  expiry_date: '만료일',
  remind_before_days: '알림 시작(일 전)',
  days_left: '남은 일수',
};

// 영문 상태값 → 한글 (weekly → 주간 등)
export const VALUE_LABELS: Record<string, Record<string, string>> = {
  period_type: { daily: '일간', weekly: '주간', monthly: '월간' },
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
  'open_amount', 'amount',
]);

// 퍼센트 키는 '%'를 붙인다
export const PERCENT_KEYS = new Set(['change_pct', 'margin_pct', 'withholding_rate', 'saving_pct']);

export const labelFor = (key: string): string => FIELD_LABELS[key] ?? key;

/** 값을 사장님이 읽기 좋은 문자열로 — 금액 콤마+원, 퍼센트, 영문 상태값 한글화 */
export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  if (typeof v === 'number') {
    const n = v.toLocaleString('ko-KR');
    if (MONEY_KEYS.has(key)) return `${n}원`;
    if (PERCENT_KEYS.has(key)) return `${n}%`;
    return n;
  }
  if (typeof v === 'string') return VALUE_LABELS[key]?.[v] ?? v;
  // 배열·객체는 원래 DocumentCard가 섹션으로 펼쳐 렌더링한다. 여기까지 오면(인쇄 HTML 등
  // 재귀하지 않는 경로) "[object Object]" 대신 최소한 읽을 수 있는 요약으로 대체한다.
  if (Array.isArray(v)) return v.length ? `${v.length}건` : '—';
  if (typeof v === 'object') return '—';
  return String(v);
}
