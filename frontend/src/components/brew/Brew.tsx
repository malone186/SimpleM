// 브루(BREW) 마스코트 — 표정 = 가게 상태. "브루 등장 지도" 기반.
// 원칙: 감정의 순간엔 브루, 판단(정확한 숫자)의 순간엔 브루를 비운다. 한 화면에 하나.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ACCESSORY_ART } from './accessories';
import { APRON_VARIANTS, type ApronColor } from './apronVariants';
import { BLINK_OVERLAY } from './blinkOverlays';
import { startLoop } from '../../lib/animLoop';
import { MOTIONS, startMotion, type MotionName } from './brewMotions';
import Flipbook from './Flipbook';
import { FLIP_FRAMES } from './flipbookFrames';

// 캐릭터 시트에서 잘라낸 포즈들 (표정 매칭 표)
const POSES = {
  welcome: require('../../../assets/mascot/brew_wave.png'), // 하트·발 흔드는 브루 — 환영·칭찬, 상점 헤더용 (투명 배경)
  happy: require('../../../assets/mascot/brew_happy.png'), // 활짝 웃는 브루 — 스트릭·좋은 소식, 챗봇 헤더용
  // [한글 주석] 번들러 캐시 우회를 위해 물리적인 파일명을 brew_resting_v2.png로 갱신하여 참조합니다
  resting: require('../../../assets/mascot/brew_resting_v2.png'), // 턱 괸 브루 — 빈 화면·대기
  pouring: require('../../../assets/mascot/brew_pouring.png'), // 드립 내리는 브루 — 로딩·처리 중
  clipboard: require('../../../assets/mascot/brew_clipboard.png'), // 클립보드 든 브루 — 리포트·발주
  serving: require('../../../assets/mascot/brew_serving.png'), // 케이크 든 브루 — 서비스·추천, 재고 헤더용
  hero: require('../../../assets/mascot/brew_hero.png'), // 스탠딩 바리스타 — 브랜드/온보딩
  top: require('../../../assets/mascot/brew_top.png'), // 모자 쓰고 커피 든 바리스타 — 홈 헤더용
  greet: require('../../../assets/mascot/brew_greet.png'), // 발 흔들며 인사하는 브루 — 인사·안내 (현재 미사용)
  coffee: require('../../../assets/mascot/brew_coffee.png'), // 커피잔 든 브루 (현재 미사용)
  // 시무룩한 브루 — 매출이 꺾였을 때. 여기 있는 다른 포즈는 전부 웃고 있어서,
  // '가게 상태가 나쁘다'를 표정으로 말할 방법이 이 둘뿐이다.
  upset: require('../../../assets/mascot/brew_upset2.png'), // 장부 보며 시무룩 (상반신) — 홈 헤더용
  upsetFull: require('../../../assets/mascot/brew_upset1.png'), // 고개 숙인 전신 — 전신을 쓰는 화면용
  // 전신 애니메이션 포즈 — 정지 시엔 첫 프레임, 모션이 켜지면 플립북으로 재생된다
  jump: require('../../../assets/mascot/anim/jump/f00.webp'), // 폴짝 뛰는 브루 (상점 판매)
  dance: require('../../../assets/mascot/anim/dance/f00.webp'), // 춤추는 브루 (상점 판매)
  hello: require('../../../assets/mascot/anim/wave/f00.webp'), // 손 흔들며 인사하는 브루 (상점 판매)
  dab: require('../../../assets/mascot/anim/dab/f00.webp'), // 스웩 dab 브루 (상점 판매)
  workout: require('../../../assets/mascot/anim/jacks/f00.webp'), // 팔벌려뛰기 브루 (상점 판매)
  bad: require('../../../assets/mascot/anim/bad/f00.webp'), // BAD 챌린지 안무 브루 (상점 판매)
} as const;

export type BrewMood = keyof typeof POSES;

// ── 전신 플립북 ─────────────────────────────────────────────────────────────
// 전신 기본 자세 일러스트를 AnimatedDrawings(오픈소스)로 리깅해 모션캡처 동작을 입히고,
// 20프레임 스프라이트로 구운 것. 부위 애니메이션과 달리 몸 전체가 움직인다.
// 앞치마 색을 착용하면 그 색으로 미리 구운 세트('wave__navy' 등)를 골라 쓴다.
const FLIP_KEY: Partial<Record<BrewMood, string>> = {
  hello: 'wave',
  jump: 'jump',
  dance: 'dance',
  dab: 'dab',
  workout: 'jacks',
  bad: 'bad',
};

// 홈 마스코트(이스터에그 래퍼)처럼 자체 모션을 끄는 곳에서도, 플립북 포즈만은
// 재생을 허용할지 판단할 수 있게 공개한다 — 이 포즈들은 '움직임 자체가 상품'이라서.
export const FLIPBOOK_MOODS = new Set<BrewMood>(['jump', 'dance', 'hello', 'dab', 'workout', 'bad']);

/** 발까지 그려진 전신 포즈.
 *
 * 나머지(welcome·happy·resting·clipboard·serving·top·greet·coffee)는 앞치마 언저리에서 잘린
 * 반신 컷이다. 무대에서 바닥 그림자를 깔거나 걸어 다니게 하는 건 발이 있는 포즈에서만 말이
 * 된다 — 반신에 그림자를 달면 상반신이 공중에 떠서 그림자를 끌고 다니는 꼴이 된다. */
export const FULL_BODY_MOODS = new Set<BrewMood>([
  'hero', 'pouring', 'jump', 'dance', 'hello', 'dab', 'workout', 'bad',
]);

// ── 부위 애니메이션 (레이어 분리) ──────────────────────────────────────────
// 기존 포즈 그림에서 '들고 있는 물건+발'만 레이어로 분리하고, 가려졌던 몸통은
// 인페인팅으로 메꿔 뒀다(base). 레이어에만 transform을 걸면 몸은 가만히 있고
// 물건만 움직인다 — 눈 깜빡임 오버레이와 같은 원리인데, 프레임을 굽지 않고
// 런타임 transform(들썩임·갸웃)으로 움직여서 그림 한 장 반이면 충분하다.
type PartKind = 'bob' | 'tilt';
const PART_ANIM: Partial<Record<BrewMood, { base: any; layer: any; kind: PartKind }>> = {
  clipboard: {
    base: require('../../../assets/mascot/parts/clipboard_base.png'),
    layer: require('../../../assets/mascot/parts/clipboard_layer.png'),
    kind: 'tilt', // 클립보드를 살짝 갸웃 — 체크리스트 확인하는 느낌
  },
};

// ── 배경 효과 ──────────────────────────────────────────────────────────────
// 상점에서 산 배경 장식을 브루 뒤에 깔아준다.
//
// 캐릭터 '위에' 얹는 착용 아이템은 없다. 브루는 포즈마다 완성된 PNG 한 장이고 그림
// 안에 이미 캡·앞치마를 착용하고 컵까지 들고 있어서, 모자를 또 얹으면 스티커를
// 덧붙이는 꼴이 된다. 게다가 포즈마다 머리 위치가 달라 좌표를 맞출 수도 없다.
// 그래서 상점은 '포즈 교체'(mood)로 가고, 겹쳐 그리는 건 배경만 남겼다.
export type BrewAccessory = { id: string; slot: 'background'; emoji: string };

// [예전 메모] 정적(테두리 고정) 장식 때는 캐릭터를 줄여(0.76) 박스 안에 테두리 공간을
// 만들어야 장식이 보였다. 지금 배경 효과는 파티클(반짝임·커피콩 등)이 박스 전체에서
// 캐릭터 '뒤'로 흐르므로 위·옆·빈틈으로 잘 보인다 — 캐릭터를 줄일 필요가 없다.
// 오히려 줄이면 '효과를 켜면 마스코트가 갑자기 작아지는' 문제만 생겨 없앴다.

const SLOT_LAYOUT: Record<BrewAccessory['slot'], (size: number) => StyleProp<ViewStyle>> = {
  background: () => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  }),
};

const SLOT_SCALE: Record<BrewAccessory['slot'], number> = {
  background: 1, // 박스를 가득 채운다 (캐릭터가 그보다 작아져서 효과가 드러난다)
};

// idle 움직임 종류.
// 그림 한 장에 transform만 거는 동작들은 brewMotions.ts의 표에서 온다 — 거기 한 줄
// 추가하는 게 곧 새 동작이다. 여기 남은 셋은 성격이 달라서 표에 못 넣는 것들이다:
//   part = 분리 레이어를 따로 움직임 / flip = 구운 프레임 재생 / none = 정지
type Motion = MotionName | 'part' | 'flip' | 'none';

const MOTION_BY_MOOD: Record<BrewMood, Motion> = {
  welcome: 'wave',
  happy: 'bounce',
  resting: 'none',
  // 시무룩할 때는 잔동작도 없다 — 가만히 있는 것 자체가 기운 없어 보인다.
  // 통통 튀게 두면 표정만 슬프고 몸은 신나 있어서 감정이 안 읽힌다.
  upset: 'none',
  upsetFull: 'none',
  pouring: 'pour',
  clipboard: 'part', // 몸 고정, 클립보드만 갸웃 (PART_ANIM)
  serving: 'bounce',
  hero: 'bounce',
  top: 'bounce',
  greet: 'wave',
  coffee: 'bounce',
  jump: 'flip', // 20프레임 플립북 재생
  dance: 'flip',
  hello: 'flip',
  dab: 'flip',
  workout: 'flip',
  bad: 'flip',
};

/** 한 번 재생 요청 — token이 바뀔 때마다 해당 모션을 처음부터 1회 재생한다 (게임 허브 탭 반응) */
export type BrewOneShot = { key: 'wave' | 'jump' | 'dance' | 'dab' | 'jacks' | 'bad'; token: number };

export default function Brew({
  mood = 'welcome',
  size = 84,
  round = false,
  framed = false,
  style,
  disableMotion = false, // [한글 주석: 말풍선 등과 애니메이션을 통합하기 위해 자체 모션을 끌 수 있는 제어 장치 추가]
  accessories = [],
  apronColor,
  oneShot = null,
  idleMotion = null,
}: {
  mood?: BrewMood;
  size?: number;
  round?: boolean; // 크림 원형 프레임 안에 넣기 (흰 카드 위 등)
  framed?: boolean; // 둥근 크림 카드로 감싸기 (드립/턱괸 등 장면 포즈용)
  style?: StyleProp<ViewStyle>;
  disableMotion?: boolean;
  accessories?: BrewAccessory[]; // 상점에서 산 꾸미기 아이템 (착용 중인 것만)
  apronColor?: string; // 상점에서 산 앞치마 색 (navy·forest 등). 없으면 기본 갈색.
  oneShot?: BrewOneShot | null; // 탭 반응 등으로 전신 모션을 1회만 재생 (끝나면 원래 모습 복귀)
  // 포즈가 정한 기본 잔동작 대신 이 동작을 시킨다 (BrewBrain이 상황에 맞춰 넣는다).
  // 전신 플립북 포즈에는 걸지 않는다 — 거기선 움직임 자체가 그 포즈의 내용이라 겹치면 망가진다.
  idleMotion?: MotionName | null;
}) {
  const a = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(0)).current;
  const part = useRef(new Animated.Value(0)).current; // 부위 레이어 진행도 (0=제자리)
  const acc = useRef(new Animated.Value(0)).current; // 악센트 동작 진행도 (기본 잔동작 위에 더해진다)
  // 앞치마 색을 착용했으면 그 색으로 리컬러한 변형 이미지를 쓴다(원본 포즈를 대체).
  // 변형이 없으면(색 미착용·해당 포즈 변형 부재) 원본 갈색 포즈로 안전하게 폴백.
  const poseSource = (apronColor && APRON_VARIANTS[mood]?.[apronColor as ApronColor]) || POSES[mood];
  // 부위 애니메이션은 '원본 그림'에서 분리한 레이어라서, 앞치마 색 변형을 입었으면
  // base와 색이 어긋난다 → 그때는 부위 애니메이션을 접고 통짜 그림 + bounce로 폴백.
  // disableMotion일 때도 원본 통짜 그림이 곧 정지 화면이므로 분리본이 필요 없다.
  const partCfg = PART_ANIM[mood];
  const usePart = !!partCfg && poseSource === POSES[mood] && !disableMotion;
  // 눈 뜬 포즈만 눈 깜빡임 오버레이가 있다. 있으면 눈 부위만 잠깐 감았다 뜬다.
  // (앞치마 색 변형 위에도 그대로 얹힌다 — 눈은 상단, 앞치마는 하단이라 안 겹친다)
  // 깜빡임은 흔들림(sway)과 별개다 — disableMotion(홈 마스코트·썸네일)이어도 눈은 깜빡인다.
  const blinkSource = BLINK_OVERLAY[mood];
  // [한글 주석: disableMotion이 켜지면 강아지 고유의 흔들림 모션을 'none'(정지) 상태로 바꿉니다]
  const moodMotion = MOTION_BY_MOOD[mood];
  const motion: Motion = disableMotion
    ? 'none'
    : moodMotion === 'part' && !usePart
      ? 'bounce' // 분리 레이어를 못 쓰는 상황(앞치마 변형)이면 예전처럼 통짜 들썩임
      : moodMotion;

  // 지시받은 잔동작(BrewBrain·무대)은 기본 잔동작을 '대체'하지 않고 그 위에 얹는다.
  // 대체하면 그 동작이 끝나고 쉬는 동안 브루가 통째로 멈춰 선다 — 원래는 bounce가 끊김
  // 없이 돌고 있었는데 한 번 움직이고 마는 것처럼 보였던 이유가 이거였다.
  // 같은 동작이 겹치면 진폭만 두 배가 되니 그때는 얹지 않는다.
  const accent: MotionName | null =
    !disableMotion && idleMotion && motion !== 'flip' && idleMotion !== motion ? idleMotion : null;

  // 플립북 — 프레임을 이어 재생한다 (전신이 통째로 움직인다).
  // 앞치마 색을 착용했으면 그 색으로 구운 세트를, 없으면 기본(갈색) 세트를 쓴다.
  const flipKey = FLIP_KEY[mood];
  const flipFrames = flipKey
    ? (apronColor && FLIP_FRAMES[`${flipKey}__${apronColor}`]) || FLIP_FRAMES[flipKey]
    : undefined;

  // 한 번 재생 — oneShot.token이 바뀌면 그 모션을 0→끝 프레임까지 1회 돌리고 원래 모습으로.
  // 루프 플립북과 별개 상태라, 어떤 포즈(정지 포즈 포함)를 입고 있어도 끼어들 수 있다.
  const shotFrames = oneShot
    ? (apronColor && FLIP_FRAMES[`${oneShot.key}__${apronColor}`]) || FLIP_FRAMES[oneShot.key]
    : undefined;
  // 재생 중인지만 알면 된다 — 몇 번째 프레임인지는 Flipbook 안에서 네이티브 드라이버가 굴린다
  const [shotPlaying, setShotPlaying] = useState(false);
  useEffect(() => {
    if (oneShot && shotFrames) setShotPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneShot?.token]);
  const shotActive = shotPlaying && !!shotFrames;

  useEffect(() => {
    // 'part'는 분리 레이어가, 'flip'은 프레임 교체가 움직임을 담당 — 몸통 루프는 돌리지 않는다
    if (motion === 'none' || motion === 'part' || motion === 'flip') return;
    a.setValue(0); // 다른 동작에서 넘어올 때 이전 자세에서 이어지지 않게
    return startMotion(motion, a);
  }, [a, motion]);

  // 악센트 동작 — 기본 잔동작과 별개의 값으로 돌아 transform이 더해진다
  useEffect(() => {
    if (!accent) return;
    acc.setValue(0);
    const stop = startMotion(accent, acc);
    return () => {
      stop();
      acc.setValue(0); // 얹었던 자세를 남기지 않고 기본 잔동작만 남게 되돌린다
    };
  }, [acc, accent]);

  // 눈 깜빡임 — 몇 초에 한 번 눈 부위 오버레이 opacity를 잠깐 1로 올렸다 내린다.
  useEffect(() => {
    if (!blinkSource) return;
    // 약 1.5초에 한 번 깜빡임 — 대기(1235) + 감기(85) + 멈춤(60) + 뜨기(120) ≈ 1500ms
    return startLoop(() =>
      Animated.sequence([
        Animated.delay(1235),
        Animated.timing(blink, { toValue: 1, duration: 85, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(60),
        Animated.timing(blink, { toValue: 0, duration: 120, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    ).stop;
  }, [blink, blinkSource]);

  // 부위 레이어 움직임 — bob: 두 번 들썩이고 쉼 / tilt: 천천히 갸웃했다가 되돌아옴
  useEffect(() => {
    if (motion !== 'part' || !partCfg) return;
    const step = (to: number, dur: number) =>
      Animated.timing(part, { toValue: to, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    return startLoop(() =>
      partCfg.kind === 'bob'
        ? Animated.sequence([step(1, 340), step(0, 340), step(1, 340), step(0, 340), Animated.delay(1700)])
        : Animated.sequence([step(1, 900), Animated.delay(350), step(0, 900), Animated.delay(1300)]),
    ).stop;
  }, [part, partCfg, motion]);

  // 기본 잔동작 + 악센트를 이어 붙인다. RN은 transform 배열을 순서대로 적용해서
  // 같은 축(translateY 등)이 두 번 나오면 서로 더해진다 — 그래서 그냥 이어 붙이면 된다.
  const transform = [
    ...(motion === 'none' || motion === 'part' || motion === 'flip' ? [] : MOTIONS[motion].tf(a, size)),
    ...(accent ? MOTIONS[accent].tf(acc, size) : []),
  ];

  // 배경 장식 — 캐릭터 '뒤'에 깔린다.
  //
  // zIndex를 명시하는 이유: 배경은 position:absolute고 캐릭터 이미지는 일반 흐름이다.
  // CSS에서는 positioned 요소가 non-positioned 형제보다 위에 그려지기 때문에, DOM 순서를
  // 앞에 두는 것만으로는 웹에서 배경이 캐릭터를 덮어버린다(실제로 그렇게 가려졌다).
  // 캐릭터 쪽도 position:relative로 만들어 zIndex가 실제로 먹히게 한다.
  const decor = (boxSize: number) =>
    accessories.map((acc) => {
      // 프론트가 아직 모르는 슬롯이면 조용히 건너뛴다 — 백엔드가 새 슬롯을 먼저
      // 추가해도(구버전 앱) 화면이 깨지지 않게 한다.
      const layout = SLOT_LAYOUT[acc.slot];
      if (!layout) return null;
      const Art = ACCESSORY_ART[acc.id];
      const px = boxSize * (SLOT_SCALE[acc.slot] ?? 1);
      // 캐릭터 바깥 고리에 그려지므로 가릴 일이 없다 — 흐리면 산 티가 안 나서 진하게 둔다
      return (
        <View key={acc.id} style={[layout(boxSize), { zIndex: 0, opacity: 0.85 }]} pointerEvents="none">
          {/* 아직 그림이 없는 아이템만 이모지로 대체 — 새 아이템을 추가해도 화면이 비지 않는다 */}
          {Art ? <Art size={px} /> : <Text style={{ fontSize: px }}>{acc.emoji}</Text>}
        </View>
      );
    });

  const hasDecor = accessories.length > 0;
  // 효과가 있어도 캐릭터 크기는 그대로 — 파티클은 캐릭터 뒤로 흐르므로 줄일 필요가 없다
  const charSize = size;

  // 눈 깜빡임 오버레이 — 같은 박스에 contain으로 얹혀 눈 위치가 정확히 맞는다.
  // pointerEvents는 Animated.Image가 prop으로 받지 않는다(타입 오류) — 터치를 막는 건
  // 감싼 View의 역할로 두고, 애니메이션 대상은 이미지만 남긴다.
  const blinkLayer = (dim: number) =>
    blinkSource ? (
      <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <Animated.Image
          source={blinkSource}
          resizeMode="contain"
          style={{ width: dim, height: dim, opacity: blink }}
        />
      </View>
    ) : null;

  // 부위 레이어 — base(물건 없는 몸통) 위에 물건 레이어만 transform으로 움직인다.
  const partLayer = (dim: number) => {
    if (!usePart || !partCfg) return null;
    const tf =
      partCfg.kind === 'bob'
        ? [{ translateY: part.interpolate({ inputRange: [0, 1], outputRange: [0, -dim * 0.025] }) }]
        : [{ rotate: part.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-3deg'] }) }];
    return (
      <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <Animated.Image
          source={partCfg.layer}
          resizeMode="contain"
          style={{ width: dim, height: dim, transform: tf }}
        />
      </View>
    );
  };

  // 플립북 — 프레임을 모두 겹쳐 두고 Flipbook이 이웃끼리 크로스페이드로 넘긴다.
  // (source를 주기적으로 갈아끼우면 웹에서 첫 사이클에 로딩 깜빡임이 생긴다)
  const flipLayer = (dim: number) =>
    motion === 'flip' && flipFrames && !shotActive ? (
      <Flipbook frames={flipFrames} size={dim} />
    ) : null;

  // 한 번 재생 레이어 — 재생 중엔 몸통·루프 플립북 대신 이 프레임들이 보인다.
  // key에 token을 물려 같은 동작을 연달아 눌러도 처음부터 다시 돌게 한다.
  const shotLayer = (dim: number) =>
    shotActive && shotFrames && oneShot ? (
      <Flipbook
        key={oneShot.token}
        frames={shotFrames}
        size={dim}
        loop={false}
        onEnd={() => setShotPlaying(false)}
      />
    ) : null;

  // 부위 애니메이션 중엔 몸통을 '물건 빠진 base'로 바꿔야 레이어가 이중으로 안 겹친다.
  // 플립북 재생 중엔 몸통을 숨긴다(첫 프레임이 움직이는 프레임 뒤로 비쳐 보이지 않게).
  const bodySource = usePart && partCfg ? partCfg.base : poseSource;
  // 전신이 통째로 움직이는 중 — 통짜 그림과 정지 포즈 기준 오버레이를 모두 감춰야 한다
  const bodyAnimating = motion === 'flip' || shotActive;

  const img = (
    <Animated.View style={{ width: charSize, height: charSize, transform }}>
      <Image
        source={bodySource}
        resizeMode="contain"
        style={{ width: charSize, height: charSize, opacity: bodyAnimating ? 0 : 1 }}
      />
      {flipLayer(charSize)}
      {shotLayer(charSize)}
      {/* 부위·눈 깜빡임 오버레이는 정지 포즈 좌표 기준이라 전신 모션 중엔 숨긴다.
          한 번 재생(shotActive)뿐 아니라 루프 플립북(motion==='flip')도 마찬가지다 —
          지금은 플립북 포즈에 깜빡임 파일이 없어서 우연히 티가 안 날 뿐, 하나라도
          추가되는 순간 춤추는 브루 위에 정지 포즈 좌표의 눈이 얹힌다. */}
      {!bodyAnimating && partLayer(charSize)}
      {!bodyAnimating && blinkLayer(charSize)}
    </Animated.View>
  );

  // 액세서리가 없으면 래퍼를 만들지 않는다 — 기존 화면들의 레이아웃이 그대로 유지된다.
  const dressed = hasDecor ? (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {decor(size)}
      <View style={{ position: 'relative', zIndex: 1 }}>{img}</View>
    </View>
  ) : (
    img
  );

  // 둥근 크림 카드 (배경색이 이미지와 동일 → 잘린 느낌 없이 하나의 일러스트 카드로)
  if (framed) {
    return (
      <View style={[styles.framed, { width: size, height: size }, style]}>
        {/* [한글 주석] 둥근 모서리에 윗머리가 잘리지 않도록 크기를 90%로 미세 조율하고 contain 모드로 그립니다 */}
        <View style={{ width: size * 0.9, height: size * 0.9, alignItems: 'center', justifyContent: 'center' }}>
          {decor(size * 0.9)}
          <View style={{ position: 'relative', zIndex: 1 }}>
            <Image
              source={poseSource}
              resizeMode="contain"
              style={{ width: charSize * 0.9, height: charSize * 0.9 }}
            />
            {blinkLayer(charSize * 0.9)}
          </View>
        </View>
      </View>
    );
  }

  if (round) {
    return (
      <View style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, style]}>
        {dressed}
      </View>
    );
  }
  return <View style={style}>{dressed}</View>;
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
