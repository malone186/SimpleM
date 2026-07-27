// 매장 지도 단독 화면 (신규) — 대시보드 웰컴헤더 왼쪽 위 지도 아이콘 직결용
import { useEffect, useState } from 'react';
import { StyleSheet, View, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import StoreLocationMap from '../../components/dashboard/StoreLocationMap';
import {
  cacheStoreLocation,
  getDevicePosition,
  getSalesForecast,
  getStoredStoreLocation,
  type SalesForecast,
  type StoredStoreLocation,
} from '../../lib/api/forecast';
import { colors, typography } from '../../theme';

export default function StoreMapScreen() {
  const { token, user } = useAuth();
  const [storedLoc, setStoredLoc] = useState<StoredStoreLocation | null>(null);
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [loading, setLoading] = useState(true);

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
    // 로그인 전이면 기다릴 게 없다 — 예전엔 여기서 그냥 return해 스피너가 영영 안 멈췄다
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    // 위치·예측 중 하나라도 응답이 없으면 화면이 로딩에 갇힌다.
    // 어떤 단계도 화면을 무한정 붙잡지 못하게 각 await에 상한을 둔다.
    const withLimit = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

    (async () => {
      try {
        const pos = await withLimit(getDevicePosition(), 9000);
        const data = await withLimit(getSalesForecast(token, pos?.lat, pos?.lon), 12000);
        if (!cancelled && data) {
          setForecast(data);
          if (data.location) cacheStoreLocation(data.location);
        }
      } catch (e) {
        console.error('지도 화면 매장 위치 조회 실패:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mapLocation = forecast?.location ?? storedLoc;



  return (
    <View style={styles.root}>
      {loading && !mapLocation ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.pointOrange} size="large" />
          <Text style={styles.loadingText}>매장 위치 지도를 불러오는 중...</Text>
        </View>
      ) : mapLocation ? (
        <StoreLocationMap
          lat={mapLocation.lat}
          lon={mapLocation.lon}
          regionName={forecast?.location?.region ?? storedLoc?.region ?? ''}
          shopLabel={user?.name ? `내 매장 (${user.name})` : '내 매장'}
          nearbyEvents={forecast?.nearby_events ?? []}
          containerId="standalone-store-map"
        />
      ) : (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.mochaBrown} />
          <Text style={styles.loadingText}>매장 위치를 불러오지 못했습니다.</Text>
          <Text style={styles.hintText}>
            네트워크와 위치 권한을 확인해 주세요.{'\n'}
            설정에서 매장 주소를 등록하면 위치 없이도 지도가 표시됩니다.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // 지도가 헤더 아래 영역을 꽉 채우도록 여백 없이 — 로딩/에러 문구만 center에서 자체 여백을 갖는다
  root: {
    flex: 1,
    backgroundColor: colors.creamSand,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  // 실패 원인과 다음 행동을 알려 주는 보조 문구 — 막다른 화면이 되지 않게
  hintText: {
    fontSize: 11.5,
    lineHeight: 18,
    color: '#A99C90',
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 28,
    marginTop: -4,
  },
});
