// 원가율 기준선 — "몇 %면 위험한가"를 화면 곳곳에서 같은 기준으로 말하기 위한 단일 출처.
//
// 왜 필요한가: 원가율 숫자만 보여주면 원가율 개념이 없는 사장님·예비 창업자는 22%가
// 좋은 건지 나쁜 건지 판단할 수 없다. 업종별 통상 기준을 명시하고 색으로 즉시 알려준다.
//
// 기준 근거: 음료(이른바 '물장사')는 재료비가 낮은 대신 임대료·인건비·카드수수료가
// 매출에서 큰 비중을 차지하므로, 재료 원가율이 20%대 초반을 넘기면 남는 게 없다는 게
// 카페 업계의 통상적인 기준이다. 디저트·베이커리는 재료비 비중이 원래 높아 기준이 다르다.
// 매장 상황(임대료·객단가)에 따라 달라질 수 있는 '가이드'이지 절대 규칙이 아니다.

export type CostCategory = 'drink' | 'dessert' | 'food';
export type CostGrade = 'good' | 'warn' | 'bad';

export type CostStandard = {
  key: CostCategory;
  label: string;
  good: number; // 이 값 이하면 양호
  warn: number; // 이 값 이하면 주의, 넘으면 위험
  note: string;
};

export const COST_STANDARDS: Record<CostCategory, CostStandard> = {
  drink: {
    key: 'drink',
    label: '음료',
    good: 22,
    warn: 30,
    note: '커피·음료는 재료 원가율 22% 이하가 통상 기준이에요. 30%를 넘으면 임대료·인건비를 빼면 남는 게 거의 없습니다.',
  },
  dessert: {
    key: 'dessert',
    label: '디저트·베이커리',
    good: 35,
    warn: 45,
    note: '디저트는 재료비 비중이 원래 높아 35% 이하면 양호해요. 45%를 넘으면 판매가를 다시 보셔야 합니다.',
  },
  food: {
    key: 'food',
    label: '푸드·식사',
    good: 40,
    warn: 50,
    note: '식사류는 40% 이하가 통상 기준이에요. 50%를 넘으면 구성을 조정해야 합니다.',
  },
};

const DESSERT_WORDS = [
  '케이크', '쿠키', '마카롱', '스콘', '빵', '베이글', '크로플', '와플', '타르트',
  '브라우니', '마들렌', '휘낭시에', '도넛', '푸딩', '티라미수', '롤케익', '롤케이크',
  '크루아상', '크로와상', '파이', '젤라또', '아이스크림', '디저트',
];
const FOOD_WORDS = [
  '샌드위치', '파니니', '토스트', '샐러드', '리조또', '파스타', '브런치',
  '핫도그', '피자', '스프', '수프', '버거',
];

/** 메뉴명으로 원가율 기준 카테고리를 추정한다 (기본은 음료). */
export function categoryOfMenu(name: string): CostCategory {
  const n = (name ?? '').toLowerCase();
  if (DESSERT_WORDS.some((w) => n.includes(w))) return 'dessert';
  if (FOOD_WORDS.some((w) => n.includes(w))) return 'food';
  return 'drink';
}

/** 원가율(%)이 기준 대비 어느 등급인지. */
export function gradeOf(ratio: number, category: CostCategory): CostGrade {
  const s = COST_STANDARDS[category];
  if (ratio <= s.good) return 'good';
  if (ratio <= s.warn) return 'warn';
  return 'bad';
}

export const GRADE_COLOR: Record<CostGrade, string> = {
  good: '#4E7D3A', // 양호 — 초록
  warn: '#C98A2B', // 주의 — 앰버
  bad: '#B23B2E', // 위험 — 빨강
};

export const GRADE_LABEL: Record<CostGrade, string> = {
  good: '양호',
  warn: '주의',
  bad: '위험',
};

export const GRADE_TONE: Record<CostGrade, 'green' | 'orange' | 'danger'> = {
  good: 'green',
  warn: 'orange',
  bad: 'danger',
};

/** 한 메뉴에 대해 "왜 이 색인지"를 한 문장으로. */
export function gradeMessage(ratio: number, category: CostCategory): string {
  const s = COST_STANDARDS[category];
  const grade = gradeOf(ratio, category);
  if (grade === 'good') return `${s.label} 기준(${s.good}% 이하)을 지키고 있어요.`;
  if (grade === 'warn')
    return `${s.label} 권장선 ${s.good}%를 ${(ratio - s.good).toFixed(1)}%p 넘었어요. 재료 단가나 판매가를 점검해 보세요.`;
  return `${s.label} 기준으로 위험 구간이에요 (${s.warn}% 초과). 이 메뉴는 팔수록 부담이 됩니다.`;
}

/** 목표 원가율을 맞추려면 판매가가 얼마여야 하는지 — 가격 인상 폭을 바로 알려준다. */
export function suggestedPrice(cost: number, category: CostCategory): number {
  const target = COST_STANDARDS[category].good / 100;
  if (target <= 0) return 0;
  // 100원 단위로 올려 실제 붙일 수 있는 가격으로 만든다
  return Math.ceil(cost / target / 100) * 100;
}
