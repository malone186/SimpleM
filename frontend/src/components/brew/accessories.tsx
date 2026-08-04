// 브루 배경 효과 — 캐릭터 뒤에 깔리는 장식.
//
// 원래는 모자·옷 같은 착용 아이템도 여기 있었는데 전부 걷어냈다. 브루는 포즈마다
// 완성된 PNG 한 장이고 그림 안에 이미 캡·앞치마를 착용하고 있어서, 그 위에 무언가를
// 얹으면 꾸미기가 아니라 스티커를 덧붙이는 꼴이 됐다. 상점은 '포즈 교체'로 바뀌었고
// 여기 남은 건 캐릭터와 겹치지 않는 배경 효과뿐이다.
//
// 이모지 대신 직접 그리는 이유: 이모지는 OS·브라우저마다 모양이 완전히 달라
// 브랜드 톤이 통제되지 않고, 키우면 '붙여놓은 글자'처럼 보인다.
//
// 모든 도형은 100×100 viewBox 기준 — Brew가 크기만 정하면 된다.
import type React from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

const PALETTE = {
  sparkle: '#F2C14E',
  heart: '#E8879B',
  bean: '#7A5230',
  beanCrease: '#4B301A',
  snow: '#BFD9EE',
  bubble: '#CDE7F0',
  // 컨페티 4색 — 앱 포인트 색과 섞어 알록달록하게
  confetti: ['#F2C14E', '#E8879B', '#8FB89A', '#6FA8D6'],
  frameWood: '#B07A46',
  frameWoodEdge: '#8A5C33',
  frameDot: '#E0A15E',
  neon: '#6FE0C8',
} as const;

type IconProps = { size: number };

const box = (size: number) => ({ width: size, height: size, viewBox: '0 0 100 100' });

/** 네 갈래로 뾰족한 반짝임 — 원 대신 곡선을 오목하게 넣어 별처럼 보이게 한다 */
const star = (cx: number, cy: number, r: number) =>
  `M${cx} ${cy - r} Q${cx + r * 0.2} ${cy - r * 0.2} ${cx + r} ${cy}` +
  ` Q${cx + r * 0.2} ${cy + r * 0.2} ${cx} ${cy + r}` +
  ` Q${cx - r * 0.2} ${cy + r * 0.2} ${cx - r} ${cy}` +
  ` Q${cx - r * 0.2} ${cy - r * 0.2} ${cx} ${cy - r} Z`;

const heart = (cx: number, cy: number, s: number) =>
  `M${cx} ${cy + s * 0.7} C${cx - s * 1.4} ${cy - s * 0.3} ${cx - s * 0.6} ${cy - s * 1.2} ${cx} ${cy - s * 0.4}` +
  ` C${cx + s * 0.6} ${cy - s * 1.2} ${cx + s * 1.4} ${cy - s * 0.3} ${cx} ${cy + s * 0.7} Z`;

// 좌표는 바깥 테두리 쪽에 몰아둔다 — 가운데는 캐릭터가 차지하므로 거기 그리면 안 보인다.
function BgSparkle({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      <G fill={PALETTE.sparkle}>
        <Path d={star(12, 16, 11)} />
        <Path d={star(88, 20, 9)} />
        <Path d={star(50, 7, 8)} />
        <Path d={star(7, 52, 8)} />
        <Path d={star(93, 56, 10)} />
        <Path d={star(16, 88, 9)} />
        <Path d={star(84, 90, 11)} />
        <Path d={star(50, 95, 7)} />
      </G>
    </Svg>
  );
}

function BgHeart({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      <G fill={PALETTE.heart}>
        <Path d={heart(13, 18, 11)} />
        <Path d={heart(87, 22, 9)} />
        <Path d={heart(6, 54, 8)} />
        <Path d={heart(94, 58, 10)} />
        <Path d={heart(18, 88, 9)} />
        <Path d={heart(82, 90, 11)} />
        <Path d={heart(50, 94, 8)} />
      </G>
    </Svg>
  );
}

// 테두리 쪽 배치 좌표 — [cx, cy, 회전각(선택)]. 가운데는 캐릭터가 가리므로 비운다.
const RING: Array<[number, number, number]> = [
  [13, 16, 18], [87, 20, -25], [50, 8, 10], [8, 52, -15],
  [93, 54, 30], [16, 88, 20], [84, 90, -20], [50, 94, 0],
];

/** 볶은 커피콩 — 기운 타원 + 가운데 크레이즈 한 줄 */
function BgBeans({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      {RING.map(([cx, cy, rot], i) => (
        <G key={i} transform={`rotate(${rot} ${cx} ${cy})`}>
          <Ellipse cx={cx} cy={cy} rx={7} ry={4.6} fill={PALETTE.bean} />
          <Path
            d={`M${cx - 5} ${cy} Q${cx} ${cy - 2.4} ${cx + 5} ${cy}`}
            stroke={PALETTE.beanCrease}
            strokeWidth={1.1}
            fill="none"
          />
        </G>
      ))}
    </Svg>
  );
}

/** 눈꽃 — 60°씩 돌린 세 줄로 여섯 갈래 */
function BgSnow({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      <G stroke={PALETTE.snow} strokeWidth={1.6} strokeLinecap="round">
        {RING.map(([cx, cy], i) => {
          const r = 6 + (i % 3);
          return [0, 60, 120].map((a, j) => (
            <Path key={`${i}-${j}`} transform={`rotate(${a} ${cx} ${cy})`} d={`M${cx} ${cy - r} L${cx} ${cy + r}`} />
          ));
        })}
      </G>
    </Svg>
  );
}

/** 컨페티 — 살짝 기운 작은 사각 조각들, 4색 순환 */
function BgConfetti({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      {RING.map(([cx, cy, rot], i) => (
        <G key={i} transform={`rotate(${rot + i * 15} ${cx} ${cy})`} fill={PALETTE.confetti[i % PALETTE.confetti.length]}>
          <Path d={`M${cx - 4} ${cy - 2.6} h8 v5.2 h-8 Z`} />
        </G>
      ))}
    </Svg>
  );
}

/** 거품 — 반투명 원 + 하이라이트 점 */
function BgBubble({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      {RING.map(([cx, cy], i) => {
        const r = 6 + (i % 3);
        return (
          <G key={i}>
            <Circle cx={cx} cy={cy} r={r} fill={PALETTE.bubble} opacity={0.85} />
            <Circle cx={cx - r * 0.3} cy={cy - r * 0.3} r={r * 0.3} fill="#FFFFFF" opacity={0.9} />
          </G>
        );
      })}
    </Svg>
  );
}

// ── 프레임(테두리) — 박스 가장자리를 둘러 캐릭터를 감싼다 ──────────────────────
/** 우드 액자 — 둥근 사각 테두리(원목색 + 진한 안쪽 선) */
function FrameWood({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      <Rect x={4} y={4} width={92} height={92} rx={16} fill="none" stroke={PALETTE.frameWood} strokeWidth={5} />
      <Rect x={4} y={4} width={92} height={92} rx={16} fill="none" stroke={PALETTE.frameWoodEdge} strokeWidth={1.4} />
    </Svg>
  );
}

/** 도트 프레임 — 둘레를 따라 점을 균등 배치 */
function FrameDots({ size }: IconProps) {
  const n = 16;
  const R = 46;
  const dots = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [50 + R * Math.cos(a), 50 + R * Math.sin(a)] as const;
  });
  return (
    <Svg {...box(size)}>
      <G fill={PALETTE.frameDot}>
        {dots.map(([x, y], i) => (
          <Circle key={i} cx={x} cy={y} r={3} />
        ))}
      </G>
    </Svg>
  );
}

/** 네온 링 — 은은한 글로우(옅은 넓은 링 + 또렷한 얇은 링) */
function FrameNeon({ size }: IconProps) {
  return (
    <Svg {...box(size)}>
      <Circle cx={50} cy={50} r={46} fill="none" stroke={PALETTE.neon} strokeWidth={4} opacity={0.35} />
      <Circle cx={50} cy={50} r={46} fill="none" stroke={PALETTE.neon} strokeWidth={2} />
    </Svg>
  );
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
  frame_wood: FrameWood,
  frame_dots: FrameDots,
  frame_neon: FrameNeon,
};
