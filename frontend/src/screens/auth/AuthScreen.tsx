// 로그인 / 회원가입 화면 — 미로그인 시 이 화면만 노출 (2단계 가게 상세 설정 폼 추가)
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';

import { useAuth } from '../../auth/AuthContext';
import { usePreferences } from '../../preferences/PreferencesContext';
import { API_BASE_URL } from '../../lib/api/client';
import { getGpsPosition } from '../../lib/api/forecast';
import { NAVER_CLIENT_ID, NAVER_MAP_ERROR, loadNaverMaps } from '../../lib/naverMap';
import { FadeInUp, PressableScale } from '../../components/motion';
import { IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { colors, spacing, typography } from '../../theme';
import { s, useBottomInset, useResponsive, useTopInset } from '../../theme/responsive';

const LOGO = require('../../../assets/brewnote_welcome_mascot.png'); // [한글 주석] 로그인/로그아웃 화면 로고 — 사장님 요청 귀여운 BREWNOTE 강아지 마스코트

type Mode = 'login' | 'signup';

/** 좌표 → 주소. 네이버 전용(백엔드 NCP Reverse Geocoding 프록시).
 *  실패하면 undefined — 다른 지도 서비스로 폴백하지 않는다. */
async function reverseGeocodeViaNaver(lat: number, lon: number): Promise<string | undefined> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/reverse-geocode?lat=${lat}&lon=${lon}`);
    if (!res.ok) return undefined;
    const d = await res.json();
    return typeof d?.address === 'string' && d.address ? d.address : undefined;
  } catch {
    return undefined;
  }
}

// [비밀번호 유출 경고 차단] 크롬·구글 비밀번호 관리자는 type="password" 필드로 로그인하면
// 입력값을 유출 DB와 대조해 "비밀번호가 유출되었습니다" 팝업을 띄운다(사이트가 끌 수 있는 공식 API 없음).
// - 웹: 필드를 일반 텍스트 입력으로 두고 CSS(-webkit-text-security)로만 가림표시 → 크롬이
//   비밀번호 필드로 인식하지 못해 유출 검사·저장 팝업이 아예 발생하지 않는다.
//   (해당 CSS 미지원 브라우저는 평문 노출을 막기 위해 기존 secureTextEntry 유지 — 유출 팝업은 크롬 전용이라 무방)
// - 앱: 자동완성·자동저장을 꺼서 구글 비밀번호 관리자가 개입하지 않게 한다.
const webSupportsTextSecurity =
  Platform.OS === 'web' &&
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('-webkit-text-security', 'disc');

// hidden=false 면 눈 아이콘으로 "보기"를 켠 상태 — 가림 처리를 모두 풀어 평문으로 보여준다.
//
// autoCapitalize:'none' / autoCorrect:false 는 반드시 있어야 한다 — '보기'를 켜면 secureTextEntry가
// 꺼져 일반 텍스트 입력이 되는데, 이게 없으면 키보드가 비밀번호 첫 글자를 자동 대문자로 바꾼다.
// 그러면 재설정 때(보기 켜고 입력) 대문자로 저장되고 로그인 때(가림, 소문자) 달라져 "비밀번호 불일치"가 난다.
const passwordFieldProps = (hidden: boolean): Partial<React.ComponentProps<typeof TextInput>> => {
  const common = {
    autoCapitalize: 'none' as const,
    autoCorrect: false,
    autoComplete: 'off' as const,
  };
  if (Platform.OS === 'web') {
    return webSupportsTextSecurity
      ? { ...common, secureTextEntry: false, style: { WebkitTextSecurity: hidden ? 'disc' : 'none' } as any }
      : { ...common, secureTextEntry: hidden };
  }
  return {
    ...common,
    secureTextEntry: hidden,
    importantForAutofill: 'no',
    textContentType: 'oneTimeCode',
  };
};

// 상권 유형 옵션 (이모지 전면 제거 및 텍스트 정돈)
const BIZ_TYPES = ['오피스 상권', '주택가 상권', '대학가 상권', '복합 상권'];

// 유입 경로 옵션 — key는 백엔드 정규 채널 키, label은 화면 표시용 (관리자 콘솔 분류와 1:1)
const ACQUISITION_OPTIONS: { key: string; label: string }[] = [
  { key: 'referral', label: '지인 추천' },
  { key: 'web_search', label: '포털/검색' },
  { key: 'instagram', label: '인스타그램' },
  { key: 'app_store', label: '앱스토어' },
  { key: 'youtube', label: '유튜브' },
  { key: 'naver_blog', label: '블로그' },
  { key: 'etc', label: '기타' },
];

// [한글 주석] 알바생 근무 시간대 설정 UI 스타일 세그먼트 시간 피커 (오픈/마감 카드 선택 폼)
function ShiftTimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const currentHour = parseInt(value.split(':')[0], 10) || 9;
  const currentMinute = parseInt(value.split(':')[1], 10) || 0;

  const hours = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  const minutes = [0, 15, 30, 45];

  const selectHour = (h: number) => {
    const hh = String(h).padStart(2, '0');
    const mm = String(currentMinute).padStart(2, '0');
    onChange(`${hh}:${mm}`);
  };

  const selectMinute = (m: number) => {
    const hh = String(currentHour).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    onChange(`${hh}:${mm}`);
  };

  return (
    <View style={styles.shiftPickerPanel}>
      <Text style={styles.shiftSubLabel}>시간 선택</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {hours.map((h) => {
          const active = currentHour === h;
          return (
            <PressableScale
              key={h}
              onPress={() => selectHour(h)}
              style={[styles.chip, active && styles.chipActive]}
              to={0.94}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {String(h).padStart(2, '0')}시
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>

      <Text style={[styles.shiftSubLabel, { marginTop: 8 }]}>분 선택</Text>
      <View style={styles.chipRow}>
        {minutes.map((m) => {
          const active = currentMinute === m;
          return (
            <PressableScale
              key={m}
              onPress={() => selectMinute(m)}
              style={[styles.chip, active && styles.chipActive]}
              to={0.94}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {String(m).padStart(2, '0')}분
              </Text>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

export default function AuthScreen() {
  // [한글 주석] 헤더 없는 전체 화면 — 노치·제스처 바 여백과 기기 급수를 직접 계산한다
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { gutter, isWide, vw, vh } = useResponsive();
  const {
    login, signup, loginWithGoogle,
    firebaseAuthEnabled, sendResetEmail,   // 팀원: 비밀번호 재설정 메일
    loginAsStaff,                          // 직원 계정 로그인
  } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const prefs = usePreferences(); // 가입 때 받은 운영 시간을 기기 설정에 남기기 위해
  const [step, setStep] = useState<1 | 2>(1); // [한글 주석] 회원가입 1단계/2단계 구분 상태

  // 1단계 기본 정보
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // [한글 주석] 직원 로그인 — 계산대에 서는 알바생용.
  // 사장님 계정에는 매출·정산·급여가 다 보여서 넘길 수 없으므로 별도 계정으로 들어온다.
  const [staffMode, setStaffMode] = useState(false);
  const [staffId, setStaffId] = useState('');
  const [staffPw, setStaffPw] = useState('');

  const [phone, setPhone] = useState(''); // 아이디/비밀번호 찾기 본인 확인용 (선택 입력)
  const [autoLogin, setAutoLogin] = useState(true);

  // 2단계 가게 상세 설정 정보
  // 매장 주소는 빈칸에서 시작한다 — 예시 주소를 미리 넣어두면 그대로 가입해 버리는 사고가 난다.
  // 사용자가 직접 입력하거나, 현위치 버튼 / 지도 핀으로 채운다.
  const [region, setRegion] = useState('');
  const [openHour, setOpenHour] = useState('09:00');
  const [closeHour, setCloseHour] = useState('21:00');
  const [bizType, setBizType] = useState('오피스 상권');
  const [acquisition, setAcquisition] = useState<string>(''); // [유입 경로] 선택값(미선택 허용)
  // [한글 주석] 네이버 지도 위치 선택 모달 표시 여부 상태 복원
  const [showMapModal, setShowMapModal] = useState(false);
  // 지도 핀으로 확정한 매장 좌표 — 가입 완료 시 저장되어 대시보드 예측(날씨·행사)에 그대로 쓰인다
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  // 모달의 "주소 검색" 버튼이 지도 초기화 이후 생성되는 검색 함수를 호출할 수 있게 ref로 연결
  const mapSearchRef = useRef<((query: string) => void) | null>(null);
  // "현위치" 버튼이 지도 핀을 임의 좌표로 옮길 수 있게 ref로 연결 (웹 전용 — 앱은 WebView 주입)
  const mapPinRef = useRef<((lat: number, lon: number) => void) | null>(null);
  // 앱(네이티브)의 지도 WebView — 검색 결과 좌표를 지도에 반영할 때 사용
  const mapWebViewRef = useRef<WebView>(null);
  // 지도 모달 안내 문구 (검색 중 / 결과 없음 피드백)
  const [mapNotice, setMapNotice] = useState('');
  // [한글 주석] 약관 동의 상태 및 상세보기 모달 상태
  const [termService, setTermService] = useState(false);
  const [termPrivacy, setTermPrivacy] = useState(false);
  const [termMarketing, setTermMarketing] = useState(false);
  const [termsModal, setTermsModal] = useState<{ visible: boolean; title: string; content: string }>({
    visible: false,
    title: '',
    content: '',
  });

  // [한글 주석] 아이디 / 비밀번호 찾기 모달 상태 — 백엔드 /auth/find-email·/auth/reset-password 실연동
  const [showFindModal, setShowFindModal] = useState(false);
  const [findTab, setFindTab] = useState<'id' | 'pw'>('id');
  const [findNameInput, setFindNameInput] = useState(''); // 상호명 (두 탭 공용 — 본인 확인용)
  const [findPhoneInput, setFindPhoneInput] = useState(''); // [한글 주석] 동일 상호 중복 구분용 (휴대폰 번호 / 사업자번호)
  const [findEmailInput, setFindEmailInput] = useState('');
  const [findNewPwInput, setFindNewPwInput] = useState(''); // 재설정할 새 비밀번호
  const [findBusy, setFindBusy] = useState(false);
  // [한글 주석] 비밀번호 재설정 방식 — 'mail'은 Firebase 재설정 링크, 'verify'는 본인확인 후 즉시 변경.
  //
  // 계정이 사는 곳이 두 군데다(auth/loginFallback.ts 참고). 데모 계정과 백엔드로 가입한
  // 계정은 Firebase에 없어서 재설정 메일이 아예 발송되지 않는데, 화면은 계정 존재를 숨기려고
  // "가입된 이메일이면 보냈어요"라고만 하니 사장님은 오지 않는 메일을 계속 기다리게 됐다.
  // 그래서 메일을 못 받았을 때 쓸 수 있는 본인확인 재설정을 항상 열어 둔다.
  const [resetMode, setResetMode] = useState<'mail' | 'verify'>('mail');
  const submitStaff = async () => {
    if (!staffId.trim() || !staffPw.trim()) {
      setError('아이디와 비밀번호를 입력해 주세요.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      // 자동 로그인 체크박스를 존중한다 — 공용 계산대 기기에서 무조건 세션을 디스크에
      // 남기던(true 고정) 동작은 화면의 체크박스와 어긋났다.
      await loginAsStaff(staffId.trim(), staffPw, autoLogin);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const [findResult, setFindResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // [에러 문구 정제] 서버 detail이 문장(string)일 때만 그대로 쓰고, 그 외(422 배열·HTML 등)는
  // 준비된 한글 안내문으로 바꾼다 — 사용자에게 코드/원시 응답이 보이는 일이 없게.
  const friendlyDetail = (data: any, fallback: string): string =>
    typeof data?.detail === 'string' && data.detail.trim() ? data.detail : fallback;

  // [아이디 찾기] 상호명 + 휴대폰 번호(또는 사업자번호)로 조회 → 마스킹된 이메일 목록 표시
  // (원본 이메일은 서버가 노출하지 않음. 휴대폰 미등록 기존 계정은 상호명만으로 조회됨)
  const submitFindEmail = async () => {
    if (!findNameInput.trim()) {
      setFindResult({ type: 'error', message: '상호명 또는 매장 이름을 입력해 주세요.' });
      return;
    }
    if (!findPhoneInput.trim()) {
      setFindResult({ type: 'error', message: '등록된 휴대폰 번호 또는 사업자번호를 입력해 주세요.' });
      return;
    }
    setFindBusy(true);
    setFindResult(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/find-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_name: findNameInput.trim(), phone: findPhoneInput.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFindResult({
          type: 'error',
          message: friendlyDetail(data, '입력하신 상호명으로 가입된 계정을 찾지 못했어요.\n가입할 때 등록한 상호명(매장 이름)을 그대로 입력해 주세요.'),
        });
        return;
      }
      const lines = (data.accounts as { masked_email: string; created_at: string }[])
        .map((a) => `• ${a.masked_email}  (가입일 ${a.created_at.slice(0, 10)})`)
        .join('\n');
      setFindResult({
        type: 'success',
        message: `'${findNameInput.trim()}' 상호로 가입된 계정을 찾았습니다!\n\n${lines}`,
      });
    } catch {
      setFindResult({ type: 'error', message: '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.' });
    } finally {
      setFindBusy(false);
    }
  };

  // [비밀번호 재설정] 메일 인프라가 없어 링크 발송 대신 이메일 + 휴대폰 번호(미등록 계정은 상호명)
  // 본인확인 후 즉시 재설정
  const submitResetPassword = async () => {
    if (!findEmailInput.trim() || !findEmailInput.includes('@')) {
      setFindResult({ type: 'error', message: '올바른 이메일 주소를 입력해 주세요.' });
      return;
    }
    if (!findPhoneInput.trim()) {
      setFindResult({ type: 'error', message: '본인 확인을 위해 가입 시 등록한 휴대폰 번호(미등록 시 상호명)를 입력해 주세요.' });
      return;
    }
    if (findNewPwInput.length < 4) {
      setFindResult({ type: 'error', message: '새 비밀번호는 4자 이상으로 입력해 주세요.' });
      return;
    }
    setFindBusy(true);
    setFindResult(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: findEmailInput.trim(),
          verify: findPhoneInput.trim(),
          new_password: findNewPwInput,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFindResult({
          type: 'error',
          message: friendlyDetail(
            data,
            '이메일과 상호명이 일치하는 계정을 찾지 못했어요.\n가입할 때 사용한 이메일과 상호명을 다시 확인해 주세요.',
          ),
        });
        return;
      }
      setFindNewPwInput('');
      setFindResult({
        type: 'success',
        message: '비밀번호가 변경되었습니다.\n새 비밀번호로 바로 로그인해 주세요.',
      });
    } catch {
      setFindResult({ type: 'error', message: '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.' });
    } finally {
      setFindBusy(false);
    }
  };

  // [Firebase 비밀번호 재설정 메일] 로그인이 Firebase 비밀번호를 검증하므로, 재설정도 Firebase 메일이
  // 정답이다(백엔드 비번만 바꾸면 로그인은 그대로 실패한다). 이메일만 받아 재설정 링크를 보낸다.
  const submitResetEmail = async () => {
    if (!findEmailInput.trim() || !findEmailInput.includes('@')) {
      setFindResult({ type: 'error', message: '올바른 이메일 주소를 입력해 주세요.' });
      return;
    }
    setFindBusy(true);
    setFindResult(null);
    try {
      await sendResetEmail(findEmailInput.trim());
      setFindResult({
        type: 'success',
        message: '가입된 이메일이면 비밀번호 재설정 메일을 보냈어요.\n메일함(스팸함 포함)의 링크에서 새 비밀번호를 설정한 뒤 로그인해 주세요.',
      });
    } catch (e) {
      setFindResult({ type: 'error', message: e instanceof Error ? e.message : '재설정 메일 발송에 실패했어요.' });
    } finally {
      setFindBusy(false);
    }
  };

  const allTermsChecked = termService && termPrivacy && termMarketing;

  const toggleAllTerms = () => {
    const next = !allTermsChecked;
    setTermService(next);
    setTermPrivacy(next);
    setTermMarketing(next);
  }; // 네이버 지도 위치 선택 모달
  const [activeTimePicker, setActiveTimePicker] = useState<'open' | 'close' | null>(null); // [한글 주석] 알바생 스케줄 스타일 시간대 선택 활성화 상태

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // [회원가입 지도 핀 훅] 공용 로더(lib/naverMap)로 네이버 SDK를 올린다.
  // 이전 iframe(m.map.naver.com) 방식은 네이버가 외부 삽입을 차단(X-Frame-Options)해 빈 화면이 됐다.
  // 지도 클릭 → 핀 이동 + 역지오코딩으로 주소 자동 입력, 주소 검색 → 지오코딩으로 핀 이동.
  // 네이버 지도 전용 — 인증/로딩이 실패하면 다른 지도로 바꾸지 않고 안내 문구만 띄운다.
  useEffect(() => {
    if (Platform.OS !== 'web' || !showMapModal) return;
    let disposed = false;

    const startLat = coords?.lat ?? 37.5665;
    const startLon = coords?.lon ?? 126.978;

    const applyPick = (lat: number, lon: number, address?: string) => {
      if (disposed) return;
      setCoords({ lat, lon });
      if (address) setRegion(address);
    };

    // 역지오코딩도 네이버 전용 — 백엔드(NCP Reverse Geocoding) 프록시를 쓴다.
    // OSM(Nominatim) 폴백 없음. 실패하면 주소는 비워 두고 사용자가 직접 입력한다.
    const reverseGeocode = reverseGeocodeViaNaver;

    const searchGeocode = async (query: string): Promise<{ lat: number; lon: number; label?: string } | null> => {
      const q = query.trim();
      if (!q) return null;
      // 1순위: 백엔드 지오코딩 프록시 — 광역 지명 축약 재시도까지 해줘서 한국 주소 적중률이 가장 높다
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/geocode?query=${encodeURIComponent(q)}`);
        if (res.ok) {
          const d = await res.json();
          if (typeof d?.lat === 'number' && typeof d?.lon === 'number') {
            return { lat: d.lat, lon: d.lon, label: d.address || undefined };
          }
        }
      } catch {
        // 백엔드 미기동 시 아래 폴백으로 진행
      }
      // 2순위: 네이버 JS SDK 지오코더 (NCP Geocoding 사용 신청이 되어 있을 때만 동작)
      const naverObj = (window as any).naver;
      if (naverObj?.maps?.Service?.geocode) {
        const viaNaver = await new Promise<{ lat: number; lon: number; label?: string } | null>((resolve) => {
          try {
            naverObj.maps.Service.geocode({ query: q }, (status: any, response: any) => {
              const item = response?.v2?.addresses?.[0];
              if (status === naverObj.maps.Service.Status.OK && item) {
                resolve({ lat: parseFloat(item.y), lon: parseFloat(item.x), label: item.roadAddress || item.jibunAddress });
              } else {
                resolve(null);
              }
            });
          } catch {
            resolve(null);
          }
        });
        if (viaNaver) return viaNaver;
      }
      // OSM(Photon·Nominatim) 폴백은 제거했다 — 네이버 지도 전용.
      // 둘 다 실패하면 null이고, 호출부가 "검색 결과가 없다"고 안내한다.
      return null;
    };

    const initNaverPicker = () => {
      try {
        const container = document.getElementById('signup-map-container');
        if (!container) return;
        container.innerHTML = '';
        const naverObj = (window as any).naver;
        if (!naverObj?.maps) {
          setMapNotice(NAVER_MAP_ERROR);
          return;
        }

        const map = new naverObj.maps.Map(container, {
          center: new naverObj.maps.LatLng(startLat, startLon),
          zoom: 15,
          zoomControl: false,
        });
        const marker = new naverObj.maps.Marker({
          position: new naverObj.maps.LatLng(startLat, startLon),
          map,
          draggable: true,
          icon: {
            content:
              '<div style="width:18px;height:18px;background:#E28257;border:3px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.35)"></div>',
            anchor: new naverObj.maps.Point(9, 9),
          },
        });

        const pick = async (latlng: any) => {
          setMapNotice('');
          marker.setPosition(latlng);
          const lat = latlng.lat();
          const lon = latlng.lng();
          applyPick(lat, lon);
          const addr = await reverseGeocode(lat, lon);
          if (addr) applyPick(lat, lon, addr);
        };

        naverObj.maps.Event.addListener(map, 'click', (e: any) => pick(e.coord));
        naverObj.maps.Event.addListener(marker, 'dragend', () => pick(marker.getPosition()));

        mapSearchRef.current = async (query: string) => {
          setMapNotice('🔍 주소를 찾는 중…');
          const found = await searchGeocode(query);
          if (disposed) return;
          if (!found) {
            setMapNotice('주소를 찾지 못했어요. 도로명주소를 좀 더 구체적으로 입력해 주세요.');
            return;
          }
          const latlng = new naverObj.maps.LatLng(found.lat, found.lon);
          map.setCenter(latlng);
          map.setZoom(16);
          marker.setPosition(latlng);
          // 찾은 명칭·주소를 입력창에 채운다 ('협성대' → '경기도 화성시 봉담읍 협성대학교')
          applyPick(found.lat, found.lon, found.label);
          setMapNotice(found.label ? `📍 ${found.label}` : '📍 위치로 이동했어요. 핀을 눌러 미세 조정할 수 있어요.');
        };

        // "현위치" 버튼 → 지도·핀을 해당 좌표로 이동시키고 역지오코딩 주소까지 채운다
        mapPinRef.current = (lat: number, lon: number) => {
          const latlng = new naverObj.maps.LatLng(lat, lon);
          map.setCenter(latlng);
          map.setZoom(16);
          pick(latlng);
        };

        // 모달을 열 때 핀 미확정이면 현위치를 먼저 시도하고, 실패(권한 거부 등) 시 입력된 주소로 이동
        if (!coords) {
          getGpsPosition().then((pos) => {
            if (disposed) return;
            if (pos) mapPinRef.current?.(pos.lat, pos.lon);
            else if (region.trim()) mapSearchRef.current?.(region);
          });
        }
      } catch (err) {
        console.error('네이버 지도 핀 초기화 실패:', err);
        setMapNotice(NAVER_MAP_ERROR);
      }
    };


    // 네이버 지도 전용 — 공용 로더가 SDK를 문서당 한 번만 올린다(중복 로드로 지도가 안 뜨던 문제).
    // 실패하면 다른 지도로 바꾸지 않고 안내 문구만 띄운다.
    const timer = setTimeout(() => {
      loadNaverMaps()
        .then(() => {
          if (!disposed) initNaverPicker();
        })
        .catch((err: Error) => {
          if (disposed) return;
          console.error('네이버 지도 로딩 실패:', err);
          setMapNotice(err.message || NAVER_MAP_ERROR);
        });
    }, 50);

    return () => {
      disposed = true;
      clearTimeout(timer);
      mapSearchRef.current = null;
      mapPinRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMapModal]);

  // [앱(네이티브) 지도 검색] 웹 훅은 DOM에 의존해 네이티브에서 동작하지 않으므로 별도로 연결한다.
  // 백엔드 지오코딩으로 좌표를 얻어 상태에 반영하고, WebView 지도의 핀도 그 위치로 옮긴다.
  useEffect(() => {
    if (Platform.OS === 'web' || !showMapModal) return;
    mapSearchRef.current = async (query: string) => {
      const q = query.trim();
      if (!q) return;
      setMapNotice('🔍 주소를 찾는 중…');
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/geocode?query=${encodeURIComponent(q)}`);
        if (res.ok) {
          const d = await res.json();
          if (typeof d?.lat === 'number' && typeof d?.lon === 'number') {
            setCoords({ lat: d.lat, lon: d.lon });
            if (d.address) setRegion(d.address);
            setMapNotice('');
            mapWebViewRef.current?.injectJavaScript(
              `window.setPin && window.setPin(${d.lat}, ${d.lon}, ${JSON.stringify(d.address || '')}); true;`,
            );
            return;
          }
        }
        setMapNotice('검색 결과가 없어요. 도로명 주소나 가게 이름으로 다시 시도해 주세요.');
      } catch {
        setMapNotice('검색에 실패했어요. 네트워크를 확인해 주세요.');
      }
    };
    return () => {
      mapSearchRef.current = null;
    };
  }, [showMapModal]);

  // [현위치 등록] 기기 GPS를 받아 지도 핀·좌표·주소를 한 번에 채운다 (웹·앱 공용).
  // silent=true는 모달을 열 때의 자동 시도 — 실패해도 안내 문구로 사용자를 방해하지 않는다.
  const applyMyLocation = async (silent = false) => {
    if (!silent) setMapNotice('📡 현위치를 찾는 중…');
    // 매장 위치 등록은 정확도가 중요 — 새 측위를 먼저 시도 (지도 표시용 빠른 경로와 다름)
    const pos = await getGpsPosition({ preferFresh: true });
    if (!pos) {
      if (!silent) setMapNotice('현위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.');
      return;
    }
    if (Platform.OS === 'web') {
      if (mapPinRef.current) {
        // 지도가 떠 있으면 핀 이동이 역지오코딩까지 처리한다
        mapPinRef.current(pos.lat, pos.lon);
      } else {
        // 지도 초기화 전이어도 주소는 채워 준다 — 현위치를 눌렀으면 주소가 보여야 한다
        setCoords(pos);
        const addr = await reverseGeocodeViaNaver(pos.lat, pos.lon);
        if (addr) setRegion(addr);
        if (!silent) setMapNotice(addr ? '' : '현위치 주소를 찾지 못했어요. 주소를 직접 입력해 주세요.');
      }
    } else {
      setCoords(pos);
      // picker.html의 setPin이 지도 이동 + 역지오코딩 주소를 postMessage로 돌려준다
      mapWebViewRef.current?.injectJavaScript(
        `window.setPin && window.setPin(${pos.lat}, ${pos.lon}); true;`,
      );
      // WebView가 아직 안 떴을 수도 있으니 주소는 여기서도 직접 채운다
      const addr = await reverseGeocodeViaNaver(pos.lat, pos.lon);
      if (addr) setRegion(addr);
      if (!silent) setMapNotice(addr ? '' : '현위치 주소를 찾지 못했어요. 주소를 직접 입력해 주세요.');
    }
  };

  // 가입 비밀번호 최소 길이 — 계정이 어디에 만들어지느냐에 따라 다르다.
  // Firebase가 켜져 있으면 Firebase가 6자 미만을 거절하고(auth/weak-password),
  // 꺼져 있으면 백엔드 스키마 기준(min_length=4)이다.
  const minPasswordLength = firebaseAuthEnabled ? 6 : 4;

  // 1단계 ➡️ 2단계 이동 검증
  const goToNextStep = () => {
    setError('');
    if (!name.trim()) {
      setError('이름(상호)을 입력해 주세요.');
      return;
    }
    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.');
      return;
    }
    // [한글 주석] 자릿수는 여기서 막는다.
    // 예전엔 통과시켜서, 지도 핀·운영시간·약관까지 다 채우고 마지막 '가입' 버튼에서야
    // "비밀번호가 너무 취약합니다"가 떴다. 처음 화면에서 걸러야 다시 입력할 게 없다.
    if (password.length < minPasswordLength) {
      setError(`비밀번호는 ${minPasswordLength}자 이상으로 입력해 주세요.`);
      return;
    }
    setStep(2);
  };

  const handleDemoLogin = async () => {
    // [한글 주석: 사장님이 클릭 한 번으로 바로 체험할 수 있는 1초 데모 로그인]
    setError('');
    setEmail('owner@cafe.com');
    setPassword('owner1234');
    setBusy(true);
    try {
      await login('owner@cafe.com', 'owner1234', true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '데모 로그인 중 문제가 발생했어요.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError('');
    if (mode === 'login') {
      if (!email.trim() || !password) {
        setError('이메일과 비밀번호를 입력해 주세요.');
        return;
      }
      if (!email.includes('@')) {
        setError('올바른 이메일 형식(예: owner@cafe.com)으로 입력해 주세요.');
        return;
      }
      setBusy(true);
      try {
        await login(email.trim(), password, autoLogin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('value is not a valid email address')) {
          setError('이메일에 @ 기호를 포함해 주세요 (예: owner@cafe.com)');
        } else {
          setError(msg || '로그인에 실패했어요. 아이디와 비밀번호를 확인해 주세요.');
        }
      } finally {
        setBusy(false);
      }
    } else {
      // 회원가입 제출 (약관 동의 검증)
      if (!termService || !termPrivacy) {
        setError('필수 약관(서비스 이용약관 및 개인정보 수집 이용)에 동의해 주세요.');
        return;
      }
      setBusy(true);
      try {
        // [매장 고정 위치] 지도 핀 좌표를 계정(DB)에 함께 등록한다 —
        // 기기가 바뀌어도 매장 지도가 이 좌표로 고정되고, 주변 카페 분석의 기준점이 된다.
        await signup(name, email, password, autoLogin, acquisition || undefined, phone.trim() || undefined, {
          lat: coords?.lat,
          lon: coords?.lon,
          address: region.trim() || undefined,
          bizType: bizType || undefined,
        });
        // 로컬에도 같은 좌표를 캐시 — 서버 응답 전에 지도를 즉시 그리기 위함
        try {
          await AsyncStorage.setItem(
            'simplem:storeLocation',
            JSON.stringify({ region: region.trim(), lat: coords?.lat, lon: coords?.lon, bizType }),
          );
        } catch {
          // 위치 저장 실패는 가입 자체를 막지 않는다 (예측은 GPS로 폴백)
        }

        // 가입 화면에서 받은 운영 시간을 기기 설정에 남긴다.
        // 예전엔 이 값이 어디에도 저장되지 않아, 화면을 벗어나는 순간 사라졌다(물어본 의미가 없었다).
        // 계정으로는 설정 화면의 resolveStoreProfile이 최초 1회 올려 준다 — 여기서 바로 못 보내는 건
        // 가입 직후엔 아직 토큰이 없을 수 있기 때문이다(자동 로그인 미선택).
        prefs.setPref('openHour', openHour);
        prefs.setPref('closeHour', closeHour);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || '가입 처리 중 문제가 발생했어요.');
      } finally {
        setBusy(false);
      }
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setBusy(true);
    try {
      await loginWithGoogle(autoLogin);
    } catch (e) {
      setError(e instanceof Error ? e.message : '구글 로그인 중 문제가 발생했어요.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setStep(1);
    setError('');
  };

  // [한글 주석] 키보드 가림 처리 — JS 방식(KeyboardAvoidingView).
  // SDK54는 edge-to-edge가 기본이라 네이티브 resize가 키보드를 밀어내지 못한다.
  // 그래서 OS 리사이즈에 기대지 않고, 키보드가 뜨면 JS가 그 높이만큼
  // 화면 아래에 여백을 넣어 입력칸을 키보드 위로 밀어 올린다.
  // (JS 처리라 네이티브 재빌드 없이 OTA로 배포된다.)
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <ScrollView
        // [한글 주석] 로그인 화면은 네비게이터 헤더가 없다 → 노치 실측 높이만큼 직접 띄우고,
        // 좌우 여백도 기기 폭에 맞춘다. 폴드 펼침에서는 입력 폼이 가로로 늘어지지 않게 폭을 묶는다.
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: gutter,
            paddingTop: topInset + s(16),
            paddingBottom: bottomInset + s(96),
          },
          isWide && { maxWidth: 460, width: '100%', alignSelf: 'center' },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* 브랜드 */}
        <FadeInUp>
          <View style={styles.brand}>
            {/* [한글 주석] 화면 폭 비례 + 상한 — 좁은 기기에서 잘리지 않고, 넓은 기기에서 과하지 않게 */}
            <Image
              source={LOGO}
              style={[styles.logo, { width: Math.min(vw(74), 310), height: Math.min(vw(45), 190) }]}
              resizeMode="contain"
            />
            <Text style={styles.brandSub}>카페 사장님을 위한 운영 파트너</Text>
          </View>
        </FadeInUp>

        {/* 로그인 / 회원가입 탭 */}
        <FadeInUp delay={80}>
          <Segmented<Mode>
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'login', label: '로그인' },
              { value: 'signup', label: '회원가입' },
            ]}
          />
        </FadeInUp>

        <FadeInUp delay={160} key={mode}>
          <View style={styles.form}>
            {/* 로그인 모드 폼 */}
            {mode === 'login' ? (
              <>
                <Field
                  icon="mail-outline"
                  placeholder="이메일"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <Field
                  icon="lock-closed-outline"
                  placeholder="비밀번호"
                  value={password}
                  onChangeText={setPassword}
                  secureToggle
                />

                {/* [한글 주석] 자동 로그인 체크박스 및 아이디/비밀번호 찾기 링크 */}
                <View style={styles.loginOptionRow}>
                  <PressableScale style={styles.checkRow} onPress={() => setAutoLogin((v) => !v)} to={0.98}>
                    <View style={[styles.checkbox, autoLogin && styles.checkboxOn]}>
                      {autoLogin && <Ionicons name="checkmark" size={14} color={colors.white} />}
                    </View>
                    <Text style={styles.checkLabel}>자동 로그인</Text>
                  </PressableScale>

                  {/* 두 링크는 한 덩어리로 묶는다 — 행이 space-between이라 따로 두면
                      사이의 구분점이 가운데로 밀려 세 번째 링크처럼 보인다 */}
                  <View style={styles.loginLinkGroup}>
                    <PressableScale
                      onPress={() => {
                        setFindResult(null);
                        setFindNameInput('');
                        setFindPhoneInput('');
                        setFindEmailInput('');
                        setFindNewPwInput('');
                        setResetMode('mail'); // 매번 기본(메일)에서 시작한다
                        setShowFindModal(true);
                      }}
                      to={0.96}
                    >
                      <Text style={styles.findAccountLink}>아이디·비밀번호 찾기</Text>
                    </PressableScale>
                    {/* 구분점은 링크가 아니므로 밑줄을 씌우지 않는다 */}
                    <Text style={styles.linkSeparator}>·</Text>
                    <PressableScale onPress={() => { setError(''); setStaffMode(true); }} to={0.96}>
                      <Text style={styles.findAccountLink}>직원 로그인</Text>
                    </PressableScale>
                  </View>
                </View>

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <PressableScale style={styles.submitBtn} onPress={submit} disabled={busy}>
                  <Text style={styles.submitText}>{busy ? '처리 중…' : '로그인'}</Text>
                </PressableScale>
              </>
            ) : (
              /* 회원가입 모드: 이메일/비밀번호는 기본 표시되고, 상호명을 입력하면 가게 상세 설정 UI가 토스처럼 밑에 등장 */
              <>
                <Field
                  icon="storefront-outline"
                  placeholder="상호 / 이름"
                  value={name}
                  onChangeText={setName}
                />
                <Field
                  icon="mail-outline"
                  placeholder="이메일"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <Field
                  icon="lock-closed-outline"
                  placeholder={`비밀번호 (${minPasswordLength}자 이상)`}
                  value={password}
                  onChangeText={setPassword}
                  secureToggle
                />
                <Field
                  icon="call-outline"
                  placeholder="휴대폰 번호 (아이디·비밀번호 찾기에 사용)"
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                />

                {/* [한글 주석: 토스 스타일 인터랙션] 상호명을 입력하면 가게 설정 UI와 완료 버튼이 부드럽게 스르륵 밑에 떠오릅니다 */}
                {name.trim().length > 0 && (
                  <FadeInUp key="toss-store-reveal" delay={50} style={{ gap: 14, marginTop: 6 }}>
                    {/* 1. 가게 위치 설정 */}
                    <View style={styles.group}>
                      <Text style={styles.groupLabel}>가게 위치 설정</Text>
                      <View style={styles.locationInputRow}>
                        <TextInput
                          style={[styles.input, { flex: 1 }]}
                          value={region}
                          onChangeText={setRegion}
                          placeholder="가게 주소 / 지역명 입력"
                        />
                        <PressableScale
                          style={styles.mapPinBtn}
                          onPress={() => setShowMapModal(true)}
                          to={0.93}
                        >
                          <Ionicons name="map-outline" size={14} color={colors.white} />
                          <Text style={styles.mapPinBtnText}>네이버 지도 핀</Text>
                        </PressableScale>
                      </View>
                    </View>

                    {/* 2. 오픈 시간 & 마감 시간 설정 (알바생 스케줄 시간 피커 IosTimePicker UI 그대로 적용) */}
                    <View style={styles.group}>
                      <Text style={styles.groupLabel}>가게 운영 시간</Text>
                      <IosTimePicker
                        value={`${openHour.slice(0, 2)}–${closeHour.slice(0, 2)}`}
                        startLabel="오픈 시간"
                        endLabel="마감 시간"
                        onChange={(val) => {
                          const parts = val.split(/[–-]/);
                          if (parts[0]) setOpenHour(`${parts[0].trim().padStart(2, '0')}:00`);
                          if (parts[1]) setCloseHour(`${parts[1].trim().padStart(2, '0')}:00`);
                        }}
                      />
                    </View>

                    {/* 3. 상권 유형 선택 (한 줄에 전부 들어가도록 레이아웃 정렬) */}
                    <View style={styles.group}>
                      <Text style={styles.groupLabel}>상권 유형</Text>
                      <View style={styles.chipRow}>
                        {BIZ_TYPES.map((bt) => (
                          <PressableScale
                            key={bt}
                            onPress={() => setBizType(bt)}
                            style={[styles.chip, bizType === bt && styles.chipActive]}
                          >
                            <Text style={[styles.chipText, bizType === bt && styles.chipTextActive]}>{bt}</Text>
                          </PressableScale>
                        ))}
                      </View>
                    </View>

                    {/* 3-b. 유입 경로 선택 (선택 사항) — 어떻게 알게 되셨는지 */}
                    <View style={styles.group}>
                      <Text style={styles.groupLabel}>어떻게 알게 되셨나요? (선택)</Text>
                      <View style={styles.chipRow}>
                        {ACQUISITION_OPTIONS.map((opt) => (
                          <PressableScale
                            key={opt.key}
                            onPress={() => setAcquisition((prev) => (prev === opt.key ? '' : opt.key))}
                            style={[styles.chip, styles.acqChip, acquisition === opt.key && styles.chipActive]}
                          >
                            <Text
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              style={[styles.chipText, styles.acqChipText, acquisition === opt.key && styles.chipTextActive]}
                            >
                              {opt.label}
                            </Text>
                          </PressableScale>
                        ))}
                      </View>
                    </View>

                    {/* 4. [한글 주석] 약관 동의 세부 UI 영역 */}
                    <View style={styles.termsBox}>
                      {/* 전체 동의 버튼 */}
                      <PressableScale style={styles.termRowAll} onPress={toggleAllTerms} to={0.98}>
                        <View style={[styles.checkbox, allTermsChecked && styles.checkboxOn]}>
                          {allTermsChecked && <Ionicons name="checkmark" size={14} color={colors.white} />}
                        </View>
                        <Text style={styles.termTextAll}>약관 전체 동의</Text>
                      </PressableScale>

                      <View style={styles.termDivider} />

                      {/* (필수) 서비스 이용약관 */}
                      <View style={styles.termRowItem}>
                        <PressableScale style={styles.termCheckLeft} onPress={() => setTermService(!termService)} to={0.98}>
                          <View style={[styles.checkbox, termService && styles.checkboxOn]}>
                            {termService && <Ionicons name="checkmark" size={14} color={colors.white} />}
                          </View>
                          <Text style={styles.termItemText}>
                            <Text style={styles.requiredBadge}>(필수)</Text> 서비스 이용약관 동의
                          </Text>
                        </PressableScale>
                        <PressableScale
                          onPress={() =>
                            setTermsModal({
                              visible: true,
                              title: '서비스 이용약관',
                              content:
                                '제1조 (목적)\n본 약관은 브루노트 서비스(이하 "서비스") 이용 조건 및 절차, 이용자와 당사의 권리·의무 및 책임사항을 규정함을 목적으로 합니다.\n\n제2조 (회원의 의무)\n회원은 본 서비스 이용 시 관련 법령 및 본 약관을 준수하여야 하며, 타인의 정보를 도용해서는 안 됩니다.\n\n제3조 (서비스의 제공)\n당사는 365일 24시간 안정적인 경영 분석 및 가맹 관리 서비스를 제공하도록 최선을 다합니다.',
                            })
                          }
                          to={0.94}
                        >
                          <Text style={styles.termDetailLink}>보기</Text>
                        </PressableScale>
                      </View>

                      {/* (필수) 개인정보 수집 및 이용 */}
                      <View style={styles.termRowItem}>
                        <PressableScale style={styles.termCheckLeft} onPress={() => setTermPrivacy(!termPrivacy)} to={0.98}>
                          <View style={[styles.checkbox, termPrivacy && styles.checkboxOn]}>
                            {termPrivacy && <Ionicons name="checkmark" size={14} color={colors.white} />}
                          </View>
                          <Text style={styles.termItemText}>
                            <Text style={styles.requiredBadge}>(필수)</Text> 개인정보 수집 및 이용 동의
                          </Text>
                        </PressableScale>
                        <PressableScale
                          onPress={() =>
                            setTermsModal({
                              visible: true,
                              title: '개인정보 수집 및 이용 동의',
                              content:
                                '1. 수집 항목: 상호명, 이메일 주소, 비밀번호, 매장 위치 정보, 운영 시간대, 광고 식별자(Android 광고 ID / Apple IDFA)\n2. 수집 및 이용 목적: 회원 식별, 카페 맞춤형 경영 분석 리포트 제공, 서비스 장애 안내, 앱 내 광고 표시 및 부정 클릭 방지\n3. 보유 및 이용 기간: 회원 탈퇴 시 즉시 파기 (단, 관계 법령에 따라 5년간 보관)\n4. 광고 식별자는 기기 설정에서 언제든지 재설정하거나 맞춤 광고를 거부할 수 있으며, 거부해도 서비스 이용에 제한이 없습니다.',
                            })
                          }
                          to={0.94}
                        >
                          <Text style={styles.termDetailLink}>보기</Text>
                        </PressableScale>
                      </View>

                      {/* (선택) 마케팅 정보 수신 */}
                      <View style={styles.termRowItem}>
                        <PressableScale style={styles.termCheckLeft} onPress={() => setTermMarketing(!termMarketing)} to={0.98}>
                          <View style={[styles.checkbox, termMarketing && styles.checkboxOn]}>
                            {termMarketing && <Ionicons name="checkmark" size={14} color={colors.white} />}
                          </View>
                          <Text style={styles.termItemText}>
                            <Text style={styles.optionalBadge}>(선택)</Text> 마케팅 정보 수신 동의
                          </Text>
                        </PressableScale>
                        <PressableScale
                          onPress={() =>
                            setTermsModal({
                              visible: true,
                              title: '마케팅 정보 수신 동의',
                              content:
                                '1. 수집 목적: 신규 원가절감 리포트 기능 안내, 맞춤 프로모션 및 혜택 알림\n2. 수집 항목: 이메일, 매장명\n3. 동의를 거부하시더라도 기본 서비스 이용에 아무런 제한이 없습니다.',
                            })
                          }
                          to={0.94}
                        >
                          <Text style={styles.termDetailLink}>보기</Text>
                        </PressableScale>
                      </View>
                    </View>

                    {error ? <Text style={styles.error}>{error}</Text> : null}

                    {/* 회원가입 완료 버튼 */}
                    <PressableScale
                      style={[styles.submitBtn, { marginTop: 6 }]}
                      onPress={submit}
                      disabled={busy}
                    >
                      <Text style={styles.submitText}>
                        {busy ? '가입 처리 중…' : '가입 완료하고 시작하기'}
                      </Text>
                    </PressableScale>
                  </FadeInUp>
                )}
              </>
            )}

            {/* 소셜 로그인 구분선 및 버튼 영역 */}
            {mode === 'login' && (
              <>
                <View style={styles.socialSeparator}>
                  <View style={styles.separatorLine} />
                  <Text style={styles.separatorText}>또는</Text>
                  <View style={styles.separatorLine} />
                </View>

                <PressableScale
                  style={[styles.socialBtn, styles.googleBtn]}
                  onPress={handleGoogleLogin}
                  disabled={busy}
                >
                  <Ionicons name="logo-google" size={18} color={colors.espressoBrown} />
                  <Text style={[styles.socialBtnText, styles.googleBtnText]}>Google 계정으로 로그인</Text>
                </PressableScale>
              </>
            )}

            <Text style={styles.switchText}>
              {mode === 'login' ? '아직 계정이 없으신가요? ' : '이미 계정이 있으신가요? '}
              <Text
                style={styles.switchLink}
                onPress={() => switchMode(mode === 'login' ? 'signup' : 'login')}
              >
                {mode === 'login' ? '회원가입' : '로그인'}
              </Text>
            </Text>
          </View>
        </FadeInUp>
      </ScrollView>

      {/* [한글 주석] 네이버 지도 위치 선택 모달 (네이버 지도 API 뷰 전면 배치) */}
      <Modal visible={showMapModal} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={styles.modalContent}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>📍 네이버 지도 위치 설정</Text>
              <PressableScale onPress={() => setShowMapModal(false)}>
                <Ionicons name="close" size={20} color={colors.mochaBrown} />
              </PressableScale>
            </View>

            {/* 주소 검색 줄 — 입력한 주소로 지도와 핀을 이동 (지도 핀 클릭과 양방향 동기화) */}
            <View style={[styles.locationInputRow, { marginTop: 6 }]}>
              <TextInput
                style={[styles.input, styles.mapSearchInput]}
                value={region}
                onChangeText={setRegion}
                // 예시까지 넣으면 입력칸 너비를 넘겨 두 줄로 접혀 읽기 나쁘다 — 예시는 아래 안내줄로 뺐다
                placeholder="가게 주소 입력"
                placeholderTextColor={colors.mochaBrown}
                numberOfLines={1}
                onSubmitEditing={() => mapSearchRef.current?.(region)}
              />
              <PressableScale
                style={styles.mapPinBtn}
                onPress={() => mapSearchRef.current?.(region)}
                to={0.93}
              >
                <Ionicons name="search" size={14} color={colors.white} />
                <Text style={styles.mapPinBtnText}>검색</Text>
              </PressableScale>
              {/* 현위치 버튼 — 누르면 기기 GPS 좌표로 핀을 옮기고 즉시 등록 */}
              <PressableScale
                style={styles.mapPinBtn}
                onPress={() => applyMyLocation()}
                to={0.93}
              >
                <Ionicons name="locate" size={14} color={colors.white} />
                <Text style={styles.mapPinBtnText}>현위치</Text>
              </PressableScale>
            </View>

            {/* 입력 예시는 placeholder 대신 여기 한 줄로 — 입력칸이 접히지 않게 */}
            <Text style={styles.mapHintText}>예: 서울 중구 명동길 26 · 상호명으로도 찾을 수 있어요</Text>

            {/* [한글 주석] 지도가 그려지는 영역 — 클릭/핀 드래그로 위치 지정 (웹 전용, 앱은 주소 입력으로 설정) */}
            {/* [한글 주석] 고정 260 은 세로가 짧은 화면(가로모드·플립)에서 화면을 다 먹었다 → 뷰포트 비례 */}
            {/* [한글 주석] 고정 260 은 세로가 짧은 화면(가로모드·플립)에서 화면을 다 먹었다 → 뷰포트 비례 */}
            <View style={{ marginVertical: 10, borderRadius: 14, overflow: 'hidden', height: Math.min(vh(34), 260), backgroundColor: colors.creamSand }}>
              {Platform.OS === 'web' ? (
                <View id="signup-map-container" style={{ width: '100%', height: '100%' }} />
              ) : (
                // 앱(네이티브)은 브라우저 DOM을 못 쓰므로, 백엔드가 서빙하는 지도 페이지를
                // WebView로 띄운다. 지도를 탭하면 핀 이동 + 역지오코딩 주소가 postMessage로 온다.
                <WebView
                  ref={mapWebViewRef}
                  originWhitelist={['*']}
                  source={{
                    uri: `${API_BASE_URL}/map/picker.html?key=${encodeURIComponent(
                      NAVER_CLIENT_ID,
                    )}&lat=${coords?.lat ?? 37.5665}&lon=${coords?.lon ?? 126.978}`,
                  }}
                  javaScriptEnabled
                  domStorageEnabled
                  // 지도 로드 완료 후 핀 미확정이면 현위치로 자동 이동 (권한 거부 시 기본 좌표 유지)
                  onLoadEnd={() => {
                    if (!coords) applyMyLocation(true);
                  }}
                  onMessage={(e) => {
                    try {
                      const msg = JSON.parse(e.nativeEvent.data);
                      if (msg.type === 'pick') {
                        setCoords({ lat: msg.lat, lon: msg.lon });
                        if (msg.address) setRegion(msg.address);
                        setMapNotice('');
                      }
                    } catch {
                      // 형식이 다른 메시지는 무시 (엔진 로그 등)
                    }
                  }}
                  style={{ flex: 1, backgroundColor: colors.creamSand }}
                />
              )}
            </View>

            {/* 현재 선택 상태 안내 — 검색 진행/실패 피드백이 있으면 그것을 우선 표시 */}
            <Text style={styles.mapPickedText}>
              {mapNotice
                ? mapNotice
                : coords
                  ? `📍 ${region}  (${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)})`
                  : '지도를 클릭하거나 주소를 검색해 핀을 놓아 주세요'}
            </Text>

            <PressableScale
              style={[styles.submitBtn, { marginTop: 4 }]}
              onPress={() => setShowMapModal(false)}
            >
              <Text style={styles.submitText}>이 위치로 설정 완료</Text>
            </PressableScale>
          </View>
        </View>
      </Modal>

      {/* [한글 주석] 약관 상세 내용 팝업 모달 */}
      <Modal
        visible={termsModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setTermsModal({ ...termsModal, visible: false })}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalContent}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>{termsModal.title}</Text>
              <PressableScale onPress={() => setTermsModal({ ...termsModal, visible: false })} to={0.9}>
                <Ionicons name="close" size={20} color={colors.espressoBrown} />
              </PressableScale>
            </View>
            <ScrollView style={{ maxHeight: 280, marginVertical: 10 }}>
              <Text style={{ ...typography.L4, fontSize: 13, color: colors.mochaBrown, lineHeight: 20 }}>
                {termsModal.content}
              </Text>
            </ScrollView>
            <PressableScale
              style={[styles.submitBtn, { marginTop: 10 }]}
              onPress={() => setTermsModal({ ...termsModal, visible: false })}
            >
              <Text style={styles.submitText}>확인</Text>
            </PressableScale>
          </View>
        </View>
      </Modal>

      {/* [한글 주석] 직원 로그인 모달.
          계산대에 서는 알바생은 사장님 계정을 쓸 수 없다(매출·정산·급여가 다 보인다).
          사장님이 발급한 아이디로 들어오면 단골 결제만 할 수 있다. */}
      <Modal visible={staffMode} transparent animationType="fade"
             onRequestClose={() => setStaffMode(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>직원 로그인</Text>
            <Text style={styles.staffModalDesc}>
              사장님께 받은 아이디와 비밀번호를 입력해 주세요.
              단골 결제만 사용할 수 있습니다.
            </Text>
            <TextInput
              style={styles.staffModalInput}
              placeholder="아이디"
              placeholderTextColor="#B0A79E"
              value={staffId}
              onChangeText={setStaffId}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={styles.staffModalInput}
              placeholder="비밀번호"
              placeholderTextColor="#B0A79E"
              value={staffPw}
              onChangeText={setStaffPw}
              keyboardType="number-pad"
              secureTextEntry
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <PressableScale
                style={[styles.staffModalBtn, { backgroundColor: '#F2EFEC' }]}
                onPress={() => { setStaffMode(false); setError(''); }}
                to={0.97}
              >
                <Text style={[styles.staffModalBtnText, { color: '#7A6E65' }]}>취소</Text>
              </PressableScale>
              <PressableScale
                style={[styles.staffModalBtn, busy && { opacity: 0.5 }]}
                onPress={submitStaff}
                disabled={busy}
                to={0.97}
              >
                <Text style={styles.staffModalBtnText}>로그인</Text>
              </PressableScale>
            </View>
          </View>
        </View>
      </Modal>

      {/* [한글 주석] 아이디 / 비밀번호 찾기 모달 */}
      <Modal
        visible={showFindModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFindModal(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalContent}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>계정 정보 찾기</Text>
              <PressableScale onPress={() => setShowFindModal(false)} to={0.9}>
                <Ionicons name="close" size={20} color={colors.espressoBrown} />
              </PressableScale>
            </View>

            {/* 아이디/비밀번호 탭 전환 */}
            <View style={styles.findTabRow}>
              <PressableScale
                style={[styles.findTabBtn, findTab === 'id' && styles.findTabBtnActive]}
                onPress={() => {
                  setFindTab('id');
                  setFindResult(null);
                }}
              >
                <Text style={[styles.findTabText, findTab === 'id' && styles.findTabTextActive]}>
                  아이디(이메일) 찾기
                </Text>
              </PressableScale>
              <PressableScale
                style={[styles.findTabBtn, findTab === 'pw' && styles.findTabBtnActive]}
                onPress={() => {
                  setFindTab('pw');
                  setFindResult(null);
                }}
              >
                <Text style={[styles.findTabText, findTab === 'pw' && styles.findTabTextActive]}>
                  비밀번호 재설정
                </Text>
              </PressableScale>
            </View>

            {findTab === 'id' ? (
              <View style={{ gap: 10, marginTop: 12 }}>
                <Text style={styles.findDesc}>
                  동일 상호 중복 방지를 위해 가입 시 등록하신 상호명과 휴대폰 번호(또는 사업자번호)를 함께 입력해 주세요.
                </Text>
                <Field
                  icon="storefront-outline"
                  placeholder="상호 / 매장 이름 (예: 메가커피 명동점)"
                  value={findNameInput}
                  onChangeText={setFindNameInput}
                />
                <Field
                  icon="call-outline"
                  placeholder="등록된 휴대폰 번호 또는 사업자번호"
                  value={findPhoneInput}
                  onChangeText={setFindPhoneInput}
                  keyboardType="numeric"
                />
                <PressableScale
                  style={[styles.submitBtn, findBusy && { opacity: 0.6 }]}
                  onPress={() => !findBusy && submitFindEmail()}
                >
                  <Text style={styles.submitText}>{findBusy ? '조회 중…' : '아이디 찾기'}</Text>
                </PressableScale>
              </View>
            ) : firebaseAuthEnabled && resetMode === 'mail' ? (
              // Firebase 로그인 환경 — 로그인이 검증하는 Firebase 비밀번호를 바꾸려면 재설정 메일이 정답.
              <View style={{ gap: 10, marginTop: 12 }}>
                <Text style={styles.findDesc}>
                  가입하신 이메일로 비밀번호 재설정 링크를 보내드려요. 메일의 링크에서 새 비밀번호를 설정하면 바로 로그인할 수 있어요.
                </Text>
                <Field
                  icon="mail-outline"
                  placeholder="가입 이메일 주소 (예: owner@cafe.com)"
                  value={findEmailInput}
                  onChangeText={setFindEmailInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <PressableScale
                  style={[styles.submitBtn, findBusy && { opacity: 0.6 }]}
                  onPress={() => !findBusy && submitResetEmail()}
                >
                  <Text style={styles.submitText}>{findBusy ? '메일 보내는 중…' : '재설정 메일 보내기'}</Text>
                </PressableScale>
                {/* 메일이 안 오는 계정(백엔드로 가입·데모 계정)을 위한 출구 */}
                <PressableScale
                  onPress={() => {
                    setResetMode('verify');
                    setFindResult(null);
                  }}
                  to={0.97}
                >
                  <Text style={styles.findSwitchLink}>
                    메일이 오지 않나요? 휴대폰 번호로 바로 재설정하기
                  </Text>
                </PressableScale>
              </View>
            ) : (
              // 본인확인 후 즉시 재설정 — 메일 인프라가 없는 환경(mock)과,
              // Firebase에 계정이 없어 재설정 메일이 나가지 않는 계정이 함께 쓴다.
              // 바꾼 비밀번호는 백엔드에 저장되고, 로그인은 Firebase 실패 시 백엔드로
              // 폴백하므로(auth/loginFallback.ts) 어느 쪽 계정이든 이 비밀번호로 들어갈 수 있다.
              <View style={{ gap: 10, marginTop: 12 }}>
                <Text style={styles.findDesc}>
                  본인 확인을 위해 가입 이메일과 휴대폰 번호를 입력하시면 새 비밀번호로 즉시 재설정됩니다.
                </Text>
                <Field
                  icon="mail-outline"
                  placeholder="가입 이메일 주소 (예: owner@cafe.com)"
                  value={findEmailInput}
                  onChangeText={setFindEmailInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <Field
                  icon="call-outline"
                  placeholder="등록된 휴대폰 번호 (미등록 시 상호명)"
                  value={findPhoneInput}
                  onChangeText={setFindPhoneInput}
                />
                <Field
                  icon="lock-closed-outline"
                  placeholder="새 비밀번호 (4자 이상)"
                  value={findNewPwInput}
                  onChangeText={setFindNewPwInput}
                  secureToggle
                />
                <PressableScale
                  style={[styles.submitBtn, findBusy && { opacity: 0.6 }]}
                  onPress={() => !findBusy && submitResetPassword()}
                >
                  <Text style={styles.submitText}>{findBusy ? '변경 중…' : '비밀번호 재설정'}</Text>
                </PressableScale>
                {firebaseAuthEnabled && (
                  <PressableScale
                    onPress={() => {
                      setResetMode('mail');
                      setFindResult(null);
                    }}
                    to={0.97}
                  >
                    <Text style={styles.findSwitchLink}>재설정 메일로 받기</Text>
                  </PressableScale>
                )}
              </View>
            )}

            {/* 결과 메세지 출력 */}
            {findResult && (
              <View style={[styles.findResultBox, findResult.type === 'error' ? styles.findResultError : styles.findResultSuccess]}>
                <Ionicons
                  name={findResult.type === 'error' ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                  size={18}
                  color={findResult.type === 'error' ? '#B23B2E' : '#2E7D32'}
                />
                <Text style={[styles.findResultText, findResult.type === 'error' ? styles.findResultTextError : styles.findResultTextSuccess]}>
                  {findResult.message}
                </Text>
              </View>
            )}

            <PressableScale
              style={[styles.submitBtn, { backgroundColor: colors.mutedSand, marginTop: 12 }]}
              onPress={() => setShowFindModal(false)}
            >
              <Text style={[styles.submitText, { color: colors.espressoBrown }]}>닫기</Text>
            </PressableScale>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Field({
  icon,
  style,
  secureToggle,
  ...props
}: {
  icon: keyof typeof Ionicons.glyphMap;
  /** 비밀번호 칸 — 가림 처리 + 오른쪽 눈 버튼으로 보기/숨기기 전환 */
  secureToggle?: boolean;
} & React.ComponentProps<typeof TextInput>) {
  const [revealed, setRevealed] = useState(false);
  // 웹은 style(-webkit-text-security)로 가리므로 style만 따로 떼어 병합한다
  const { style: maskStyle, ...maskProps } = (
    secureToggle ? passwordFieldProps(!revealed) : {}
  ) as React.ComponentProps<typeof TextInput>;

  return (
    <View style={styles.field}>
      <Ionicons name={icon} size={18} color={colors.mochaBrown} />
      <TextInput
        style={[styles.input, style, maskStyle]}
        placeholderTextColor={colors.mochaBrown}
        {...props}
        {...maskProps}
      />
      {secureToggle && (
        <PressableScale style={styles.eyeBtn} onPress={() => setRevealed((v) => !v)} to={0.88}>
          <Ionicons
            name={revealed ? 'eye-off-outline' : 'eye-outline'}
            size={19}
            color={revealed ? colors.pointOrange : colors.mochaBrown}
          />
        </PressableScale>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  // [한글 주석] flexGrow: 내용이 짧아도 ScrollView가 화면을 꽉 채우도록.
  // paddingBottom: 키보드가 떠서 뷰포트가 줄었을 때, 비밀번호 등 하단 입력칸을
  //   키보드 위로 끌어올릴 스크롤 여유 공간. 이 값이 부족하면 칸이 키보드에 가려진다.
  content: {
    flexGrow: 1,
    gap: spacing.verticalGap,
  },
  brand: { alignItems: 'center', marginBottom: 8 },
  // [한글 주석] 크기는 화면에서 폭 비례로 덮어쓴다 (고정 310×190 은 SE·플립에서 좌우가 잘렸다)
  logo: { resizeMode: 'contain' },
  brandSub: { ...typography.L4, color: colors.mochaBrown, marginTop: 10 },
  form: { gap: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
  },
  // 비밀번호 보기/숨기기 눈 버튼 — 손가락으로 누르기 편하게 여백을 넉넉히 준다
  eyeBtn: { paddingVertical: 10, paddingLeft: 10, paddingRight: 2 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.mutedSand,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.pointOrange, borderColor: colors.pointOrange },
  checkLabel: { ...typography.L4, color: colors.espressoBrown },
  checkHint: { ...typography.L5, color: colors.mochaBrown },
  error: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },
  submitBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  submitText: { ...typography.L3, color: colors.white, fontWeight: '800' },
  switchText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', marginTop: 4 },
  switchLink: { color: colors.pointOrange, fontWeight: '700' },

  // Step 2 가게 설정 스타일 (이모지 제거, 폰트 위계 정돈, 간격 조율)
  step2Container: {
    backgroundColor: colors.white,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.12)',
    padding: 16,
    gap: 14,
  },
  stepTitleRow: { marginBottom: 2 },
  stepTitle: { fontSize: 17, fontWeight: '900', color: colors.espressoBrown },
  stepSub: { fontSize: 11.5, color: colors.mochaBrown, marginTop: 2, fontWeight: '500' },
  
  // 그룹 레이아웃 — 라벨과 힌트는 가깝게(gap: 3), 주요 텍스트 크기 확대
  group: { gap: 4 },
  groupLabel: { fontSize: 14, fontWeight: '800', color: colors.espressoBrown },
  groupHint: { fontSize: 10.5, color: colors.mochaBrown, fontWeight: '500', marginTop: 1, marginBottom: 4 },
  subLabel: { fontSize: 11.5, fontWeight: '700', color: colors.espressoBrown, marginBottom: 2 },
  
  locationInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  mapPinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  mapPinBtnText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  mapSearchInput: {
    flex: 1,
    backgroundColor: colors.creamSand,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  // 입력칸 아래 예시 안내 — placeholder가 두 줄로 접히던 걸 대체한다
  mapHintText: {
    fontSize: 10.5,
    lineHeight: 15,
    color: '#A99C90',
    fontWeight: '600',
    marginTop: 5,
    marginLeft: 3,
  },
  mapPickedText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.mochaBrown,
    textAlign: 'center',
    marginBottom: 2,
  },

  // 알바생 스케줄 스타일 시간대 피커 카드
  shiftTimeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  shiftTimeCard: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: 'rgba(140, 111, 86, 0.2)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.coffeeCream,
  },
  shiftTimeCardActive: {
    backgroundColor: '#F6DED8', // 연한 포인트 오렌지 틴트 (OperationScreen 동일)
    borderColor: colors.pointOrange,
  },
  shiftTimeTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  shiftTimeValue: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  shiftTimeValueActive: {
    color: colors.pointOrange,
  },
  shiftPickerPanel: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
  },
  shiftSubLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.mochaBrown,
    marginBottom: 4,
  },

  chipRow: { flexDirection: 'row', flexWrap: 'nowrap', gap: 4, marginTop: 2 },
  chip: {
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(242, 236, 224, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  chipText: { fontSize: 11, fontWeight: '700', color: colors.mochaBrown, textAlign: 'center' },
  chipTextActive: { color: colors.white, fontWeight: '800' },
  // 유입경로 칩 전용 — 7개가 한 줄에 들어가도록 폰트/여백 축소 (한 칩당 한 줄 고정)
  acqChip: { paddingHorizontal: 2 },
  acqChipText: { fontSize: 9 },
  backBtn: {
    backgroundColor: 'rgba(140, 111, 86, 0.1)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: { fontSize: 13, color: colors.espressoBrown, fontWeight: '700' },

  // 네이버 지도 모달 (핸드폰 프레임에 맞춰 maxWidth 380px 설정)
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle: { fontSize: 15, fontWeight: '900', color: colors.espressoBrown },

  // 직원 로그인 모달
  staffModalDesc: { fontSize: 12, color: '#7A6E65', lineHeight: 18, marginBottom: 12 },
  staffModalInput: {
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    color: colors.espressoBrown,
    marginBottom: 8,
  },
  staffModalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pointOrange,
  },
  staffModalBtnText: { fontSize: 13, fontWeight: 'bold', color: '#FFF' },
  mapContainerBox: {
    height: 140,
    backgroundColor: colors.creamSand,
    borderRadius: 14,
    marginVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },

  socialSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 15,
    marginBottom: 5,
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(78, 54, 41, 0.15)',
  },
  separatorText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 12,
    borderWidth: 1,
  },
  googleBtn: {
    backgroundColor: colors.white,
    borderColor: colors.mutedSand,
  },
  googleBtnText: {
    color: colors.espressoBrown,
  },
  socialBtnText: {
    ...typography.L4,
    fontWeight: '700',
  },

  // [한글 주석] 약관 동의 세부 전용 스타일
  termsBox: {
    backgroundColor: 'rgba(242, 236, 224, 0.45)',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
    marginTop: 4,
  },
  termRowAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  termTextAll: {
    ...typography.L3,
    fontSize: 13.5,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  termDivider: {
    height: 1,
    backgroundColor: 'rgba(140, 111, 86, 0.12)',
    marginVertical: 8,
  },
  termRowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  termCheckLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  termItemText: {
    ...typography.L4,
    fontSize: 12,
    color: colors.espressoBrown,
  },
  requiredBadge: {
    color: colors.pointOrange,
    fontWeight: '800',
  },
  optionalBadge: {
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  termDetailLink: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
    textDecorationLine: 'underline',
    paddingLeft: 8,
  },

  // [한글 주석] 아이디 / 비밀번호 찾기 모달 및 옵션 전용 스타일
  loginOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  findAccountLink: {
    ...typography.L5,
    fontSize: 12,
    color: colors.mochaBrown,
    textDecorationLine: 'underline',
    fontWeight: '600',
  },
  loginLinkGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  linkSeparator: {
    ...typography.L5,
    fontSize: 12,
    color: colors.mochaBrown,
    opacity: 0.45,
  },
  findTabRow: {
    flexDirection: 'row',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 3,
    marginTop: 8,
  },
  findTabBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  findTabBtnActive: {
    backgroundColor: colors.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  findTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  findTabTextActive: {
    color: colors.pointOrange,
    fontWeight: '800',
  },
  findDesc: {
    ...typography.L5,
    fontSize: 12,
    color: colors.mochaBrown,
    lineHeight: 18,
  },
  // 재설정 방식 전환 링크 (메일 ↔ 본인확인)
  findSwitchLink: {
    ...typography.L5,
    fontSize: 12,
    color: colors.espressoBrown,
    textAlign: 'center',
    textDecorationLine: 'underline',
    paddingVertical: 6,
  },
  findResultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    marginTop: 10,
  },
  findResultSuccess: {
    backgroundColor: '#E8F5E9',
  },
  findResultError: {
    backgroundColor: '#FFEBEE',
  },
  findResultText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  findResultTextSuccess: {
    color: '#2E7D32',
  },
  findResultTextError: {
    color: '#B23B2E',
  },
});
