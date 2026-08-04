// [자동 생성] 눈 깜빡임 오버레이 — 눈 부위만 그린 투명 PNG. 포즈 이미지(원본/앞치마
// 변형) 위에 얹어 opacity를 잠깐 1로 올리면 눈을 감았다 뜬다. 손으로 고치지 말 것.
import type { ImageSourcePropType } from 'react-native';

// 눈을 뜬(또는 윙크) 포즈만 — 이미 눈 감은 포즈(coffee·resting·happy)는 블링크가 무의미해 제외.
export const BLINK_OVERLAY: Record<string, ImageSourcePropType | undefined> = {
  clipboard: require('../../../assets/mascot/blink/clipboard.png'),
  greet: require('../../../assets/mascot/blink/greet.png'),
  hero: require('../../../assets/mascot/blink/hero.png'),
  pouring: require('../../../assets/mascot/blink/pouring.png'),
  serving: require('../../../assets/mascot/blink/serving.png'),
  top: require('../../../assets/mascot/blink/top.png'),
  welcome: require('../../../assets/mascot/blink/welcome.png'),
};
