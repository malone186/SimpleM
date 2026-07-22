// 넘치는 텍스트를 좌우로 스르륵 흘려 전부 읽히게 하는 마퀴(전광판) 래퍼.
// 내용이 컨테이너보다 짧으면 정지, 길면 양끝에서 잠깐 멈췄다 왕복 스크롤한다.
// children을 두 번 렌더한다: 숨은 사본으로 자연 너비를 재고, 보이는 사본을 실제로 움직인다.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export default function MarqueeText({
  children,
  style,
  speed = 34,   // 초당 이동 픽셀
  pause = 1100, // 양끝에서 멈추는 시간(ms)
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  speed?: number;
  pause?: number;
}) {
  const [containerW, setContainerW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;

  const overflow = contentW > 0 && containerW > 0 && contentW > containerW + 1;

  useEffect(() => {
    x.stopAnimation();
    x.setValue(0);
    if (!overflow) return;
    const dist = contentW - containerW;
    const dur = Math.max(600, (dist / speed) * 1000);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(pause),
        Animated.timing(x, { toValue: -dist, duration: dur, easing: Easing.linear, useNativeDriver: true }),
        Animated.delay(pause),
        Animated.timing(x, { toValue: 0, duration: dur, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [overflow, contentW, containerW, speed, pause, x]);

  return (
    <View style={[styles.clip, style]} onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}>
      {/* 자연 너비 측정용 숨은 사본 — 절대배치라 폭 제약 없이 한 줄 자연 너비로 잰다 */}
      <View style={styles.measure} onLayout={(e) => setContentW(e.nativeEvent.layout.width)} pointerEvents="none">
        {children}
      </View>
      {/* 실제 표시 — 넘칠 때만 translateX로 스크롤, 아니면 제자리 */}
      <Animated.View
        style={[
          styles.visibleRow,
          overflow && contentW ? { width: contentW } : null,
          { transform: [{ translateX: overflow ? x : 0 }] },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  measure: { position: 'absolute', opacity: 0, left: 0, top: 0, alignSelf: 'flex-start' },
  visibleRow: { flexDirection: 'row', alignSelf: 'flex-start' },
});
