// 홈·재고·챗봇·관리 탭 상단 배경 — 착용한 카페 배경 '사진'을 그대로 깐다.
//
// 브루룸(BrewRoomScreen)과 같은 사진을 쓴다. 예전에는 사진에서 뽑은 분위기 '색'만
// 입혔는데(getRoomTint), 브루룸과 홈이 달라 보인다는 얘기가 나와 사진으로 맞췄다.
//
// [글자가 묻히지 않게] 사진을 그냥 깔면 상단의 흰 아이콘·말풍선과 바로 아래 흰 카드가
// 밝은 사진에 묻힌다 — 색만 쓰던 이유가 그거였다. 그래서 사진 위에 어두운 막을 한 겹
// 씌우고, 아래로 내려가며 크림색으로 녹아들게 한다. 브루룸도 사진 위에 블러를 깔아
// 같은 문제를 푸니, 보이는 결은 그대로 두고 가독성만 지키는 방식이다.
//
// 아무것도 착용하지 않았으면 사진을 깔지 않는다 — 종전 오로라 배경이 그대로 보이도록
// null을 돌려주고, 화면은 자기 오로라를 계속 그린다.
import { ImageBackground, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { colors } from '../../theme';
import { ROOM_BGS } from './roomBackgrounds';

type Props = {
  /** 착용한 배경 아이템 id (EquippedContext의 roomBgId) */
  roomBgId?: string;
  /**
   * 사진이 크림색으로 완전히 녹아드는 지점 (0~1, 화면 높이 기준).
   * 홈은 웰컴 영역이 길어 넉넉히, 나머지 탭은 헤더만 덮으면 되므로 짧게 쓴다.
   */
  fadeAt?: number;
};

export default function RoomBackdrop({ roomBgId, fadeAt = 0.34 }: Props) {
  const source = roomBgId ? ROOM_BGS[roomBgId] : undefined;
  if (!source) return null; // 미착용·사진 미등록 → 화면이 그리던 오로라를 그대로 둔다

  const fade = Math.min(0.95, Math.max(0.12, fadeAt));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <ImageBackground source={source} style={StyleSheet.absoluteFill} resizeMode="cover" />
      {/* 어두운 막 + 크림 페이드를 한 번에 — 레이어를 나누면 경계에 띠가 생긴다 */}
      <Svg width="100%" height="100%" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="roomScrim" x1="0%" y1="0%" x2="0%" y2="100%">
            {/* 상단: 흰 아이콘·말풍선이 얹히는 자리라 가장 어둡게 */}
            <Stop offset="0%" stopColor="#140F0C" stopOpacity="0.72" />
            <Stop offset={`${fade * 45}%`} stopColor="#140F0C" stopOpacity="0.45" />
            {/* 사진이 끝나고 흰 카드가 시작되는 구간 — 크림으로 완전히 덮는다 */}
            <Stop offset={`${fade * 88}%`} stopColor={colors.creamSand} stopOpacity="0.86" />
            <Stop offset={`${fade * 100}%`} stopColor={colors.creamSand} stopOpacity="1" />
            <Stop offset="100%" stopColor={colors.creamSand} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#roomScrim)" />
      </Svg>
    </View>
  );
}
