// 디자인 스펙 기반 테마 (Design Specification §1, §3)
// 커피 전문점 아이덴티티 — Mocha & Espresso Brown + Cream White + Terracotta Orange

export const colors = {
  creamSand: '#FDFCF7', // 배경 (모바일 프레임 내부)
  coffeeCream: '#F5F0E6', // 카드 배경 / 서브 컴포넌트
  mutedSand: '#EADFC9', // 경계선, 구분선
  mochaBrown: '#8C6F56', // 그래프 라인, 서브 포인트 텍스트
  espressoBrown: '#4E3629', // 대표 타이틀, 본문, 메인 아이콘
  pointOrange: '#C25E35', // 발주 버튼, 모달 확정 (핵심 액션)
  trendGreenBg: '#EBF4E0', // 매출 상승 배지 배경
  trendGreenText: '#4E7D3A', // 매출 상승 배지 텍스트 / 그래프 피크
  white: '#FFFFFF',
  stone300: '#D6D3D1', // 디바이스 프레임 테두리
  black40: 'rgba(0,0,0,0.4)', // 모달 딤드 배경
} as const;

// 타이포그래피 계층 (§3)
export const typography = {
  L1: { fontSize: 20, fontWeight: '900' as const }, // 대표 강조 헤더
  L2: { fontSize: 30, fontWeight: '900' as const }, // 실시간 숫자 금액
  L3: { fontSize: 16, fontWeight: '700' as const }, // 카드 내부 값
  L4: { fontSize: 12, fontWeight: '700' as const }, // 주요 알림 타이틀
  L5: { fontSize: 10, fontWeight: '500' as const }, // 캡션 & 서브 정보
} as const;

// 간격 시스템 (§2)
export const spacing = {
  globalPadding: 20, // px-5
  verticalGap: 20, // space-y-5
  gridGap: 10, // gap-2.5
} as const;
