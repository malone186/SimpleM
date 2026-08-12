import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { adUnitId, initAds } from '../../lib/ads';
// SDK는 반드시 안전 로더를 거친다 — 직접 import하면 Expo Go에서 앱이 시작조차 못 한다.
import { sdk } from '../../lib/ads/sdk';

export type AdBannerProps = {
  /** BannerAdSize 값 또는 '300x250' 형태의 커스텀 크기 */
  size?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * 하단 고정 배너 광고.
 *
 * 로드 실패(네트워크 없음·노필·Expo Go)하면 아무것도 그리지 않으므로
 * 레이아웃에 빈 공간이 남지 않는다.
 */
export default function AdBanner({ size, style }: AdBannerProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!sdk) return; // Expo Go 등 — 배너 자리 없이 렌더
    let alive = true;
    initAds().then((allowed) => {
      if (alive && !allowed) setFailed(true);
      if (alive && allowed) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!sdk || !ready || failed) return null;
  const { BannerAd, BannerAdSize } = sdk;

  return (
    <View style={[styles.slot, style]}>
      <BannerAd
        unitId={adUnitId('banner')}
        size={size ?? BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER}
        onAdFailedToLoad={(error: any) => {
          if (__DEV__) console.warn('[ads] 배너 로드 실패:', error.message);
          setFailed(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
