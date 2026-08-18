// [매장 위치 등록/변경 모달]
// 회원가입 2단계의 지도 핀과 같은 역할을, 로그인 후에도 할 수 있게 한 화면.
//   · 구버전 앱에서 가입해 좌표가 없는 계정 → 여기서 처음 등록
//   · 이전/확장으로 매장이 옮겨간 경우      → 여기서 핀 이동
// 확정하면 계정(DB)에 저장되므로 어느 기기로 로그인해도 매장 지도는 이 좌표에 고정된다.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';

import { API_BASE_URL } from '../../lib/api/client';
import { NAVER_CLIENT_ID, NAVER_MAP_ERROR, loadNaverMaps, mapPageOrigin } from '../../lib/naverMap';
import { colors, shadows, typography } from '../../theme';
import { useResponsive } from '../../theme/responsive';
import { useFrameSheetStyle } from '../DeviceFrame';

type Picked = { lat: number; lon: number; address?: string };

export default function StoreLocationPicker({
  visible,
  initial,
  saving = false,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initial?: { lat: number; lon: number; address?: string } | null;
  saving?: boolean;
  onClose: () => void;
  onConfirm: (picked: Picked) => void;
}) {
  // [한글 주석] 뷰포트 비례 계산 — 가로모드·작은 기기에서 지도 높이를 줄인다
  const { vh } = useResponsive();
  const frameSheetStyle = useFrameSheetStyle();
  const [picked, setPicked] = useState<Picked | null>(initial ?? null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);
  const webRef = useRef<WebView>(null);
  // 웹 지도의 핀을 검색 결과 좌표로 옮기는 함수 (지도 초기화 후 연결된다)
  const setPinRef = useRef<((lat: number, lon: number, address?: string) => void) | null>(null);

  const startLat = initial?.lat ?? 37.5665;
  const startLon = initial?.lon ?? 126.978;

  // 좌표 → 주소 (백엔드 네이버 역지오코딩 프록시)
  const reverseGeocode = async (lat: number, lon: number): Promise<string | undefined> => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/reverse-geocode?lat=${lat}&lon=${lon}`);
      if (!res.ok) return undefined;
      const data = await res.json();
      return typeof data?.address === 'string' && data.address ? data.address : undefined;
    } catch {
      return undefined;
    }
  };

  // 주소/상호 검색 → 좌표 (백엔드 네이버 지오코딩 프록시)
  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setNotice('🔎 위치를 찾는 중…');
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/geocode?query=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setNotice('그 주소를 찾지 못했어요. 도로명주소나 상호를 더 구체적으로 입력해 주세요.');
        return;
      }
      const d = await res.json();
      if (typeof d?.lat !== 'number' || typeof d?.lon !== 'number') {
        setNotice('그 주소를 찾지 못했어요. 다시 시도해 주세요.');
        return;
      }
      setPicked({ lat: d.lat, lon: d.lon, address: d.address });
      setNotice(d.address ? `📍 ${d.address}` : '📍 위치로 이동했어요. 지도를 눌러 미세 조정할 수 있어요.');
      if (Platform.OS === 'web') {
        setPinRef.current?.(d.lat, d.lon, d.address);
      } else {
        webRef.current?.injectJavaScript(
          `window.setPin && window.setPin(${d.lat}, ${d.lon}, ${JSON.stringify(d.address || '')}); true;`,
        );
      }
    } finally {
      setSearching(false);
    }
  };

  // 웹 전용 지도 렌더 — 네이티브는 백엔드가 서빙하는 picker.html을 WebView로 띄운다
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    let disposed = false;

    loadNaverMaps()
      .then((naverObj) => {
        if (disposed) return;
        const container = document.getElementById('store-location-picker-map');
        if (!container) return;
        container.innerHTML = '';

        const center = new naverObj.maps.LatLng(picked?.lat ?? startLat, picked?.lon ?? startLon);
        const map = new naverObj.maps.Map(container, { center, zoom: 16, zoomControl: false });
        const marker = new naverObj.maps.Marker({ position: center, map });

        const pick = async (lat: number, lon: number, addressMaybe?: string) => {
          marker.setPosition(new naverObj.maps.LatLng(lat, lon));
          setPicked({ lat, lon, address: addressMaybe });
          setNotice('');
          if (!addressMaybe) {
            const addr = await reverseGeocode(lat, lon);
            if (addr) setPicked({ lat, lon, address: addr });
          }
        };

        naverObj.maps.Event.addListener(map, 'click', (e: any) => {
          pick(e.coord.lat(), e.coord.lng());
        });

        setPinRef.current = (lat: number, lon: number, address?: string) => {
          const pos = new naverObj.maps.LatLng(lat, lon);
          map.setCenter(pos);
          marker.setPosition(pos);
          pick(lat, lon, address);
        };
      })
      .catch((err: Error) => {
        if (!disposed) setNotice(err.message || NAVER_MAP_ERROR);
      });

    return () => {
      disposed = true;
      setPinRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/* [FormSheet 패턴] Modal은 웹에서 뷰포트 전체를 덮으므로, root에서 폰 프레임(maxWidth 420)
          안에 시트를 가둔다. 이걸 빼면 데스크톱에서 지도가 화면 폭만큼 늘어나 띠처럼 보인다. */}
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, frameSheetStyle]}>
          <View style={styles.header}>
            <Text style={styles.title}>매장 위치 {initial ? '변경' : '등록'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.espressoBrown} />
            </TouchableOpacity>
          </View>

          <Text style={styles.desc}>
            지도를 눌러 매장 자리를 지정해 주세요. 이 위치가 매장 지도와 주변 카페 분석의 기준점이 됩니다.
          </Text>

          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.mochaBrown} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="도로명주소 또는 상호 검색"
              placeholderTextColor={colors.mochaBrown}
              onSubmitEditing={search}
              returnKeyType="search"
            />
            <TouchableOpacity style={styles.searchBtn} onPress={search} disabled={searching}>
              <Text style={styles.searchBtnText}>{searching ? '검색 중' : '검색'}</Text>
            </TouchableOpacity>
          </View>

          {/* [한글 주석] 지도 높이는 뷰포트 비례 — 세로 짧은 기기에서 아래 버튼이 밀리지 않게 */}
          <View style={[styles.mapBox, { height: Math.min(vh(38), 300) }]}>
            {Platform.OS === 'web' ? (
              <View id="store-location-picker-map" style={{ width: '100%', height: '100%' }} />
            ) : (
              <WebView
                ref={webRef}
                originWhitelist={['*']}
                source={{
                  // 지도 페이지만은 네이버에 등록된 도메인에서 받아온다 (mapPageOrigin 주석 참고)
                  uri: `${mapPageOrigin(API_BASE_URL)}/map/picker.html?key=${encodeURIComponent(
                    NAVER_CLIENT_ID,
                  )}&lat=${picked?.lat ?? startLat}&lon=${picked?.lon ?? startLon}`,
                }}
                javaScriptEnabled
                domStorageEnabled
                onMessage={(e) => {
                  try {
                    const msg = JSON.parse(e.nativeEvent.data);
                    if (msg.type === 'pick') {
                      setPicked({ lat: msg.lat, lon: msg.lon, address: msg.address });
                      setNotice('');
                    }
                  } catch {
                    // 엔진 알림 등 형식이 다른 메시지는 무시
                  }
                }}
                style={{ flex: 1, backgroundColor: colors.creamSand }}
              />
            )}
          </View>

          <Text style={styles.picked}>
            {notice
              ? notice
              : picked
                ? `📍 ${picked.address ?? '주소 확인 중'}  (${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)})`
                : '아직 위치를 지정하지 않았어요.'}
          </Text>

          <TouchableOpacity
            style={[styles.confirmBtn, (!picked || saving) && styles.confirmBtnDisabled]}
            disabled={!picked || saving}
            onPress={() => picked && onConfirm(picked)}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.confirmText}>이 위치로 매장 등록</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 28,
    maxHeight: '92%',
    ...shadows.medium,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.L1, color: colors.espressoBrown },
  desc: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 6 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  searchInput: { flex: 1, ...typography.L4, color: colors.espressoBrown, outlineStyle: 'none' as any },
  searchBtn: {
    backgroundColor: colors.espressoBrown,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  searchBtnText: { ...typography.L5, color: colors.white, fontWeight: '800' },
  mapBox: {
    // [한글 주석] 높이는 컴포넌트에서 뷰포트 비례로 덮어쓴다 (고정 300 은 가로모드에서 버튼을 밀어냈다)
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 12,
    backgroundColor: colors.coffeeCream,
  },
  picked: { ...typography.L5, color: colors.espressoBrown, marginTop: 10, lineHeight: 16 },
  confirmBtn: {
    marginTop: 14,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmBtnDisabled: { opacity: 0.45 },
  confirmText: { ...typography.L3, color: colors.white },
});
