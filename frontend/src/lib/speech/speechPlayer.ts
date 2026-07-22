// 네이티브(Android/iOS) 전용 음성 플레이어 — no-op 구현
// Web Speech API는 브라우저 전용이므로, 네이티브에서는 텍스트만 표시합니다.
// 향후 expo-speech 등을 연동하면 이 파일만 교체하면 됩니다.
// (Metro가 네이티브에서는 .ts를, 웹에서는 .web.ts를 자동 선택)
import type { EarphoneStatus, SpeechPlayer } from './speechTypes';

// [한글 주석] 네이티브에서는 이어폰 감지를 하지 않습니다 (항상 미연결)
async function isEarphoneConnected(): Promise<EarphoneStatus> {
  return {
    connected: false,
    reason: '네이티브 환경에서는 아직 이어폰 감지를 지원하지 않습니다. (2단계 이후 구현 예정)',
  };
}

// [한글 주석] 네이티브에서는 음성을 재생하지 않습니다 (빈 동작)
async function speak(_text: string): Promise<void> {
  // no-op: 네이티브 TTS 미구현
}

function enqueue(_text: string, _id?: string): void {
  // no-op: 네이티브 TTS 미구현
}

function cancelAll(): void {
  // no-op
}

function isSpeaking(): boolean {
  return false;
}

const speechPlayer: SpeechPlayer = {
  isEarphoneConnected,
  speak,
  enqueue,
  cancelAll,
  isSpeaking,
};

export default speechPlayer;
export { isEarphoneConnected, speak, enqueue, cancelAll, isSpeaking };
