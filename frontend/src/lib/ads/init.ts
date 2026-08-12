// AdMob(Google Mobile Ads) SDK 초기화.
//
// Expo Go에서는 네이티브 모듈이 없어 동작하지 않는다 — 개발 빌드(eas build --profile development)나
// preview/production 빌드에서만 실제 광고가 뜬다.
// SDK는 반드시 안전 로더(sdk.ts)를 거친다 — 직접 import하면 Expo Go에서 앱이 시작조차 못 한다.
import { sdk } from './sdk';

let initialized: Promise<boolean> | null = null;

/**
 * 동의(UMP) 수집 후 SDK를 초기화한다. 여러 번 불러도 실제 초기화는 한 번만 수행된다.
 * @returns 광고 요청이 허용된 상태인지 여부
 */
export function initAds(): Promise<boolean> {
  if (!initialized) initialized = run();
  return initialized;
}

async function run(): Promise<boolean> {
  // 네이티브 모듈이 없는 환경(Expo Go 등) — 광고 기능 전체를 조용히 끈다.
  if (!sdk) return false;

  // EEA/영국 사용자에게는 Google 정책상 동의 양식을 먼저 띄워야 한다.
  // 그 외 지역에서는 즉시 canRequestAds: true로 통과한다.
  let canRequestAds = true;
  try {
    const consent = await sdk.AdsConsent.gatherConsent();
    canRequestAds = consent.canRequestAds;
  } catch (error) {
    // 동의 수집 실패가 앱 실행을 막아서는 안 된다 — 광고만 포기한다.
    if (__DEV__) console.warn('[ads] 동의 수집 실패:', error);
  }

  try {
    await sdk.default().initialize();
  } catch (error) {
    if (__DEV__) console.warn('[ads] SDK 초기화 실패:', error);
    return false;
  }

  return canRequestAds;
}
