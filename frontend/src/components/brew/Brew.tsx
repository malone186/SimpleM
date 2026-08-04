// 브루(BREW) 마스코트 — 표정 = 가게 상태. "브루 등장 지도" 기반.
// 원칙: 감정의 순간엔 브루, 판단(정확한 숫자)의 순간엔 브루를 비운다. 한 화면에 하나.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ACCESSORY_ART } from './accessories';
import { APRON_VARIANTS, type ApronColor } from './apronVariants';
import { BLINK_OVERLAY } from './blinkOverlays';

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
  // 새 일러스트(윙크+하트) — 발이 분리돼 있어 '진짜 손 흔들기'가 된다 (아래 PAW_FRAMES)
  hello: require('../../../assets/mascot/wave2/base.png'),
  coffee: require('../../../assets/mascot/brew_coffee.png'), // 커피잔 든 브루 (현재 미사용)
} as const;

export type BrewMood = keyof typeof POSES;

// ── 발 흔들기 플립북 ────────────────────────────────────────────────────────
// hello 포즈는 본체(base, 발 없음) + 발 프레임 3장(내림/중간/올림)으로 쪼개져 있다.
// 발 프레임만 번갈아 보여주면 팔이 실제로 흔들리는 애니메이션이 된다 — 눈 깜빡임
// 오버레이와 같은 원리의 '부위 애니메이션'. (원본 AI 일러스트에서 발을 분리·회전 제작)
const PAW_FRAMES: Partial<Record<BrewMood, [any, any, any]>> = {
  hello: [
    require('../../../assets/mascot/wave2/paw_down.png'),
    require('../../../assets/mascot/wave2/paw_mid.png'),
    require('../../../assets/mascot/wave2/paw_up.png'),
  ],
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

// idle 움직임 종류
type Motion = 'bounce' | 'wave' | 'pour' | 'paw' | 'none';

const MOTION_BY_MOOD: Record<BrewMood, Motion> = {
  welcome: 'wave',
  happy: 'bounce',
  resting: 'none',
  pouring: 'pour',
  clipboard: 'bounce',
  serving: 'bounce',
  hero: 'bounce',
  top: 'bounce',
  greet: 'wave',
  hello: 'paw', // 몸은 고정, 분리된 발 프레임이 흔들린다
  coffee: 'bounce',
};

export default function Brew({
  mood = 'welcome',
  size = 84,
  round = false,
  framed = false,
  style,
  disableMotion = false, // [한글 주석: 말풍선 등과 애니메이션을 통합하기 위해 자체 모션을 끌 수 있는 제어 장치 추가]
  accessories = [],
  apronColor,
}: {
  mood?: BrewMood;
  size?: number;
  round?: boolean; // 크림 원형 프레임 안에 넣기 (흰 카드 위 등)
  framed?: boolean; // 둥근 크림 카드로 감싸기 (드립/턱괸 등 장면 포즈용)
  style?: StyleProp<ViewStyle>;
  disableMotion?: boolean;
  accessories?: BrewAccessory[]; // 상점에서 산 꾸미기 아이템 (착용 중인 것만)
  apronColor?: string; // 상점에서 산 앞치마 색 (navy·forest 등). 없으면 기본 갈색.
}) {
  const a = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(0)).current;
  const paw = useRef(new Animated.Value(1)).current; // 0=내림 1=중간 2=올림
  // 앞치마 색을 착용했으면 그 색으로 리컬러한 변형 이미지를 쓴다(원본 포즈를 대체).
  // 변형이 없으면(색 미착용·해당 포즈 변형 부재) 원본 갈색 포즈로 안전하게 폴백.
  const poseSource = (apronColor && APRON_VARIANTS[mood]?.[apronColor as ApronColor]) || POSES[mood];
  // 눈 뜬 포즈만 눈 깜빡임 오버레이가 있다. 있으면 눈 부위만 잠깐 감았다 뜬다.
  // (앞치마 색 변형 위에도 그대로 얹힌다 — 눈은 상단, 앞치마는 하단이라 안 겹친다)
  // 깜빡임은 흔들림(sway)과 별개다 — disableMotion(홈 마스코트·썸네일)이어도 눈은 깜빡인다.
  const blinkSource = BLINK_OVERLAY[mood];
  // [한글 주석: disableMotion이 켜지면 강아지 고유의 흔들림 모션을 'none'(정지) 상태로 바꿉니다]
  const motion = disableMotion ? 'none' : MOTION_BY_MOOD[mood];

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

  // 눈 깜빡임 — 몇 초에 한 번 눈 부위 오버레이 opacity를 잠깐 1로 올렸다 내린다.
  useEffect(() => {
    if (!blinkSource) return;
    // 약 1.5초에 한 번 깜빡임 — 대기(1235) + 감기(85) + 멈춤(60) + 뜨기(120) ≈ 1500ms
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(1235),
        Animated.timing(blink, { toValue: 1, duration: 85, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(60),
        Animated.timing(blink, { toValue: 0, duration: 120, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink, blinkSource]);

  // 발 흔들기 — 중간→올림→중간→내림을 두 번 파닥이고 잠시 쉼 (실제 인사 느낌)
  const pawFrames = PAW_FRAMES[mood];
  useEffect(() => {
    if (!pawFrames || motion !== 'paw') return;
    const step = (to: number) =>
      Animated.timing(paw, { toValue: to, duration: 120, easing: Easing.linear, useNativeDriver: true });
    const loop = Animated.loop(
      Animated.sequence([
        step(2), step(1), step(0), step(1), step(2), step(1),
        Animated.delay(1500),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [paw, pawFrames, motion]);

  const transform =
    motion === 'wave'
      ? [{ rotate: a.interpolate({ inputRange: [-1, 1], outputRange: ['-5deg', '5deg'] }) }]
      : motion === 'bounce'
        ? [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) }]
        : motion === 'pour'
          ? [{ rotate: a.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '3deg'] }) }]
          : [];

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

  // 발 프레임 오버레이 — 세 장을 겹쳐 두고 opacity로 한 장만 보이게 (플립북).
  // 모션이 꺼져 있으면 중간 프레임 한 장만 정지 상태로 그린다 (base엔 발이 없으므로 필수).
  const pawLayer = (dim: number) => {
    if (!pawFrames) return null;
    if (disableMotion || motion !== 'paw') {
      return (
        <Image
          source={pawFrames[1]}
          resizeMode="contain"
          style={{ position: 'absolute', top: 0, left: 0, width: dim, height: dim }}
        />
      );
    }
    return pawFrames.map((src, i) => (
      <Animated.Image
        key={i}
        source={src}
        resizeMode="contain"
        style={{
          position: 'absolute', top: 0, left: 0, width: dim, height: dim,
          opacity: paw.interpolate({
            inputRange: [i - 0.5, i - 0.49, i + 0.49, i + 0.5],
            outputRange: [0, 1, 1, 0],
            extrapolate: 'clamp',
          }),
        }}
      />
    ));
  };

  const img = (
    <Animated.View style={{ width: charSize, height: charSize, transform }}>
      <Image source={poseSource} resizeMode="contain" style={{ width: charSize, height: charSize }} />
      {pawLayer(charSize)}
      {blinkLayer(charSize)}
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
