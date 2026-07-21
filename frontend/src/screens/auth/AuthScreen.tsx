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

import { useAuth } from '../../auth/AuthContext';
import { API_BASE_URL } from '../../lib/api/client';
import { FadeInUp, PressableScale } from '../../components/motion';
import { IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { colors, spacing, typography } from '../../theme';

const LOGO = require('../../../assets/logo_transparent.png');

type Mode = 'login' | 'signup';

// 상권 유형 옵션 (이모지 전면 제거 및 텍스트 정돈)
const BIZ_TYPES = ['오피스 상권', '주택가 상권', '대학가 상권', '복합 상권'];

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
  const { login, signup, loginWithGoogle, loginWithApple } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [step, setStep] = useState<1 | 2>(1); // [한글 주석] 회원가입 1단계/2단계 구분 상태

  // 1단계 기본 정보
  const [name, setName] = useState('');
  // [한글 주석] 직접 입력하여 가입 및 로그인을 할 수 있도록 기본값(데모 계정)을 삭제합니다.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [autoLogin, setAutoLogin] = useState(true);

  // 2단계 가게 상세 설정 정보
  const [region, setRegion] = useState('서울특별시 중구 명동');
  const [openHour, setOpenHour] = useState('09:00');
  const [closeHour, setCloseHour] = useState('21:00');
  const [bizType, setBizType] = useState('오피스 상권');
  // [한글 주석] 네이버 지도 위치 선택 모달 표시 여부 상태 복원
  const [showMapModal, setShowMapModal] = useState(false);
  // 지도 핀으로 확정한 매장 좌표 — 가입 완료 시 저장되어 대시보드 예측(날씨·행사)에 그대로 쓰인다
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  // 모달의 "주소 검색" 버튼이 지도 초기화 이후 생성되는 검색 함수를 호출할 수 있게 ref로 연결
  const mapSearchRef = useRef<((query: string) => void) | null>(null);
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

  // [회원가입 지도 핀 훅] SalesCard와 동일한 '직접 스크립트 로드' 방식.
  // 이전 iframe(m.map.naver.com) 방식은 네이버가 외부 삽입을 차단(X-Frame-Options)해 빈 화면이 됐다.
  // 지도 클릭 → 핀 이동 + 역지오코딩으로 주소 자동 입력, 주소 검색 → 지오코딩으로 핀 이동.
  // 네이버 인증 실패 시 Leaflet 오픈맵 + Nominatim 지오코딩으로 폴백해 기능이 죽지 않는다.
  useEffect(() => {
    if (Platform.OS !== 'web' || !showMapModal) return;
    const NAVER_CLIENT_ID = process.env.EXPO_PUBLIC_NAVER_CLIENT_ID || '6amak4awt7';
    let disposed = false;

    const startLat = coords?.lat ?? 37.5665;
    const startLon = coords?.lon ?? 126.978;

    const applyPick = (lat: number, lon: number, address?: string) => {
      if (disposed) return;
      setCoords({ lat, lon });
      if (address) setRegion(address);
    };

    // 역지오코딩은 Nominatim 사용 — 네이버 Geocoding API는 NCP에서 별도 신청이 필요해
    // 미신청 상태에서도 주소가 항상 채워지도록 공개 API로 통일한다
    const reverseGeocode = async (lat: number, lon: number): Promise<string | undefined> => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ko&zoom=17`,
        );
        const data = await res.json();
        const a = data?.address;
        if (!a) return undefined;
        // 한국 주소 위계: 시/도 → 구/군 → 동/읍/면 → 도로명
        const parts = [a.province || a.city, a.borough || a.county || a.city_district, a.suburb || a.quarter || a.town || a.village, a.road]
          .filter(Boolean);
        return parts.length ? Array.from(new Set(parts)).join(' ') : (data.display_name as string);
      } catch {
        return undefined;
      }
    };

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
      // 3순위: Photon(OSM) — 접두어 매칭이 되어 '협성대'→'협성대학교' 같은 명칭 검색에 강하다.
      // 네이버 지오코더는 도로명주소 전용이라, 백엔드가 꺼져 있을 때 명칭 검색은 여기서 잡는다.
      try {
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&bbox=124,33,132,39`,
        );
        const feats: any[] = (await res.json())?.features ?? [];
        const minor = ['bicycle_rental', 'vending_machine', 'parking'];
        const best = feats
          .map((f) => {
            const p = f?.properties ?? {};
            const name: string = p.name ?? '';
            const score = (name === q ? 4 : 0) + (name.startsWith(q) ? 2 : 0) + (minor.includes(p.osm_value) ? 0 : 1);
            return { f, p, name, score };
          })
          .sort((a, b) => b.score - a.score)[0];
        if (best?.f?.geometry?.coordinates) {
          const [lonP, latP] = best.f.geometry.coordinates;
          const region = [best.p.state, best.p.city, best.p.county, best.p.district]
            .filter((v, i, arr) => v && arr.indexOf(v) === i)
            .join(' ');
          return {
            lat: parseFloat(latP),
            lon: parseFloat(lonP),
            label: [region, best.name].filter(Boolean).join(' ') || undefined,
          };
        }
      } catch {
        // Photon 실패 시 아래 Nominatim으로
      }
      // 4순위: Nominatim 검색 (도로명주소·정식 지명)
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&accept-language=ko&countrycodes=kr&limit=1`,
        );
        const data = await res.json();
        if (data?.[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      } catch {
        // 검색 실패 시 null — 버튼 쪽에서 안내
      }
      return null;
    };

    const initNaverPicker = () => {
      try {
        const container = document.getElementById('signup-map-container');
        if (!container) return;
        container.innerHTML = '';
        const naverObj = (window as any).naver;
        if (!naverObj?.maps) {
          initLeafletPicker();
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

        // 모달을 열 때 이미 주소가 입력되어 있으면 그 위치로 자동 이동 (핀 미확정 상태일 때만)
        if (!coords && region.trim()) mapSearchRef.current(region);
      } catch (err) {
        console.error('네이버 지도 핀 초기화 실패, Leaflet 폴백:', err);
        initLeafletPicker();
      }
    };

    const initLeafletPicker = () => {
      const container = document.getElementById('signup-map-container');
      if (!container) return;
      container.innerHTML = '';

      if (!document.getElementById('leaflet-css-direct')) {
        const link = document.createElement('link');
        link.id = 'leaflet-css-direct';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }

      const startLeaflet = () => {
        const L = (window as any).L;
        if (!L || disposed) return;
        const map = L.map(container, { zoomControl: false }).setView([startLat, startLon], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
        const marker = L.circleMarker([startLat, startLon], {
          color: '#E28257',
          fillColor: '#FFFFFF',
          fillOpacity: 1,
          radius: 9,
          weight: 4,
        }).addTo(map);

        const pick = async (lat: number, lon: number) => {
          setMapNotice('');
          marker.setLatLng([lat, lon]);
          applyPick(lat, lon);
          const addr = await reverseGeocode(lat, lon);
          if (addr) applyPick(lat, lon, addr);
        };

        map.on('click', (e: any) => pick(e.latlng.lat, e.latlng.lng));

        mapSearchRef.current = async (query: string) => {
          setMapNotice('🔍 주소를 찾는 중…');
          const found = await searchGeocode(query);
          if (disposed) return;
          if (!found) {
            setMapNotice('주소를 찾지 못했어요. 도로명주소를 좀 더 구체적으로 입력해 주세요.');
            return;
          }
          map.setView([found.lat, found.lon], 16);
          marker.setLatLng([found.lat, found.lon]);
          // 찾은 명칭·주소를 입력창에 채운다 ('협성대' → '경기도 화성시 봉담읍 협성대학교')
          applyPick(found.lat, found.lon, found.label);
          setMapNotice(found.label ? `📍 ${found.label}` : '📍 위치로 이동했어요. 핀을 눌러 미세 조정할 수 있어요.');
        };

        // 모달을 열 때 이미 주소가 입력되어 있으면 그 위치로 자동 이동 (핀 미확정 상태일 때만)
        if (!coords && region.trim()) mapSearchRef.current(region);
      };

      const existingScript = document.getElementById('leaflet-js-direct');
      if (existingScript) {
        if ((window as any).L) startLeaflet();
        else existingScript.addEventListener('load', startLeaflet, { once: true });
      } else {
        const script = document.createElement('script');
        script.id = 'leaflet-js-direct';
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.onload = startLeaflet;
        document.head.appendChild(script);
      }
    };

    (window as any).navermap_authFailure = () => {
      console.warn('네이버 지도 인증 실패: Leaflet 오픈 지도로 전환합니다.');
      initLeafletPicker();
    };

    const loadNaverScript = () => {
      const existing = document.getElementById('naver-map-script-geocoder');
      if (existing) {
        if ((window as any).naver?.maps) initNaverPicker();
        else existing.addEventListener('load', initNaverPicker, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = 'naver-map-script-geocoder';
      script.type = 'text/javascript';
      // 신규 NCP Maps API는 oapi 도메인 + ncpKeyId 파라미터로만 인증됨. geocoder 서브모듈로 주소 검색까지 지원.
      script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NAVER_CLIENT_ID}&submodules=geocoder`;
      script.onload = initNaverPicker;
      script.onerror = () => {
        console.error('네이버 지도 로딩 실패: Leaflet으로 전환');
        initLeafletPicker();
      };
      document.head.appendChild(script);
    };

    const timer = setTimeout(loadNaverScript, 50);
    return () => {
      disposed = true;
      clearTimeout(timer);
      mapSearchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMapModal]);

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
    setStep(2);
  };

  const submit = async () => {
    setError('');
    if (mode === 'login') {
      if (!email.trim() || !password) {
        setError('이메일과 비밀번호를 입력해 주세요.');
        return;
      }
      setBusy(true);
      try {
        await login(email, password, autoLogin);
      } catch (e) {
        setError(e instanceof Error ? e.message : '문제가 발생했어요.');
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
        await signup(name, email, password, autoLogin);
        // 가입 성공 시 매장 위치를 로컬에 저장 — 대시보드/발주 예측이 기기 GPS보다 이 좌표를 우선 사용한다
        try {
          await AsyncStorage.setItem(
            'simplem:storeLocation',
            JSON.stringify({ region: region.trim(), lat: coords?.lat, lon: coords?.lon, bizType }),
          );
        } catch {
          // 위치 저장 실패는 가입 자체를 막지 않는다 (예측은 GPS로 폴백)
        }
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

  const handleAppleLogin = async () => {
    setError('');
    setBusy(true);
    try {
      await loginWithApple(autoLogin);
    } catch (e) {
      setError(e instanceof Error ? e.message : '애플 로그인 중 문제가 발생했어요.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setStep(1);
    setError('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 브랜드 */}
        <FadeInUp>
          <View style={styles.brand}>
            <Image source={LOGO} style={styles.logo} resizeMode="contain" />
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
                  secureTextEntry
                />

                {/* 자동 로그인 체크박스 */}
                <PressableScale style={styles.checkRow} onPress={() => setAutoLogin((v) => !v)} to={0.98}>
                  <View style={[styles.checkbox, autoLogin && styles.checkboxOn]}>
                    {autoLogin && <Ionicons name="checkmark" size={14} color={colors.white} />}
                  </View>
                  <Text style={styles.checkLabel}>자동 로그인</Text>
                </PressableScale>

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
                  placeholder="비밀번호"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
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
                                '제1조 (목적)\n본 약관은 SimpleM 서비스(이하 "서비스") 이용 조건 및 절차, 이용자와 당사의 권리·의무 및 책임사항을 규정함을 목적으로 합니다.\n\n제2조 (회원의 의무)\n회원은 본 서비스 이용 시 관련 법령 및 본 약관을 준수하여야 하며, 타인의 정보를 도용해서는 안 됩니다.\n\n제3조 (서비스의 제공)\n당사는 365일 24시간 안정적인 경영 분석 및 가맹 관리 서비스를 제공하도록 최선을 다합니다.',
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
                                '1. 수집 항목: 상호명, 이메일 주소, 비밀번호, 매장 위치 정보, 운영 시간대\n2. 수집 및 이용 목적: 회원 식별, 카페 맞춤형 경영 분석 리포트 제공, 서비스 장애 안내\n3. 보유 및 이용 기간: 회원 탈퇴 시 즉시 파기 (단, 관계 법령에 따라 5년간 보관)',
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
                  <Text style={styles.separatorText}>또는 소셜 계정으로 로그인</Text>
                  <View style={styles.separatorLine} />
                </View>

                <View style={styles.socialButtonsRow}>
                  <PressableScale
                    style={[styles.socialBtn, styles.googleBtn]}
                    onPress={handleGoogleLogin}
                    disabled={busy}
                  >
                    <Ionicons name="logo-google" size={18} color={colors.espressoBrown} />
                    <Text style={[styles.socialBtnText, styles.googleBtnText]}>Google</Text>
                  </PressableScale>

                  <PressableScale
                    style={[styles.socialBtn, styles.appleBtn]}
                    onPress={handleAppleLogin}
                    disabled={busy}
                  >
                    <Ionicons name="logo-apple" size={18} color={colors.white} />
                    <Text style={[styles.socialBtnText, styles.appleBtnText]}>Apple</Text>
                  </PressableScale>
                </View>
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
                placeholder="가게 주소 입력 (예: 서울 중구 명동길 26)"
                placeholderTextColor={colors.mochaBrown}
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
            </View>

            {/* [한글 주석] 지도가 그려지는 영역 — 클릭/핀 드래그로 위치 지정 (웹 전용, 앱은 주소 입력으로 설정) */}
            <View style={{ marginVertical: 10, borderRadius: 14, overflow: 'hidden', height: 260, backgroundColor: colors.creamSand }}>
              {Platform.OS === 'web' ? (
                <View id="signup-map-container" style={{ width: '100%', height: '100%' }} />
              ) : (
                <View style={styles.mapContainerBox}>
                  <Ionicons name="location" size={36} color={colors.pointOrange} />
                  <Text style={{ fontSize: 13, fontWeight: '800', color: colors.espressoBrown, marginTop: 6, textAlign: 'center' }}>
                    {region}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.mochaBrown, marginTop: 4, textAlign: 'center' }}>
                    앱에서는 위 주소 입력으로 위치를 설정해 주세요
                  </Text>
                </View>
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
    </KeyboardAvoidingView>
  );
}

function Field({
  icon,
  ...props
}: { icon: keyof typeof Ionicons.glyphMap } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Ionicons name={icon} size={18} color={colors.mochaBrown} />
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.mochaBrown}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  content: { padding: spacing.globalPadding, paddingTop: 60, gap: spacing.verticalGap },
  brand: { alignItems: 'center', marginBottom: 8 },
  logo: { width: 216, height: 175 },
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
  socialButtonsRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  socialBtn: {
    flex: 1,
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
  appleBtn: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  appleBtnText: {
    color: colors.white,
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
});
