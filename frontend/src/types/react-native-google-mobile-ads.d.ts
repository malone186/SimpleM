// [한글 주석: react-native-google-mobile-ads 라이브러리의 TypeScript 모듈 타입 정의]
declare module 'react-native-google-mobile-ads' {
  export type InterstitialAd = any;
  export type RewardedAd = any;
  export const BannerAd: any;
  export const BannerAdSize: any;
  export const AdEventType: any;
  export const RewardedAdEventType: any;
  export const InterstitialAd: any;
  export const RewardedAd: any;
  export const TestIds: any;
  export const AdsConsent: any;
  const mobileAds: () => {
    initialize: () => Promise<any>;
  };
  export default mobileAds;
}
