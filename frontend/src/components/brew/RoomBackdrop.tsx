// 홈·재고·챗봇·관리 탭 상단 배경 — 착용한 카페 배경 '사진'을 그대로 깐다.
//
// 브루룸(BrewRoomScreen)과 같은 사진을 쓴다. 예전에는 사진에서 뽑은 분위기 '색'만
// 입혔는데(getRoomTint), 브루룸과 홈이 달라 보인다는 얘기가 나와 사진으로 맞췄다.
//
// [사진이 사진으로 보이게] 처음엔 사진 위에 검정 72% 막을 씌우고 화면 높이의 30%에서
// 크림으로 지웠다. 그러면 어느 배경을 착용해도 "갈색 아지랑이"로만 보여서 바꾼 티가
// 나지 않았다. 그래서 막을 크게 걷어냈다 (0.72 → 0.5/0.2). 대신 흰 글자가 얹히는
// 맨 위만 조금 더 진하게 두고, 글자 쪽에는 그림자를 준다(ROOM_TEXT_SHADOW).
//
// [어디까지 보일지] 사진을 크림 시트 코앞까지 꽉 채웠더니 이번엔 "화면 전체가 사진"으로
// 보였다. 그래서 시트에 닿기 전에 끝낸다 — 말풍선·마스코트 윗몸까지는 사진이 또렷하고,
// 그 아래 70~140px 구간에서 크림으로 녹아든 뒤 카드 시트가 시작한다.
// 기준선은 화면 비율이 아니라 '크림 시트가 시작하는 실제 y'다(useSheetTop).
//
// 네 탭(홈·재고·챗봇·관리)이 useSheetTop()으로 각자 시트 위치를 재서 넘기므로,
// 헤더 높이가 달라도 보이는 결과는 같다 — "헤더에 깔린 사진 → 크림으로 소멸 → 카드 시트".
//
// 아무것도 착용하지 않았으면 사진을 깔지 않는다 — 종전 오로라 배경이 그대로 보이도록
// null을 돌려주고, 화면은 자기 오로라를 계속 그린다.
import { useCallback, useState } from 'react';
import type { LayoutChangeEvent, TextStyle } from 'react-native';
import { ImageBackground, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { colors } from '../../theme';
import { ROOM_BGS } from './roomBackgrounds';

/** 시트 위치를 아직 못 쟀을 때(첫 프레임) fadeAt 비율에서 빼는 여유분(px) */
const PEEK = 44;

/**
 * 사진 위에 얹히는 흰 글자용 그림자.
 * 막을 걷어낸 만큼(0.72 → 0.5/0.2) 밝은 사진에서 제목이 흐려질 수 있어, 글자 쪽에만
 * 그림자를 준다 — 막을 다시 진하게 만들면 사진이 또 안 보이기 때문이다.
 * 배경 미착용(오로라)일 때도 어두운 바탕이라 그림자는 티가 나지 않는다.
 */
export const ROOM_TEXT_SHADOW: TextStyle = {
  textShadowColor: 'rgba(18,13,10,0.55)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 6,
};

type Props = {
  /** 착용한 배경 아이템 id (EquippedContext의 roomBgId) */
  roomBgId?: string;
  /**
   * 크림 시트(불투명 바디)가 시작하는 y 좌표(px). useSheetTop()으로 실측해 넘긴다.
   * 넘어오기 전(첫 프레임)에는 fadeAt 비율을 쓴다.
   */
  sheetTop?: number;
  /** 실측 전 대비용 — 사진이 끝나는 지점 (0~1, 화면 높이 기준) */
  fadeAt?: number;
};

/**
 * 크림 시트의 화면상 y를 재는 훅 — 네 탭이 똑같이 쓴다.
 * 시트 View에 onLayout={onSheetLayout} 만 달면 된다.
 */
export function useSheetTop() {
  const [sheetTop, setSheetTop] = useState<number | undefined>(undefined);
  const onSheetLayout = useCallback((e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    // 1px 미만 흔들림으로 매 프레임 리렌더되지 않게
    setSheetTop((prev) => (prev != null && Math.abs(prev - y) < 1 ? prev : y));
  }, []);
  return { sheetTop, onSheetLayout };
}

export default function RoomBackdrop({ roomBgId, sheetTop, fadeAt = 0.42 }: Props) {
  const { height } = useWindowDimensions();
  const source = roomBgId ? ROOM_BGS[roomBgId] : undefined;
  if (!source) return null; // 미착용·사진 미등록 → 화면이 그리던 오로라를 그대로 둔다

  const H = height || 800;
  // 사진이 다 지워지는 자리 = 크림 시트 상단(실측) / 없으면 비율 대비값
  const cut = sheetTop != null && sheetTop > 80 ? sheetTop : Math.max(120, fadeAt * H - PEEK);
  // 녹아드는 구간 — 64~140px. 헤더가 짧은 탭(관리·챗봇)에서 이 값이 크면
  // 마스코트가 통째로 크림에 잠겨 "배경을 착용한 티"가 다시 사라진다.
  const span = Math.min(140, Math.max(64, cut * 0.32));
  const fadeStart = cut - span;

  // 위 → 아래 순서가 뒤집히지 않게 정리하며 %로 바꾼다
  let last = 0;
  const y = (px: number) => {
    const pct = Math.min(100, Math.max(last, (px / H) * 100));
    last = pct;
    return `${pct}%`;
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <ImageBackground source={source} style={StyleSheet.absoluteFill} resizeMode="cover" />
      {/* 어두운 막 + 크림 페이드를 한 번에 — 레이어를 나누면 경계에 띠가 생긴다 */}
      <Svg width="100%" height="100%" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="roomScrim" x1="0%" y1="0%" x2="0%" y2="100%">
            {/* 맨 위 130px: 상태바 아이콘·흰 제목이 얹히는 자리라 조금 진하게.
                이 구간만 px로 고정한다 — 탭마다 헤더 높이가 달라도 아이콘 대비는 같아야 한다 */}
            <Stop offset="0%" stopColor="#120D0A" stopOpacity="0.5" />
            <Stop offset={y(Math.min(130, fadeStart * 0.5))} stopColor="#120D0A" stopOpacity="0.3" />
            {/* 말풍선·마스코트 윗몸이 있는 구간 — 사진을 최대한 살린다 */}
            <Stop offset={y(fadeStart)} stopColor="#120D0A" stopOpacity="0.2" />
            {/* 여기부터 크림으로 녹아든다. 카드 시트에 닿기 전에 끝내야
                "화면 전체가 사진"이 아니라 "헤더에 깔린 사진"으로 보인다 */}
            <Stop offset={y(fadeStart + span * 0.45)} stopColor={colors.creamSand} stopOpacity="0.42" />
            <Stop offset={y(fadeStart + span * 0.8)} stopColor={colors.creamSand} stopOpacity="0.8" />
            <Stop offset={y(cut + 10)} stopColor={colors.creamSand} stopOpacity="1" />
            <Stop offset="100%" stopColor={colors.creamSand} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#roomScrim)" />
      </Svg>
      {/*
        ScrollView 내용이 짧거나 끝까지 내려갔을 때 시트 바깥의 투명한 하단 패딩이
        드러날 수 있다. SVG 페이드에만 의존하면 웹에서 그 자리에 배경 사진이 다시
        비치므로, 사진이 완전히 사라지는 지점 아래는 불투명 크림색으로 고정한다.
      */}
      <View style={[styles.creamTail, { top: cut + 10 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  creamTail: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.creamSand,
  },
});
