// 웹(react-native-web) 전용 TTS + 이어폰 감지 + 음성 큐 + 파격적 톤(피치/속도/보이스) 차별화
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PREFS_STORAGE_KEY } from '../../preferences/PreferencesContext';
import type {
  AudioPlaybackPermission,
  EarphoneStatus,
  SpeechPlayer,
  SpeechQueueItem,
} from './speechTypes';

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
// [한글 주석] 목소리 톤(삼촌/남성/아이/여성) 피치 및 속도 극대화 튜닝
// ═══════════════════════════════════════════════════

interface VoiceConfig {
  pitch: number;
  rate: number;
  gender: 'female' | 'male' | 'child';
  voiceType: string;
}

// 반드시 PreferencesContext와 같은 저장 키를 읽어야 한다 — 예전엔 존재하지 않는
// '@simplem_user_prefs' 키를 읽어서, 설정의 목소리 선택이 알림 TTS에 반영되지 않았다.
async function getVoiceAudioConfig(overrideVoiceType?: string): Promise<VoiceConfig> {
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

    switch (voiceType) {
      case 'friendly_male':
        // [한글 주석: 삼촌/아저씨 톤 — 피치를 0.48로 파격적으로 낮춰 굵직한 통통 남성 목소리로 변환]
        return { pitch: 0.48, rate: 0.85, gender: 'male', voiceType };
      case 'calm_male':
        // [한글 주석: 차분한 젠틀맨 톤 — 피치 0.62, 저음 안정적인 톤]
        return { pitch: 0.62, rate: 0.82, gender: 'male', voiceType };
      case 'cute_child':
        // [한글 주석: 귀여운 꼬마/아이 톤 — 피치 1.75로 높은 톡톡 튀는 목소리]
        return { pitch: 1.75, rate: 1.05, gender: 'child', voiceType };
      case 'warm_female':
      default:
        // [한글 주석: 다정한 아나운서 여성 톤 — 피치 1.15]
        return { pitch: 1.15, rate: 0.95, gender: 'female', voiceType };
    }
  } catch {
    return { pitch: 1.15, rate: 0.95, gender: 'female', voiceType: 'warm_female' };
  }
}

const _queue: SpeechQueueItem[] = [];
let _speaking = false;
let _seq = 0;

function isSpeaking(): boolean {
  return _speaking || (typeof window !== 'undefined' && Boolean(window.speechSynthesis?.speaking));
}

function humanizeSpeechText(text: string): string {
  return text.replace(/원/g, ' 원').replace(/개/g, ' 개');
}

function selectVoiceForConfig(synth: SpeechSynthesis, config: VoiceConfig): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  if (voices.length === 0) return null;

  const koreanVoices = voices.filter((v) => v.lang.startsWith('ko') || v.lang.includes('KR'));
  if (koreanVoices.length === 0) return voices[0] || null;

  if (config.gender === 'male') {
    // 남성 보이스 탐색 (Microsoft InJoon, YunJae, Google 한국어 남성 등)
    const maleVoice = koreanVoices.find(
      (v) =>
        v.name.includes('Male') ||
        v.name.includes('InJoon') ||
        v.name.includes('YunJae') ||
        v.name.includes('Minsu') ||
        v.name.includes('Minho') ||
        v.name.includes('Sang-Woo') ||
        v.name.includes('인준') ||
        v.name.includes('윤재') ||
        v.name.includes('민수') ||
        v.name.includes('남성')
    );
    if (maleVoice) return maleVoice;
  }

  // 기본 한국어 보이스 선택
  const naturalVoice = koreanVoices.find(
    (v) => v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Neural')
  );
  return naturalVoice || koreanVoices[0];
}

async function _speakInternal(text: string, overrideVoiceType?: string): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return;
  }

  const config = await getVoiceAudioConfig(overrideVoiceType);

  return new Promise<void>((resolve) => {
    const synth = window.speechSynthesis;
    synth.cancel();

    const humanized = humanizeSpeechText(text);
    const utterance = new SpeechSynthesisUtterance(humanized);
    utterance.lang = 'ko-KR';
    utterance.rate = config.rate;
    utterance.pitch = config.pitch;
    utterance.volume = 1.0;

    const matchedVoice = selectVoiceForConfig(synth, config);
    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }

    _speaking = true;

    utterance.onend = () => {
      _speaking = false;
      resolve();
    };

    utterance.onerror = () => {
      _speaking = false;
      resolve();
    };

    synth.speak(utterance);
  });
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
 * (자동 알림은 enqueue를 쓰고, 그쪽은 기존대로 이어폰 정책을 지킨다.
 *  예전엔 여기서도 이어폰을 요구해 이어폰 없이 샘플을 누르면 아무 소리가 없었다) */
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
};

export default speechPlayer;
export { isEarphoneConnected, canPlayAudio, speak, enqueue, cancelAll, isSpeaking };
