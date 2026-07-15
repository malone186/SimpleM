// 브루(BREW) 마스코트 — 표정 = 가게 상태. "브루 등장 지도" 기반.
// 원칙: 감정의 순간엔 브루, 판단(정확한 숫자)의 순간엔 브루를 비운다. 한 화면에 하나.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

// 캐릭터 시트에서 잘라낸 포즈들 (표정 매칭 표)
const POSES = {
  welcome: require('../../../assets/mascot/brew_wave.png'), // 하트·발 흔드는 브루 — 환영·칭찬 (투명 배경)
  happy: require('../../../assets/mascot/brew_happy.png'), // 활짝 웃는 브루 — 스트릭·좋은 소식
  resting: require('../../../assets/mascot/brew_resting.png'), // 턱 괸 브루 — 빈 화면·대기
  pouring: require('../../../assets/mascot/brew_pouring.png'), // 드립 내리는 브루 — 로딩·처리 중
  clipboard: require('../../../assets/mascot/brew_clipboard.png'), // 클립보드 든 브루 — 리포트·발주
  serving: require('../../../assets/mascot/brew_serving.png'), // 케이크 든 브루 — 서비스·추천
  hero: require('../../../assets/mascot/brew_hero.png'), // 스탠딩 바리스타 — 브랜드/온보딩
} as const;

export type BrewMood = keyof typeof POSES;

// idle 움직임 종류
type Motion = 'bounce' | 'wave' | 'pour' | 'none';

const MOTION_BY_MOOD: Record<BrewMood, Motion> = {
  welcome: 'wave',
  happy: 'bounce',
  resting: 'none',
  pouring: 'pour',
  clipboard: 'bounce',
  serving: 'bounce',
  hero: 'bounce',
};

export default function Brew({
  mood = 'welcome',
  size = 84,
  round = false,
  framed = false,
  style,
}: {
  mood?: BrewMood;
  size?: number;
  round?: boolean; // 크림 원형 프레임 안에 넣기 (흰 카드 위 등)
  framed?: boolean; // 둥근 크림 카드로 감싸기 (드립/턱괸 등 장면 포즈용)
  style?: StyleProp<ViewStyle>;
}) {
  const a = useRef(new Animated.Value(0)).current;
  const motion = MOTION_BY_MOOD[mood];

  useEffect(() => {
    if (motion === 'none') return;
    const cfg =
      motion === 'wave'
        ? { dur: 620 }
        : motion === 'pour'
          ? { dur: 1400 }
          : { dur: 1250 };
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: cfg.dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(a, { toValue: motion === 'wave' ? -1 : 0, duration: cfg.dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [a, motion]);

  const transform =
    motion === 'wave'
      ? [{ rotate: a.interpolate({ inputRange: [-1, 1], outputRange: ['-5deg', '5deg'] }) }]
      : motion === 'bounce'
        ? [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) }]
        : motion === 'pour'
          ? [{ rotate: a.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '3deg'] }) }]
          : [];

  const img = (
    <Animated.Image
      source={POSES[mood]}
      resizeMode="contain"
      style={{ width: size, height: size, transform }}
    />
  );

  // 둥근 크림 카드 (배경색이 이미지와 동일 → 잘린 느낌 없이 하나의 일러스트 카드로)
  if (framed) {
    return (
      <View style={[styles.framed, { width: size, height: size }, style]}>
        <Image source={POSES[mood]} resizeMode="cover" style={{ width: size, height: size }} />
      </View>
    );
  }

  if (round) {
    return (
      <View style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, style]}>
        {img}
      </View>
    );
  }
  return <View style={style}>{img}</View>;
}

const styles = StyleSheet.create({
  round: {
    backgroundColor: '#FBEFDD',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  framed: {
    backgroundColor: '#FBEFDD',
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
