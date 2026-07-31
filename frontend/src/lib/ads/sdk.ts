// 광고 SDK 안전 로더 — 광고 관련 모듈은 **반드시** 여기를 거쳐서 SDK를 가져와야 한다.
//
// `react-native-google-mobile-ads`는 specs/modules/*.js에서 최상위에
// `TurboModuleRegistry.getEnforcing('RNGoogleMobileAdsModule')`을 호출한다. getEnforcing은
// 네이티브 모듈이 없으면 **import 시점에** 즉시 throw하므로, 광고 모듈이 안 들어간 구버전
// 빌드(2026-07-29 versionCode 5 이전)에 이 코드를 OTA로 내보내면 앱이 시작하자마자 죽는다.
// RootNavigator가 재고·챗봇 화면을 정적 import 하기 때문에 크래시는 특정 탭이 아니라
// 앱 실행 자체를 막는다. (2026-07-28 expo-notifications 때와 같은 사고 구조)
//
// 그래서 존재 여부를 먼저 확인하고, 없으면 `require` 자체를 하지 않는다.
// 지연 require + try/catch는 안전장치가 아니다 — 죽는 지점이 JS가 아니라 그 아래일 수 있다.
import { TurboModuleRegistry } from 'react-native';

type Sdk = typeof import('react-native-google-mobile-ads');

/** 이 빌드에 광고 네이티브 모듈이 들어있는지. false면 광고 기능 전체를 조용히 끈다. */
export const adsSupported: boolean = (() => {
  try {
    return TurboModuleRegistry.get('RNGoogleMobileAdsModule') != null;
  } catch {
    return false;
  }
})();

function load(): Sdk | null {
  if (!adsSupported) return null;
  try {
    return require('react-native-google-mobile-ads') as Sdk;
  } catch (error) {
    if (__DEV__) console.warn('[ads] SDK 로드 실패 — 광고를 끕니다:', error);
    return null;
  }
}

/** 광고 SDK. **null일 수 있다** — 쓰기 전에 반드시 확인할 것. */
export const sdk: Sdk | null = load();
