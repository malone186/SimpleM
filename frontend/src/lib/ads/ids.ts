// 광고 단위(ad unit) ID 해석기 — 네이티브 모듈을 import 하지 않으므로 웹에서도 안전하다.
//
// 실제 ID는 AdMob 콘솔 > 앱 > 광고 단위에서 발급받아 eas.json의 env로 주입한다.
// 값이 없으면 Google 공식 테스트 ID로 떨어지므로, 개발 중 실수로 실광고를
// 클릭해 계정이 정지되는 일이 없다.
import { Platform } from 'react-native';

// Google이 공개한 테스트 광고 단위 ID (https://developers.google.com/admob/android/test-ads)
const TEST_IDS = {
  banner: {
    android: 'ca-app-pub-3940256099942544/9214589741',
    ios: 'ca-app-pub-3940256099942544/2435281174',
  },
  interstitial: {
    android: 'ca-app-pub-3940256099942544/1033173712',
    ios: 'ca-app-pub-3940256099942544/4411468910',
  },
  rewarded: {
    android: 'ca-app-pub-3940256099942544/5224354917',
    ios: 'ca-app-pub-3940256099942544/1712485313',
  },
} as const;

type AdFormat = keyof typeof TEST_IDS;

const REAL_IDS: Record<AdFormat, { android?: string; ios?: string }> = {
  banner: {
    android: process.env.EXPO_PUBLIC_ADMOB_BANNER_ANDROID,
    ios: process.env.EXPO_PUBLIC_ADMOB_BANNER_IOS,
  },
  interstitial: {
    android: process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ANDROID,
    ios: process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS,
  },
  rewarded: {
    android: process.env.EXPO_PUBLIC_ADMOB_REWARDED_ANDROID,
    ios: process.env.EXPO_PUBLIC_ADMOB_REWARDED_IOS,
  },
};

/** 개발 빌드에서는 항상 테스트 광고, 릴리즈에서만 실제 광고 단위를 쓴다. */
export function adUnitId(format: AdFormat): string {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const test = TEST_IDS[format][platform];
  if (__DEV__) return test;
  return REAL_IDS[format][platform] || test;
}
