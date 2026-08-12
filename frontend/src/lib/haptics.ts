// 촉감 어휘 — 앱 전체가 같은 의미의 진동을 쓰게 하는 공용 모듈 (iOS HIG의 햅틱 문법).
//
//   tick    선택이 바뀌는 미세한 틱 — 탭 전환, 칩 선택
//   tap     가벼운 확인 톡 — 체크, 토글
//   thud    묵직한 톡 — 롱프레스 메뉴 열림, 중요한 버튼
//   success 일이 잘 끝났다 — 생성 완료, 목표 달성
//   warn    주의 — 삭제, 실패
//
// 웹에선 전부 조용히 무시된다. require 실패(모듈 없는 빌드)에도 안전하다 —
// 인자를 이름으로 받는 이유는 MascotEasterEgg의 buzz와 같다: 인자가 먼저 평가되면
// Haptics=null인 기기에서 가드에 닿기 전에 터진다.
import { Platform } from 'react-native';

let Haptics: any = null;
try {
  Haptics = require('expo-haptics');
} catch {
  // 모듈이 없는 빌드 — 진동 없이 동작한다
}

const canBuzz = Platform.OS !== 'web';

export const tick = () => {
  if (!canBuzz || !Haptics?.selectionAsync) return;
  Haptics.selectionAsync()?.catch(() => {});
};

const impact = (kind: 'Light' | 'Medium' | 'Heavy') => {
  if (!canBuzz || !Haptics?.impactAsync) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle?.[kind])?.catch(() => {});
};
export const tap = () => impact('Light');
export const thud = () => impact('Medium');

const notify = (kind: 'Success' | 'Warning' | 'Error') => {
  if (!canBuzz || !Haptics?.notificationAsync) return;
  Haptics.notificationAsync?.(Haptics.NotificationFeedbackType?.[kind])?.catch(() => {});
};
export const success = () => notify('Success');
export const warn = () => notify('Warning');
