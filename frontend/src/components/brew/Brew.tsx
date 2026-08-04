// 브루(BREW) 마스코트 — 표정 = 가게 상태. "브루 등장 지도" 기반.
// 원칙: 감정의 순간엔 브루, 판단(정확한 숫자)의 순간엔 브루를 비운다. 한 화면에 하나.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ACCESSORY_ART } from './accessories';

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
} as const;

export type BrewMood = keyof typeof POSES;

// ── 배경 효과 ──────────────────────────────────────────────────────────────
// 상점에서 산 배경 장식을 브루 뒤에 깔아준다.
//
// 캐릭터 '위에' 얹는 착용 아이템은 없다. 브루는 포즈마다 완성된 PNG 한 장이고 그림
// 안에 이미 캡·앞치마를 착용하고 컵까지 들고 있어서, 모자를 또 얹으면 스티커를
// 덧붙이는 꼴이 된다. 게다가 포즈마다 머리 위치가 달라 좌표를 맞출 수도 없다.
// 그래서 상점은 '포즈 교체'(mood)로 가고, 겹쳐 그리는 건 배경만 남겼다.
export type BrewAccessory = { id: string; slot: 'background'; emoji: string };

// 배경 장식과 캐릭터의 크기 관계.
//
// 둘을 같은 크기로 그리면 장식이 전부 캐릭터 뒤에 숨어서 산 사람 입장에선 아무것도
// 안 보인다(실제로 하트 하나만 옆으로 삐져나왔다).
//
// 장식을 박스 밖으로 키우는 방법도 있지만, 상점 카드나 원형 프레임처럼 overflow를
// 자르는 부모 안에서는 그대로 잘려나간다. 그래서 반대로 캐릭터를 조금 줄여 박스 안에
// 테두리 공간을 만든다 — 전체 차지 면적이 그대로라 레이아웃도 안 흔들린다.
const CHAR_SHRINK_WITH_BG = 0.76;

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
  background: 1, // 박스를 가득 채운다 (캐릭터가 그보다 작아져서 고리가 드러난다)
};

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
  top: 'bounce',
  greet: 'wave',
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
}: {
  mood?: BrewMood;
  size?: number;
  round?: boolean; // 크림 원형 프레임 안에 넣기 (흰 카드 위 등)
  framed?: boolean; // 둥근 크림 카드로 감싸기 (드립/턱괸 등 장면 포즈용)
  style?: StyleProp<ViewStyle>;
  disableMotion?: boolean;
  accessories?: BrewAccessory[]; // 상점에서 산 꾸미기 아이템 (착용 중인 것만)
}) {
  const a = useRef(new Animated.Value(0)).current;
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
      const Art = ACCESSORY_ART[acc.id];
      const px = boxSize * SLOT_SCALE[acc.slot];
      // 캐릭터 바깥 고리에 그려지므로 가릴 일이 없다 — 흐리면 산 티가 안 나서 진하게 둔다
      return (
        <View key={acc.id} style={[SLOT_LAYOUT[acc.slot](boxSize), { zIndex: 0, opacity: 0.85 }]} pointerEvents="none">
          {/* 아직 그림이 없는 아이템만 이모지로 대체 — 새 아이템을 추가해도 화면이 비지 않는다 */}
          {Art ? <Art size={px} /> : <Text style={{ fontSize: px }}>{acc.emoji}</Text>}
        </View>
      );
    });

  const hasDecor = accessories.length > 0;
  // 배경을 산 경우에만 캐릭터를 줄여 테두리 공간을 낸다
  const charSize = hasDecor ? size * CHAR_SHRINK_WITH_BG : size;

  const img = (
    <Animated.Image
      source={POSES[mood]}
      resizeMode="contain"
      style={{ width: charSize, height: charSize, transform }}
    />
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
              source={POSES[mood]}
              resizeMode="contain"
              style={{ width: charSize * 0.9, height: charSize * 0.9 }}
            />
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
