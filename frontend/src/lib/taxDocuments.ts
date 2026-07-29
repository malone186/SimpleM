// 신고 종류별 '무슨 서류가 필요한지' 체크리스트.
//
// 왜 필요한가(사장님 피드백): 신고 일정만 알려주는 앱은 많다. 정작 막히는 건 "그래서
// 뭘 챙겨야 하지?"다. 신고 유형별로 카테고리를 나누고, 각 항목이 어디서 발급되는지까지
// 적어 두면 꼼꼼한 분은 이대로 모아 바로 신고할 수 있다.
//
// 세법은 바뀐다 — 여기 내용은 안내이지 세무 자문이 아니다. 화면에도 그렇게 표시한다.

export type TaxDocItem = {
  id: string;
  name: string;
  where: string; // 어디서 구하는지
  note?: string; // 놓치기 쉬운 부분
  critical?: boolean; // 빠뜨리면 세금이 크게 늘어나는 항목
};

export type TaxDocGroup = {
  id: string;
  title: string;
  sub: string;
  when: string;
  icon: string; // Ionicons 이름
  sections: { label: string; items: TaxDocItem[] }[];
};

export const TAX_DOC_GROUPS: TaxDocGroup[] = [
  {
    id: 'vat',
    title: '부가가치세 신고',
    sub: '매출세액에서 매입세액을 빼고 냅니다. 매입 증빙을 못 모으면 그만큼 더 냅니다.',
    when: '1월 25일 · 7월 25일 (간이과세자는 1월 25일 연 1회)',
    icon: 'calculator-outline',
    sections: [
      {
        label: '매출 자료 (얼마 벌었나)',
        items: [
          { id: 'vat-card', name: '카드 매출전표 발행금액 집계', where: '여신금융협회 또는 각 카드사 가맹점 사이트' },
          { id: 'vat-cash', name: '현금영수증 발행 내역', where: '홈택스 > 조회/발급 > 현금영수증' },
          { id: 'vat-taxinvoice', name: '발행한 세금계산서', where: '홈택스 전자세금계산서 조회' },
          { id: 'vat-delivery', name: '배달앱 정산 내역', where: '배민·쿠팡이츠 사장님 사이트 정산 메뉴', note: '앱 수수료는 매입 증빙으로 따로 챙기세요.' },
          { id: 'vat-cashsale', name: '현금 매출 장부', where: '직접 기록', note: '카드로 안 잡히는 현금 매출도 신고 대상이에요.' },
        ],
      },
      {
        label: '매입 자료 (얼마 썼나 — 이게 곧 세금 절약)',
        items: [
          { id: 'vat-in-invoice', name: '매입 세금계산서', where: '홈택스 전자세금계산서 조회', critical: true },
          { id: 'vat-in-card', name: '사업용 신용카드 매입 내역', where: '홈택스 > 사업용신용카드 등록·조회', critical: true, note: '카드를 홈택스에 등록해 두지 않으면 매입세액 공제가 자동으로 안 잡혀요.' },
          { id: 'vat-in-cashreceipt', name: '지출증빙용 현금영수증', where: '홈택스 현금영수증 조회', note: '결제할 때 소득공제용이 아니라 지출증빙용으로 받아야 합니다.' },
          { id: 'vat-rent', name: '임대료 세금계산서', where: '건물주 발행', note: '못 받으면 임대료 부가세를 공제받지 못해요.' },
          { id: 'vat-utility', name: '전기·가스·통신요금 (사업자 명의)', where: '한전·도시가스·통신사 청구서', note: '사업자 명의로 바꿔야 공제됩니다.' },
        ],
      },
      {
        label: '놓치기 쉬운 공제',
        items: [
          { id: 'vat-deemed', name: '의제매입세액공제 — 면세 농축수산물 매입', where: '계산서·신용카드 매출전표', critical: true, note: '우유·생수·과일·채소는 면세라 부가세가 없지만, 음식점업은 매입액의 일정 비율을 공제받을 수 있어요. 계산서를 꼭 받으세요.' },
          { id: 'vat-creditcard-deduct', name: '신용카드 매출전표 발행세액공제', where: '자동 반영 (연매출 10억 이하)', note: '카드·현금영수증 매출의 1.3%를 세액에서 빼 줍니다.' },
        ],
      },
    ],
  },
  {
    id: 'income',
    title: '종합소득세 신고',
    sub: '1년치 순이익에 매기는 세금. 비용 증빙이 곧 세금입니다.',
    when: '5월 31일 (성실신고 대상은 6월 30일)',
    icon: 'documents-outline',
    sections: [
      {
        label: '장부 · 기본 서류',
        items: [
          { id: 'inc-ledger', name: '장부 (간편장부 또는 복식부기)', where: '앱의 월별 장부 초안 또는 세무사', critical: true, note: '장부 없이 추계신고하면 무기장가산세 20%가 붙어요.' },
          { id: 'inc-biz', name: '사업자등록증', where: '홈택스 발급' },
          { id: 'inc-lease', name: '임대차계약서', where: '보관분' },
        ],
      },
      {
        label: '비용 증빙',
        items: [
          { id: 'inc-payroll', name: '인건비 지급명세서 · 임금대장', where: '홈택스 제출분 + 매장 보관', critical: true, note: '신고하지 않은 인건비는 비용으로 인정되지 않아요.' },
          { id: 'inc-insurance', name: '4대보험 납부확인서', where: '4대사회보험 정보연계센터' },
          { id: 'inc-card', name: '사업용 카드 사용내역 (연간)', where: '홈택스' },
          { id: 'inc-depreciation', name: '설비·인테리어 등 자산 목록', where: '구입 계약서·세금계산서', note: '에스프레소 머신·인테리어는 여러 해에 나눠 비용 처리(감가상각)합니다.' },
          { id: 'inc-interest', name: '사업자 대출 이자 납입증명', where: '거래 은행' },
        ],
      },
      {
        label: '소득공제 · 세액공제',
        items: [
          { id: 'inc-noran', name: '노란우산공제 납입증명서', where: '중소기업중앙회', critical: true, note: '사업소득에서 최대 500만 원까지 빼 줍니다. 가입만 해도 절세 효과가 큽니다.' },
          { id: 'inc-pension', name: '개인연금저축 납입증명', where: '가입 금융기관' },
          { id: 'inc-donation', name: '기부금 영수증', where: '기부처' },
        ],
      },
    ],
  },
  {
    id: 'withholding',
    title: '원천징수 · 4대보험',
    sub: '직원에게 준 돈에서 뗀 세금을 대신 내는 신고. 안 하면 인건비가 비용으로 안 잡힙니다.',
    when: '매월 10일 (반기납부 신청 시 1월·7월 10일)',
    icon: 'people-outline',
    sections: [
      {
        label: '매월 · 반기',
        items: [
          { id: 'wh-report', name: '원천징수이행상황신고서', where: '홈택스 > 신고/납부 > 원천세', critical: true },
          { id: 'wh-simple', name: '간이지급명세서 (근로소득)', where: '홈택스', note: '매월 제출로 바뀌었어요. 안 내면 가산세가 붙습니다.' },
          { id: 'wh-daily', name: '일용근로소득 지급명세서', where: '홈택스', note: '단기 알바를 썼다면 매월 제출 대상이에요.' },
          { id: 'wh-freelance', name: '사업소득 3.3% 원천징수분', where: '홈택스', note: '프리랜서·미가입 알바에게 지급한 경우.' },
        ],
      },
      {
        label: '매장에 보관 (근로감독 대비)',
        items: [
          { id: 'wh-contract', name: '근로계약서 (전 직원)', where: '앱의 근로계약서 초안 활용', critical: true, note: '미작성·미교부는 직원 1인당 과태료 대상이에요.' },
          { id: 'wh-ledger', name: '임금대장 · 임금명세서', where: '앱의 임금명세서 초안', critical: true, note: '3년 보관 의무. 임금명세서 교부도 의무입니다.' },
          { id: 'wh-attendance', name: '근무시간 기록 (출퇴근)', where: '앱의 스케줄·출퇴근 기록', note: '주휴수당·연장수당 다툼이 생기면 이게 증거가 됩니다.' },
          { id: 'wh-insurance', name: '4대보험 취득·상실 신고 확인서', where: '4대사회보험 정보연계센터' },
        ],
      },
    ],
  },
  {
    id: 'always',
    title: '상시 비치 · 정기 갱신',
    sub: '신고와 무관하게 매장에 있어야 하는 서류. 점검 나오면 여기부터 봅니다.',
    when: '수시 (만료일 관리 필요)',
    icon: 'shield-checkmark-outline',
    sections: [
      {
        label: '영업 관련',
        items: [
          { id: 'al-biz', name: '사업자등록증', where: '홈택스', note: '잘 보이는 곳에 게시해야 합니다.' },
          { id: 'al-food', name: '영업신고증 (휴게음식점 등)', where: '관할 구청 위생과' },
          { id: 'al-price', name: '가격표 게시', where: '매장 게시', note: '옥외가격표시 대상이면 외부에도 붙여야 해요.' },
        ],
      },
      {
        label: '매년 갱신',
        items: [
          { id: 'al-hygiene', name: '위생교육 수료증', where: '한국휴게음식업중앙회 등 온라인 교육', critical: true, note: '연 1회 3시간. 안 받으면 과태료입니다.' },
          { id: 'al-health', name: '보건증 (건강진단결과서) — 전 직원', where: '보건소 또는 지정 병원', critical: true, note: '유효기간 1년. 직원 것도 매장이 보관해야 해요.' },
        ],
      },
    ],
  },
];

/** 체크 상태 저장 키 (AsyncStorage) — 신고 주기가 지나면 새 키가 되어 자동 초기화된다. */
export const taxCheckKey = (groupId: string, periodTag: string) =>
  `simplem:taxdocs:${groupId}:${periodTag}`;
