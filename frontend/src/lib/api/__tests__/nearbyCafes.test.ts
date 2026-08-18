import { normalizeCafeAnalysisResult, type CafeAnalysisResult } from '../nearbyCafes';

function resultWithAnalysis(): CafeAnalysisResult {
  return {
    name: '테스트 카페',
    address: '서울시 테스트구',
    category: '카페',
    distance_m: 120,
    review_count: 3,
    reviews: [],
    analysis: {
      summary: '  동네 카페입니다.  ',
      strengths: ['접근성 우수', '접근성 우수', '정보 부족'],
      weaknesses: ['정보 부족', ' 정보 부족 '],
      signature_menus: ['-', '아메리카노'],
      price_level: '정보 부족',
      main_customers: '정보 없음',
      atmosphere: '  조용한 분위기  ',
      sentiment: '알 수 없음',
      counter_strategy: '  메뉴 정보를 보강한다.  ',
    },
  };
}

test('정보 부족 태그와 중복 분석 항목을 화면에 넘기지 않는다', () => {
  const normalized = normalizeCafeAnalysisResult(resultWithAnalysis());

  expect(normalized.analysis).toEqual({
    summary: '동네 카페입니다.',
    strengths: ['접근성 우수'],
    weaknesses: [],
    signature_menus: ['아메리카노'],
    price_level: '미확인',
    main_customers: '',
    atmosphere: '조용한 분위기',
    sentiment: '미확인',
    counter_strategy: '메뉴 정보를 보강한다.',
  });
});

test('분석 결과가 없으면 응답을 그대로 유지한다', () => {
  const result = { ...resultWithAnalysis(), analysis: null };
  expect(normalizeCafeAnalysisResult(result)).toBe(result);
});
