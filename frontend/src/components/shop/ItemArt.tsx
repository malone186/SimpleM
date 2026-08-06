// 꾸미기 아이템 썸네일 — 사기 전 미리보기와 산 뒤 모습이 정확히 같아야 한다.
// 상점 목록과 보관함이 같은 그림을 써야 해서 화면 바깥으로 빼 두었다.
import { Image as RNImage, Text } from 'react-native';

import Brew, { type BrewMood } from '../brew/Brew';
import { ACCESSORY_ART } from '../brew/accessories';
import { ROOM_BGS } from '../brew/roomBackgrounds';
import type { ShopItem } from '../../lib/api/rewards';

export default function ItemArt({
  item,
  apronColor,
  size = 42,
}: {
  item: ShopItem;
  /** 지금 착용 중인 앞치마 색 — 포즈 썸네일에도 입혀서 실제 모습 그대로 보여준다 */
  apronColor?: string;
  size?: number;
}) {
  if (item.slot === 'pose' && item.mood) {
    return <Brew mood={item.mood as BrewMood} apronColor={apronColor} size={size} disableMotion />;
  }
  // 앞치마 색: 기본 포즈에 그 색을 입힌 미니 브루로 미리보기 (실제 착용 모습 그대로)
  if (item.slot === 'apron' && item.color) {
    return <Brew mood="top" apronColor={item.color} size={size} disableMotion />;
  }
  // 카페 배경: 실제 배경 사진을 작게 (등록된 것만 목록에 오므로 항상 존재)
  if (item.slot === 'room' && ROOM_BGS[item.id]) {
    return (
      <RNImage
        source={ROOM_BGS[item.id]}
        style={{ width: size, height: size, borderRadius: size * 0.19 }}
        resizeMode="cover"
      />
    );
  }
  const Art = ACCESSORY_ART[item.id];
  return Art ? <Art size={size * 0.71} /> : <Text style={{ fontSize: size * 0.57 }}>{item.emoji}</Text>;
}
