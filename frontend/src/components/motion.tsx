// 토스 스타일 모션 프리미티브 — 스프링 물리 기반 마이크로 인터랙션
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

// ── 누르면 쑥 들어갔다 통통 튀어 돌아오는 프레스 (토스 버튼 특유의 쫀득함) ──
// Pressable 자체를 애니메이션화 → 스타일(너비/flex 포함)이 실제 레이아웃 박스에 적용됨
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PressableScale({
  children,
  onPress,
  disabled,
  style,
  to = 0.95,
}: {
  children: ReactNode;
  onPress?: (e: GestureResponderEvent) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  to?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current; // [한글 주석: 투박함을 없애기 위해 꾹 누를 때의 알파 투명도 상태 추가]

  const pressIn = () => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: to,
        useNativeDriver: true,
        speed: 50,
        bounciness: 0,
      }),
      Animated.timing(opacity, {
        toValue: 0.76, // 꾹 눌렸을 때 투명도를 76%로 낮추어 부드러운 하이라이트 효과 연출
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const pressOut = () => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        speed: 12,
        bounciness: 12, // 놓을 때 통통 튀는 오버슛
      }),
      Animated.timing(opacity, {
        toValue: 1, // 떼면 다시 신속하게 100% 투명도로 조용히 복원
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      disabled={disabled}
      style={[style, { transform: [{ scale }], opacity }]}
    >
      {children}
    </AnimatedPressable>
  );
}

// ── 아래에서 스르륵 떠오르며 나타나기 (진입 stagger용, delay로 순차 배치) ──
export function FadeInUp({
  children,
  delay = 0,
  distance = 16,
  style,
}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, {
      toValue: 1,
      duration: 460,
      delay,
      easing: Easing.out(Easing.cubic), // 빠르게 감속하는 토스식 커브
      useNativeDriver: true,
    }).start();
  }, [v, delay]);

  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] });
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

// ── 스프링으로 팝하며 나타나기 (배지/체크마크 강조용) ──
export function PopIn({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.spring(v, { toValue: 1, delay, useNativeDriver: true, speed: 14, bounciness: 14 }).start();
  }, [v, delay]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  return <Animated.View style={[style, { opacity: v, transform: [{ scale }] }]}>{children}</Animated.View>;
}

// ── 숫자가 촤르륵 세어 올라가기 (매출/금액 강조) ──
export function useCountUp(target: number, duration = 900, deps: unknown[] = []) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let raf = 0;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      // easeOutExpo — 빠르게 올라가다 부드럽게 안착
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, ...deps]);

  return value;
}
