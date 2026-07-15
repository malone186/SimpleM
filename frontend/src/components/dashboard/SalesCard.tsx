// [실시간 매출 카드 - Svg 내부형 펄스 링 이식 및 리사이징 결함 차단]
// 절대 좌표 오버레이로 인한 리사이징 어긋남 결함을 잡기 위해 AnimatedCircle을 Svg 내부 동일 좌표로 이식했습니다.
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line } from 'react-native-svg';

import { colors, spacing, typography } from '../../theme';
import { useCountUp } from '../motion';

// 애니메이션 적용을 위해 Circle 컴포넌트를 Animated 객체로 승격
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// 차트 트렌드 라인 패스 정의
const LINE = 'M 10 90 C 60 85, 90 88, 130 80 C 170 72, 210 75, 250 62 L 290 50';
const FILL = `${LINE} L 290 100 L 10 100 Z`;

// 캘린더 요일 및 데이터 셋
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

// 7월 가상 캘린더 매출 현황 (수입 전용)
const CALENDAR_ITEMS = [
  { date: '', income: 0 }, { date: '', income: 0 },
  { date: '1', income: 420000 }, { date: '2', income: 380000 }, { date: '3', income: 450000 },
  { date: '4', income: 620000 }, { date: '5', income: 580000 }, { date: '6', income: 390000 },
  { date: '7', income: 410000 }, { date: '8', income: 430000 }, { date: '9', income: 350000 },
  { date: '10', income: 490000 }, { date: '11', income: 710000 }, { date: '12', income: 630000 },
  { date: '13', income: 380000 }, { date: '14', income: 400000 }, { date: '15', income: 428500 }, // 오늘 날짜 수입
  { date: '16', income: 0 }, { date: '17', income: 0 }, { date: '18', income: 0 },
  { date: '19', income: 0 }, { date: '20', income: 0 }, { date: '21', income: 0 },
  { date: '22', income: 0 }, { date: '23', income: 0 }, { date: '24', income: 0 },
  { date: '25', income: 0 }, { date: '26', income: 0 }, { date: '27', income: 0 },
  { date: '28', income: 0 }, { date: '29', income: 0 }, { date: '30', income: 0 },
  { date: '31', income: 0 }
];

// [슬라이딩 세그먼트 토글 컴포넌트]
function SlidingTabToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (val: boolean) => void;
}) {
  const slideAnim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: value ? 1 : 0,
      useNativeDriver: true,
      tension: 110,
      friction: 11,
    }).start();
  }, [value]);

  const translateX = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [2, 38],
  });

  return (
    <Pressable onPress={() => onChange(!value)} style={StyleSheet.flatten([styles.toggleTrack, Platform.OS === 'web' && { cursor: 'pointer' }])}>
      <Animated.View style={[styles.toggleCapsule, { transform: [{ translateX }] }]} />
      
      <View style={styles.toggleLabelsRow}>
        <View style={styles.toggleLabelCell}>
          <Text style={[styles.toggleLabelText, !value && styles.toggleLabelTextActive]}>일</Text>
        </View>
        <View style={styles.toggleLabelCell}>
          <Text style={[styles.toggleLabelText, value && styles.toggleLabelTextActive]}>월</Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function SalesCard() {
  const [isMonthly, setIsMonthly] = useState(false);
  const targetValue = isMonthly ? 12480000 : 428500;
  const amount = useCountUp(targetValue, 1100, [isMonthly]);

  // 펄스 애니메이션 구동 제어
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

  // [한글 주석: Svg 내부 펄스 링의 크기 및 투명도 인터폴레이션]
  const pulseRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [4, 12] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  // 일/월별 상승 뱃지 텍스트
  const badgeText = isMonthly ? '▲ 8.7%' : '▲ 12.4%';

  // 하단 세부 요약 수치
  const salesCount = isMonthly ? '4,120잔' : '142잔';
  const averagePrice = isMonthly ? '₩3,085' : '₩3,018';
  const peakTime = isMonthly ? '주말 오후' : '14–15시';

  return (
    <View style={styles.card}>
      {/* 헤더 영역 */}
      <View style={styles.headRow}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <SlidingTabToggle value={isMonthly} onChange={setIsMonthly} />
          <Text style={[styles.amount, { marginTop: 6 }]}>₩ {amount.toLocaleString()}</Text>
        </View>

        {/* 성장폭 뱃지 */}
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badgeText}</Text>
        </View>
      </View>

      {/* 실시간 차트 / 토스 달력 전환 영역 */}
      {isMonthly ? (
        <View style={styles.calendarContainer}>
          {/* 요일 행 */}
          <View style={styles.calendarHeaderRow}>
            {DAYS.map(day => (
              <Text key={day} style={styles.calendarHeaderDay}>{day}</Text>
            ))}
          </View>
          {/* 날짜 그리드 행 */}
          <View style={styles.calendarGrid}>
            {CALENDAR_ITEMS.map((item, idx) => (
              <View key={idx} style={styles.calendarCell}>
                <Text style={[
                  styles.calendarDateText,
                  item.date === '15' && styles.calendarTodayText
                ]}>{item.date}</Text>
                {item.income > 0 && (
                  <Text style={styles.calendarIncomeText}>
                    +{Math.round(item.income / 10000)}만
                  </Text>
                )}
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.chartWrap}>
          <Svg width="100%" height="100" viewBox="0 0 300 100" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.mochaBrown} stopOpacity="0.3" />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
              </LinearGradient>
            </Defs>

            {/* 그리드 가로선 */}
            <Line x1="10" y1="20" x2="290" y2="20" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.3" />
            <Line x1="10" y1="50" x2="290" y2="50" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.3" />
            <Line x1="10" y1="80" x2="290" y2="80" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.3" />

            <Path d={FILL} fill="url(#salesFill)" />
            <Path d={LINE} stroke={colors.mochaBrown} strokeWidth={3} fill="none" strokeLinecap="round" />
            
            {/* 고정 피크 점 */}
            <Circle cx={290} cy={50} r={4} fill={colors.trendGreenText} />
            
            {/* 
              [한글 주석: Svg 내부 펄스 링] 
              cx={290}, cy={50} 좌표를 고정 피크 점과 완벽히 일치시켜
              화면 가로 폭 리사이징 시에도 단 0.1px의 엇갈림도 발생하지 않게 보장합니다.
            */}
            <AnimatedCircle
              cx={290}
              cy={50}
              r={pulseRadius}
              fill={colors.trendGreenText}
              opacity={pulseOpacity}
            />
          </Svg>

          {/* X축 */}
          <View style={styles.xAxis}>
            <Text style={styles.xAxisText}>09시</Text>
            <Text style={styles.xAxisText}>12시</Text>
            <Text style={styles.xAxisText}>15시</Text>
            <Text style={[styles.xAxisText, { color: colors.trendGreenText, fontWeight: '700', opacity: 0.95 }]}>실시간</Text>
          </View>
        </View>
      )}

      {/* 하단 요약 정보 그리드 */}
      <View style={styles.footRow}>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>판매 잔</Text>
          <Text style={styles.footValue}>{salesCount}</Text>
        </View>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>객단가</Text>
          <Text style={styles.footValue}>{averagePrice}</Text>
        </View>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>피크</Text>
          <Text style={[styles.footValue, { color: colors.trendGreenText }]}>{peakTime}</Text>
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
    borderColor: 'rgba(140,111,86,0.25)',
    padding: spacing.globalPadding,
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  label: { ...typography.L5, color: colors.mochaBrown, marginBottom: 4 },
  amount: { ...typography.L2, color: colors.espressoBrown },

  toggleTrack: {
    width: 76,
    height: 28,
    borderRadius: 999,
    backgroundColor: '#F0EADF',
    position: 'relative',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.12)',
  },
  toggleCapsule: {
    position: 'absolute',
    width: 36,
    height: 22,
    borderRadius: 999,
    backgroundColor: '#2E1C14',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1.5 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleLabelsRow: {
    flexDirection: 'row',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
  },
  toggleLabelCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleLabelText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#8C6F56',
  },
  toggleLabelTextActive: {
    color: '#FFFFFF',
    fontWeight: '900',
  },

  calendarContainer: {
    marginTop: 14,
    backgroundColor: '#FAF8F5',
    borderRadius: 16,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.08)',
  },
  calendarHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(140, 111, 86, 0.08)',
    paddingBottom: 6,
    marginBottom: 6,
  },
  calendarHeaderDay: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: 9,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarCell: {
    width: `${100 / 7}%`,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 1,
  },
  calendarDateText: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.espressoBrown,
  },
  calendarTodayText: {
    color: colors.pointOrange,
    fontWeight: '900',
  },
  calendarIncomeText: {
    fontSize: 7,
    fontWeight: '800',
    color: colors.trendGreenText,
    marginTop: 1,
  },

  badge: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  badgeText: { ...typography.L5, color: colors.trendGreenText, fontWeight: '700' },
  chartWrap: { marginTop: 16, height: 112, position: 'relative' },
  xAxis: {
    position: 'absolute',
    bottom: -6,
    left: 8,
    right: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  xAxisText: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.mochaBrown,
    opacity: 0.65,
  },
  footRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 12,
  },
  footItem: { alignItems: 'center', flex: 1 },
  footLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 2 },
  footValue: { ...typography.L3, color: colors.espressoBrown },
});
