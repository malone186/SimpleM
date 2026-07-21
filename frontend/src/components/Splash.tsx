// 앱 첫 실행 스플래시 — 로고를 1초 보여준 뒤 부드럽게 사라진다.
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { colors } from '../theme';

const LOGO = require('../../assets/brew_icon_cutout.png'); // [한글 주석] 앱 첫 실행 스플래시 로고 — 흰 배경 제거한 브루노트 마스코트(강아지+테이블)

export default function Splash() {
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(0.86)).current;
  const [gone, setGone] = useState(false);

  useEffect(() => {
    // 로고가 살짝 커지며 등장
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 8 }).start();
    // 1초 뒤 페이드아웃 → 언마운트
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 380, useNativeDriver: true }).start(
        ({ finished }) => finished && setGone(true)
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [opacity, scale]);

  if (gone) return null;

  return (
    <Animated.View style={[styles.fill, { opacity }]}>
      <Animated.Image
        source={LOGO}
        resizeMode="contain"
        style={[styles.logo, { transform: [{ scale }] }]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.creamSand,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  logo: { width: 264, height: 232 },
});
