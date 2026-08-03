// 음성(TTS) 관련 설정을 React 컨텍스트 밖에서 읽는 공용 헬퍼.
//
// [한글 주석] speechPlayer는 알림 큐(컴포넌트 밖)에서 돌기 때문에 usePreferences를 쓸 수 없어
// AsyncStorage를 직접 읽는다. 예전에 플레이어가 존재하지 않는 키('@simplem_user_prefs')를
// 읽어 목소리 설정이 통째로 무시되던 사고가 있었으므로, 읽는 코드를 여기 한 곳에 모은다.
// (웹/네이티브 플레이어가 같은 파일을 공유 → 한쪽만 고쳐지는 일이 없다)
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PREFS_STORAGE_KEY } from '../../preferences/PreferencesContext';

/** 음성 출력 조건 — '항상'이면 스피커로도 읽고, '이어폰'이면 이어폰 연결 시에만 읽는다 */
export type VoiceOutputMode = 'always' | 'earphone';

export type VoicePrefsSnapshot = {
  /** 목소리 타입 (warm_female | friendly_male | calm_male | cute_child) */
  voiceType: string;
  /** 말하는 속도 배율 (1.0 = 보통) */
  speechRate: number;
  /** 음성 출력 조건 */
  outputMode: VoiceOutputMode;
};

export const DEFAULT_VOICE_PREFS: VoicePrefsSnapshot = {
  voiceType: 'warm_female',
  speechRate: 1,
  outputMode: 'always',
};

/** TTS 엔진이 감당하는 범위로 속도 배율을 자른다 (너무 느리면 늘어지고, 너무 빠르면 안 들린다) */
export function clampRate(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0.5, n));
}

/** 설정 화면에서 저장한 음성 설정을 읽어온다 (실패하면 기본값) */
export async function readVoicePrefs(): Promise<VoicePrefsSnapshot> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_PREFS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      voiceType:
        typeof parsed.voiceType === 'string' ? parsed.voiceType : DEFAULT_VOICE_PREFS.voiceType,
      speechRate: clampRate(parsed.speechRate, DEFAULT_VOICE_PREFS.speechRate),
      outputMode:
        parsed.voiceAlertOutput === 'earphone' ? 'earphone' : DEFAULT_VOICE_PREFS.outputMode,
    };
  } catch {
    // 저장소 접근 실패 — 기본값으로 말한다 (침묵하는 것보다 낫다)
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export default readVoicePrefs;
