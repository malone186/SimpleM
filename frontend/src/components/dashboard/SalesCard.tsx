// 실시간 매출 카드 (Design Spec §4-②)
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { colors, spacing, typography } from '../../theme';
import { useCountUp } from '../motion';

// 곡선 라인 패스 (스펙 지정)
const LINE = 'M 10 90 C 60 85, 90 88, 130 80 C 170 72, 210 75, 250 62 L 290 50';
// 채우기 영역 (라인 아래를 닫아 그라데이션 마스크)
const FILL = `${LINE} L 290 100 L 10 100 Z`;

export default function SalesCard() {
  const amount = useCountUp(428500, 1100); // 매출 금액 촤르륵 카운트업
  // 좌측 끝(최신값) 노드의 퍼지는 펄스 모션 (animate-pulse)
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View>
          <Text style={styles.label}>오늘 실시간 매출</Text>
          <Text style={styles.amount}>₩ {amount.toLocaleString()}</Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>▲ 12.4%</Text>
        </View>
      </View>

      <View style={styles.chartWrap}>
        <Svg width="100%" height="100" viewBox="0 0 300 100" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#C3B091" stopOpacity="0.55" />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Path d={FILL} fill="url(#salesFill)" />
          <Path
            d={LINE}
            stroke={colors.mochaBrown}
            strokeWidth={2.5}
            fill="none"
            strokeLinecap="round"
          />
          {/* 우측 끝(최신) 피크 노드 */}
          <Circle cx={290} cy={50} r={4} fill={colors.trendGreenText} />
        </Svg>

        {/* 펄스 링 — SVG 우측 끝 노드 위치에 오버레이 */}
        <View style={[styles.pulseAnchor, { pointerEvents: 'none' }]}>
          <Animated.View
            style={[
              styles.pulseRing,
              { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
            ]}
          />
        </View>
      </View>

      <View style={styles.footRow}>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>판매 잔</Text>
          <Text style={styles.footValue}>142잔</Text>
        </View>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>객단가</Text>
          <Text style={styles.footValue}>₩3,018</Text>
        </View>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>피크</Text>
          <Text style={[styles.footValue, { color: colors.trendGreenText }]}>14–15시</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)', // border-coffee-200/50
    padding: spacing.globalPadding,
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  label: { ...typography.L5, color: colors.mochaBrown, marginBottom: 4 },
  amount: { ...typography.L2, color: colors.espressoBrown },
  badge: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { ...typography.L5, color: colors.trendGreenText },
  chartWrap: { marginTop: 16, height: 100, position: 'relative' },
  pulseAnchor: { position: 'absolute', right: 2, top: 46, width: 8, height: 8 },
  pulseRing: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.trendGreenText,
  },
  footRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 12,
  },
  footItem: { alignItems: 'center', flex: 1 },
  footLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 2 },
  footValue: { ...typography.L3, color: colors.espressoBrown },
});
