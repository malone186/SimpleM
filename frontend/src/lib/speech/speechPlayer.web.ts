// 웹(react-native-web) 전용 음성 플레이어 — 서버 TTS(진짜 다른 목소리 4종) 우선 + 로컬 폴백
//
// [한글 주석] 왜 서버 TTS가 1순위인가:
// 브라우저 내장 speechSynthesis는 한국어 보이스가 보통 1개뿐이라 목소리 4종을
// 피치 변형으로만 흉내 냈고, 극단 피치(0.48/1.75)는 기계음처럼 들렸다(사장님 실사용 불만).
// 게다가 getVoices()가 첫 호출에 빈 배열을 주면 한국어가 아닌 기본 보이스로 읽혀
// "이상한 기계 목소리"가 났다. 서버(/chatbot/tts, Gemini TTS)는 성별·톤이 실제로
// 다른 보이스로 합성해 주므로 이 문제가 전부 사라진다.
// 서버 실패(쿼터·오프라인·미로그인) 시에만 로컬 speechSynthesis로 폴백한다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PREFS_STORAGE_KEY } from '../../preferences/PreferencesContext';
import { API_BASE_URL } from '../api/client';
import type {
  AudioPlaybackPermission,
  EarphoneStatus,
  SpeechPlayer,
  SpeechQueueItem,
} from './speechTypes';

// ═══════════════════════════════════════════════════
// [한글 주석] 서버 TTS 호출용 로그인 토큰 — AlertsWatcher가 로그인/로그아웃 시 넣어준다.
// (쿼터 보호를 위해 /chatbot/tts는 로그인 필수라, 토큰이 없으면 바로 로컬 폴백)
// ═══════════════════════════════════════════════════

let _authToken: string | null = null;

function setAuthToken(token: string | null): void {
  _authToken = token;
}

// ═══════════════════════════════════════════════════
// [한글 주석] 이어폰(외부 오디오 출력 장치) 감지
// ═══════════════════════════════════════════════════

async function isEarphoneConnected(): Promise<EarphoneStatus> {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return { connected: false, reason: '이 브라우저는 오디오 장치 감지를 지원하지 않습니다.' };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
    const connected = audioOutputs.length >= 2;
    return { connected, reason: null };
  } catch (err) {
    return {
      connected: false,
      reason: '오디오 장치 감지 실패',
    };
  }
}

async function canPlayAudio(): Promise<AudioPlaybackPermission> {
  const status = await isEarphoneConnected();
  if (status.reason) {
    return {
      allowed: true,
      reason: '장치 감지를 지원하지 않는 웹 브라우저 환경입니다.',
    };
  }
  return {
    allowed: status.connected,
    reason: status.connected
      ? null
      : '이어폰이 연결되어 있지 않아 음성을 재생하지 않습니다.',
  };
}

// ═══════════════════════════════════════════════════
// [한글 주석] 목소리 타입 결정 — 설정(PreferencesContext)과 같은 저장 키를 읽는다
// ═══════════════════════════════════════════════════

async function resolveVoiceType(overrideVoiceType?: string): Promise<string> {
  if (overrideVoiceType) return overrideVoiceType;
  try {
    const raw = await AsyncStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.voiceType) return parsed.voiceType as string;
    }
  } catch {
    // 저장소 접근 실패 — 기본 목소리로
  }
  return 'warm_female';
}

// [한글 주석] 로컬 폴백용 피치/속도 — 서버 TTS를 못 쓸 때만 쓰인다.
// 예전의 극단값(0.48/1.75)은 기계음처럼 들려서 자연스러운 범위로 완화했다.
function localToneFor(voiceType: string): { pitch: number; rate: number; male: boolean } {
  switch (voiceType) {
    case 'friendly_male':
      return { pitch: 0.8, rate: 0.95, male: true };
    case 'calm_male':
      return { pitch: 0.85, rate: 0.88, male: true };
    case 'cute_child':
      return { pitch: 1.3, rate: 1.02, male: false };
    case 'warm_female':
    default:
      return { pitch: 1.08, rate: 0.95, male: false };
  }
}

const _queue: SpeechQueueItem[] = [];
let _speaking = false;
let _seq = 0;
let _currentAudio: HTMLAudioElement | null = null; // 서버 TTS 재생 중단(cancelAll)용

function isSpeaking(): boolean {
  return _speaking || (typeof window !== 'undefined' && Boolean(window.speechSynthesis?.speaking));
}

// ═══════════════════════════════════════════════════
// [한글 주석] 1순위 — 서버 TTS (Gemini, 진짜 다른 목소리)
// ═══════════════════════════════════════════════════

async function _speakViaServer(text: string, voiceType: string): Promise<void> {
  if (!_authToken) throw new Error('로그인 토큰 없음 — 로컬 TTS로 폴백');

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${_authToken}`,
    },
    body: JSON.stringify({ text, voice_type: voiceType }),
  });
  if (!res.ok) throw new Error(`서버 TTS ${res.status}`);
  const blob = await res.blob();

  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      _currentAudio = audio;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('오디오 재생 실패'));
      // 자동재생 정책에 막히면 reject → 로컬 폴백(그쪽도 같은 정책이면 조용히 스킵)
      audio.play().catch(reject);
    });
  } finally {
    _currentAudio = null;
    URL.revokeObjectURL(url);
  }
}

// ═══════════════════════════════════════════════════
// [한글 주석] 2순위 — 브라우저 내장 speechSynthesis (폴백)
// ═══════════════════════════════════════════════════

/** getVoices()는 첫 호출에 빈 배열을 줄 수 있다(voiceschanged 이후 채워짐).
 *  빈 배열인 채로 utterance를 만들면 한국어가 아닌 기본 보이스로 읽혀
 *  "이상한 기계 목소리"가 난다 — 잠깐 기다려 목록을 확보한다. */
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const voices = synth.getVoices();
  if (voices.length > 0) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
    synth.onvoiceschanged = () => {
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
  });
}

function selectLocalVoice(
  voices: SpeechSynthesisVoice[],
  male: boolean
): SpeechSynthesisVoice | null {
  const korean = voices.filter((v) => v.lang.startsWith('ko') || v.lang.includes('KR'));
  if (korean.length === 0) return null; // 한국어 보이스가 없으면 억지로 읽지 않는 편이 낫다

  if (male) {
    const maleVoice = korean.find(
      (v) =>
        v.name.includes('Male') ||
        v.name.includes('InJoon') ||
        v.name.includes('Hyunsu') ||
        v.name.includes('남성') ||
        v.name.includes('인준') ||
        v.name.includes('현수')
    );
    if (maleVoice) return maleVoice;
  }
  const natural = korean.find(
    (v) => v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Neural')
  );
  return natural || korean[0];
}

async function _speakViaLocal(text: string, voiceType: string): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;

  const synth = window.speechSynthesis;
  const voices = await loadVoices(synth);
  const tone = localToneFor(voiceType);
  const matched = selectLocalVoice(voices, tone.male);

  return new Promise<void>((resolve) => {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = tone.rate;
    utterance.pitch = tone.pitch;
    utterance.volume = 1.0;
    if (matched) utterance.voice = matched;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    synth.speak(utterance);
  });
}

// ═══════════════════════════════════════════════════
// [한글 주석] 공통 재생 진입점 + 큐
// ═══════════════════════════════════════════════════

async function _speakInternal(text: string, overrideVoiceType?: string): Promise<void> {
  const voiceType = await resolveVoiceType(overrideVoiceType);
  _speaking = true;
  try {
    await _speakViaServer(text, voiceType);
  } catch {
    // 쿼터 소진·오프라인·미로그인·자동재생 차단 — 기기 내장 TTS로 폴백
    try {
      await _speakViaLocal(text, voiceType);
    } catch {
      // 폴백까지 실패해도 큐는 계속 흘러야 한다 (텍스트 토스트는 화면이 담당)
    }
  } finally {
    _speaking = false;
  }
}

async function _processQueue(): Promise<void> {
  if (_speaking || _queue.length === 0) return;
  const item = _queue.shift();
  if (item) {
    await _speakInternal(item.text);
    _processQueue();
  }
}

/** 설정 화면 '샘플 듣기' 같은 명시적 조작 전용 — 이어폰 게이트를 걸지 않는다.
 * (자동 알림은 enqueue를 쓰고, 그쪽은 기존대로 이어폰 정책을 지킨다) */
async function speak(text: string, overrideVoiceType?: string): Promise<void> {
  await _speakInternal(text, overrideVoiceType);
}

function enqueue(text: string, id?: string): void {
  const item: SpeechQueueItem = {
    id: id ?? ('speech-' + (++_seq)),
    text,
    enqueuedAt: Date.now(),
  };
  _queue.push(item);
  if (!_speaking) {
    _processQueue();
  }
}

function cancelAll(): void {
  _queue.length = 0;
  _speaking = false;
  if (_currentAudio) {
    try {
      _currentAudio.pause();
    } catch {
      // 이미 정지된 경우 무시
    }
    _currentAudio = null;
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
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
