// 홈 강아지(브루) 이스터에그.
//  - 한 번 탭: 랜덤으로 [쓰다듬기 + 한마디] 또는 [간식 주기 미니 연출]
//  - 빠르게 두 번 탭: 시크릿(하트 뿅뿅 + 오늘의 행운 원두)
// 모두 RN 내장 Animated로 처리 (추가 패키지/에셋 없음, 간식·하트는 이모지).
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';

import Brew, { type BrewMood } from '../brew/Brew';
import { colors } from '../../theme';

// 진동 피드백 — 웹에선 no-op, 실패해도 조용히 무시
const buzz = (style: Haptics.ImpactFeedbackStyle) => {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(style).catch(() => {});
};
const buzzSuccess = () => {
  if (Platform.OS === 'web') return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
};

const PAT_LINES = [
  '헤헤, 간지러워요!',
  '오늘도 좋은 하루 되세요!',
  '왈왈! 사장님 최고!',
  '쓰담쓰담 좋아요~',
  '오늘 매출도 파이팅이에요!',
  '커피 한 잔 하실래요?',
  '손님들이 사장님 커피를 좋아할 거예요!',
  '저는 브루예요, 반가워요!',
];

const TREATS = ['🦴', '☕', '🍪', '🫘', '🥛'];

const LUCKY_BEANS = ['예가체프', '게이샤', '콜롬비아 수프리모', '케냐 AA', '만델링', '블루마운틴', '수마트라'];
const secretLine = () => {
  const roll = Math.random();
  if (roll < 0.5) return `🎉 오늘의 행운 원두는 "${LUCKY_BEANS[Math.floor(Math.random() * LUCKY_BEANS.length)]}"!`;
  if (roll < 0.8) return '🎉 숨은 브루 발견! 오늘 좋은 일이 생길 거예요!';
  return '🎉 브루의 비밀 응원: 사장님은 최고의 바리스타!';
};

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function HeartsBurst() {
  const items = useRef([...Array(5)].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(
      55,
      items.map((v) =>
        Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ),
    ).start();
  }, [items]);

  const X = [-42, -20, 0, 20, 42];
  const EMOJI = ['❤️', '💛', '✨', '🧡', '⭐'];
  return (
    <View pointerEvents="none" style={styles.burstWrap}>
      {items.map((v, i) => (
        <Animated.Text
          key={i}
          style={{
            position: 'absolute',
            fontSize: 18,
            opacity: v.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0, 1, 0] }),
            transform: [
              { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, X[i]] }) },
              { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -72] }) },
              { scale: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.4, 1.15, 0.8] }) },
            ],
          }}
        >
          {EMOJI[i]}
        </Animated.Text>
      ))}
    </View>
  );
}

export default function MascotEasterEgg({
  mood = 'top',
  size = 150,
  style,
}: {
  mood?: BrewMood;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // 강아지 반동(모든 탭 공통)
  const scale = useRef(new Animated.Value(1)).current;
  const rot = useRef(new Animated.Value(0)).current;
  const wiggle = () => {
    scale.setValue(1);
    rot.setValue(0);
    Animated.parallel([
      Animated.sequence([
        Animated.spring(scale, { toValue: 1.14, useNativeDriver: true, speed: 40, bounciness: 16 }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 12 }),
      ]),
      Animated.sequence([
        Animated.timing(rot, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.timing(rot, { toValue: -1, duration: 120, useNativeDriver: true }),
        Animated.timing(rot, { toValue: 0, duration: 90, useNativeDriver: true }),
      ]),
    ]).start();
  };
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] });

  // 말풍선(한마디/시크릿)
  const [bubble, setBubble] = useState<{ text: string; color: string } | null>(null);
  const bubbleAnim = useRef(new Animated.Value(0)).current;
  const showBubble = (text: string, color: string, hold = 1400) => {
    setBubble({ text, color });
    bubbleAnim.setValue(0);
    Animated.sequence([
      Animated.spring(bubbleAnim, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 10 }),
      Animated.delay(hold),
      Animated.timing(bubbleAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => {
      if (alive.current) setBubble(null);
    });
  };
  const bubbleY = bubbleAnim.interpolate({ inputRange: [0, 1], outputRange: [8, -4] });

  // 간식
  const [treat, setTreat] = useState<string | null>(null);
  const treatAnim = useRef(new Animated.Value(0)).current;
  const showTreat = () => {
    setTreat(pick(TREATS));
    treatAnim.setValue(0);
    Animated.timing(treatAnim, { toValue: 1, duration: 720, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
      wiggle(); // 받아먹고 신남
      if (alive.current) setTimeout(() => { if (alive.current) setTreat(null); }, 180);
    });
  };
  const treatY = treatAnim.interpolate({ inputRange: [0, 1], outputRange: [-58, size * 0.42] });
  const treatScale = treatAnim.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0.3] });
  const treatOpacity = treatAnim.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });

  // 하트 버스트(시크릿)
  const [burstKey, setBurstKey] = useState(0);

  // 단일 vs 더블 탭 판별
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DOUBLE_MS = 280;

  const triggerSingle = () => {
    wiggle();
    if (Math.random() < 0.5) {
      buzz(Haptics.ImpactFeedbackStyle.Light); // 쓰다듬기 = 가벼운 진동
      showBubble(pick(PAT_LINES), '#C05A24'); // 쓰다듬기 + 한마디
    } else {
      buzz(Haptics.ImpactFeedbackStyle.Medium); // 간식 = 중간 진동(툭)
      showTreat(); // 간식 주기
    }
  };

  const triggerSecret = () => {
    wiggle();
    buzzSuccess(); // 시크릿 = 성공 진동 패턴
    setBurstKey((k) => k + 1);
    showBubble(secretLine(), '#B8860B', 2000);
  };

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_MS) {
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      lastTap.current = 0;
      triggerSecret();
    } else {
      lastTap.current = now;
      singleTimer.current = setTimeout(() => {
        singleTimer.current = null;
        if (alive.current) triggerSingle();
      }, DOUBLE_MS);
    }
  };

  useEffect(() => () => { if (singleTimer.current) clearTimeout(singleTimer.current); }, []);

  return (
    <View style={[{ position: 'relative', alignItems: 'center' }, style]}>
      <Pressable onPress={handleTap} hitSlop={6}>
        <Animated.View style={{ transform: [{ scale }, { rotate }] }}>
          <Brew mood={mood} size={size} disableMotion />
        </Animated.View>
      </Pressable>

      {bubble && (
        <Animated.View
          pointerEvents="none"
          style={[styles.bubble, { opacity: bubbleAnim, transform: [{ translateY: bubbleY }, { scale: bubbleAnim }] }]}
        >
          <Text style={[styles.bubbleText, { color: bubble.color }]}>{bubble.text}</Text>
        </Animated.View>
      )}

      {treat && (
        <Animated.Text
          pointerEvents="none"
          style={[styles.treat, { opacity: treatOpacity, transform: [{ translateY: treatY }, { scale: treatScale }] }]}
        >
          {treat}
        </Animated.Text>
      )}

      {burstKey > 0 && <HeartsBurst key={burstKey} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    top: -6,
    right: 4,
    maxWidth: 200,
    backgroundColor: colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.15)',
    paddingHorizontal: 11,
    paddingVertical: 7,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
    zIndex: 20,
  },
  bubbleText: { fontSize: 11.5, fontWeight: '800', letterSpacing: -0.3 },
  treat: {
    position: 'absolute',
    top: 0,
    fontSize: 30,
    zIndex: 15,
  },
  burstWrap: {
    position: 'absolute',
    top: '38%',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 15,
  },
});
