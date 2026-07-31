import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';

import { adUnitId, initAds } from '../../lib/ads';

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
export default function AdBanner({
  size = BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER,
  style,
}: AdBannerProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    initAds().then((allowed) => {
      if (alive && !allowed) setFailed(true);
      if (alive && allowed) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!ready || failed) return null;

  return (
    <View style={[styles.slot, style]}>
      <BannerAd
        unitId={adUnitId('banner')}
        size={size}
        onAdFailedToLoad={(error) => {
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
