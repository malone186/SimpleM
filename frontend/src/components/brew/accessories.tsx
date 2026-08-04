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
import Svg, { G, Path } from 'react-native-svg';

const PALETTE = {
  sparkle: '#F2C14E',
  heart: '#E8879B',
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

/**
 * 아이템 id → 그림. 없는 아이템은 undefined를 돌려주고, 그때는 서버가 준 이모지로
 * 대신 그린다 — 새 아이템을 추가해도 화면이 비지 않는다.
 */
export const ACCESSORY_ART: Record<string, React.ComponentType<IconProps>> = {
  bg_sparkle: BgSparkle,
  bg_heart: BgHeart,
};
