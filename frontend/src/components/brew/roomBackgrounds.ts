// 게임 룸(브루의 카페) 배경 사진 등록부.
//
// [사진 추가 방법 — 디자인 담당자용, 저장소 루트 '카페배경_추가_가이드.md'에도 있음]
//  1. 사진 파일을 frontend/assets/game/rooms/<아이템id>.jpg 로 넣는다 (세로 1:2 비율 권장)
//  2. 아래 ROOM_BGS에 한 줄 추가한다:  room_window: require('../../../assets/game/rooms/room_window.jpg'),
//  이게 전부다 — 상점 노출·구매·착용·게임 룸 반영은 자동으로 따라온다.
//
// 동작 원리: 백엔드 상점 카탈로그에는 배경 아이템 8종이 이미 등록돼 있고,
// 프론트는 여기 등록된 id만 상점에 보여준다(사진 없는 아이템은 숨김).
// 착용하면 게임 룸 배경이 그 사진으로 바뀌고, 미등록/해제 상태면 기본 배경을 쓴다.
import type { ImageSourcePropType } from 'react-native';

export const ROOM_BGS: Record<string, ImageSourcePropType> = {
  // room_window: require('../../../assets/game/rooms/room_window.jpg'),
  // room_terrace: require('../../../assets/game/rooms/room_terrace.jpg'),
  // room_night: require('../../../assets/game/rooms/room_night.jpg'),
  // room_blossom: require('../../../assets/game/rooms/room_blossom.jpg'),
  // room_rainy: require('../../../assets/game/rooms/room_rainy.jpg'),
  // room_winter: require('../../../assets/game/rooms/room_winter.jpg'),
  // room_sunset: require('../../../assets/game/rooms/room_sunset.jpg'),
  // room_plant: require('../../../assets/game/rooms/room_plant.jpg'),
};

/** 기본 배경 (아무것도 착용 안 했을 때의 카페 카운터) */
export const ROOM_BG_DEFAULT: ImageSourcePropType = require('../../../assets/game/room_bg.jpg');

/** 착용한 배경 id → 실제 이미지. 미등록 id(사진 아직 없음)면 기본 배경으로 안전하게. */
export const getRoomBg = (roomId?: string): ImageSourcePropType =>
  (roomId && ROOM_BGS[roomId]) || ROOM_BG_DEFAULT;
