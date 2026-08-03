// 설정 화면 — 관리 허브에서 진입. (P0)
// ① 계정/가게 정보  ② 알림 설정  ③ 화면 표시/접근성
// 계정은 백엔드 /auth 실연동, 나머지 환경설정은 PreferencesContext(AsyncStorage)에 저장.
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, TextInput, View, LayoutAnimation, Platform, UIManager, Animated, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// [한글 주석: Android 기기에서 레이아웃 애니메이션이 부드럽게 동작하도록 허용하는 전처리]
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { useNavigation, useRoute } from '@react-navigation/native';

/**
 * 설정 하위 화면 전환 효과.
 *
 * 기존 springTransition()은 LayoutAnimation인데, 이건 웹(react-native-web)에서 아무 동작도
 * 하지 않는다. 그래서 박스를 눌러 하위 화면으로 들어가도 툭 하고 바뀌기만 했다.
 * Animated는 웹·네이티브 모두에서 동작하므로 여기서 직접 그린다.
 *
 * 방향은 스택 화면 전환(slide_from_right)과 맞춘다 — 깊이 들어갈 땐 오른쪽에서,
 * 목록으로 되돌아올 땐 왼쪽에서 밀려 들어온다. 어디로 이동했는지가 몸으로 읽힌다.
 *
 * 자식을 remount하지 않고 컨테이너만 움직인다. key로 갈아끼우면 문의 작성 폼처럼
 * 입력 중이던 하위 화면의 상태가 날아간다.
 */
function SubViewTransition({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  const anim = useRef(new Animated.Value(1)).current;
  const goingDeeper = viewKey !== 'main';

  useEffect(() => {
    anim.setValue(0);
    Animated.spring(anim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 120,
      friction: 14,
    }).start();
  }, [viewKey, anim]);

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [goingDeeper ? 24 : -24, 0],
  });

  return (
    <Animated.View style={{ opacity: anim, transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  );
}

import { useAuth } from '../../auth/AuthContext';
import {
  FONT_SIZE_LABEL,
  LANGUAGE_LABEL,
  SPEECH_RATE_STEPS,
  VOICE_TYPE_LABEL,
  nearestSpeechRate,
  usePreferences,
  type FontSize,
  type Language,
  type VoiceAlertOutput,
  type VoiceType,
} from '../../preferences/PreferencesContext';
import speechPlayer from '../../lib/speech/speechPlayer';
import { resetEarphoneCache } from '../../lib/speech/audioPolicy';
import type { EarphoneStatus } from '../../lib/speech/speechTypes';
import { useTranslation } from '../../i18n/translations';
import { Badge, Button, Card, Divider, Screen, SectionTitle, IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { API_BASE_URL } from '../../lib/api/client';
import { getSensorFeature, setSensorFeature } from '../../lib/api/sensor';
import SettlementSetupPanel from '../../components/settlement/SettlementSetupPanel';
import { getSettlementSettings } from '../../lib/api/settlement';
import { resolveStoreProfile, updateStoreProfile } from '../../lib/api/store';
import { isNativePushAvailable } from '../../notifications/pushRegistration';
import { colors, typography } from '../../theme';

// 설정 항목 한 줄 (라벨 + 우측 컨트롤)
function Row({ label, hint, right }: { label: string; hint?: string; right: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

// 라벨 붙은 입력칸
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: 'default' | 'numeric';
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(140,111,86,0.5)"
        secureTextEntry={secure}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
      />
    </View>
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  // 다른 화면에서 특정 설정 하위 화면으로 바로 들어오는 경우(예: 매출 입력 → 카드 정산 설정)
  const route = useRoute<any>();
  const initialSection = route.params?.section as
    | 'account' | 'notification' | 'appearance' | 'inquiry' | 'legal' | 'settlement'
    | undefined;
  const { user, token, updateProfile, logout } = useAuth();
  const prefs = usePreferences();

  // ── 계정/가게 정보 상태 ─────────────────────────────
  const [name, setName] = useState(user?.name ?? '');
  const [storeName, setStoreName] = useState('');
  const [businessType, setBusinessType] = useState(prefs.businessType);
  const [newPw, setNewPw] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  // [한글 주석] 저장 성공 시 확실한 정보 확정 시각 피백을 제공하는 상태
  const [savedSuccess, setSavedSuccess] = useState(false);
  // [한글 주석] 운영 시간 변경 모드 활성화 여부 (평소에는 휠 조작이 안 되게 잠금 확정 뷰로 표시)
  const [isEditingTime, setIsEditingTime] = useState(false);
  // [한글 주석: 계정/가게 기본 정보(이름, 매장명, 업종) 수정 활성화 상태]
  const [isEditingAccount, setIsEditingAccount] = useState(false);
  // [한글 주석: 1대1 문의 화면 내 3가지 서브 탭 관리 상태]
  const [inquiryTab, setInquiryTab] = useState<'write' | 'list' | 'faq'>('write');
  // [한글 주석: 자주 묻는 질문(FAQ)의 아코디언 펼침 인덱스 관리]
  const [faqExpandedId, setFaqExpandedId] = useState<number | null>(null);

  // [한글 주석] 매장 센서 연동 기능 ON/OFF — 백엔드 기본값과 동일하게 ON으로 시작하고,
  // 서버 조회가 성공하면 실제 값으로 동기화. 조회가 실패해도 스위치는 항상 누를 수 있다.
  const [sensorOn, setSensorOn] = useState(true);

  // 카드 정산을 한 번이라도 설정했는지 — 메뉴에 '설정 필요' 배지를 띄우는 용도.
  // null이면 아직 모르는 상태라 배지를 띄우지 않는다(깜빡임 방지).
  const [settlementConfigured, setSettlementConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!token) return;
    getSettlementSettings(token)
      .then((r) => setSettlementConfigured(!!r.configured))
      .catch(() => {}); // 조회 실패 시 배지는 그냥 띄우지 않는다
  }, [token]);

  useEffect(() => {
    if (!token) return;
    getSensorFeature(token)
      .then((r) => setSensorOn(r.enabled))
      .catch(() => {}); // 구버전 서버(GET 미지원)여도 토글은 정상 동작
  }, [token]);

  const toggleSensor = async (next: boolean) => {
    setSensorOn(next); // 낙관적 반영 — 실패 시 아래에서 원복
    if (!token) return;
    try {
      await setSensorFeature(token, next);
      toast(
        next ? '센서 연동 켜짐' : '센서 연동 꺼짐',
        next
          ? '발주 화면에 실시간 라이브·AI 발주 코치가 다시 표시돼요.'
          : '라이브·배너·AI 코치 알림이 모두 숨겨져요. 언제든 다시 켤 수 있어요.'
      );
    } catch {
      setSensorOn(!next);
      toast('변경 실패', '서버 연결을 확인하고 잠시 후 다시 시도해 주세요.');
    }
  };

  // ── 음성 알림 출력 상태 ─────────────────────────────────────────
  // [한글 주석] "이어폰을 꼈는데 왜 안 읽어주지?"를 사장님이 직접 확인할 수 있게,
  // 지금 앱이 판단한 출력 장치를 알림 설정 화면에 그대로 보여준다.
  // (안드로이드 이어폰 감지 API가 false를 내놓는 기기가 있어, 감지 결과를 숨기면
  //  음성이 안 나오는 이유를 알 방법이 없었다)
  const [audioOut, setAudioOut] = useState<EarphoneStatus | null>(null);
  const [audioChecking, setAudioChecking] = useState(false);

  const refreshAudioOut = async (force = false) => {
    if (force) resetEarphoneCache();
    setAudioChecking(true);
    try {
      setAudioOut(await speechPlayer.isEarphoneConnected());
    } catch {
      setAudioOut({ connected: false, supported: false, via: null, reason: '확인 실패' });
    } finally {
      setAudioChecking(false);
    }
  };

  // [한글 주석: 1대1 CS 탭 슬라이더 너비 및 슬라이드 애니메이션 상태]
  const [csTrackWidth, setCsTrackWidth] = useState(300);
  const csSlideAnim = useRef(new Animated.Value(0)).current;

  const subViewAnim = useRef(new Animated.Value(1)).current;

  // [한글 주석: 설정 메뉴 들어갔다 나올 때 쫀득한 입체 반동과 부드러운 슬라이딩을 주는 트랜지션 모션]
  const springTransition = () => {
    LayoutAnimation.configureNext({
      duration: 320,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.76 },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
  };

  const changeSubView = (nextView: typeof subView) => {
    springTransition();
    subViewAnim.setValue(0.95);
    Animated.spring(subViewAnim, {
      toValue: 1,
      friction: 6,
      tension: 180,
      useNativeDriver: true,
    }).start();

    setSubView(nextView);
  };

  useEffect(() => {
    const tabIndex = inquiryTab === 'write' ? 0 : inquiryTab === 'list' ? 1 : 2;
    Animated.spring(csSlideAnim, {
      toValue: tabIndex,
      useNativeDriver: true,
      tension: 110,
      friction: 12,
    }).start();
  }, [inquiryTab]);

  // [한글 주석] 사장님 1대1 문의 / 요청사항 데이터 및 작성 모달 상태
  const [showInquiryModal, setShowInquiryModal] = useState(false);
  const [inquiryCategory, setInquiryCategory] = useState('💡 기능 요청 / 개선');
  const [inquiryTitle, setInquiryTitle] = useState('');
  const [inquiryContent, setInquiryContent] = useState('');
  const [isSubmittingInquiry, setIsSubmittingInquiry] = useState(false);
  const [inquiries, setInquiries] = useState<
    Array<{ id: number; category: string; title: string; content: string; date: string; status: 'answered' | 'pending'; answer?: string }>
  >([]);

  const initial = (user?.name || 'S').charAt(0).toUpperCase();

  // [한글 주석: 다국어 번역 훅 호출 — 사장님이 선택한 언어(ko/en) 텍스트 제공]
  const { t } = useTranslation();

  // [한글 주석: 설정 창 내부 서브 라우팅 뷰 관리 상태 ('main'일 때는 메뉴 목록 노출)]
  const [subView, setSubView] = useState<'main' | 'account' | 'notification' | 'appearance' | 'inquiry' | 'legal' | 'settlement'>(initialSection ?? 'main');

  // 알림 설정 화면을 보고 있는 동안에만 출력 장치를 주기적으로 다시 확인한다.
  // (이어폰을 꽂거나 빼면 몇 초 안에 화면 문구가 따라 바뀌어야 사장님이 신뢰할 수 있다)
  useEffect(() => {
    if (subView !== 'notification') return;
    refreshAudioOut(true);
    const timer = setInterval(() => refreshAudioOut(true), 5000);
    return () => clearInterval(timer);
  }, [subView]);

  // [한글 주석: 현재 진입한 subView 상태에 맞춰 상단 헤더 타이틀과 뒤로가기 동작을 동적으로 변경]
  useEffect(() => {
    let title = t('settings');
    if (subView === 'account') title = '가게 & 계정 설정';
    else if (subView === 'notification') title = '알림 수신 설정';
    else if (subView === 'appearance') title = t('displayAndAccessibility');
    else if (subView === 'inquiry') title = '1대1 CS 문의';
    else if (subView === 'legal') title = '약관 및 정책';
    else if (subView === 'settlement') title = '카드 정산 설정';

    // [한글 주석: 아이폰 iOS / 프리텐다드 미디엄 스타일 자간 및 화살표 간격 띄움 반영]
    navigation.setOptions({
      title,
      headerTintColor: colors.creamSand,
      headerTitleStyle: {
        fontSize: 16.5,
        fontWeight: '500',
        letterSpacing: -0.45, // [한글 주석: 자간을 쫀쫀하게 좁혀 깔끔한 미디엄 타이포 표현]
        fontFamily: Platform.select({
          web: 'Pretendard, -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif',
          default: undefined,
        }),
      },
      headerLeftContainerStyle: { paddingLeft: 10 },
      headerTitleContainerStyle: { marginLeft: 4 },
      headerLeft: () => (
        <PressableScale
          style={{ marginLeft: 2, marginRight: 10, padding: 6 }}
          to={0.84}
          onPress={() => {
            if (subView !== 'main') {
              changeSubView('main');
            } else {
              navigation.goBack();
            }
          }}
        >
          <Ionicons name="arrow-back" size={22} color={colors.creamSand} />
        </PressableScale>
      ),
    });
  }, [subView, navigation]);

  // 현재 가게 이름·회원 id는 로그인 응답에 없어 /users에서 이메일로 조회
  useEffect(() => {
    if (!user) return;
    fetch(`${API_BASE_URL}/api/v1/auth/users`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: number; email: string; store_name?: string }>) => {
        const me = list.find((u) => u.email === user.email);
        if (me) {
          setUserId(me.id);
          setStoreName(me.store_name ?? '');
        }
      })
      .catch(() => {});
  }, [user]);

  // 업종·영업 시간은 계정에 저장된 값이 원본이다 (기기 설정은 표시용 캐시).
  // 예전엔 이 화면이 AsyncStorage만 읽어서, 재설치하거나 다른 기기로 로그인하면
  // 저장했던 값이 조용히 기본값으로 되돌아가 있었다.
  useEffect(() => {
    if (!token || !prefs.ready) return;
    resolveStoreProfile(token, {
      business_type: prefs.businessType || '카페',
      open_hour: prefs.openHour || '09:00',
      close_hour: prefs.closeHour || '21:00',
    })
      .then((p) => {
        setBusinessType(p.business_type);
        prefs.setPref('businessType', p.business_type);
        prefs.setPref('openHour', p.open_hour);
        prefs.setPref('closeHour', p.close_hour);
      })
      .catch((e) => console.error('매장 정보 조회 실패:', e));
  }, [token, prefs.ready]);

  const saveAccount = async () => {
    setSavingAccount(true);
    try {
      await updateProfile({ name, store_name: storeName });
      // 서버에 먼저 저장하고, 성공했을 때만 기기 캐시를 갱신한다.
      // 실패하면 아래 catch로 빠져 "저장 실패"가 뜨므로, 화면이 저장됐다고 거짓말하지 않는다.
      if (token) {
        const saved = await updateStoreProfile(token, {
          business_type: businessType,
          open_hour: prefs.openHour || '09:00',
          close_hour: prefs.closeHour || '21:00',
        });
        prefs.setPref('businessType', saved.business_type);
        prefs.setPref('openHour', saved.open_hour);
        prefs.setPref('closeHour', saved.close_hour);
      }
      setSavedSuccess(true);
      setIsEditingTime(false); // [한글 주석] 저장 성공 시 시간 변경 모드를 닫고 확정 잠금 상태로 전환
      setIsEditingAccount(false); // [한글 주석] 저장 성공 시 수정 모드를 닫고 정보 고정 상태로 전환
      toast('저장 완료', '계정·가게 정보가 확정 업데이트됐어요.');
      setTimeout(() => setSavedSuccess(false), 2200);
    } catch (e) {
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSavingAccount(false);
    }
  };

  const changePassword = async () => {
    if (newPw.trim().length < 4) {
      toast('비밀번호 확인', '4자 이상으로 입력해 주세요.');
      return;
    }
    try {
      await updateProfile({ password: newPw.trim() });
      setNewPw('');
      toast('변경 완료', '비밀번호가 변경됐어요.');
    } catch (e) {
      toast('변경 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const doLogout = () => {
    confirmDialog('로그아웃 할까요?', { confirmLabel: '로그아웃', onConfirm: () => logout() });
  };

  const deleteAccount = () => {
    confirmDialog('정말 탈퇴하시겠어요? 모든 데이터가 삭제되며 되돌릴 수 없어요.', {
      confirmLabel: '탈퇴하기',
      destructive: true,
      onConfirm: async () => {
        try {
          if (userId != null) {
            await fetch(`${API_BASE_URL}/api/v1/auth/users/${userId}`, {
              method: 'DELETE',
              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
          }
        } catch {
          /* 삭제 실패해도 로컬 로그아웃은 진행 */
        }
        await logout();
      },
    });
  };

  // [한글 주석] 백엔드에서 1대1 문의 실시간 내역 불러오기.
  // 누구 문의인지는 서버가 토큰으로 판단한다 — 이메일을 쿼리로 넘기던 방식은
  // 인증이 없어 남의 이메일만 알면 그 사람 문의를 읽을 수 있었다.
  const fetchInquiries = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/inquiries`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        // 빈 배열도 그대로 반영 — 신규 계정에 데모 시드가 남아 보이지 않게
        if (Array.isArray(data)) setInquiries(data);
      }
    } catch {
      /* 서버 오프라인 시 기존 목록 유지 */
    }
  };

  // 최초 로드 + 8초 주기 폴링 — 관리자 콘솔에서 답변하면 앱에 자동 반영
  useEffect(() => {
    fetchInquiries();
    const timer = setInterval(fetchInquiries, 8000);
    return () => clearInterval(timer);
  }, [token]);

  // [한글 주석] 1대1 문의 제출 — 백엔드 /inquiries 한 곳에만 등록 (백엔드가 관리자 CS 리스트에 동일 id로 자동 연동)
  const handleSubmitInquiry = async () => {
    if (!inquiryTitle.trim()) {
      toast('입력 확인', '문의 제목을 입력해 주세요.');
      return;
    }
    if (!inquiryContent.trim()) {
      toast('입력 확인', '문의 내용을 입력해 주세요.');
      return;
    }
    // 토큰이 없으면 서버가 보낸 사람을 확정할 수 없어 접수 자체가 거절된다.
    if (!token) {
      toast('로그인 확인', '로그인 정보를 불러오지 못했어요. 다시 로그인한 뒤 시도해 주세요.');
      return;
    }

    setIsSubmittingInquiry(true);

    const payload = {
      store_name: storeName || '',
      category: inquiryCategory,
      title: inquiryTitle.trim(),
      content: inquiryContent.trim(),
    };

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchInquiries();
        setInquiryTitle('');
        setInquiryContent('');
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setInquiryTab('list');
        toast('접수 완료', '1대1 문의 및 요청사항이 관리자 콘솔에 전달되었어요.');
      } else {
        toast('접수 실패', '서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } catch (err) {
      console.warn('Inquiries API fetch error:', err);
      toast('접수 실패', '네트워크 연결 상태를 확인 후 다시 시도해 주세요.');
    }
  };

  return (
    <Screen>
      <SubViewTransition viewKey={subView}>
      {/* ── [한글 주석: 설정 첫 화면 진입 시 카테고리 6개 항목 메뉴 리스트 노출] ── */}
      {/* ── [한글 주석: 설정 첫 화면 진입 시 카테고리 6개 항목 메뉴 리스트 노출] ── */}
      {/* ── [한글 주석: 설정 첫 화면 진입 시 카테고리 6개 항목 메뉴 리스트 노출] ── */}
      {subView === 'main' && (
        <Animated.View style={{ gap: 12, marginTop: 8, opacity: subViewAnim, transform: [{ scale: subViewAnim }] }}>
          {/* 가게 & 계정 설정 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('account')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="storefront-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? 'Store & Account Settings' : '가게 & 계정 설정'}</Text>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en'
                    ? 'Store name, Manager name, Sensors & Password'
                    : '매장명, 사장님 이름, 센서 연동, 비밀번호 변경'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>

          {/* 알림 수신 설정 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('notification')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="notifications-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? 'Notifications & Alerts' : '알림 수신 설정'}</Text>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en'
                    ? 'Stock alerts, price changes & Do Not Disturb hours'
                    : '재고·단가 알림, 음성 읽어주기, 방해금지 시간대'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>

          {/* 카드 정산 설정 — 수수료율 구간·카드사별 입금 소요일 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('settlement')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="card-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? 'Card Settlement' : '카드 정산 설정'}</Text>
                  {/* 한 번도 설정한 적이 없으면 여기서 먼저 눈에 띄어야 한다 —
                      기본값으로 조용히 계산되고 있다는 걸 사장님은 모른다 */}
                  {settlementConfigured === false && (
                    <Badge label={prefs.language === 'en' ? 'Setup needed' : '설정 필요'} tone="orange" />
                  )}
                </View>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en'
                    ? 'Guided 3-step setup — fees & deposit dates'
                    : '3단계 안내로 수수료율·입금일 설정 (처음이면 여기부터)'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>

          {/* 화면 표시 & 접근성 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('appearance')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="text-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? 'Display & Accessibility' : '화면 표시 & 접근성'}</Text>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en' ? 'Font size adjustment & live preview' : '글자 크기 조절, 실시간 폰트 사이즈 미리보기'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>

          {/* 1대1 문의 & 요청사항 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('inquiry')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="chatbubbles-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? '1:1 CS & Support' : '1대1 CS 문의 & 요청'}</Text>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en' ? 'Submit feedback & view admin responses' : '건의사항 접수, 실시간 관리자 답변 피드백'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>

          {/* 약관 및 정책 */}
          <PressableScale
            style={styles.menuItemCard}
            to={0.975}
            onPress={() => changeSubView('legal')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.menuIconWrap}>
                <Ionicons name="document-text-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuItemTitle}>{prefs.language === 'en' ? 'Terms & Policies' : '약관 및 정책'}</Text>
                <Text style={styles.menuItemDesc}>
                  {prefs.language === 'en' ? 'Terms of service & privacy policy' : '이용약관 및 개인정보처리방침 규정 조회'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown + '80'} />
            </View>
          </PressableScale>
        </Animated.View>
      )}

      {/* ① 계정 / 가게 정보 */}
      {subView === 'account' && (
        <Card>
        <View style={styles.rowBetween}>
          <SectionTitle>계정 · 가게 정보</SectionTitle>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {savedSuccess && <Badge label="✓ 설정 확정됨" tone="green" />}
            <PressableScale
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setIsEditingAccount(!isEditingAccount);
              }}
              style={{
                backgroundColor: isEditingAccount ? colors.pointOrange + '20' : 'rgba(140, 111, 86, 0.1)',
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
              }}
              to={0.94}
            >
              <Text
                style={{
                  ...typography.L5,
                  fontSize: 12,
                  fontWeight: '800',
                  color: isEditingAccount ? colors.pointOrange : colors.espressoBrown,
                }}
              >
                {isEditingAccount ? '취소' : '✏ 정보 수정'}
              </Text>
            </PressableScale>
          </View>
        </View>
        <View style={styles.accountHead}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.accountName}>{user?.name ?? '사장님'}</Text>
            <Text style={styles.accountEmail}>{user?.email ?? '-'}</Text>
          </View>
        </View>

        {isEditingAccount ? (
          /* [한글 주석] 수정 모드일 때만 활성화되는 입력 인풋 폼 */
          <View style={{ marginTop: 8 }}>
            <Field label="사장님 이름" value={name} onChangeText={setName} placeholder="이름" />
            <Field label="가게 이름" value={storeName} onChangeText={setStoreName} placeholder="예: 포슬카페" />
            <Field label="업종" value={businessType} onChangeText={setBusinessType} placeholder="예: 카페 / 베이커리 / 음식점" />
          </View>
        ) : (
          /* [한글 주석] 평상시: 박스 칸을 완전히 없애고 세련되게 양옆 가로 정렬한 리스트 뷰 */
          <View style={{ marginTop: 14, paddingHorizontal: 4 }}>
            <View style={styles.fixedInfoRow}>
              <Text style={styles.fixedInfoLabel}>사장님 이름</Text>
              <Text style={styles.fixedInfoValue}>{name || '-'}</Text>
            </View>
            <Divider style={{ marginVertical: 2, opacity: 0.4 }} />
            <View style={styles.fixedInfoRow}>
              <Text style={styles.fixedInfoLabel}>가게 이름</Text>
              <Text style={styles.fixedInfoValue}>{storeName || '-'}</Text>
            </View>
            <Divider style={{ marginVertical: 2, opacity: 0.4 }} />
            <View style={styles.fixedInfoRow}>
              <Text style={styles.fixedInfoLabel}>업종</Text>
              <Text style={styles.fixedInfoValue}>{businessType || '-'}</Text>
            </View>
            <Divider style={{ marginVertical: 2, opacity: 0.4 }} />
            <View style={styles.fixedInfoRow}>
              <Text style={styles.fixedInfoLabel}>가게 운영 시간</Text>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text style={{
                  fontFamily: Platform.OS === 'ios' ? 'Apple SD Gothic Neo' : 'System',
                  fontSize: 13,
                  fontWeight: '600',
                  color: colors.espressoBrown,
                }}>오픈 {prefs.openHour || '09:00'}</Text>
                <Text style={{
                  fontFamily: Platform.OS === 'ios' ? 'Apple SD Gothic Neo' : 'System',
                  fontSize: 13,
                  fontWeight: '600',
                  color: colors.espressoBrown,
                }}>마감 {prefs.closeHour || '21:00'}</Text>
              </View>
            </View>
            <Divider style={{ marginVertical: 2, opacity: 0.4 }} />
          </View>
        )}
        
        {/* [한글 주석] 가게 운영 시간 섹션: 수정 상태일 때만 입력용 휠 피커를 노출시킴 */}
        {isEditingAccount && (
          <View style={{ marginTop: 14, marginBottom: 8, gap: 8 }}>
            <Text style={styles.fieldLabel}>가게 운영 시간 수정</Text>
            <View style={{ gap: 8, marginTop: 4 }}>
              <IosTimePicker
                value={`${(prefs.openHour || '09:00').slice(0, 2)}–${(prefs.closeHour || '21:00').slice(0, 2)}`}
                startLabel="오픈 시간"
                endLabel="마감 시간"
                onChange={(val) => {
                  const parts = val.split(/[–-]/);
                  if (parts[0]) prefs.setPref('openHour', `${parts[0].trim().padStart(2, '0')}:00`);
                  if (parts[1]) prefs.setPref('closeHour', `${parts[1].trim().padStart(2, '0')}:00`);
                }}
              />
            </View>
          </View>
        )}

        <Text style={styles.fieldLabel}>이메일 (변경 불가)</Text>
        <Text style={styles.readonly}>{user?.email ?? '-'}</Text>

        {/* [한글 주석] 정보 수정 중일 때만 저장 버튼이 세련되게 노출되도록 개선 */}
        {isEditingAccount && (
          <Button
            label={savingAccount ? '저장 처리 중…' : savedSuccess ? '✓ 정보 변경 확정 완료!' : '정보 저장'}
            onPress={saveAccount}
            disabled={savingAccount}
            style={[
              { marginTop: 16 },
              savedSuccess && { backgroundColor: '#3E8E5A', borderColor: '#3E8E5A' },
            ]}
          />
        )}



        {/* [한글 주석: 매장 센서 연동 ON/OFF 스위치 복원] */}
        <Divider />
        <Row
          label="매장 센서 연동"
          hint="센서가 없는 매장은 꺼 두세요 — 발주 화면의 라이브·배너·AI 코치 알림이 모두 숨겨져요"
          right={
            <Switch
              value={sensorOn}
              onValueChange={toggleSensor}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />

        <Divider />
        <Text style={[styles.fieldLabel, { marginTop: 4 }]}>비밀번호 변경</Text>
        <View style={styles.pwRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newPw}
            onChangeText={setNewPw}
            placeholder="새 비밀번호 (4자 이상)"
            placeholderTextColor="rgba(140,111,86,0.5)"
            secureTextEntry
            autoCapitalize="none"
          />
          <Button label="변경" variant="secondary" onPress={changePassword} />
        </View>

        <Divider />
        <View style={styles.actionsRow}>
          <Button label="로그아웃" variant="secondary" style={{ flex: 1 }} onPress={doLogout} />
          <PressableScale style={styles.dangerBtn} onPress={deleteAccount}>
            <Ionicons name="trash-outline" size={15} color="#B23B2E" />
            <Text style={styles.dangerText}>회원 탈퇴</Text>
          </PressableScale>
        </View>
      </Card>
      )}

      {/* 카드 정산 설정 — 수수료율 구간과 카드사별 입금 소요일 */}
      {subView === 'settlement' && <SettlementSetupPanel />}

      {/* ② 알림 설정 */}
      {subView === 'notification' && (
        <Card>
        <SectionTitle>알림 설정</SectionTitle>
        {/* [솔직한 안내] 푸시 모듈이 없는 빌드에서는 알림이 앱 밖으로 나가지 않는다.
            스위치만 켜져 있고 아무 일도 안 일어나면 사장님은 고장으로 오해한다. */}
        {Platform.OS !== 'web' && !isNativePushAvailable() && (
          <Text style={styles.pushNotice}>
            지금 설치된 버전은 앱을 켜 두었을 때만 알림이 표시돼요. 앱이 꺼진 동안에도 받는
            푸시 알림은 다음 앱 업데이트부터 지원됩니다.
          </Text>
        )}
        <Row
          label="재고 부족 알림"
          hint="설정한 안전재고 밑으로 떨어지면 먼저 알려드려요"
          right={
            <Switch
              value={prefs.lowStockAlert}
              onValueChange={(v) => prefs.setPref('lowStockAlert', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Row
          label="단가 급등 알림"
          hint="원재료 매입 단가가 크게 오르면 알려드려요"
          right={
            <Switch
              value={prefs.priceSurgeAlert}
              onValueChange={(v) => prefs.setPref('priceSurgeAlert', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Row
          label="놓친 일 먼저 알려주기"
          hint="재고 소진 예상일, 신고 기한, 갱신 서류, 방치된 초안 등을 매장 데이터에서 찾아 미리 알려드려요"
          right={
            <Switch
              value={prefs.proactiveInsights}
              onValueChange={(v) => prefs.setPref('proactiveInsights', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Row
          label="알림 음성 읽어주기"
          hint="완료 알림·브리핑을 사장님 목소리 설정으로 읽어드려요"
          right={
            <Switch
              value={prefs.voiceAlertEnabled}
              onValueChange={(v) => prefs.setPref('voiceAlertEnabled', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />

        {/* [한글 주석] 음성 출력 조건 + 지금 어디로 나가는지 실시간 표시.
            예전엔 '이어폰 연결 시에만'이 코드에 박혀 있었는데, 안드로이드 이어폰 감지가
            연결을 놓치는 기기에서는 아무 말도 안 하는 상태가 됐다. 이제 조건을 고를 수 있고,
            감지 결과와 테스트 재생까지 이 자리에서 확인된다. */}
        {prefs.voiceAlertEnabled ? (
          <View style={styles.voiceOutBox}>
            <Text style={[styles.fieldLabel, { marginTop: 0 }]}>언제 소리로 읽어줄까요?</Text>
            <View style={{ marginTop: 8 }}>
              <Segmented
                options={[
                  { value: 'always', label: '항상 읽어주기' },
                  { value: 'earphone', label: '이어폰 연결 시에만' },
                ]}
                value={prefs.voiceAlertOutput}
                onChange={(v) => prefs.setPref('voiceAlertOutput', v as VoiceAlertOutput)}
              />
            </View>

            <View style={styles.audioStatusRow}>
              <Ionicons
                name={
                  audioOut?.connected
                    ? 'headset'
                    : audioOut?.supported === false
                      ? 'help-circle-outline'
                      : 'volume-medium-outline'
                }
                size={15}
                color={audioOut?.connected ? colors.espressoBrown : colors.mochaBrown}
              />
              <Text style={styles.audioStatusText}>
                {audioOut === null
                  ? '출력 장치를 확인하는 중이에요…'
                  : audioOut.connected
                    ? `이어폰 연결됨${
                        audioOut.via === 'bluetooth'
                          ? ' (블루투스)'
                          : audioOut.via === 'wired'
                            ? ' (유선)'
                            : audioOut.via === 'recent'
                              ? ' (최근 연결 유지 중)'
                              : ''
                      } — 음성이 이어폰으로 나가요`
                    : audioOut.supported === false
                      ? '이 기기에선 이어폰 연결을 확인할 수 없어요 — 조건과 상관없이 읽어드려요'
                      : '이어폰 없음 — 스피커로 나가요'}
              </Text>
              <PressableScale
                style={styles.audioCheckBtn}
                onPress={() => refreshAudioOut(true)}
                to={0.9}
              >
                <Ionicons
                  name="refresh"
                  size={12}
                  color={colors.espressoBrown}
                  style={{ marginRight: 3 }}
                />
                <Text style={styles.audioCheckBtnText}>
                  {audioChecking ? '확인 중' : '다시 확인'}
                </Text>
              </PressableScale>
            </View>

            <PressableScale
              style={styles.audioTestBtn}
              to={0.94}
              onPress={async () => {
                // 실제 알림과 똑같은 정책으로 판단한 뒤 재생 — "설정에선 되는데 알림은 안 되는" 차이 방지
                const permission = await speechPlayer.canPlayAudio();
                await refreshAudioOut(true);
                if (!permission.allowed) {
                  toast('음성을 건너뛰었어요', permission.reason ?? '지금은 소리를 낼 수 없어요.');
                  return;
                }
                speechPlayer.speak(
                  '사장님, 알림이 오면 이 목소리와 이 속도로 읽어드릴게요.',
                  { voiceType: prefs.voiceType, rate: prefs.speechRate }
                );
              }}
            >
              <Ionicons name="play" size={13} color="#FFFFFF" style={{ marginRight: 5 }} />
              <Text style={styles.audioTestBtnText}>지금 알림 음성 테스트</Text>
            </PressableScale>

            <Text style={styles.audioHint}>
              목소리와 말하는 속도는 설정 &gt; 화면 표시에서 바꿀 수 있어요.
            </Text>
          </View>
        ) : null}
        <Divider />
        <Row
          label="음성 비서 버튼 표시"
          hint="화면 우하단 브리핑(📋)·음성 명령(🎤) 버튼을 껐다 켤 수 있어요"
          right={
            <Switch
              value={prefs.voiceAssistantEnabled}
              onValueChange={(v) => prefs.setPref('voiceAssistantEnabled', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Text style={styles.fieldLabel}>AI 경영 리포트 수신 주기</Text>
        <View style={{ marginTop: 8 }}>
          <Segmented
            options={[
              { value: 'daily', label: '매일' },
              { value: 'weekly', label: '매주' },
            ]}
            value={prefs.reportFrequency}
            onChange={(v) => prefs.setPref('reportFrequency', v)}
          />
        </View>
        <Divider />
        <Row
          label="방해 금지 시간대"
          hint="이 시간엔 푸시를 보내지 않아요 (새벽 알림 방지)"
          right={
            <Switch
              value={prefs.dndEnabled}
              onValueChange={(v) => prefs.setPref('dndEnabled', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        {prefs.dndEnabled ? (
          <View style={styles.dndRow}>
            <TextInput
              style={styles.timeInput}
              value={prefs.dndStart}
              onChangeText={(t) => prefs.setPref('dndStart', t)}
              placeholder="22:00"
              placeholderTextColor="rgba(140,111,86,0.5)"
              maxLength={5}
            />
            <Text style={styles.dndTilde}>~</Text>
            <TextInput
              style={styles.timeInput}
              value={prefs.dndEnd}
              onChangeText={(t) => prefs.setPref('dndEnd', t)}
              placeholder="08:00"
              placeholderTextColor="rgba(140,111,86,0.5)"
              maxLength={5}
            />
          </View>
        ) : null}
      </Card>
      )}

      {/* ③ 화면 표시 / 접근성 & 외국인 사장님을 위한 언어 설정 */}
      {subView === 'appearance' && (
        <Card>
        <SectionTitle>{t('displayAndAccessibility')}</SectionTitle>

        {/* [한글 주석: 글자 크기 조절 세션] */}
        <Text style={styles.fieldLabel}>{t('fontSize')}</Text>
        <View style={{ marginTop: 8 }}>
          <Segmented
            options={(['small', 'normal', 'large', 'xlarge'] as FontSize[]).map((f) => ({
              value: f,
              label: f === 'small' ? t('fontSizeSmall') : f === 'normal' ? t('fontSizeNormal') : f === 'large' ? t('fontSizeLarge') : t('fontSizeXLarge'),
            }))}
            value={prefs.fontSize}
            onChange={(v) => prefs.setPref('fontSize', v)}
          />
        </View>

        <Divider style={{ marginVertical: 18 }} />

        {/* [한글 주석: 외국인 사장님을 위한 다국어(한국어/영어) 언어 선택 세션] */}
        <Text style={styles.fieldLabel}>{t('languageSetting')}</Text>
        <View style={{ marginTop: 8 }}>
          <Segmented
            options={(['ko', 'en'] as Language[]).map((lang) => ({
              value: lang,
              label: LANGUAGE_LABEL[lang],
            }))}
            value={prefs.language}
            onChange={(v) => prefs.setPref('language', v)}
          />
        </View>

        {/* [한글 주석: 음성 비서 목소리 선택 (다정한 여성, 친근한 삼촌, 차분한 젠틀맨, 귀여운 꼬마)] */}
        <Divider style={{ marginVertical: 18 }} />

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={styles.fieldLabel}>음성 비서 목소리 (TTS 톤)</Text>
          <PressableScale
            style={styles.voiceTestBtn}
            onPress={() => {
              const vt = prefs.voiceType ?? 'warm_female';
              const sampleText =
                vt === 'friendly_male'
                  ? '반갑습니다 사장님! 든든하고 친근한 삼촌 목소리입니다.'
                  : vt === 'calm_male'
                    ? '반갑습니다 사장님. 차분하고 안정적인 젠틀맨 목소리입니다.'
                    : vt === 'cute_child'
                      ? '우와 사장님 안녕! 귀여운 꼬마 목소리야!'
                      : '안녕하세요 사장님! 다정한 아나운서 여성 목소리입니다.';
              speechPlayer.speak(sampleText, { voiceType: vt, rate: prefs.speechRate });
            }}
            to={0.88}
          >
            <Ionicons name="volume-high" size={13} color="#FFFFFF" style={{ marginRight: 4 }} />
            <Text style={styles.voiceTestBtnText}>샘플 듣기</Text>
          </PressableScale>
        </View>

        <View style={styles.voiceGrid}>
          {(['warm_female', 'friendly_male', 'calm_male', 'cute_child'] as VoiceType[]).map((vt) => {
            const active = (prefs.voiceType ?? 'warm_female') === vt;
            const meta = VOICE_TYPE_LABEL[vt];
            return (
              <PressableScale
                key={vt}
                style={[styles.voiceCard, active && styles.voiceCardActive]}
                onPress={() => {
                  prefs.setPref('voiceType', vt);
                  const sampleText =
                    vt === 'friendly_male'
                      ? '반갑습니다 사장님! 든든하고 친근한 삼촌 목소리입니다.'
                      : vt === 'calm_male'
                        ? '반갑습니다 사장님. 차분하고 안정적인 젠틀맨 목소리입니다.'
                        : vt === 'cute_child'
                          ? '우와 사장님 안녕! 귀여운 꼬마 목소리야!'
                          : '안녕하세요 사장님! 다정한 아나운서 여성 목소리입니다.';
                  speechPlayer.speak(sampleText, { voiceType: vt, rate: prefs.speechRate });
                }}
                to={0.94}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons
                    name={
                      vt === 'warm_female'
                        ? 'woman-outline'
                        : vt === 'friendly_male'
                          ? 'man-outline'
                          : vt === 'calm_male'
                            ? 'person-outline'
                            : 'happy-outline'
                    }
                    size={15}
                    color={active ? colors.espressoBrown : colors.mochaBrown}
                  />
                  <Text style={[styles.voiceTitle, active && styles.voiceTitleActive]}>
                    {meta.title}
                  </Text>
                </View>
                <Text style={styles.voiceDesc}>{meta.desc}</Text>
              </PressableScale>
            );
          })}
        </View>

        {/* [한글 주석] 말하는 속도 — 알림을 읽는 빠르기. 5단계로 고르고, 고르는 즉시
            그 속도로 샘플이 나가 바로 비교된다. 값은 목소리 타입의 기본 속도에 곱해지므로
            어떤 목소리를 골라도 사장님이 정한 빠르기가 그대로 따라간다. */}
        <Text style={styles.fieldLabel}>말하는 속도</Text>
        <View style={styles.rateRow}>
          {SPEECH_RATE_STEPS.map((step) => {
            const active = nearestSpeechRate(prefs.speechRate) === step.value;
            return (
              <PressableScale
                key={step.value}
                style={[styles.rateChip, active && styles.rateChipActive]}
                onPress={() => {
                  prefs.setPref('speechRate', step.value);
                  speechPlayer.speak(
                    '이 속도로 알림을 읽어드릴게요. 사장님, 오늘도 좋은 하루 되세요.',
                    { voiceType: prefs.voiceType ?? 'warm_female', rate: step.value }
                  );
                }}
                to={0.92}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.rateChipText, active && styles.rateChipTextActive]}
                >
                  {step.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>
        <Text style={styles.rateHint}>
          {SPEECH_RATE_STEPS.find((s) => s.value === nearestSpeechRate(prefs.speechRate))?.hint ??
            '기본 속도'}
          {' · '}
          {nearestSpeechRate(prefs.speechRate).toFixed(2).replace(/0$/, '')}배속 — 누르면 바로
          들려드려요
        </Text>

        {/* 미리보기 — 선택한 글자 크기 및 언어가 즉시 반영 */}
        <View style={styles.previewBox}>
          <Text style={styles.previewCaption}>{t('preview')}</Text>
          <Text style={[styles.previewText, { fontSize: 15 * prefs.fontScale }]}>
            {t('previewText')}
          </Text>
        </View>

        {/* 설정 관련 안내 정보 */}
        <View style={styles.noteBox}>
          <Ionicons name="information-circle-outline" size={15} color={colors.mochaBrown} />
          <Text style={styles.noteText}>
            {t('fontSizeNote')}
          </Text>
        </View>
        <View style={[styles.noteBox, { marginTop: 6 }]}>
          <Ionicons name="globe-outline" size={15} color={colors.mochaBrown} />
          <Text style={styles.noteText}>
            {t('languageNote')}
          </Text>
        </View>
      </Card>
      )}

      {/* ④ [한글 주석] 사장님 1대1 문의 & 요청사항 서비스 카드 */}
      {subView === 'inquiry' && (
        <Card tone="cream">
          <View style={styles.rowBetween}>
            <SectionTitle>💬 1대1 CS 문의 & 요청</SectionTitle>
            <Badge label="실시간 관리자 연동" tone="green" />
          </View>
          <Text style={[styles.helperText, { marginTop: 4, marginBottom: 12 }]}>
            매장 운영 시 필요한 기능 개선 요청이나 불편사항을 해결해 드려요.
          </Text>

          {/* 3개 세그먼트형 탭 헤더 */}
          <View
            style={styles.tabContainer}
            onLayout={(e) => setCsTrackWidth(e.nativeEvent.layout.width)}
          >
            <Animated.View
              style={[
                styles.tabCapsule,
                {
                  width: (csTrackWidth - 6) / 3,
                  transform: [
                    {
                      translateX: csSlideAnim.interpolate({
                        inputRange: [0, 1, 2],
                        outputRange: [3, (csTrackWidth - 6) / 3 + 3, ((csTrackWidth - 6) / 3) * 2 + 3],
                      }),
                    },
                  ],
                },
              ]}
            />
            {[
              { id: 'write', label: '새 문의 작성' },
              { id: 'list', label: '나의 문의 내역' },
              { id: 'faq', label: '자주 묻는 질문' },
            ].map((tab) => {
              const active = inquiryTab === tab.id;
              return (
                <PressableScale
                  key={tab.id}
                  style={styles.tabButton}
                  onPress={() => {
                    springTransition();
                    setInquiryTab(tab.id as any);
                  }}
                  to={0.96}
                >
                  <Text style={[styles.tabButtonText, active && styles.tabButtonTextActive]}>
                    {tab.label}
                  </Text>
                </PressableScale>
              );
            })}
          </View>

          {/* 탭 1: 새 문의 작성 (내가 질문하는 칸) */}
          {inquiryTab === 'write' && (
            <View style={{ marginTop: 8 }}>
              {/* 문의 유형 선택 */}
              <Text style={styles.fieldLabel}>문의 유형 선택</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: 4, marginVertical: 8 }}>
                {[
                  { id: '💡 기능 요청 / 개선', label: '💡 기능 요청' },
                  { id: '❓ 사용 문의', label: '❓ 사용 문의' },
                  { id: '⚠ 에러 / 불편 제보', label: '⚠ 에러 제보' },
                  { id: '📞 기타 문의', label: '📞 기타 문의' },
                ].map((item) => {
                  const active = inquiryCategory === item.id;
                  return (
                    <PressableScale
                      key={item.id}
                      onPress={() => setInquiryCategory(item.id)}
                      style={{
                        flex: 1,
                        paddingHorizontal: 2,
                        paddingVertical: 8,
                        borderRadius: 999,
                        backgroundColor: active ? colors.pointOrange : 'rgba(242, 236, 224, 0.6)',
                        borderWidth: 1,
                        borderColor: active ? colors.pointOrange : 'rgba(140, 111, 86, 0.15)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      to={0.95}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          fontSize: 11.5,
                          fontWeight: active ? '800' : '700',
                          color: active ? colors.white : colors.mochaBrown,
                        }}
                      >
                        {item.label}
                      </Text>
                    </PressableScale>
                  );
                })}
              </View>

              {/* 제목 입력 */}
              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>문의 제목</Text>
              <TextInput
                style={[styles.input, { marginTop: 4 }]}
                placeholder="제목을 입력해 주세요 (예: 발주 추천 단위 변경 요청)"
                placeholderTextColor="rgba(140,111,86,0.5)"
                value={inquiryTitle}
                onChangeText={setInquiryTitle}
              />

              {/* 내용 입력 */}
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>상세 내용 / 요청사항</Text>
              <TextInput
                style={[
                  styles.input,
                  { marginTop: 4, height: 110, textAlignVertical: 'top', paddingTop: 10, paddingBottom: 10 },
                ]}
                placeholder="관리자에게 전달하실 내용을 상세히 작성해 주세요. 소중히 검토하여 빠르게 답변드릴게요."
                placeholderTextColor="rgba(140,111,86,0.5)"
                multiline
                numberOfLines={4}
                value={inquiryContent}
                onChangeText={setInquiryContent}
              />

              <Button
                label="문의 제출하기"
                style={{ marginTop: 16 }}
                onPress={handleSubmitInquiry}
              />
            </View>
          )}

          {/* 탭 2: 나의 문의 내역 (내가 질문했던 목록) */}
          {inquiryTab === 'list' && (
            <View style={{ marginTop: 8, gap: 10 }}>
              {inquiries.length === 0 ? (
                <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                  <Text style={{ ...typography.L5, color: colors.mochaBrown }}>아직 작성한 문의 내역이 없습니다.</Text>
                </View>
              ) : (
                inquiries.map((inq) => (
                  <View
                    key={inq.id}
                    style={{
                      backgroundColor: colors.white,
                      borderRadius: 14,
                      padding: 14,
                      borderWidth: 1,
                      borderColor: 'rgba(140, 111, 86, 0.1)',
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.05,
                      shadowRadius: 4,
                      elevation: 1,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Badge
                          label={inq.status === 'answered' ? '답변완료' : '접수완료'}
                          tone={inq.status === 'answered' ? 'green' : 'orange'}
                        />
                        <Text style={{ ...typography.L5, fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown }}>
                          {inq.category}
                        </Text>
                      </View>
                      <Text style={{ ...typography.L5, fontSize: 11, color: colors.mochaBrown + '80' }}>{inq.date}</Text>
                    </View>

                    <Text style={{ ...typography.L3, fontSize: 14, fontWeight: '800', color: colors.espressoBrown }}>
                      {inq.title}
                    </Text>
                    <Text style={{ ...typography.L4, fontSize: 12.5, color: colors.mochaBrown, marginTop: 4, lineHeight: 18 }}>
                      {inq.content}
                    </Text>

                    {inq.answer && (
                      <View
                        style={{
                          backgroundColor: colors.coffeeCream,
                          borderRadius: 10,
                          padding: 10,
                          marginTop: 10,
                          borderLeftWidth: 3,
                          borderLeftColor: colors.pointOrange,
                        }}
                      >
                        <Text style={{ ...typography.L4, fontSize: 12, fontWeight: '700', color: colors.espressoBrown }}>
                          💬 관리자 답변
                        </Text>
                        <Text style={{ ...typography.L4, fontSize: 12, color: colors.espressoBrown, marginTop: 2, lineHeight: 17 }}>
                          {inq.answer}
                        </Text>
                      </View>
                    )}
                  </View>
                ))
              )}
            </View>
          )}

          {/* 탭 3: 자주 묻는 질문 (다른 사람들이 많이 물어보는 질문) */}
          {inquiryTab === 'faq' && (
            <View style={{ marginTop: 8, gap: 8 }}>
              {[
                {
                  id: 1,
                  q: '원가율은 언제 업데이트되나요?',
                  a: '거래처로부터 매입 영수증이나 세금계산서가 OCR/자동 스크래핑을 통해 등록될 때마다, 원재료 단가 변동이 실시간 추적되어 메뉴 원가율에 자동 반영됩니다.'
                },
                {
                  id: 2,
                  q: '알바 스케줄을 짤 때 주휴수당도 계산되나요?',
                  // '분할 최적화 알고리즘 내장'은 사실이 아니었다 — 실제로 하는 건 주 15시간
                  // 기준 초과 여부를 계산해 보여주는 것까지다. 없는 기능을 약속하지 않는다.
                  a: '주 15시간을 넘기면 주휴수당이 발생하므로, 직원별 주간 근무시간과 그에 따른 주휴수당 예상액을 함께 계산해 보여드립니다. 일정을 자동으로 재배치해 드리지는 않고, 기준을 넘는 직원을 짚어 드리면 사장님이 판단하시는 방식이에요.'
                },
                {
                  id: 3,
                  q: 'AI 발주량 추천은 무엇을 보고 계산하나요?',
                  // '평균 22% 절감'은 측정한 적 없는 수치였다. 근거 없는 성능 수치는 빼고,
                  // 무엇을 입력으로 쓰는지만 사실대로 적는다.
                  a: '요일별 판매 흐름, 날씨 예보, 매장 주변 상권 정보를 함께 봅니다. 다만 판매 데이터가 쌓일수록 정확해지는 방식이라, 갓 시작한 매장에서는 추천 폭이 넓게 나올 수 있어요. 추천값은 참고용이고 최종 발주량은 사장님이 정하시면 됩니다.'
                },
                {
                  id: 4,
                  q: '매장 데이터는 안전하게 보관되나요?',
                  a: '매출·재고·거래명세서 등 입력하신 운영 데이터는 암호화된 통신으로 전송되며, 설정 > 약관 및 정책의 개인정보처리방침에 명시된 목적 범위 안에서만 처리됩니다. 회원 탈퇴 시에는 지체 없이 파기됩니다.'
                }
              ].map((faq) => {
                const expanded = faqExpandedId === faq.id;
                return (
                  <View
                    key={faq.id}
                    style={{
                      backgroundColor: colors.white,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: 'rgba(140, 111, 86, 0.1)',
                      overflow: 'hidden'
                    }}
                  >
                    <PressableScale
                      onPress={() => {
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setFaqExpandedId(expanded ? null : faq.id);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        backgroundColor: expanded ? colors.coffeeCream + '50' : colors.white
                      }}
                      to={0.98}
                    >
                      <Text style={{ ...typography.L4, fontSize: 13, fontWeight: '800', color: colors.espressoBrown, flex: 1, paddingRight: 8 }}>
                        Q. {faq.q}
                      </Text>
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={colors.mochaBrown}
                      />
                    </PressableScale>
                    
                    {expanded && (
                      <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: 'rgba(140, 111, 86, 0.08)', backgroundColor: colors.white }}>
                        <Text style={{ ...typography.L4, fontSize: 12.5, color: colors.mochaBrown, lineHeight: 18 }}>
                          {faq.a}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </Card>
      )}

      {/* ⑤ 약관 및 정책 */}
      {subView === 'legal' && (
        <Card>
        <SectionTitle>약관 및 정책</SectionTitle>
        <PressableScale
          style={styles.legalRow}
          onPress={() => navigation.navigate('Legal', { doc: 'terms' })}
        >
          <Text style={styles.legalLabel}>이용약관</Text>
          <Ionicons name="chevron-forward" size={17} color={colors.mochaBrown} />
        </PressableScale>
        <Divider />
        <PressableScale
          style={styles.legalRow}
          onPress={() => navigation.navigate('Legal', { doc: 'privacy' })}
        >
          <Text style={styles.legalLabel}>개인정보처리방침</Text>
          <Ionicons name="chevron-forward" size={17} color={colors.mochaBrown} />
        </PressableScale>
      </Card>
      )}

      {subView !== 'main' && (
        <Button
          label={t('returnToSettingsHome')}
          variant="secondary"
          style={{ marginTop: 14 }}
          onPress={() => changeSubView('main')}
        />
      )}
      </SubViewTransition>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { ...typography.L4, color: colors.espressoBrown },
  rowHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 3, lineHeight: 15 },
  // 푸시 미지원 빌드 안내 — 스위치가 왜 조용한지 알려주는 한 문단
  pushNotice: {
    ...typography.L5,
    color: colors.mochaBrown,
    lineHeight: 16,
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    padding: 11,
    marginBottom: 6,
  },

  fieldLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700', marginTop: 12 },
  input: {
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 6,
  },
  readonly: { ...typography.L4, color: colors.mochaBrown, marginTop: 6, paddingHorizontal: 2, paddingVertical: 4 },

  accountHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.espressoBrown, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '900', fontSize: 18 },
  accountName: { ...typography.L3, color: colors.espressoBrown },
  accountEmail: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  pwRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  dangerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(178,59,46,0.35)',
  },
  dangerText: { ...typography.L4, color: '#B23B2E' },

  // 카드 상단 안내 문구
  helperText: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 16 },

  dndRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  timeInput: {
    ...typography.L4, color: colors.espressoBrown, textAlign: 'center',
    backgroundColor: colors.coffeeCream, borderRadius: 10, paddingVertical: 10, width: 92,
  },
  dndTilde: { ...typography.L3, color: colors.mochaBrown },

  previewBox: {
    marginTop: 16, backgroundColor: colors.coffeeCream, borderRadius: 12, padding: 14,
  },
  previewCaption: { ...typography.L5, color: colors.mochaBrown, marginBottom: 6 },
  previewText: { color: colors.espressoBrown, fontWeight: '600' },

  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: 'rgba(140,111,86,0.06)', borderRadius: 10, padding: 10, marginTop: 12,
  },
  noteText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 16 },

  legalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 },
  legalLabel: { ...typography.L4, color: colors.espressoBrown },

  // [한글 주석] 1대1 문의 및 팝업 모달 전용 레이아웃 스타일 (스마트폰 중앙 너비 420px 한정 조형)
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: colors.white,
    borderRadius: 22,
    padding: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  modalHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    ...typography.L2,
    fontSize: 16,
    color: colors.espressoBrown,
    fontWeight: '900',
  },
  // [한글 주석: 카테고리별 정렬 설정 메뉴 카드 및 아이콘 래퍼 디자인 스타일]
  menuItemCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    shadowColor: 'rgba(140, 111, 86, 0.15)',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  menuIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuItemTitle: {
    ...typography.L4,
    fontSize: 14.5,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  menuItemDesc: {
    ...typography.L5,
    fontSize: 11.5,
    color: colors.mochaBrown,
    marginTop: 4,
    lineHeight: 14,
  },
  // [한글 주석: 1대1 CS 탭 컴포넌트 스타일군 추가]
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: colors.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  tabButtonText: {
    ...typography.L5,
    fontSize: 12,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  tabButtonTextActive: {
    color: colors.espressoBrown,
    fontWeight: '900',
  },
  tabCapsule: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    borderRadius: 8,
    backgroundColor: colors.white,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  // [한글 주석: 수정 불가능하게 고정된 확정 텍스트 정보 가로 행 스타일 추가]
  fixedInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  fixedInfoLabel: {
    ...typography.L4,
    fontSize: 13.5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  fixedInfoValue: {
    ...typography.L3,
    fontSize: 14.5,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  // [한글 주석: 음성 비서 목소리 타입 선택 카드 그리드 스타일]
  voiceTestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.espressoBrown,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  voiceTestBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.white,
  },
  voiceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  voiceCard: {
    width: '48.5%',
    backgroundColor: '#FFFDF9',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#EFECE6',
  },
  voiceCardActive: {
    backgroundColor: 'rgba(110, 85, 68, 0.09)',
    borderColor: colors.espressoBrown,
    borderWidth: 1.5,
  },
  voiceTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  voiceTitleActive: {
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  voiceDesc: {
    fontSize: 10,
    color: colors.mochaBrown,
    marginTop: 4,
    lineHeight: 13,
  },
  // [한글 주석: 말하는 속도 5단계 칩]
  // [한글 주석] 5단계가 반드시 한 줄에 들어가야 한다 — 줄바꿈되면 '아주 빠르게'만 아래로
  // 떨어져 단계가 이어져 보이지 않는다. 그래서 wrap 없이 다섯 칸을 균등 분할한다.
  rateRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 4,
    marginTop: 8,
  },
  rateChip: {
    flex: 1,
    paddingHorizontal: 2,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#FFFDF9',
    borderWidth: 1,
    borderColor: '#EFECE6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateChipActive: {
    backgroundColor: colors.espressoBrown,
    borderColor: colors.espressoBrown,
  },
  rateChipText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.mochaBrown,
    textAlign: 'center',
    letterSpacing: -0.4, // 좁은 칸에 '아주 느리게'가 한 줄로 들어가도록 자간을 살짝 줄인다
  },
  rateChipTextActive: {
    color: colors.white,
    fontWeight: '900',
  },
  rateHint: {
    ...typography.L5,
    color: colors.mochaBrown,
    marginTop: 7,
    lineHeight: 16,
  },
  // [한글 주석: 음성 출력 조건 · 현재 출력 장치 표시 박스]
  voiceOutBox: {
    marginTop: 10,
    backgroundColor: '#FFFDF9',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#EFECE6',
    padding: 12,
  },
  audioStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  audioStatusText: {
    ...typography.L5,
    color: colors.mochaBrown,
    flex: 1,
    lineHeight: 16,
  },
  audioCheckBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.espressoBrown,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  audioCheckBtnText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  audioTestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.espressoBrown,
    borderRadius: 10,
    paddingVertical: 9,
    marginTop: 10,
  },
  audioTestBtnText: {
    fontSize: 12.5,
    fontWeight: '800',
    color: colors.white,
  },
  audioHint: {
    ...typography.L5,
    color: colors.mochaBrown,
    marginTop: 8,
    lineHeight: 15,
  },
});
