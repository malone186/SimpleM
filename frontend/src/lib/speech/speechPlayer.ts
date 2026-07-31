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

import AsyncStorage from '@react-native-async-storage/async-storage';

import { PREFS_STORAGE_KEY } from '../../preferences/PreferencesContext';
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

// [한글 주석] 서버 TTS용 토큰 자리 — 웹 구현과 인터페이스를 맞추기 위한 저장만 한다.
// 네이티브는 오디오 파일 재생 모듈(expo-audio)이 현재 빌드에 없어 서버 TTS(WAV)를
// 재생할 수 없다 — 기기 내장 expo-speech로 말하되, 아래에서 기기의 한국어 보이스를
// 목소리 타입별로 다르게 배정해 차이를 만든다. (expo-audio를 넣은 새 빌드가 나오면
// 웹처럼 서버 TTS 1순위로 전환할 것)
let _authToken: string | null = null;

function setAuthToken(token: string | null): void {
  _authToken = token;
}

// ═══════════════════════════════════════════════════
// [한글 주석] 기기 한국어 보이스 배정 — "여러 목소리"를 최대한 진짜로.
// Google/Samsung TTS는 한국어 변형 보이스가 여러 개 설치된 경우가 많다
// (예: ko-kr-x-ism, ko-kr-x-kob, ko-kr-x-koc, ko-kr-x-kod).
// 목소리 타입마다 다른 변형을 고정 배정해, 피치만 바꾸던 예전보다 실제로 다르게 들린다.
// 변형이 1개뿐인 기기에서는 피치·속도 차이만 남는다 (기기 한계).
// ═══════════════════════════════════════════════════

const VOICE_ORDER = ['warm_female', 'friendly_male', 'calm_male', 'cute_child'];
let _koreanVoiceIds: string[] | null = null; // 최초 1회만 조회

async function _getKoreanVoiceIds(): Promise<string[]> {
  if (_koreanVoiceIds) return _koreanVoiceIds;
  let ids: string[] = [];
  try {
    const voices = (await Speech.getAvailableVoicesAsync?.()) ?? [];
    ids = voices
      .filter((v: any) => String(v.language || '').toLowerCase().startsWith('ko'))
      .map((v: any) => String(v.identifier))
      .sort(); // 정렬로 배정을 기기 재부팅 후에도 안정적으로
  } catch {
    ids = [];
  }
  _koreanVoiceIds = ids;
  return ids;
}

async function _voiceIdFor(voiceType: string): Promise<string | undefined> {
  const ids = await _getKoreanVoiceIds();
  if (ids.length < 2) return undefined; // 변형이 없으면 시스템 기본에 맡긴다
  const idx = Math.max(0, VOICE_ORDER.indexOf(voiceType));
  return ids[idx % ids.length];
}

/** 현재 재생 중인지 확인 (동기) */
function isSpeaking(): boolean {
  return _speaking;
}

/** [한글 주석] AsyncStorage에서 목소리 설정타입을 읽어와 pitch/rate 속성 반환
 *
 * 반드시 PreferencesContext와 같은 저장 키를 읽어야 한다 — 예전엔 존재하지 않는
 * '@simplem_user_prefs' 키를 읽어서, 설정에서 어떤 목소리를 골라도 알림 TTS는
 * 항상 기본(다정한 여성) 톤으로만 나오던 버그가 있었다. */
async function getVoiceAudioConfig(
  overrideVoiceType?: string
): Promise<{ pitch: number; rate: number; voiceType: string }> {
  try {
    let voiceType = overrideVoiceType;
    if (!voiceType) {
      const raw = await AsyncStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.voiceType) voiceType = parsed.voiceType;
      }
    }
    if (!voiceType) voiceType = 'warm_female';

    // 피치는 자연스러운 범위 안에서만 — 극단값은 목소리가 아니라 기계음처럼 들린다
    switch (voiceType) {
      case 'friendly_male':
        return { pitch: 0.85, rate: 0.95, voiceType }; // 묵직하고 친근한 삼촌/아저씨 톤
      case 'calm_male':
        return { pitch: 0.9, rate: 0.88, voiceType }; // 차분한 젠틀맨 톤
      case 'cute_child':
        return { pitch: 1.3, rate: 1.0, voiceType }; // 톡톡 튀는 꼬마/아이 톤
      case 'warm_female':
      default:
        return { pitch: 1.08, rate: 0.95, voiceType }; // 다정한 여성 톤
    }
  } catch {
    return { pitch: 1.08, rate: 0.95, voiceType: 'warm_female' };
  }
}

/** 실제 Expo Speech API 호출 (Promise 래핑) */
function _speakInternal(text: string, overrideVoiceType?: string): Promise<void> {
  return new Promise<void>(async (resolve) => {
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
      const config = await getVoiceAudioConfig(overrideVoiceType);
      // 목소리 타입별로 기기의 다른 한국어 보이스를 배정 (변형이 여러 개인 기기 한정)
      const voiceId = await _voiceIdFor(config.voiceType);

      // [한글 주석] 예전의 '자연스러운 호흡 가공'(문장부호를 ".. , "로 치환)은 제거했다 —
      // TTS 엔진이 이상한 지점에서 끊거나 더듬어 오히려 기계처럼 들리는 원인이었다.
      // 원문 그대로 읽는 쪽이 엔진의 기본 억양을 살려 훨씬 자연스럽다.
      Speech.speak(text, {
        language: 'ko-KR',
        pitch: config.pitch,
        rate: config.rate,
        ...(voiceId ? { voice: voiceId } : {}),
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

/** 텍스트를 즉시 음성으로 읽습니다 — 설정 화면 '샘플 듣기' 같은 명시적 조작 전용.
 *
 * [한글 주석] 이어폰 게이트를 걸지 않는다: 자동 알림(enqueue)과 달리 사장님이 직접
 * 버튼을 눌러 재생을 요청한 것이라 스피커로 나가도 사생활 문제가 없다. 예전엔
 * 여기서도 이어폰을 요구해서, 이어폰 없이 '샘플 듣기'를 누르면 아무 소리도 나지
 * 않아 목소리 설정이 고장 난 것처럼 보였다.
 * overrideVoiceType: 저장 전 미리듣기용 — 방금 누른 목소리 타입을 바로 반영한다.
 * (예전 네이티브 구현은 이 인자를 무시해서 어떤 카드를 눌러도 같은 톤이 나왔다) */
async function speak(text: string, overrideVoiceType?: string): Promise<void> {
  await _speakInternal(text, overrideVoiceType);
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
  setAuthToken,
};

export default speechPlayer;
export { isEarphoneConnected, canPlayAudio, speak, enqueue, cancelAll, isSpeaking, setAuthToken };
