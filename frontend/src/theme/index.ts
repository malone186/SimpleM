// 디자인 스펙 기반 테마 (Design Specification §1, §3)
// 커피 전문점 아이덴티티 — Mocha & Espresso Brown + Cream White + Terracotta Orange

export const colors = {
  creamSand: '#FAF9F6', // [배경색] 노랑기를 걷어내고 밝고 투명함을 더한 소프트 베이지-그레이 오프화이트
  coffeeCream: '#F2ECE0', // [카드 배경] 약간의 투명감을 살리기 좋은 부드러운 밀크커피 톤
  mutedSand: 'rgba(140, 111, 86, 0.12)', // [초슬림 테두리] 투박한 단색 대신 자연스러운 반투명 브라운
  mochaBrown: '#8C6F56', // 그래프 라인, 서브 포인트 텍스트
  espressoBrown: '#4E3629', // 대표 타이틀, 본문, 메인 아이콘
  pointOrange: '#2E2521', // [핵심 포인트 컬러] 웜 그레이에서 블랙에 가까우면서 에스프레소 톤이 도는 극초콜릿 블랙으로 업그레이드
  trendGreenBg: 'rgba(78, 125, 58, 0.08)', // [상승 배지 배경] 자연스러운 녹색 투명화
  trendGreenText: '#4E7D3A', // 매출 상승 배지 텍스트 / 그래프 피크
  white: '#FFFFFF',
  stone300: '#D6D3D1', // 디바이스 프레임 테두리
  black40: 'rgba(0,0,0,0.4)', // 모달 딤드 배경
} as const;

// [iOS 스타일 은은한 섀도우 시스템]
// 카드가 배경 위에 부드럽게 떠 있는 듯한 입체감을 연출하여 투박한 보더라인을 보완합니다.
export const shadows = {
  soft: {
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 2,
  },
  medium: {
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 4,
  },
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

