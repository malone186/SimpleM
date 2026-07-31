// 웹에서는 Google Mobile Ads 네이티브 모듈이 존재하지 않으므로 아무것도 하지 않는다.
export function initAds(): Promise<boolean> {
  return Promise.resolve(false);
}
