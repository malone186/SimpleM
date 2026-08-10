// 홈 강아지(브루) 이스터에그.
//  - 한 번 탭: 랜덤으로 [쓰다듬기 + 한마디] 또는 [간식 주기 미니 연출]
//  - 빠르게 두 번 탭: 시크릿(하트 뿅뿅 + 오늘의 행운 원두)
//  - 꾹 누르기(롱프레스): 풍선처럼 점점 부풀다가 끝까지 부풀면 펑! 터짐 (중간에 떼면 바람 빠지듯 복귀)
// 모두 RN 내장 Animated + 이모지로 처리 (추가 이미지 에셋 없음), 진동은 expo-haptics.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
// [한글 주석] 웹(Web) 환경 및 Haptics 모듈 미지원 환경에서 번들링 에러가 나는 것을 방지합니다.
let Haptics: any = null;
try {
  Haptics = require('expo-haptics');
} catch (e) {
  // 모듈 로드 불가 시 예외를 내지 않고 넘어갑니다.
}

import Brew, { FLIPBOOK_MOODS, type BrewAccessory, type BrewMood, type BrewOneShot } from '../brew/Brew';
import type { MotionName } from '../brew/brewMotions';
import { useBrewBrain, type BrewContext } from '../brew/useBrewBrain';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors } from '../../theme';

// [한글 주석] 진동 피드백 — 웹에선 동작하지 않고, 실패 시에도 안전하게 예외 처리
//
// 세기를 문자열로 받는 이유: 예전엔 호출부에서 buzz(Haptics.ImpactFeedbackStyle.Light)처럼
// 넘겼는데, 인자가 먼저 평가되므로 모듈 로드에 실패한 기기(위 try/catch로 Haptics=null)에서는
// 함수 안의 가드에 닿기도 전에 터진다. 이름만 넘기면 그런 일이 없다.
const buzz = (kind: 'Light' | 'Medium' | 'Heavy') => {
  if (Platform.OS === 'web' || !Haptics?.impactAsync) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle?.[kind])?.catch(() => {});
};
const buzzSuccess = () => {
  if (Platform.OS === 'web' || !Haptics?.notificationAsync) return;
  Haptics.notificationAsync?.(Haptics.NotificationFeedbackType?.Success)?.catch(() => {});
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

// 이모지가 사방으로 퍼지며 떠오르는 버스트 연출 (하트/펑 공용)
function Burst({ emojis, spread = 42, rise = 72 }: { emojis: string[]; spread?: number; rise?: number }) {
  const items = useRef(emojis.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(
      45,
      items.map((v) => Animated.timing(v, { toValue: 1, duration: 850, easing: Easing.out(Easing.quad), useNativeDriver: true })),
    ).start();
  }, [items]);

  const n = emojis.length;
  return (
    <View pointerEvents="none" style={styles.burstWrap}>
      {items.map((v, i) => {
        const x = n > 1 ? (i / (n - 1) - 0.5) * spread * 2 : 0;
        return (
          <Animated.Text
            key={i}
            style={{
              position: 'absolute',
              fontSize: 20,
              opacity: v.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, x] }) },
                { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -rise] }) },
                { scale: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.4, 1.2, 0.7] }) },
              ],
            }}
          >
            {emojis[i]}
          </Animated.Text>
        );
      })}
    </View>
  );
}

// 배경 효과를 감출 때 넘길 빈 배열 — 매번 새 배열을 만들면 Brew가 불필요하게 다시 그려진다
const EMPTY_ACCESSORIES: BrewAccessory[] = [];

export default function MascotEasterEgg({
  mood = 'top',
  size = 150,
  style,
  motion = false,
  interactiveMotions = false,
  autonomous = false,
  context,
  idleMotion: idleMotionOverride = null,
  moodOverridesPose = false,
  suppressAccessories = false,
}: {
  mood?: BrewMood;
  size?: number;
  style?: StyleProp<ViewStyle>;
  // 산 포즈보다 mood를 앞세운다 — 지금 꼭 표정으로 말해야 할 상황일 때만 켠다.
  // (홈에서 매출이 꺾였는데 스웩 댑 포즈로 춤추고 있으면 표정이 정보가 아니라 장식이 된다)
  moodOverridesPose?: boolean;
  // 배경 효과(하트·반짝이)를 잠시 감춘다 — 나쁜 소식과 같이 띄우면 화면이 농담처럼 읽힌다.
  // 보관함에서 다른 배경으로 갈아입으면 그 즉시 다시 보인다 (아래 suppressedSig 참고).
  suppressAccessories?: boolean;
  // 게임 룸처럼 브루가 주인공인 화면에서는 정지 포즈여도 잔동작(숨쉬기 등)을 켠다.
  // 홈에서는 기존대로 플립북 포즈만 움직인다(기본값 false).
  motion?: boolean;
  // 게임 룸 전용: 탭할 때마다 전신 모션(손인사·점프·댄스) 중 하나를 1회 재생한다.
  // 어떤 포즈를 입고 있어도 끼어들고, 끝나면 원래 모습으로 돌아온다.
  interactiveMotions?: boolean;
  // 아무도 안 누를 때 브루가 스스로 다음 동작을 고르게 한다 (BrewBrain).
  // 화면이 보이는 동안만 켜는 게 원칙 — 상시 켜 두면 루프가 프레임을 깎는다.
  autonomous?: boolean;
  // 브루가 몸으로 표현할 가게 상태 (매출 흐름·부족 재고 등). 없으면 시간대만 본다.
  context?: BrewContext;
  // 바깥(무대 등)에서 지금 이 동작을 시켜야 할 때. 자율 행동보다 우선한다 —
  // 걸어가는 중에 브루가 혼자 기지개를 켜면 안 되니까.
  idleMotion?: MotionName | null;
}) {
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // 상점에서 산 것 (전역 공유 — 구매·착용하면 여기도 같이 바뀐다).
  // 평소엔 산 포즈가 이긴다 — 코인 주고 산 걸 앱이 마음대로 덮으면 산 보람이 없다.
  // 다만 화면이 '지금은 이 표정이어야 한다'고 못박은 순간(moodOverridesPose)에는 mood가 이긴다.
  // 앞치마 색은 어느 쪽이든 유지된다 — 옷 색은 감정과 무관하기 때문이다.
  const { accessories, poseMood, apronColor } = useEquipped();
  const shownMood = moodOverridesPose ? mood : (poseMood ?? mood);

  // ── 배경 효과(하트·반짝이)는 나쁜 소식과 같이 띄우지 않는다 ──
  // 매출이 반 토막 났는데 시무룩한 브루 주위로 하트가 날아다니면 화면이 농담처럼 읽힌다.
  //
  // 다만 영영 숨기면 안 된다. 사장님이 보관함에서 배경을 바꿨는데 아무 변화가 없으면
  // 앱이 고장난 것처럼 보인다. 그래서 '숨기기 시작한 그 배경'만 숨기고, 다른 것으로
  // 갈아입는 순간 숨기기를 푼다 — 방금 고른 건 눈으로 확인돼야 한다.
  const accessorySig = accessories.map((a) => a.id).join(',');
  const suppressedSig = useRef<string | null>(null);
  if (!suppressAccessories) {
    suppressedSig.current = null;              // 상황이 풀리면 다음 나쁜 날을 위해 비워 둔다
  } else if (suppressedSig.current === null) {
    suppressedSig.current = accessorySig;      // 이 배경이 숨김 대상
  }
  // 지금 착용한 게 숨김 대상과 다르면 = 사장님이 방금 갈아입은 것 → 그대로 보여 준다
  const hideAccessories = suppressAccessories && suppressedSig.current === accessorySig;
  const shownAccessories = hideAccessories ? EMPTY_ACCESSORIES : accessories;

  // 강아지 반동(탭 공통) + 풍선 부풀기(롱프레스) — 최종 스케일은 둘의 곱
  const scale = useRef(new Animated.Value(1)).current;
  const balloon = useRef(new Animated.Value(1)).current;
  const rot = useRef(new Animated.Value(0)).current;
  const combinedScale = Animated.multiply(scale, balloon);
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] });

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

  // 말풍선(한마디/시크릿/펑)
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
      wiggle();
      if (alive.current) setTimeout(() => { if (alive.current) setTreat(null); }, 180);
    });
  };
  const treatY = treatAnim.interpolate({ inputRange: [0, 1], outputRange: [-58, size * 0.42] });
  const treatScale = treatAnim.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0.3] });
  const treatOpacity = treatAnim.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });

  // 버스트: 하트(시크릿) / 펑(풍선)
  const [heartKey, setHeartKey] = useState(0);
  const [popKey, setPopKey] = useState(0);

  // ── 탭 (단일/더블) ──────────────────────────────────────────
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DOUBLE_MS = 280;

  // 게임 룸 탭 반응 — 전신 모션 1회 재생 (token이 바뀔 때마다 Brew가 새로 재생한다).
  // 자율 행동과 통로를 하나로 합쳐 둔다: 둘이 각자 state를 들면 브루가 스스로 고른 동작과
  // 사장님이 눌러서 낸 동작이 서로를 덮어써 깜빡인다. 여기서는 눌렀을 때가 항상 최신이라
  // 자연스럽게 탭이 이긴다.
  const { idleMotion, oneShot, setOneShot } = useBrewBrain({ enabled: autonomous, context });
  // token은 '새 요청'이라는 표시일 뿐이라 단조 증가면 충분하다. 예전엔 Date.now()를 썼는데
  // 같은 밀리초에 두 번 눌리면 token이 겹쳐 두 번째 탭이 조용히 무시됐다.
  const shotToken = useRef(0);
  const playMotion = (key: BrewOneShot['key']) => {
    shotToken.current += 1;
    setOneShot({ key, token: shotToken.current });
  };
  const playRandomMotion = () => playMotion(pick<BrewOneShot['key']>(['wave', 'jump', 'dance', 'dab', 'jacks', 'bad', 'heart', 'celeb']));

  const triggerSingle = () => {
    if (interactiveMotions) playRandomMotion(); // 쓰다듬으면 폴짝 뛰거나 춤추거나 인사한다
    else wiggle(); // 전신 모션 중엔 통짜 흔들기를 겹치지 않는다 (움직임이 이중으로 보임)
    if (Math.random() < 0.5) {
      buzz('Light');
      showBubble(pick(PAT_LINES), '#C05A24');
    } else {
      buzz('Medium');
      showTreat();
    }
  };
  const triggerSecret = () => {
    if (interactiveMotions) playMotion('dance'); // 시크릿은 항상 댄스!
    else wiggle();
    buzzSuccess();
    setHeartKey((k) => k + 1);
    showBubble(secretLine(), '#B8860B', 2000);
  };
  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_MS) {
      if (singleTimer.current) { clearTimeout(singleTimer.current); singleTimer.current = null; }
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

  // ── 롱프레스 (풍선 부풀기 → 펑) ─────────────────────────────
  const growStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const growAnim = useRef<Animated.CompositeAnimation | null>(null);
  const longPressing = useRef(false);
  const popped = useRef(false);
  const suppressTap = useRef(false);

  const pop = () => {
    popped.current = true;
    suppressTap.current = true;
    buzz('Heavy'); // 모듈이 없는 기기에서도 안전하게 (예전엔 여기서 바로 터졌다)
    Animated.sequence([
      Animated.timing(balloon, { toValue: 2.7, duration: 90, useNativeDriver: true }),
      Animated.timing(balloon, { toValue: 0, duration: 130, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(() => {
      if (!alive.current) return;
      setPopKey((k) => k + 1); // 💥 터짐 연출
      showBubble('펑! 🎈', '#C0392B', 1100);
      // 잠깐 사라졌다 통통 튀며 다시 등장
      setTimeout(() => {
        if (!alive.current) return;
        balloon.setValue(0);
        Animated.spring(balloon, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 16 }).start();
        popped.current = false;
      }, 380);
    });
  };

  const startGrow = () => {
    longPressing.current = true;
    popped.current = false;
    buzz('Light'); // 부풀기 시작 틱
    balloon.setValue(1);
    growAnim.current = Animated.timing(balloon, { toValue: 2.3, duration: 1000, easing: Easing.linear, useNativeDriver: true });
    growAnim.current.start(({ finished }) => {
      if (finished) pop(); // 끝까지 부풀면 터짐
    });
  };

  const onPressIn = () => {
    // 잠깐 이상 누르고 있을 때만 부풀기 시작 → 빠른 탭과 구분
    growStartTimer.current = setTimeout(startGrow, 180);
  };
  const onPressOut = () => {
    if (growStartTimer.current) { clearTimeout(growStartTimer.current); growStartTimer.current = null; }
    if (longPressing.current && !popped.current) {
      // 끝까지 안 부풀고 뗌 → 바람 빠지듯 복귀, 탭 이벤트는 무시
      growAnim.current?.stop();
      suppressTap.current = true;
      Animated.spring(balloon, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }).start();
    }
    longPressing.current = false;
  };
  const onPress = () => {
    if (suppressTap.current) { suppressTap.current = false; return; }
    handleTap();
  };

  useEffect(
    () => () => {
      if (singleTimer.current) clearTimeout(singleTimer.current);
      if (growStartTimer.current) clearTimeout(growStartTimer.current);
    },
    [],
  );

  return (
    <View style={[{ position: 'relative', alignItems: 'center' }, style]}>
      <Pressable onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut} hitSlop={6}>
        <Animated.View style={{ transform: [{ scale: combinedScale }, { rotate }] }}>
          {/* 상점에서 산 포즈·배경을 홈 마스코트에 그대로 반영한다 */}
          {/* 플립북 포즈(점프·댄스)는 움직임 자체가 상품이라 홈에서도 재생을 허용한다 */}
          <Brew
            mood={shownMood}
            size={size}
            disableMotion={!motion && !FLIPBOOK_MOODS.has(shownMood)}
            accessories={shownAccessories}
            apronColor={apronColor}
            oneShot={oneShot}
            idleMotion={idleMotionOverride ?? idleMotion}
          />
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

      {heartKey > 0 && <Burst key={`h${heartKey}`} emojis={['❤️', '💛', '✨', '🧡', '⭐']} />}
      {popKey > 0 && <Burst key={`p${popKey}`} emojis={['💥', '🎈', '✨', '💥', '🎉', '✨']} spread={62} rise={92} />}
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
