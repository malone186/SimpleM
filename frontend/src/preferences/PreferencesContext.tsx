// 앱 환경설정(설정 탭) 전역 상태 — AsyncStorage에 영구 저장한다.
// 알림 on/off, AI 리포트 주기, 방해금지 시간, 글자 크기, 다크/라이트, 업종, 구독 요금제를 보관.
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
export type PlanTier = 'free' | 'pro' | 'business';

export type Preferences = {
  // 알림
  lowStockAlert: boolean;   // 재고 부족 알림
  priceSurgeAlert: boolean; // 단가 급등 알림
  reportFrequency: ReportFrequency; // AI 경영 리포트 수신 주기
  dndEnabled: boolean;      // 방해 금지 시간대 사용
  dndStart: string;         // 'HH:MM'
  dndEnd: string;           // 'HH:MM'
  voiceAlertEnabled: boolean; // 알림 음성 읽어주기(TTS) — 이어폰 연결 시 완료 알림을 읽어줌
  voiceAssistantEnabled: boolean; // 음성 비서 버튼 표시 — 우하단 브리핑(📋)·음성 명령(🎤) 버튼
  // 화면 표시 / 접근성
  fontSize: FontSize;
  // 계정 부가정보 (백엔드 User에 필드가 없어 로컬 보관)
  businessType: string;     // 업종
  openHour: string;         // 가게 오픈 시간 ('HH:MM')
  closeHour: string;        // 가게 마감 시간 ('HH:MM')
  // 구독 (데모 — 실제 결제 백엔드 없음)
  plan: PlanTier;
};

const DEFAULTS: Preferences = {
  lowStockAlert: true,
  priceSurgeAlert: true,
  reportFrequency: 'weekly',
  dndEnabled: true,
  dndStart: '22:00',
  dndEnd: '08:00',
  voiceAlertEnabled: true,
  voiceAssistantEnabled: true,
  fontSize: 'normal',
  businessType: '카페',
  openHour: '09:00',
  closeHour: '21:00',
  plan: 'free',
};

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

// 구독 요금제 메타 (데모 가격)
export const PLANS: Record<PlanTier, { label: string; price: number; blurb: string }> = {
  free: { label: 'Free', price: 0, blurb: '기본 재고·발주 관리' },
  pro: { label: 'Pro', price: 29000, blurb: 'AI 리포트·예측·알림 전체' },
  business: { label: 'Business', price: 59000, blurb: '다점포·세무 자동화·우선지원' },
};

type Ctx = Preferences & {
  ready: boolean;
  fontScale: number;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
};

const PreferencesContext = createContext<Ctx | null>(null);
const STORAGE_KEY = 'simplem:preferences';

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
