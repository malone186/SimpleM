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
  room_window: require('../../../assets/game/rooms/room_window.jpg'),
  room_terrace: require('../../../assets/game/rooms/room_terrace.jpg'),
  room_night: require('../../../assets/game/rooms/room_night.jpg'),
  room_blossom: require('../../../assets/game/rooms/room_blossom.jpg'),
  room_rainy: require('../../../assets/game/rooms/room_rainy.jpg'),
  room_winter: require('../../../assets/game/rooms/room_winter.jpg'),
  room_sunset: require('../../../assets/game/rooms/room_sunset.jpg'),
  room_plant: require('../../../assets/game/rooms/room_plant.jpg'),
};

/** 기본 배경 (아무것도 착용 안 했을 때의 카페 카운터) */
export const ROOM_BG_DEFAULT: ImageSourcePropType = require('../../../assets/game/room_bg.jpg');

/**
 * 홈 화면 배경 물들이기 — 착용한 카페 배경의 '분위기 색'만 홈으로 가져온다.
 *
 * 홈에 사진을 그대로 깔지 않는 이유: 홈 상단에는 흰 아이콘·말풍선이 얹히고 바로 아래
 * 흰 카드가 붙어서, 밝은 사진이 깔리면 글자가 묻힌다. 게다가 사진 8장이 죄다 따뜻한
 * 갈색 계열이라 그대로 쓰면 어느 걸 착용해도 홈이 비슷해 보인다.
 * 그래서 각 사진에서 '그 배경다운 색'(벚꽃의 분홍, 밤/겨울의 파랑, 노을의 주황 …)만
 * 뽑아 상단 그라데이션과 글로우에 입힌다 — 가독성은 그대로, 바꾼 티는 확실하게.
 *
 * top: 상단 딥 그라데이션 2단(어둡게 유지 — 흰 아이콘 대비 확보) / glow: 번지는 원 3개
 */
export type RoomTint = { top: [string, string]; glow: [string, string, string] };

/** 아무것도 착용 안 했을 때의 홈 색 — 원래 오로라 배경 그대로 */
export const ROOM_TINT_DEFAULT: RoomTint = {
  top: ['#1E1612', '#251C17'],
  glow: ['#E28257', '#C29D7A', '#88BCB5'],
};

export const ROOM_TINTS: Record<string, RoomTint> = {
  room_window: { top: ['#1D1C11', '#2A291B'], glow: ['#CCC452', '#ADA968', '#9E9B6F'] },
  room_terrace: { top: ['#1D1C11', '#2A281B'], glow: ['#CCBC52', '#ADA468', '#9E986F'] },
  room_night: { top: ['#11171D', '#1B232A'], glow: ['#528FCC', '#688BAD', '#6F869E'] },
  room_blossom: { top: ['#1D1311', '#2A1D1B'], glow: ['#CC6452', '#AD7268', '#9E766F'] },
  room_rainy: { top: ['#11191D', '#1B242A'], glow: ['#529FCC', '#6894AD', '#6F8D9E'] },
  room_winter: { top: ['#111B1D', '#1B272A'], glow: ['#52B2CC', '#689EAD', '#6F949E'] },
  room_sunset: { top: ['#1D1711', '#2A221B'], glow: ['#CC8D52', '#AD8A68', '#9E866F'] },
  room_plant: { top: ['#1D1D11', '#2A291B'], glow: ['#CCC752', '#ADAB68', '#9E9C6F'] },
};

/** 착용한 배경 id → 홈 분위기 색. 미착용/미등록이면 원래 색. */
export const getRoomTint = (roomId?: string): RoomTint =>
  (roomId && ROOM_TINTS[roomId]) || ROOM_TINT_DEFAULT;

/** 착용한 배경 id → 실제 이미지. 미등록 id(사진 아직 없음)면 기본 배경으로 안전하게. */
export const getRoomBg = (roomId?: string): ImageSourcePropType =>
  (roomId && ROOM_BGS[roomId]) || ROOM_BG_DEFAULT;
