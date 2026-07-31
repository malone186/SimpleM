// 웹에는 AdMob이 없다 — 광고 없이 작업 결과만 그대로 흘려보낸다.
export function preloadInterstitial(): void {}

export function showAdWhile<T>(task: Promise<T>): Promise<T> {
  return task;
}
