// 네이티브(Android/iOS) 전용 음성 플레이어 — expo-speech 기반 TTS
// (Metro가 네이티브에서는 .ts를, 웹에서는 .web.ts를 자동 선택)
//
// [한글 주석] 웹 구현(speechPlayer.web.ts)과 동작을 맞추기 위해 큐를 직접 관리합니다.
// expo-speech에도 자체 큐가 있지만, 웹과 같은 순서 보장·취소 동작을 쓰려면
let Speech: any = null;
try {
  Speech = require('expo-speech');
} catch {
  Speech = {
    speak: () => {},
    stop: () => {},
    isSpeakingAsync: async () => false,
  };
}

import type {
  AudioPlaybackPermission,
  EarphoneStatus,
  SpeechPlayer,
  SpeechQueueItem,
} from './speechTypes';

// ═══════════════════════════════════════════════════
// [한글 주석] 이어폰 감지 — react-native-device-info의 오디오 출력 조회를 사용합니다.
// 유선 헤드셋뿐 아니라 에어팟 같은 블루투스 이어폰(A2DP/HFP)도 감지됩니다.
// Expo Go처럼 네이티브 모듈이 없는 환경에서는 감지가 불가능하므로
// 예전 동작(항상 재생 허용)으로 폴백합니다 → 개발 빌드에서만 이어폰 정책이 적용됩니다.
// ═══════════════════════════════════════════════════

// 네이티브 모듈이 없으면 import 시점이 아니라 "메서드 호출 시점"에 throw하므로
// require와 호출 양쪽 모두 try/catch로 감쌉니다.
let DeviceInfo: any = null;
try {
  const mod = require('react-native-device-info');
  DeviceInfo = mod?.default ?? mod;
} catch {
  DeviceInfo = null;
}

/** 감지 결과 — supported=false면 이 빌드에서는 출력 장치를 알 수 없다는 뜻 */
type EarphoneDetection =
  | { supported: false; reason: string }
  | { supported: true; connected: boolean; via: 'bluetooth' | 'wired' | null };

async function detectEarphone(): Promise<EarphoneDetection> {
  if (!DeviceInfo?.isHeadphonesConnected) {
    return {
      supported: false,
      reason: '이 빌드에는 오디오 장치 감지 모듈이 없습니다. (Expo Go — 개발 빌드에서 감지돼요)',
    };
  }
  try {
    const [bluetooth, wired] = await Promise.all([
      DeviceInfo.isBluetoothHeadphonesConnected?.() ?? Promise.resolve(false),
      DeviceInfo.isWiredHeadphonesConnected?.() ?? Promise.resolve(false),
    ]);
    // 개별 조회가 둘 다 false여도 통합 조회를 한 번 더 확인 (플랫폼별 커버리지 차이 대비)
    const connected = bluetooth || wired || (await DeviceInfo.isHeadphonesConnected());
    return {
      supported: true,
      connected,
      via: bluetooth ? 'bluetooth' : wired ? 'wired' : null,
    };
  } catch (err) {
    return {
      supported: false,
      reason: `오디오 장치 감지 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function isEarphoneConnected(): Promise<EarphoneStatus> {
  const d = await detectEarphone();
  if (!d.supported) return { connected: false, reason: d.reason };
  return {
    connected: d.connected,
    reason: d.connected ? null : '이어폰(블루투스 포함)이 연결되어 있지 않습니다.',
  };
}

/** 지금 소리를 내도 되는가 — 네이티브 정책
 *
 * [한글 주석] 감지가 되는 빌드에서는 웹과 동일하게 "이어폰 착용 시에만 재생"을 지킵니다
 * (에어팟 등 블루투스 이어폰 포함 — 매장 스피커로 직원 정보가 흘러나가지 않게).
 * 감지가 불가능한 환경(Expo Go 등)에서는 TTS가 영원히 침묵하지 않도록
 * 예전처럼 재생을 허용하고, 주변에 들릴 수 있다는 점을 reason으로 남깁니다.
 */
async function canPlayAudio(): Promise<AudioPlaybackPermission> {
  const d = await detectEarphone();
  if (!d.supported) {
    return {
      allowed: true,
      reason: '이 환경에서는 출력 장치를 감지할 수 없어 항상 재생합니다. 주변에 들릴 수 있습니다.',
    };
  }
  return {
    allowed: d.connected,
    reason: d.connected
      ? null
      : '이어폰이 연결되어 있지 않아 음성은 재생하지 않았습니다. (에어팟 등 블루투스 이어폰도 인식돼요)',
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
      // [한글 주석] 사람이 말하듯 자연스러운 억양과 호흡 가공 (pitch 1.08, rate 0.93)
      const humanized = text
        .replace(/([.!?])\s*/g, '$1 , ')
        .replace(/입니다\./g, '입니다.. , ')
        .replace(/있습니다\./g, '있습니다.. , ')
        .replace(/에요\./g, '에요.. , ')
        .replace(/요\./g, '요.. , ');

      Speech.speak(humanized, {
        language: 'ko-KR',
        pitch: 1.08,
        rate: 0.93,
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
