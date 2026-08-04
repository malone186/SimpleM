// 브루 배경 효과 — 캐릭터 뒤에 깔리는 장식. 각 효과는 '요소별 애니메이션'을 가진다.
//
//   반짝임   : 별이 제자리에서 깜빡인다(트윙클)
//   커피콩   : 원두가 위 → 아래로 떨어진다(tumble)
//   눈꽃     : 눈이 좌우로 흔들리며 위 → 아래로 내린다
//   컨페티   : 조각이 회전하며 위 → 아래로 떨어진다
//   하트     : 하트가 아래 → 위로 떠오른다
//   거품     : 거품이 아래 → 위로 떠오른다
//
// 착용 아이템은 없다 — 브루는 포즈마다 완성된 PNG 한 장이라 위에 얹으면 스티커가 된다.
// 그래서 겹쳐 그리는 건 캐릭터와 안 겹치는 '배경 효과'만 남겼다(캐릭터 뒤 zIndex 0).
//
// 애니메이션: react-native의 Animated로 파티클(작은 SVG)의 transform/opacity만 움직인다.
// 웹(react-native-web)은 네이티브 드라이버가 없어 useNativeDriver를 끈다(경고 회피).
// 이모지 대신 직접 그리는 이유: OS·브라우저마다 이모지 모양이 달라 브랜드 톤이 깨진다.
import type React from 'react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';

const PALETTE = {
  sparkle: '#F2C14E',
  heart: '#E8879B',
  bean: '#7A5230',
  beanCrease: '#4B301A',
  snow: '#BFD9EE',
  bubble: '#CDE7F0',
  // 컨페티 4색 — 앱 포인트 색과 섞어 알록달록하게
  confetti: ['#F2C14E', '#E8879B', '#8FB89A', '#6FA8D6'],
} as const;

type IconProps = { size: number };

// 웹에는 네이티브 애니메이션 드라이버가 없다 → transform/opacity도 JS로 돌린다(기능은 동일).
const USE_NATIVE = Platform.OS !== 'web';

// ── 파티클 모양(작은 SVG 한 조각). viewBox 20×20 기준으로 그려 px로 스케일된다 ──────
/** 네 갈래로 뾰족한 반짝임 — 원 대신 곡선을 오목하게 넣어 별처럼 보이게 한다 */
const star = (cx: number, cy: number, r: number) =>
  `M${cx} ${cy - r} Q${cx + r * 0.2} ${cy - r * 0.2} ${cx + r} ${cy}` +
  ` Q${cx + r * 0.2} ${cy + r * 0.2} ${cx} ${cy + r}` +
  ` Q${cx - r * 0.2} ${cy + r * 0.2} ${cx - r} ${cy}` +
  ` Q${cx - r * 0.2} ${cy - r * 0.2} ${cx} ${cy - r} Z`;

const heartPath = (cx: number, cy: number, s: number) =>
  `M${cx} ${cy + s * 0.7} C${cx - s * 1.4} ${cy - s * 0.3} ${cx - s * 0.6} ${cy - s * 1.2} ${cx} ${cy - s * 0.4}` +
  ` C${cx + s * 0.6} ${cy - s * 1.2} ${cx + s * 1.4} ${cy - s * 0.3} ${cx} ${cy + s * 0.7} Z`;

const sparkleShape = (px: number) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <Path d={star(10, 10, 9)} fill={PALETTE.sparkle} />
  </Svg>
);
const heartShape = (px: number) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <Path d={heartPath(10, 11, 7)} fill={PALETTE.heart} />
  </Svg>
);
const beanShape = (px: number) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <Ellipse cx={10} cy={10} rx={9} ry={6} fill={PALETTE.bean} />
    <Path d="M4 10 Q10 6.5 16 10" stroke={PALETTE.beanCrease} strokeWidth={1.4} fill="none" />
  </Svg>
);
const snowShape = (px: number) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <G stroke={PALETTE.snow} strokeWidth={2} strokeLinecap="round">
      {[0, 60, 120].map((a) => (
        <Path key={a} transform={`rotate(${a} 10 10)`} d="M10 2 L10 18" />
      ))}
    </G>
  </Svg>
);
const confettiShape = (px: number, color: string) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <Path d="M6 3 h8 v14 h-8 Z" fill={color} />
  </Svg>
);
const bubbleShape = (px: number) => (
  <Svg width={px} height={px} viewBox="0 0 20 20">
    <Circle cx={10} cy={10} r={8} fill={PALETTE.bubble} opacity={0.85} />
    <Circle cx={7} cy={7} r={2.4} fill="#FFFFFF" opacity={0.9} />
  </Svg>
);

// ── 떨어짐/떠오름 파티클 ────────────────────────────────────────────────────
// 각 파티클은 화면 밖 위(또는 아래)에서 시작해 반대편으로 흘러가며 루프한다.
// 좌표·크기·속도는 박스 크기의 '비율'로 잡아 어떤 크기(썸네일 30 ~ 홈 130)에서도 균형이 맞는다.
type Cfg = { x: number; sf: number; delay: number; dur: number; drift: number; i: number };

function makeCfgs(
  count: number,
  sf: [number, number], // 크기(박스 대비 비율)
  dur: [number, number], // 한 바퀴 시간(ms)
  driftMax: number, // 좌우 흔들림 폭(박스 대비 비율)
): Cfg[] {
  return Array.from({ length: count }, (_, i) => ({
    x: 0.08 + Math.random() * 0.84,
    sf: sf[0] + Math.random() * (sf[1] - sf[0]),
    delay: Math.random() * dur[1], // 시작 시점을 흩뜨려 뭉치지 않게
    dur: dur[0] + Math.random() * (dur[1] - dur[0]),
    drift: driftMax ? (Math.random() * 2 - 1) * driftMax : 0,
    i,
  }));
}

function Drift({
  box,
  cfg,
  dir,
  spin,
  children,
}: {
  box: number;
  cfg: Cfg;
  dir: 'down' | 'up';
  spin?: boolean;
  children: (px: number) => ReactNode;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: cfg.dur,
        delay: cfg.delay,
        easing: Easing.linear,
        useNativeDriver: USE_NATIVE,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [t, cfg.dur, cfg.delay]);

  const px = cfg.sf * box;
  const from = dir === 'down' ? -0.18 : 1.18;
  const to = dir === 'down' ? 1.18 : -0.18;
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [from * box, to * box] });
  const translateX = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, cfg.drift * box, 0] });
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const transform = spin
    ? [{ translateY }, { translateX }, { rotate }]
    : [{ translateY }, { translateX }];
  // 양 끝에서 서서히 나타났다 사라져 '끊김' 없이 계속 흐르는 느낌
  const opacity = t.interpolate({ inputRange: [0, 0.12, 0.88, 1], outputRange: [0, 1, 1, 0] });

  return (
    <Animated.View style={{ position: 'absolute', left: cfg.x * box - px / 2, top: 0, opacity, transform }}>
      {children(px)}
    </Animated.View>
  );
}

function DriftField({
  size,
  cfgs,
  dir,
  spin,
  render,
}: {
  size: number;
  cfgs: Cfg[];
  dir: 'down' | 'up';
  spin?: boolean;
  render: (px: number, cfg: Cfg) => ReactNode;
}) {
  return (
    <View style={{ width: size, height: size, overflow: 'hidden' }} pointerEvents="none">
      {cfgs.map((c) => (
        <Drift key={c.i} box={size} cfg={c} dir={dir} spin={spin}>
          {(px) => render(px, c)}
        </Drift>
      ))}
    </View>
  );
}

// ── 제자리 반짝임(트윙클) ───────────────────────────────────────────────────
// 테두리 쪽 좌표 [x, y, 반지름] (100 기준). 가운데는 캐릭터가 가리므로 비운다.
const SPOTS: Array<[number, number, number]> = [
  [13, 16, 5], [87, 20, 4.5], [50, 8, 4], [8, 52, 4],
  [93, 54, 5], [16, 88, 4.5], [84, 90, 5], [50, 94, 3.5],
];

function Twinkle({
  box,
  x,
  y,
  r,
  delay,
  children,
}: {
  box: number;
  x: number;
  y: number;
  r: number;
  delay: number;
  children: (px: number) => ReactNode;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 780, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: USE_NATIVE }),
        Animated.timing(t, { toValue: 0, duration: 780, easing: Easing.inOut(Easing.ease), useNativeDriver: USE_NATIVE }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [t, delay]);

  const px = (r / 100) * box * 2;
  const opacity = t.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.12] });
  return (
    <Animated.View
      style={{ position: 'absolute', left: (x / 100) * box - px / 2, top: (y / 100) * box - px / 2, opacity, transform: [{ scale }] }}
    >
      {children(px)}
    </Animated.View>
  );
}

// ── 효과들 ──────────────────────────────────────────────────────────────────
function BgSparkle({ size }: IconProps) {
  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {SPOTS.map(([x, y, r], i) => (
        <Twinkle key={i} box={size} x={x} y={y} r={r} delay={i * 160}>
          {(px) => sparkleShape(px)}
        </Twinkle>
      ))}
    </View>
  );
}

function BgHeart({ size }: IconProps) {
  const cfgs = useMemo(() => makeCfgs(6, [0.12, 0.2], [2800, 4400], 0.05), []);
  return <DriftField size={size} cfgs={cfgs} dir="up" render={(px) => heartShape(px)} />;
}

function BgBeans({ size }: IconProps) {
  const cfgs = useMemo(() => makeCfgs(7, [0.13, 0.2], [2600, 4200], 0.05), []);
  return <DriftField size={size} cfgs={cfgs} dir="down" spin render={(px) => beanShape(px)} />;
}

function BgSnow({ size }: IconProps) {
  const cfgs = useMemo(() => makeCfgs(8, [0.09, 0.15], [3200, 5200], 0.1), []);
  return <DriftField size={size} cfgs={cfgs} dir="down" render={(px) => snowShape(px)} />;
}

function BgConfetti({ size }: IconProps) {
  const cfgs = useMemo(() => makeCfgs(8, [0.1, 0.16], [2400, 3800], 0.08), []);
  return (
    <DriftField
      size={size}
      cfgs={cfgs}
      dir="down"
      spin
      render={(px, c) => confettiShape(px, PALETTE.confetti[c.i % PALETTE.confetti.length])}
    />
  );
}

function BgBubble({ size }: IconProps) {
  const cfgs = useMemo(() => makeCfgs(7, [0.1, 0.18], [3000, 4600], 0.06), []);
  return <DriftField size={size} cfgs={cfgs} dir="up" render={(px) => bubbleShape(px)} />;
}

/**
 * 아이템 id → 그림. 없는 아이템은 undefined를 돌려주고, 그때는 서버가 준 이모지로
 * 대신 그린다 — 새 아이템을 추가해도 화면이 비지 않는다.
 */
export const ACCESSORY_ART: Record<string, React.ComponentType<IconProps>> = {
  bg_sparkle: BgSparkle,
  bg_heart: BgHeart,
  bg_beans: BgBeans,
  bg_snow: BgSnow,
  bg_confetti: BgConfetti,
  bg_bubble: BgBubble,
};
