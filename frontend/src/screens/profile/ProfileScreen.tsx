// 프로필 화면 — 사진 변경 + 상호/비밀번호 수정 + 매장 위치 지도 + 로그아웃
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import StoreLocationMap from '../../components/dashboard/StoreLocationMap';
import { FadeInUp, PressableScale } from '../../components/motion';
import {
  cacheStoreLocation,
  getDevicePosition,
  getSalesForecast,
  getStoredStoreLocation,
  type SalesForecast,
  type StoredStoreLocation,
} from '../../lib/api/forecast';
import { colors, spacing, typography } from '../../theme';

export default function ProfileScreen() {
  const navigation = useNavigation();
  const { user, token, updateProfile, logout } = useAuth();

  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');
  const [photo, setPhoto] = useState<string | undefined>(user?.photo);
  const [saved, setSaved] = useState(false);

  // [한글 주석] 매장 위치·주변 행사 — 로컬 저장 좌표(가입 핀/예측 캐시)로 지도를 먼저 즉시 띄우고,
  // 무거운 예측 API는 뒤에서 받아 지역명 보정과 인근 행사 마커만 추가한다
  const [storedLoc, setStoredLoc] = useState<StoredStoreLocation | null>(null);
  const [forecast, setForecast] = useState<SalesForecast | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStoredStoreLocation().then((loc) => {
      if (!cancelled && loc) setStoredLoc(loc);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const pos = await getDevicePosition();
        const data = await getSalesForecast(token, pos?.lat, pos?.lon);
        if (!cancelled) {
          setForecast(data);
          // 다음 방문부터는 이 좌표로 지도가 즉시 뜨도록 캐시
          if (data.location) cacheStoreLocation(data.location);
        }
      } catch (e) {
        console.error('프로필 매장 위치 조회 실패:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 예측 응답이 오면 그것을 우선, 오기 전엔 로컬 저장 좌표로 즉시 렌더
  const mapLocation = forecast?.location ?? storedLoc;
  const mapRegion = forecast?.location?.region ?? storedLoc?.region ?? '';

  const initial = (user?.name || 'S').charAt(0).toUpperCase();

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    });
    if (!res.canceled && res.assets[0]) {
      const a = res.assets[0];
      // 웹/앱 모두 재접속 후에도 유지되도록 data URI로 저장
      const uri = a.base64 ? `data:image/jpeg;base64,${a.base64}` : a.uri;
      setPhoto(uri);
    }
  };

  const save = async () => {
    await updateProfile({ name, password: password || undefined, photo });
    setPassword('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const removePhoto = () => setPhoto(undefined);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* 상단바 */}
      <View style={styles.appbar}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.espressoBrown} />
        </TouchableOpacity>
        <Text style={styles.appbarTitle}>프로필</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* [한글 주석] 프로필 사진 순차 등장 */}
        <FadeInUp delay={50}>
          <View style={styles.avatarWrap}>
            <TouchableOpacity activeOpacity={0.85} onPress={pickPhoto}>
              {photo ? (
                <Image source={{ uri: photo }} style={styles.avatarImg} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
              )}
              <View style={styles.camBadge}>
                <Ionicons name="camera" size={16} color={colors.white} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={pickPhoto}>
              <Text style={styles.changePhoto}>사진 변경</Text>
            </TouchableOpacity>
            {photo ? (
              <TouchableOpacity onPress={removePhoto}>
                <Text style={styles.removePhoto}>기본 이미지로</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </FadeInUp>

        {/* [한글 주석] 상호/이름 필드 순차 등장 */}
        <FadeInUp delay={120}>
          <Text style={styles.label}>상호 / 이름</Text>
          <View style={styles.field}>
            <Ionicons name="storefront-outline" size={18} color={colors.mochaBrown} />
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="상호" placeholderTextColor={colors.mochaBrown} />
          </View>
        </FadeInUp>

        {/* [한글 주석] 이메일 필드 순차 등장 */}
        <FadeInUp delay={190}>
          <Text style={styles.label}>이메일</Text>
          <View style={[styles.field, styles.fieldDisabled]}>
            <Ionicons name="mail-outline" size={18} color={colors.mochaBrown} />
            <Text style={styles.readonly}>{user?.email}</Text>
          </View>
        </FadeInUp>

        {/* [한글 주석] 매장 위치 네이버 지도 — 위치 칩 대신 프로필 창에서 확인 (브라운 마커=내 매장, 오렌지=인근 행사) */}
        <FadeInUp delay={225}>
          <Text style={styles.label}>
            매장 위치{mapRegion ? ` — ${mapRegion}` : ''}
          </Text>
          <View style={styles.mapCard}>
            {mapLocation ? (
              <StoreLocationMap
                lat={mapLocation.lat}
                lon={mapLocation.lon}
                regionName={mapRegion}
                shopLabel={user?.name ? `내 매장 (${user.name})` : '내 매장'}
                nearbyEvents={forecast?.nearby_events ?? []}
                containerId="profile-store-map"
              />
            ) : (
              <View style={styles.mapLoading}>
                <ActivityIndicator size="small" color={colors.mochaBrown} />
                <Text style={styles.mapLoadingText}>매장 위치를 불러오는 중...</Text>
              </View>
            )}
          </View>
        </FadeInUp>

        {/* [한글 주석] 새 비밀번호 필드 순차 등장 */}
        <FadeInUp delay={260}>
          <Text style={styles.label}>새 비밀번호 (변경 시에만)</Text>
          <View style={styles.field}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.mochaBrown} />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="비워두면 그대로 유지"
              placeholderTextColor={colors.mochaBrown}
              secureTextEntry
            />
          </View>
        </FadeInUp>

        {/* [한글 주석] 저장 버튼 순차 등장 */}
        <FadeInUp delay={330}>
          <PressableScale style={styles.saveBtn} onPress={save}>
            <Text style={styles.saveText}>{saved ? '저장됐어요 ✓' : '저장하기'}</Text>
          </PressableScale>
        </FadeInUp>

        {/* [한글 주석] 로그아웃 버튼 순차 등장 */}
        <FadeInUp delay={400}>
          <PressableScale style={styles.logoutBtn} onPress={logout} to={0.98}>
            <Ionicons name="log-out-outline" size={18} color="#B23B2E" />
            <Text style={styles.logoutText}>로그아웃</Text>
          </PressableScale>
        </FadeInUp>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 52,
    paddingBottom: 14,
    paddingHorizontal: spacing.globalPadding,
    borderBottomWidth: 1,
    borderBottomColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  appbarTitle: { ...typography.L3, color: colors.espressoBrown },
  // [한 화면 피트] 지도 섹션이 늘어난 만큼 아바타·여백을 압축해 스크롤 없이 전체가 보이게
  content: { padding: spacing.globalPadding, paddingBottom: 24 },
  avatarWrap: { alignItems: 'center', marginBottom: 14 },
  avatarImg: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.coffeeCream },
  avatarFallback: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.espressoBrown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 32, fontWeight: '900', color: colors.creamSand },
  camBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.pointOrange,
    borderWidth: 3,
    borderColor: colors.creamSand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhoto: { ...typography.L4, color: colors.pointOrange, fontWeight: '700', marginTop: 8 },
  removePhoto: { ...typography.L5, color: colors.mochaBrown, marginTop: 6 },
  label: { ...typography.L5, color: colors.mochaBrown, marginBottom: 6, marginTop: 8 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  fieldDisabled: { backgroundColor: colors.coffeeCream },
  // [한글 주석] 매장 위치 지도 카드 — 입력 필드와 같은 라운드·보더 톤으로 통일
  mapCard: {
    height: 150, // [한 화면 피트] 240 → 150으로 축소
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    backgroundColor: '#F8F6F2',
    overflow: 'hidden',
    marginBottom: 8,
  },
  mapLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  mapLoadingText: { ...typography.L5, color: colors.mochaBrown },
  input: { flex: 1, paddingVertical: 13, ...typography.L4, fontWeight: '500', color: colors.espressoBrown },
  readonly: { flex: 1, paddingVertical: 13, ...typography.L4, color: colors.mochaBrown },
  saveBtn: { backgroundColor: colors.pointOrange, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  saveText: { ...typography.L3, color: colors.white },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, marginTop: 4 },
  logoutText: { ...typography.L4, color: '#B23B2E', fontWeight: '700' },
});
