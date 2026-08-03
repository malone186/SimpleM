// 웹에는 AdMob이 없다. 개발 중에는 모의 광고로 흐름만 확인하고,
// 릴리즈(웹 배포)에서는 광고를 권하지 않는다.
import { mockAvailable, showMockRewarded } from './mockRewarded';

export function preloadRewarded(): void {}

export function isRewardedReady(): boolean {
  return mockAvailable();
}

export function showRewarded(): Promise<boolean> {
  if (!mockAvailable()) return Promise.resolve(false);
  return showMockRewarded();
}
