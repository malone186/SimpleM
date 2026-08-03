// 개발용 모의 보상형 광고.
//
// AdMob은 네이티브 모듈이라 Expo Go와 웹에서는 광고가 절대 뜨지 않는다. 그렇다고 매번
// 개발 빌드를 구워야만 "할당량 소진 → 광고 제안 → 시청 → 충전 → 재전송" 흐름을 확인할 수
// 있으면 개발이 너무 느려진다. 그래서 SDK를 쓸 수 없는 환경에서만 이 대역이 들어간다.
//
// __DEV__에서만 켜진다. 릴리즈 빌드에서는 mockAvailable()이 항상 false라, 광고를 보지
// 않고 보상을 받는 경로가 열리는 일은 없다.

const MOCK_DURATION_MS = 3000;

/** 개발 중이고 실제 SDK를 쓸 수 없을 때만 true */
export function mockAvailable(): boolean {
  return __DEV__;
}

/** 광고를 보는 시늉만 하고 '끝까지 봤다'로 처리한다. */
export function showMockRewarded(): Promise<boolean> {
  if (__DEV__) {
    console.log('[ads] 모의 보상형 광고 재생 (실제 광고 아님 — 개발 빌드에서만 진짜 광고가 뜹니다)');
  }
  return new Promise((resolve) => setTimeout(() => resolve(true), MOCK_DURATION_MS));
}
