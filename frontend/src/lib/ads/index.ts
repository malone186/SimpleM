// 광고 모듈 진입점. 각 하위 모듈에 .web 변형이 있어 웹에서는 자동으로 no-op으로 대체된다.
export { adUnitId } from './ids';
export { initAds } from './init';
export { preloadInterstitial, showAdWhile } from './interstitial';
export { isRewardedReady, preloadRewarded, showRewarded } from './rewarded';
