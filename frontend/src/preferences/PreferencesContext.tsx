// 앱 환경설정(설정 탭) 전역 상태 — AsyncStorage에 영구 저장한다.
// 알림 on/off, AI 리포트 주기, 방해금지 시간, 글자 크기, 다크/라이트, 업종을 보관.
// [단계적 적용] 현재는 설정값을 저장·노출하며, 폰트/테마의 전역 화면 적용은 후속 작업으로 확장한다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type FontSize = 'small' | 'normal' | 'large' | 'xlarge';
export type ReportFrequency = 'daily' | 'weekly';
export type Language = 'ko' | 'en'; // 다국어 언어 지원 타입 (한국어 / 영어)
export type VoiceType = 'warm_female' | 'friendly_male' | 'calm_male' | 'cute_child'; // [한글 주석: 음성 비서 목소리 4가지 타입]
// 알림 음성을 어떤 상황에서 읽어줄지 — 'always'는 스피커 포함 항상, 'earphone'은 이어폰 연결 시에만
export type VoiceAlertOutput = 'always' | 'earphone';

export type Preferences = {
  // 알림
  lowStockAlert: boolean;   // 재고 부족 알림
  priceSurgeAlert: boolean; // 단가 급등 알림
  reportFrequency: ReportFrequency; // AI 경영 리포트 수신 주기
  proactiveInsights: boolean; // 선제 알림 — 매장 데이터에서 찾아낸 '곧 할 일·놓친 일'을 먼저 알려줌
  dndEnabled: boolean;      // 방해 금지 시간대 사용
  dndStart: string;         // 'HH:MM'
  dndEnd: string;           // 'HH:MM'
  voiceAlertEnabled: boolean; // 알림 음성 읽어주기(TTS) — 완료 알림을 음성으로 읽어줌
  voiceAlertOutput: VoiceAlertOutput; // 음성 출력 조건 — 항상 / 이어폰 연결 시에만
  voiceAssistantEnabled: boolean; // 음성 비서 버튼 표시 — 우하단 브리핑(📋)·음성 명령(🎤) 버튼
  // 화면 표시 / 접근성
  fontSize: FontSize;       // 글자 크기
  language: Language;       // 앱 표현 언어 (한국어: 'ko', 영어: 'en')
  voiceType: VoiceType;     // [한글 주석: 음성 비서 목소리 타입 (다정한 여성, 친근한 삼촌, 차분한 젠틀맨, 귀여운 꼬마)]
  speechRate: number;       // 말하는 속도 배율 (0.75 느리게 ~ 1.35 빠르게, 1 = 보통)
  // 계정 부가정보 (백엔드 User에 필드가 없어 로컬 보관)
  businessType: string;     // 업종
  openHour: string;         // 가게 오픈 시간 ('HH:MM')
  closeHour: string;        // 가게 마감 시간 ('HH:MM')
};

const DEFAULTS: Preferences = {
  lowStockAlert: true,
  priceSurgeAlert: true,
  reportFrequency: 'weekly',
  proactiveInsights: true,
  dndEnabled: true,
  dndStart: '22:00',
  dndEnd: '08:00',
  voiceAlertEnabled: true,
  // [한글 주석] 기본을 '항상'으로 둔 이유: 예전 기본값('이어폰 연결 시에만')은 안드로이드
  // 이어폰 감지가 false negative를 자주 내는 탓에 "이어폰을 꼈는데도 아무 말을 안 하는"
  // 상태로 이어졌다. 조용한 실패보다 들리는 쪽을 기본으로 두고, 매장 스피커로 나가는 게
  // 싫은 사장님은 '이어폰 연결 시에만'을 고르면 된다.
  voiceAlertOutput: 'always',
  voiceAssistantEnabled: true,
  fontSize: 'normal',
  language: 'ko', // 기본 언어: 한국어
  voiceType: 'warm_female', // 기본 목소리: 다정한 여성
  speechRate: 1, // 기본 속도: 보통
  businessType: '카페',
  openHour: '09:00',
  closeHour: '21:00',
};

export const VOICE_TYPE_LABEL: Record<VoiceType, { title: string; desc: string }> = {
  warm_female: { title: '다정한 여성', desc: '화사하고 부드러운 아나운서 톤' },
  friendly_male: { title: '친근한 삼촌', desc: '묵직하고 친근한 아저씨 톤' },
  calm_male: { title: '차분한 남성', desc: '낮고 안정감 있는 젠틀맨 톤' },
  cute_child: { title: '귀여운 아이', desc: '톡톡 튀고 발랄한 꼬마 톤' },
};

// [한글 주석] 말하는 속도 단계 — 슬라이더 대신 5단계로 고정한 이유:
// 사장님이 값을 미세 조정하는 것보다 "느리게/보통/빠르게"를 한 번에 고르는 쪽이 빠르고,
// 단계마다 샘플을 들려주면 바로 비교가 된다. 값은 TTS 엔진이 자연스러운 구간(0.75~1.35)만 쓴다.
export const SPEECH_RATE_STEPS: { value: number; label: string; hint: string }[] = [
  { value: 0.75, label: '아주 느리게', hint: '또박또박 천천히' },
  { value: 0.9, label: '느리게', hint: '조금 여유 있게' },
  { value: 1, label: '보통', hint: '기본 속도' },
  { value: 1.15, label: '빠르게', hint: '조금 서둘러' },
  { value: 1.35, label: '아주 빠르게', hint: '핵심만 빠르게' },
];

/** 저장된 속도값과 가장 가까운 단계를 찾아준다 (예전 버전에서 저장된 값 대비) */
export function nearestSpeechRate(value: number): number {
  return SPEECH_RATE_STEPS.reduce(
    (best, step) =>
      Math.abs(step.value - value) < Math.abs(best - value) ? step.value : best,
    SPEECH_RATE_STEPS[2].value
  );
}

// 글자 크기 → 배율 (전역 적용 시 곱해 쓸 값)
export const FONT_SCALE: Record<FontSize, number> = {
  small: 0.9,
  normal: 1,
  large: 1.15,
  xlarge: 1.3,
};

export const FONT_SIZE_LABEL: Record<FontSize, string> = {
  small: '작게',
  normal: '보통',
  large: '크게',
  xlarge: '아주 크게',
};

// 언어 선택용 라벨 매핑 (한국어 / English)
export const LANGUAGE_LABEL: Record<Language, string> = {
  ko: '한국어',
  en: 'English',
};

type Ctx = Preferences & {
  ready: boolean;
  fontScale: number;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
};

const PreferencesContext = createContext<Ctx | null>(null);
// speechPlayer(.web).ts가 React 컨텍스트 밖(음성 큐)에서 voiceType을 읽을 때 같은 키를 쓴다.
// 예전에 플레이어가 존재하지 않는 키(@simplem_user_prefs)를 읽어 목소리 설정이
// TTS에 전혀 반영되지 않던 사고가 있어, 키를 여기 한 곳에서만 정의해 내보낸다.
export const PREFS_STORAGE_KEY = 'simplem:preferences';
const STORAGE_KEY = PREFS_STORAGE_KEY;

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [ready, setReady] = useState(false);

  // 앱 구동 시 저장된 설정 복원
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setPrefs((p) => ({ ...p, ...(JSON.parse(raw) as Partial<Preferences>) }));
      } catch (err) {
        console.error('설정 복원 실패:', err);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setPref = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPrefs((prev) => {
        const next = { ...prev, [key]: value };
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    []
  );

  return (
    <PreferencesContext.Provider
      value={{ ...prefs, ready, fontScale: FONT_SCALE[prefs.fontSize], setPref }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within PreferencesProvider');
  return ctx;
}
