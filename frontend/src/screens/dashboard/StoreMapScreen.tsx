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
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
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
    let cancelled = false;

    // 위치·예측 중 하나라도 응답이 없으면 화면이 로딩에 갇힌다.
    // 어떤 단계도 화면을 무한정 붙잡지 못하게 각 await에 상한을 둔다.
    const withLimit = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

    (async () => {
      try {
        // 1) 좌표(가입 핀 또는 기기 GPS)가 잡히는 즉시 지도를 그린다.
        //    예전엔 예측 API 응답의 location만 썼는데, 판매 기록 14일 미만 계정은
        //    예측이 409로 실패해 GPS를 받아 놓고도 에러 화면이 떴다(+ 직렬 대기 최대 21초).
        // 12초 상한: 내부의 '마지막 위치(즉시)→새 측위(최대 10초)' 폴백이 잘리지 않게
        // 내부 최대치보다 길게 둔다 (6초로 뒀더니 폴백이 끝나기 전에 끊겨 위치를 버렸다).
        // 대부분은 마지막 위치가 즉시 오므로 실제 체감은 1초 미만이다.
        const p = await withLimit(getDevicePosition(), 12000);
        if (cancelled) return;
        if (p) {
          setPos(p);
          setLoading(false); // 지도는 이미 그릴 수 있다 — 아래 예측은 배경 보강일 뿐
        }
        if (!token) {
          setLoading(false);
          return;
        }
        // 2) 예측 API는 지역명·주변 행사 보강용 — 실패해도 지도는 그대로 뜬다
        const data = await withLimit(getSalesForecast(token, p?.lat, p?.lon), 12000);
        if (!cancelled && data) {
          setForecast(data);
          // 좌표 없이 부르면 서울 기본값이 오므로, 실제 좌표를 보냈을 때만 캐시한다
          if (data.location && p) cacheStoreLocation(data.location);
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

  // 우선순위: 예측 응답(보낸 좌표 + 지역명) → 가입 핀 → 기기 GPS → 예측의 서울 폴백(최후)
  const mapLocation = (pos && forecast?.location) || storedLoc || pos || forecast?.location || null;



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
            이 앱의 위치 권한과 휴대폰의 위치(GPS) 스위치를 켜면{'\n'}
            현재 위치 기준으로 지도가 표시됩니다.
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
