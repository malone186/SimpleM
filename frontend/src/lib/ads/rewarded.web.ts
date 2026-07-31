// 웹에는 AdMob이 없다. 광고를 띄울 수 없으니 보상도 없다 —
// 호출부는 isRewardedReady()가 false인 것을 보고 광고를 권하지 않게 된다.
export function preloadRewarded(): void {}

export function isRewardedReady(): boolean {
  return false;
}

export function showRewarded(): Promise<boolean> {
  return Promise.resolve(false);
}
