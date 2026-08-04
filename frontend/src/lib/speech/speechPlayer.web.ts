// 웹(react-native-web) 전용 음성 플레이어 — 서버 TTS(진짜 다른 목소리 4종) 우선 + 로컬 폴백
//
// [한글 주석] 왜 서버 TTS가 1순위인가:
// 브라우저 내장 speechSynthesis는 한국어 보이스가 보통 1개뿐이라 목소리 4종을
// 피치 변형으로만 흉내 냈고, 극단 피치(0.48/1.75)는 기계음처럼 들렸다(사장님 실사용 불만).
// 게다가 getVoices()가 첫 호출에 빈 배열을 주면 한국어가 아닌 기본 보이스로 읽혀
// "이상한 기계 목소리"가 났다. 서버(/chatbot/tts, Gemini TTS)는 성별·톤이 실제로
// 다른 보이스로 합성해 주므로 이 문제가 전부 사라진다.
// 서버 실패(쿼터·오프라인·미로그인) 시에만 로컬 speechSynthesis로 폴백한다.
import { API_BASE_URL } from '../api/client';
import { canPlayAudio, isEarphoneConnected } from './audioPolicy';
import type { SpeakOptions, SpeechPlayer, SpeechQueueItem } from './speechTypes';
import { clampRate, readVoicePrefs } from './voicePrefs';

// ═══════════════════════════════════════════════════
// [한글 주석] 서버 TTS 호출용 로그인 토큰 — AlertsWatcher가 로그인/로그아웃 시 넣어준다.
// (쿼터 보호를 위해 /chatbot/tts는 로그인 필수라, 토큰이 없으면 바로 로컬 폴백)
// ═══════════════════════════════════════════════════

let _authToken: string | null = null;

function setAuthToken(token: string | null): void {
  _authToken = token;
}

// ═══════════════════════════════════════════════════
// [한글 주석] 이어폰 감지·재생 정책은 네이티브와 공유한다 (audioPolicy → earphoneDetector.web).
// 예전엔 "출력 장치가 2개 이상이면 이어폰"으로 세는 코드가 여기 따로 있었는데,
// 크롬은 스피커 하나도 default/communications로 중복 보고해서 판정이 엉망이었다.
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// [한글 주석] 목소리·속도 결정 — 설정(PreferencesContext)과 같은 저장 키를 읽는다(voicePrefs)
// ═══════════════════════════════════════════════════

/** 이번 재생에 쓸 목소리 타입과 속도 배율 (미리듣기 옵션이 있으면 그게 우선) */
async function resolveVoice(options?: SpeakOptions): Promise<{ voiceType: string; speed: number }> {
  const saved = await readVoicePrefs();
  return {
    voiceType: options?.voiceType ?? saved.voiceType,
    speed: clampRate(options?.rate ?? saved.speechRate),
  };
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

// [한글 주석] AI 목소리 분당 한도(무료 티어 3회) — 서버가 429 + Retry-After로 알려준다.
// 한도를 넘으면 이 시각까지는 기기 기본 목소리로 읽는다는 뜻이고, 설정 화면이 그
// 남은 시간을 사장님께 보여준다.
//
// 한도 중에도 서버는 계속 부른다: 반복되는 알림 문구와 설정 샘플은 서버 디스크 캐시에
// 있어서 구글을 부르지 않고 200으로 나오고, 그건 한도와 무관하게 AI 목소리로 들려드릴
// 수 있다. 미리 끊어버리면 공짜로 쓸 수 있는 캐시까지 기기 목소리로 떨어진다.
let _serverBlockedUntil = 0; // epoch ms

/** 웹은 서버 TTS(Gemini)가 1순위 — 즉 AI 목소리를 실제로 쓴다 */
function usesAiVoice(): boolean {
  return true;
}

/** AI 목소리를 지금 쓸 수 있는지 / 아니면 몇 초 뒤에 풀리는지 (설정 화면 안내용) */
function aiVoiceCooldownSec(): number {
  return Math.max(0, Math.ceil((_serverBlockedUntil - Date.now()) / 1000));
}

async function _speakViaServer(text: string, voiceType: string, speed: number): Promise<void> {
  if (!_authToken) throw new Error('로그인 토큰 없음 — 로컬 TTS로 폴백');

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${_authToken}`,
    },
    body: JSON.stringify({ text, voice_type: voiceType }),
  });
  if (res.status === 429) {
    // 분당 한도 초과 — 실패가 아니라 '이번엔 기기 목소리로 읽어라'는 신호다
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 60, 60);
    _serverBlockedUntil = Date.now() + wait * 1000;
    throw new Error(`AI 음성 분당 한도 — ${wait}초 뒤 복귀`);
  }
  if (!res.ok) throw new Error(`서버 TTS ${res.status}`);
  // 캐시 응답(hit)은 구글을 부르지 않은 것이라 한도가 풀렸다는 증거가 못 된다.
  // 새로 합성된 응답(miss)이 왔을 때만 대기 표시를 푼다.
  if (res.headers.get('X-Tts-Cache') !== 'hit') _serverBlockedUntil = 0;
  const blob = await res.blob();

  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      // [한글 주석] 말하는 속도 — 서버가 합성해 준 음성을 재생 배속으로 조절한다.
      // preservesPitch를 켜두면 배속을 올려도 목소리 톤이 높아지지 않는다(다람쥐 소리 방지).
      const anyAudio = audio as HTMLAudioElement & {
        preservesPitch?: boolean;
        mozPreservesPitch?: boolean;
        webkitPreservesPitch?: boolean;
      };
      anyAudio.preservesPitch = true;
      anyAudio.mozPreservesPitch = true;
      anyAudio.webkitPreservesPitch = true;
      audio.playbackRate = speed;
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

async function _speakViaLocal(text: string, voiceType: string, speed: number): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;

  const synth = window.speechSynthesis;
  const voices = await loadVoices(synth);
  const tone = localToneFor(voiceType);
  const matched = selectLocalVoice(voices, tone.male);

  return new Promise<void>((resolve) => {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    // 목소리별 기본 속도에 사장님이 고른 속도 배율을 곱한다
    utterance.rate = clampRate(tone.rate * speed);
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

async function _speakInternal(text: string, options?: SpeakOptions): Promise<void> {
  const { voiceType, speed } = await resolveVoice(options);
  _speaking = true;
  try {
    await _speakViaServer(text, voiceType, speed);
  } catch {
    // 쿼터 소진·오프라인·미로그인·자동재생 차단 — 기기 내장 TTS로 폴백
    try {
      await _speakViaLocal(text, voiceType, speed);
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
    // 네이티브와 동일하게 큐에서도 정책을 한 번 더 확인한다 (호출부가 빠뜨려도 규칙은 지켜지도록)
    const permission = await canPlayAudio();
    if (permission.allowed) {
      await _speakInternal(item.text);
    }
    _processQueue();
  }
}

/** 설정 화면 '샘플 듣기' 같은 명시적 조작 전용 — 출력 정책(이어폰 게이트)을 걸지 않는다.
 * (자동 알림은 enqueue를 쓰고, 그쪽은 설정한 출력 조건을 지킨다) */
async function speak(text: string, options?: SpeakOptions): Promise<void> {
  await _speakInternal(text, options);
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
  usesAiVoice,
  aiVoiceCooldownSec,
};

export default speechPlayer;
export {
  isEarphoneConnected,
  canPlayAudio,
  speak,
  enqueue,
  cancelAll,
  isSpeaking,
  setAuthToken,
  usesAiVoice,
  aiVoiceCooldownSec,
};
