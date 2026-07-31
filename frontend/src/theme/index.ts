// 디자인 스펙 기반 테마 — Manus/Apple 스타일 클린 미니멀 (2026-08 리스타일)
// 흰 배경 + 뉴트럴 그레이 위계 + 블랙 잉크/CTA. 색은 절제하고 여백·타이포로 위계를 만든다.
// [주의] 토큰 이름은 기존(커피 테마 시절) 그대로다 — 50여 개 화면이 참조하므로
// 이름을 바꾸지 않고 값만 바꿔 전체 앱을 한 번에 전환한다.

export const colors = {
  creamSand: '#F7F7F8', // [배경색] 애플 systemGroupedBackground 계열의 뉴트럴 오프화이트
  coffeeCream: '#F0F0F2', // [카드/필 배경] 은은한 뉴트럴 그레이 필
  mutedSand: 'rgba(60, 60, 67, 0.10)', // [초슬림 테두리] 애플 separator 계열 헤어라인
  mochaBrown: '#6E6E73', // 보조 텍스트 (secondary label)
  espressoBrown: '#141416', // 대표 타이틀·본문·다크 서피스 (near-black ink)
  pointOrange: '#111113', // [핵심 CTA] manus식 블랙 버튼 — 색 대신 명도로 시선을 끈다
  trendGreenBg: 'rgba(52, 199, 89, 0.10)', // [상승 배지 배경]
  trendGreenText: '#1F7A3D', // 매출 상승 배지 텍스트 / 그래프 피크
  white: '#FFFFFF',
  stone300: '#E5E5EA', // 디바이스 프레임 테두리
  black40: 'rgba(0,0,0,0.4)', // 모달 딤드 배경
} as const;

// [애플식 섀도우] 색조 없는 순수 블랙 섀도우를 아주 옅게 — 떠 있되 티 나지 않게.
export const shadows = {
  soft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
  },
} as const;

// 타이포그래피 계층 — 900 블랙 대신 700~800 + 타이트한 자간으로 산뜻한 애플 무드
export const typography = {
  L1: { fontSize: 20, fontWeight: '800' as const, letterSpacing: -0.4 }, // 대표 강조 헤더
  L2: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.6 }, // 실시간 숫자 금액
  L3: { fontSize: 16, fontWeight: '700' as const, letterSpacing: -0.3 }, // 카드 내부 값
  L4: { fontSize: 12, fontWeight: '600' as const, letterSpacing: -0.1 }, // 주요 알림 타이틀
  L5: { fontSize: 10, fontWeight: '500' as const }, // 캡션 & 서브 정보
} as const;

// 간격 시스템 (§2)
export const spacing = {
  globalPadding: 20, // px-5
  verticalGap: 20, // space-y-5
  gridGap: 10, // gap-2.5
} as const;
