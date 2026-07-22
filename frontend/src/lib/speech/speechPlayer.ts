// 네이티브(Android/iOS) 전용 음성 플레이어 — expo-speech 기반 TTS
// (Metro가 네이티브에서는 .ts를, 웹에서는 .web.ts를 자동 선택)
//
// [한글 주석] 웹 구현(speechPlayer.web.ts)과 동작을 맞추기 위해 큐를 직접 관리합니다.
// expo-speech에도 자체 큐가 있지만, 웹과 같은 순서 보장·취소 동작을 쓰려면
// 같은 방식의 FIFO 큐를 두는 편이 예측 가능합니다.
import * as Speech from 'expo-speech';

import type {
  AudioPlaybackPermission,
  EarphoneStatus,
  SpeechPlayer,
  SpeechQueueItem,
} from './speechTypes';

// ═══════════════════════════════════════════════════
// [한글 주석] 이어폰 감지 — 네이티브에서는 불가능합니다.
// iOS/안드로이드의 오디오 라우팅을 읽으려면 플랫폼별 네이티브 모듈이 필요한데
// 지금은 붙어 있지 않으므로 "모른다"고 정직하게 답합니다.
// ═══════════════════════════════════════════════════

async function isEarphoneConnected(): Promise<EarphoneStatus> {
  return {
    connected: false,
    reason: '앱에서는 오디오 출력 장치를 감지할 수 없습니다.',
  };
}

/** 지금 소리를 내도 되는가 — 네이티브 정책
 *
 * [한글 주석] 감지가 불가능한데 "이어폰 확인 안 되면 무음"으로 두면
 * 앱에서는 TTS가 영원히 동작하지 않습니다. 그래서 재생을 허용합니다.
 * 대신 주변에 들릴 수 있다는 점을 reason에 남겨 화면에서 안내합니다.
 */
async function canPlayAudio(): Promise<AudioPlaybackPermission> {
  return {
    allowed: true,
    reason: '앱에서는 출력 장치를 감지할 수 없어 항상 재생합니다. 주변에 들릴 수 있습니다.',
  };
}

// ═══════════════════════════════════════════════════
// [한글 주석] 음성 큐 — 웹 구현과 동일한 FIFO 방식
// ═══════════════════════════════════════════════════

const _queue: SpeechQueueItem[] = [];
let _speaking = false;
let _seq = 0;

/** 현재 재생 중인지 확인 (동기) */
function isSpeaking(): boolean {
  return _speaking;
}

/** 실제 expo-speech 호출 (콜백을 Promise로 감쌈) */
function _speakInternal(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    // onDone/onStopped/onError가 겹쳐 호출돼도 한 번만 진행하도록 보호
    const finish = () => {
      if (settled) return;
      settled = true;
      _speaking = false;
      resolve();
    };

    _speaking = true;

    try {
      Speech.speak(text, {
        language: 'ko-KR',
        pitch: 1.0,
        rate: 1.0,
        onDone: finish,
        onStopped: finish,
        // 에러 시에도 resolve하여 큐 진행이 막히지 않도록 함 (웹 구현과 동일)
        onError: finish,
      });
    } catch {
      finish();
    }
  });
}

/** 큐에서 다음 항목을 꺼내 재생합니다 (큐가 빌 때까지 반복) */
async function _processQueue(): Promise<void> {
  if (_speaking || _queue.length === 0) return;

  const item = _queue.shift();
  if (!item) return;

  const permission = await canPlayAudio();
  if (!permission.allowed) {
    // 재생은 건너뛰되 큐는 계속 비웁니다 (텍스트 알림은 화면이 담당)
    _processQueue();
    return;
  }

  await _speakInternal(item.text);
  _processQueue();
}

// ═══════════════════════════════════════════════════
// [한글 주석] 외부 공개 API — 웹 구현과 시그니처 동일
// ═══════════════════════════════════════════════════

/** 텍스트를 즉시 음성으로 읽습니다 */
async function speak(text: string): Promise<void> {
  const permission = await canPlayAudio();
  if (!permission.allowed) return;
  await _speakInternal(text);
}

/** 큐에 추가하고 순서대로 재생합니다 (겹침 방지) */
function enqueue(text: string, id?: string): void {
  const item: SpeechQueueItem = {
    id: id ?? `speech-${++_seq}`,
    text,
    enqueuedAt: Date.now(),
  };
  _queue.push(item);
  if (!_speaking) {
    _processQueue();
  }
}

/** 큐 전체를 비우고 현재 재생도 중단합니다 */
function cancelAll(): void {
  _queue.length = 0;
  _speaking = false;
  // Speech.stop()은 재생 중단과 함께 expo-speech 내부 큐도 비웁니다
  Speech.stop().catch(() => {
    // 재생 중이 아닐 때 호출되면 무시
  });
}

const speechPlayer: SpeechPlayer = {
  isEarphoneConnected,
  canPlayAudio,
  speak,
  enqueue,
  cancelAll,
  isSpeaking,
};

export default speechPlayer;
export { isEarphoneConnected, canPlayAudio, speak, enqueue, cancelAll, isSpeaking };
