// AI 판매량 예측 카드 (발주 탭 상단) — GPS 기반 매장 위치의 날씨·요일·공휴일 + POS 시계열
// 익일/금주 예상 판매량과 재고 소진 경고를 보여준다. 판매 기록 14일 미만이면 안내만 표시.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import {
  getDevicePosition,
  getSalesForecast,
  type SalesForecast,
} from '../../lib/api/forecast';
import { colors, typography } from '../../theme';

const won = (n: number) => `₩${n.toLocaleString('ko-KR')}`;

// 날씨 → 아이콘 (색만으로 구분하지 않도록 텍스트도 함께 표기)
const WEATHER_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  맑음: 'sunny-outline',
  구름: 'partly-sunny-outline',
  흐림: 'cloud-outline',
  비: 'rainy-outline',
  소나기: 'rainy-outline',
  뇌우: 'thunderstorm-outline',
  눈: 'snow-outline',
  안개: 'cloud-outline',
};

export default function ForecastCard() {
  const { token } = useAuth();
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [gateMessage, setGateMessage] = useState<string | null>(null); // 데이터 부족 안내
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // GPS 좌표 획득 (거부/실패 시 서버가 서울 기준 날씨로 대신 예측)
      const pos = await getDevicePosition();
      try {
        const data = await getSalesForecast(token, pos?.lat, pos?.lon);
        if (!cancelled) setForecast(data);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '';
        if (msg.startsWith('409')) {
          setGateMessage(msg.replace(/^409\s*·\s*/, '')); // 판매 기록 14일 미만 안내
        } else {
          setFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return null;

  if (loading) {
    return (
      <View style={styles.card}>
        <View style={styles.stateRow}>
          <ActivityIndicator color={colors.mochaBrown} size="small" />
          <Text style={styles.stateText}>매장 위치·날씨·판매 패턴으로 예측 중…</Text>
        </View>
      </View>
    );
  }

  if (gateMessage) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>AI 판매량 예측</Text>
        <Text style={styles.stateText}>{gateMessage}</Text>
      </View>
    );
  }

  if (failed || !forecast) return null; // 예측 실패 시 조용히 숨김 — 발주 추천은 그대로 동작

  const t = forecast.tomorrow;
  const stockAlerts = forecast.order_recommendations
    .filter((r) => r.days_until_stockout !== null && r.days_until_stockout <= 7)
    .slice(0, 3);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.title}>AI 판매량 예측</Text>
        <Text style={styles.region} numberOfLines={1}>
          <Ionicons name="location-outline" size={10} color={colors.mochaBrown} />{' '}
          {forecast.location.region}
        </Text>
      </View>

      {/* 익일 히어로 — 잔 수·매출·날씨 */}
      <View style={styles.heroRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.heroLabel}>
            내일({t.weekday}) 예상 {t.holiday ? `· ${t.holiday}` : ''}
          </Text>
          <Text style={styles.heroValue}>
            {t.cups}잔 <Text style={styles.heroSub}>{won(t.revenue)}</Text>
          </Text>
        </View>
        {t.weather && (
          <View style={styles.weatherBox}>
            <Ionicons
              name={WEATHER_ICON[t.weather] ?? 'cloud-outline'}
              size={20}
              color={colors.espressoBrown}
            />
            <Text style={styles.weatherText}>
              {t.weather} {t.temp_max != null ? `${Math.round(t.temp_max)}°` : ''}
            </Text>
          </View>
        )}
      </View>

      {/* 보정 근거 — 날씨·공휴일·행사 */}
      {t.adjustments.map((a, i) => (
        <Text key={i} style={styles.adjust}>✦ {a}</Text>
      ))}

      {/* 금주 미니 스트립 — 요일별 예상 잔 수 */}
      <View style={styles.weekRow}>
        {forecast.week.map((d) => (
          <View key={d.date} style={styles.dayCell}>
            <Text style={styles.dayName}>{d.weekday}</Text>
            <Text style={styles.dayCups}>{d.cups}</Text>
            {d.weather && (
              <Ionicons
                name={WEATHER_ICON[d.weather] ?? 'cloud-outline'}
                size={11}
                color={colors.mochaBrown}
              />
            )}
          </View>
        ))}
      </View>
      <Text style={styles.weekTotal}>
        금주 합계 {forecast.week_total.cups.toLocaleString('ko-KR')}잔 ·{' '}
        {won(forecast.week_total.revenue)}
      </Text>

      {/* 주변 행사 (서울 문화행사 API 자동 수집, 반경 3km) — 예측에 이미 부스팅 반영됨 */}
      {forecast.nearby_events.length > 0 && (
        <View style={styles.eventBox}>
          {forecast.nearby_events.slice(0, 3).map((ev) => (
            <Text key={`${ev.name}-${ev.date}`} style={styles.eventText} numberOfLines={1}>
              <Ionicons name="musical-notes-outline" size={11} color={colors.trendGreenText} />{' '}
              {ev.date.slice(5)} {ev.name} ({ev.distance_km}km)
            </Text>
          ))}
          {forecast.nearby_events.length > 3 && (
            <Text style={styles.eventText}>외 {forecast.nearby_events.length - 3}건 — 예측에 반영됨</Text>
          )}
        </View>
      )}

      {/* 재고 소진 경고 — 예측 소요량 기반 */}
      {stockAlerts.length > 0 && (
        <View style={styles.alertBox}>
          {stockAlerts.map((r) => (
            <Text key={r.ingredient} style={styles.alertText}>
              <Ionicons name="warning-outline" size={11} color={colors.pointOrange} />{' '}
              {r.ingredient} — 약 {r.days_until_stockout}일 후 소진, {r.suggested_quantity}
              {r.unit} 발주 권장
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.modelNote}>
        {forecast.model} · 날씨/행사 보정 적용 참고치
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)',
    padding: 16,
    gap: 8,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { ...typography.L3, color: colors.espressoBrown },
  region: { ...typography.L5, fontSize: 9, color: colors.mochaBrown, flexShrink: 1 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 15 },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroLabel: { ...typography.L5, color: colors.mochaBrown },
  heroValue: { ...typography.L2, fontSize: 24, color: colors.espressoBrown, marginTop: 2 },
  heroSub: { ...typography.L4, color: colors.mochaBrown },
  weatherBox: { alignItems: 'center', gap: 2 },
  weatherText: { ...typography.L5, fontSize: 9, color: colors.espressoBrown, fontWeight: '700' },
  adjust: { ...typography.L5, fontSize: 10, color: colors.mochaBrown, lineHeight: 14 },
  weekRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 8,
    gap: 4,
  },
  dayCell: { flex: 1, alignItems: 'center', gap: 1 },
  dayName: { ...typography.L5, fontSize: 9, color: colors.mochaBrown },
  dayCups: { ...typography.L5, fontSize: 11, fontWeight: '700', color: colors.espressoBrown },
  weekTotal: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown, textAlign: 'center' },
  eventBox: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 10,
    padding: 10,
    gap: 5,
  },
  eventText: { ...typography.L5, fontSize: 10, color: colors.trendGreenText, lineHeight: 14 },
  alertBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 10,
    padding: 10,
    gap: 5,
  },
  alertText: { ...typography.L5, fontSize: 10, color: colors.espressoBrown, lineHeight: 14 },
  modelNote: { ...typography.L5, fontSize: 8, color: colors.mochaBrown, textAlign: 'center' },
});
