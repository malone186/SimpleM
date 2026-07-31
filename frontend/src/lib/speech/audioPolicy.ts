// "지금 소리를 내도 되는가" 정책 — 웹/네이티브 플레이어가 공유한다.
//
// ═══════════════════════════════════════════════════
// [한글 주석] 예전 정책의 문제
// 이어폰 감지가 false면 무조건 음성을 건너뛰었다. 그런데 안드로이드 감지 API는 이어폰을
// 꽂아도 false를 자주 내놓는다(earphoneDetector.ts 주석 참고) → 사장님은 "이어폰 꼈는데
// 알림을 안 읽어준다"는 상태에 갇혔고, 그게 감지 실패인지 설정 문제인지 알 방법도 없었다.
//
// 새 정책은 두 가지를 지킨다:
//   1) 기본값은 '항상 읽어주기' — 알림이 조용히 사라지지 않는 쪽이 기본
//   2) '이어폰 연결 시에만'을 고른 사장님에게도, 감지가 불가능한 환경(supported=false)에서는
//      침묵 대신 재생한다. 감지가 확실히 "안 꽂힘"이라고 말할 때만 건너뛴다.
// ═══════════════════════════════════════════════════
import { detectEarphone, resetEarphoneCache } from './earphoneDetector';
import type { AudioPlaybackPermission, EarphoneStatus } from './speechTypes';
import { readVoicePrefs } from './voicePrefs';

/** 이어폰 연결 여부 (사실 확인 — 설정 화면 표시용) */
export async function isEarphoneConnected(): Promise<EarphoneStatus> {
  return detectEarphone();
}

/** 지금 음성을 재생해도 되는지 (정책 — 호출부는 이것만 보면 된다) */
export async function canPlayAudio(): Promise<AudioPlaybackPermission> {
  const prefs = await readVoicePrefs();

  // '항상'이면 출력 장치를 따지지 않는다 (매장 스피커로 나가도 사장님이 그렇게 고른 것)
  if (prefs.outputMode === 'always') {
    return { allowed: true, reason: null };
  }

  const status = await detectEarphone();
  if (status.supported === false) {
    return {
      allowed: true,
      reason: `출력 장치를 확인할 수 없어 그대로 읽어드려요. (${status.reason ?? '감지 불가'})`,
    };
  }
  if (status.connected) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason:
      '이어폰이 연결되어 있지 않아 음성은 건너뛰었어요. 설정 > 알림에서 "항상 읽어주기"로 바꾸면 스피커로도 읽어드려요.',
  };
}

export { resetEarphoneCache };
