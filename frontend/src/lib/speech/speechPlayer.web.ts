// 웹(react-native-web) 전용 TTS + 이어폰 감지 + 음성 큐
// 브라우저 내장 Web Speech API(window.speechSynthesis)를 사용합니다.
// (Metro가 웹에서는 .web.ts를 자동 선택)
import type {
  AudioPlaybackPermission,
  EarphoneStatus,
  SpeechPlayer,
  SpeechQueueItem,
} from './speechTypes';

// ═══════════════════════════════════════════════════
// [한글 주석] 이어폰(외부 오디오 출력 장치) 감지
// navigator.mediaDevices.enumerateDevices()로 audiooutput 장치를 세어
// 기본 스피커(1개) 외에 추가 장치가 있으면 이어폰으로 간주합니다.
// ═══════════════════════════════════════════════════

async function isEarphoneConnected(): Promise<EarphoneStatus> {
  try {
    // mediaDevices API 미지원 브라우저 처리
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return { connected: false, reason: '이 브라우저는 오디오 장치 감지를 지원하지 않습니다.' };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    // audiooutput 타입 장치 목록 추출
    const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

    // 브라우저 기본 스피커(1개)만 있으면 이어폰 미착용,
    // 2개 이상이면 이어폰/블루투스 등 외부 장치가 연결된 것으로 판단
    const connected = audioOutputs.length >= 2;
    return { connected, reason: null };
  } catch (err) {
    return {
      connected: false,
      reason: `오디오 장치 감지 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}


/** 지금 소리를 내도 되는가 — 웹 정책
 *
 * [한글 주석] 웹은 출력 장치를 셀 수 있으므로 "이어폰 착용 시에만 재생"을 지킵니다.
 * 카페에서 직원 이름·근무 정보가 스피커로 흘러나가지 않게 하려는 목적입니다.
 */
async function canPlayAudio(): Promise<AudioPlaybackPermission> {
  const earphone = await isEarphoneConnected();
  return {
    allowed: earphone.connected,
    reason: earphone.connected
      ? null
      : (earphone.reason ?? '이어폰이 연결되어 있지 않아 음성은 재생하지 않았습니다.'),
  };
}


// ═══════════════════════════════════════════════════
// [한글 주석] 음성 큐 관리 — FIFO 방식으로 겹침 없이 순서대로 재생
// 비유: 식당 주문 대기열처럼, 먼저 온 주문(음성)을 먼저 처리합니다.
// ═══════════════════════════════════════════════════

const _queue: SpeechQueueItem[] = [];
let _speaking = false;
let _seq = 0;

/** 현재 재생 중인지 확인 */
function isSpeaking(): boolean {
  return _speaking || (typeof window !== 'undefined' && window.speechSynthesis?.speaking);
}

/** 큐에서 다음 항목을 꺼내 재생합니다 (재귀적으로 큐가 빌 때까지) */
async function _processQueue(): Promise<void> {
  if (_speaking || _queue.length === 0) return;

  const item = _queue.shift();
  if (!item) return;

  // 이어폰 체크 — 미착용이면 스킵하고 다음 항목으로
  const earphone = await isEarphoneConnected();
  if (!earphone.connected) {
    // 음성은 스킵하지만 큐에 남은 것도 계속 처리 (텍스트 알림은 AlertsWatcher가 담당)
    _processQueue();
    return;
  }

  await _speakInternal(item.text);
  // 재생 완료 후 큐의 다음 항목 처리
  _processQueue();
}

/** [한글 주석] 브라우저 내 자연스러운 신경망/고품질 한국어 보이스 최우선 검색 */
function getNaturalKoreanVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  if (!voices.length) return null;

  // 1순위: Natural, Neural, Google, Online 키워드가 들어간 고품질 한국어 사람 목소리
  const naturalKo = voices.find(
    (v) =>
      v.lang.startsWith('ko') &&
      (v.name.includes('Natural') ||
        v.name.includes('Neural') ||
        v.name.includes('Google') ||
        v.name.includes('Online'))
  );
  if (naturalKo) return naturalKo;

  // 2순위: Yuna, Heami, Sun-Hi 등 고유 한국어 보이스
  const namedKo = voices.find(
    (v) =>
      v.lang.startsWith('ko') &&
      (v.name.includes('Yuna') || v.name.includes('Heami') || v.name.includes('Sun-Hi'))
  );
  if (namedKo) return namedKo;

  // 3순위: 일반 한국어 보이스
  return voices.find((v) => v.lang.startsWith('ko')) || null;
}

/** [한글 주석] 사람이 말하듯 숨 쉬는 어조와 자연스러운 호흡 쉼표 가공 */
function humanizeSpeechText(raw: string): string {
  return raw
    .replace(/([.!?])\s*/g, '$1 , ')
    .replace(/입니다\./g, '입니다.. , ')
    .replace(/있습니다\./g, '있습니다.. , ')
    .replace(/에요\./g, '에요.. , ')
    .replace(/요\./g, '요.. , ');
}

/** 실제 Web Speech API 호출 (Promise 래핑) */
function _speakInternal(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // speechSynthesis 미지원 시 즉시 resolve
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve();
      return;
    }

    const synth = window.speechSynthesis;
    const humanized = humanizeSpeechText(text);
    const utterance = new SpeechSynthesisUtterance(humanized);

    // [한글 주석] 사람이 또박또박 따뜻하게 말하는 호흡과 억양 튜닝 (rate 0.93, pitch 1.08)
    utterance.lang = 'ko-KR';
    utterance.rate = 0.93;   // 사람이 편안하게 짚어주는 자연스러운 호흡 속도
    utterance.pitch = 1.08;  // 로봇 같지 않고 부드럽고 다정한 사장님 톤
    utterance.volume = 1.0;

    // 고품질 사람 목소리가 세팅되어 있으면 적용
    const naturalVoice = getNaturalKoreanVoice(synth);
    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    _speaking = true;

    utterance.onend = () => {
      _speaking = false;
      resolve();
    };

    utterance.onerror = () => {
      _speaking = false;
      resolve(); // 에러 시에도 resolve하여 큐 진행을 막지 않음
    };

    synth.speak(utterance);
  });
}


// ═══════════════════════════════════════════════════
// [한글 주석] 외부 공개 API
// ═══════════════════════════════════════════════════

/** 텍스트를 즉시 음성으로 읽습니다 (이어폰 미착용 시 스킵) */
async function speak(text: string): Promise<void> {
  const earphone = await isEarphoneConnected();
  if (!earphone.connected) return;
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
  // 현재 재생 중이 아니면 즉시 큐 처리 시작
  if (!_speaking) {
    _processQueue();
  }
}

/** 큐 전체를 비우고 현재 재생도 중단합니다 */
function cancelAll(): void {
  _queue.length = 0;
  _speaking = false;
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}


// [한글 주석] SpeechPlayer 인터페이스를 구현하는 객체를 export합니다.
const speechPlayer: SpeechPlayer = {
  isEarphoneConnected,
  canPlayAudio,
  speak,
  enqueue,
  cancelAll,
  isSpeaking,
};

export default speechPlayer;

// 개별 함수도 named export로 제공 (AlertsWatcher 등에서 직접 import 가능)
export { isEarphoneConnected, canPlayAudio, speak, enqueue, cancelAll, isSpeaking };
