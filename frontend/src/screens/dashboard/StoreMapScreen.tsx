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
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const pos = await getDevicePosition();
        const data = await getSalesForecast(token, pos?.lat, pos?.lon);
        if (!cancelled) {
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
          <Text style={styles.loadingText}>매장 위치 정보가 없습니다.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.creamSand,
    padding: 16,
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
});
