import type { StyleProp, ViewStyle } from 'react-native';

export type AdBannerProps = {
  size?: string;
  style?: StyleProp<ViewStyle>;
};

/** 웹에서는 AdMob 배너를 띄울 수 없으므로 자리만 비워둔다. */
export default function AdBanner(_props: AdBannerProps) {
  return null;
}
