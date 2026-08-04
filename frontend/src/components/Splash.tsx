// 앱 첫 실행 스플래시 — 로고를 1초 보여준 뒤 부드럽게 사라진다.
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { colors } from '../theme';
import { useResponsive } from '../theme/responsive';

const LOGO = require('../../assets/brewnote_welcome_mascot.png'); // [한글 주석] 어플 첫 시작 스플래시 캐릭터 로고 — 사장님 요청 귀여운 BREWNOTE 강아지 마스코트

export default function Splash() {
  // [한글 주석] 화면 폭의 n% — 회전·폴더블 전개에 즉시 반응한다
  const { vw } = useResponsive();
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
        // [한글 주석] 로고 크기는 훅으로 실시간 계산 — 모듈 로드 시점 고정값은 폴더블 전개 때 어긋난다
        style={[styles.logo, { width: Math.min(vw(78), 330), height: Math.min(vw(50), 210) }, { transform: [{ scale }] }]}
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
  // [한글 주석] 예전 고정 330×210 은 아이폰 SE(320dp)·플립 커버 화면에서 좌우가 잘렸다.
  // 화면 폭의 78%를 쓰되 상한을 둬서 태블릿·폴드 펼침에서 과하게 커지지 않게 한다.
  // [한글 주석] 실제 크기는 컴포넌트에서 화면 폭 비례로 덮어쓴다 (고정 330×210 은 SE·플립에서 잘렸다)
  logo: { resizeMode: 'contain' },
});
