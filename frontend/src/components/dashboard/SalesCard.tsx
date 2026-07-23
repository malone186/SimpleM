import { useEffect, useRef, useState, useMemo } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line, Text as SvgText, Rect, G } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { useCountUp } from '../motion';
import { PressableScale } from '../motion';
import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import {
  getDevicePosition,
  getSalesCalendar,
  getSalesForecast,
  type CalendarDay,
  type ForecastDay,
  type HourlyPoint,
  type SalesCalendar,
  type SalesForecast,
} from '../../lib/api/forecast';
import Brew from '../brew/Brew';
import TodoList, { type Todo } from './TodoList';

// (삭제함 - Web 호환성을 위해 addListener + 일반 Circle을 사용하도록 개선)

// [웹 호환 SVG 터치 핸들러] 웹에서 SVG 요소에 onPress를 주면 구형 Touchable 믹스인이 가동되어
// 콘솔 에러가 발생하므로, 웹은 브라우저 표준 onClick으로 우회한다 (네이티브는 onPress 유지)
const svgPress = (handler: () => void) =>
  Platform.OS === 'web' ? ({ onClick: handler } as any) : { onPress: handler };

// 차트 X좌표 4개 (양 끝 마진 25px로 대칭 및 한가운데 정렬)
const CHART_X = [25, 108, 192, 275];

// 백엔드가 24시간 예측 분배를 못 준 경우 총량을 나눌 카페 기본 판매 곡선 (0~23시, 합계 1.0)
// backend forecast_service._DEFAULT_HOUR_PROFILE과 동일해야 한다
const DEFAULT_HOUR_PROFILE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0.06, 0.07, 0.09, 0.13, 0.11, 0.1, 0.09, 0.08, 0.07, 0.08, 0.07, 0.05,
  0, 0, 0,
];

// X축 시간 라벨 포맷 (9 → "09시")
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}시`;

// 캘린더 요일 및 데이터 셋 (영어 대문자로 세련되게 전환)
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

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

// 월간 캘린더 그리드 — 실제 연·월 기준으로 셀을 만든다 (월요일 시작, 앞쪽 공백 포함)
function buildMonthCells(year: number, month0: number): (number | null)[] {
  const firstOffset = (new Date(year, month0, 1).getDay() + 6) % 7; // 월=0 … 일=6
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  return [
    ...Array.from({ length: firstOffset }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
}


// [한글 주석: 3단 탭 상태 타입 정의]
export type SalesTab = 'day' | 'month' | 'todo';

// [슬라이딩 세그먼트 토글 컴포넌트 (3단 탭 지원)]
function SlidingTabToggle({
  value,
  onChange,
}: {
  value: SalesTab;
  onChange: (val: SalesTab) => void;
}) {
  const tabIndex = value === 'day' ? 0 : value === 'month' ? 1 : 2;
  const slideAnim = useRef(new Animated.Value(tabIndex)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: tabIndex,
      useNativeDriver: true,
      tension: 110,
      friction: 11,
    }).start();
  }, [tabIndex]);

  const translateX = slideAnim.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [2, 68, 134],
  });

  return (
    <View style={StyleSheet.flatten([styles.toggleTrack, Platform.OS === 'web' && { cursor: 'pointer' }])}>
      <Animated.View style={[styles.toggleCapsule, { transform: [{ translateX }] }]} />
      
      <View style={styles.toggleLabelsRow}>
        <Pressable onPress={() => onChange('day')} style={styles.toggleLabelCell}>
          <Text style={[styles.toggleLabelText, value === 'day' && styles.toggleLabelTextActive]}>일</Text>
        </Pressable>
        <Pressable onPress={() => onChange('month')} style={styles.toggleLabelCell}>
          <Text style={[styles.toggleLabelText, value === 'month' && styles.toggleLabelTextActive]}>월</Text>
        </Pressable>
        <Pressable onPress={() => onChange('todo')} style={styles.toggleLabelCell}>
          <Text style={[styles.toggleLabelText, value === 'todo' && styles.toggleLabelTextActive]}>todo</Text>
        </Pressable>
      </View>
    </View>
  );
}

// [한글 주석] onPressReport 콜백, todos 리스트, onPressTodo, onToggleDone, onAddTodo, onEditTodo, onDeleteTodo 핸들러를 바인딩합니다.
export default function SalesCard({
  onPressReport,
  todos = [],
  onPressTodo,
  onToggleDone,
  onAddTodo,
  onEditTodo,
  onDeleteTodo,
}: {
  onPressReport?: () => void;
  todos?: Todo[];
  onPressTodo?: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onAddTodo?: (title: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
}) {
  const { token } = useAuth();
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [calendar, setCalendar] = useState<SalesCalendar | null>(null); // 이번 달 일별 실판매 집계
  const [loadingForecast, setLoadingForecast] = useState(false);

  const [activeTab, setActiveTab] = useState<SalesTab>('day');
  const isMonthly = activeTab === 'month'; // 월간 탭 여부 — 실데이터 집계 분기에 사용
  const [selectedDate, setSelectedDate] = useState<number | null>(null); // 선택한 날짜(일)의 상세 매출 분석 모달
  const [selectedFutureDate, setSelectedFutureDate] = useState<number | null>(null);
  const [showBrew, setShowBrew] = useState(false); // [브루 예측 설명 오버레이]
  const [activeTooltip, setActiveTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    value: string;
  } | null>(null);
  // [한글 주석] 매장 위치 지도는 프로필 화면(StoreLocationMap)으로 이동됨

  const [layoutWidth, setLayoutWidth] = useState(300);
  const tooltipAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (activeTooltip) {
      tooltipAnim.setValue(0);
      Animated.spring(tooltipAnim, {
        toValue: 1,
        friction: 6.5,
        tension: 42,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(tooltipAnim, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      }).start();
    }
  }, [activeTooltip, tooltipAnim]);

  const tooltipOpacity = tooltipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const tooltipScale = tooltipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1.0],
  });
  const tooltipTranslateY = tooltipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [5, 0],
  });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoadingForecast(true);
      try {
        const pos = await getDevicePosition();
        const data = await getSalesForecast(token, pos?.lat, pos?.lon);
        if (!cancelled) {
          setForecast(data);
        }
      } catch (e) {
        console.error('대시보드 판매 예측 조회 실패:', e);
      } finally {
        if (!cancelled) setLoadingForecast(false);
      }
    })();
    // 월간 캘린더 집계 — 예측(GPS 대기)과 독립적으로 병렬 조회
    (async () => {
      try {
        const cal = await getSalesCalendar(token);
        if (!cancelled) setCalendar(cal);
      } catch (e) {
        console.error('월간 판매 캘린더 조회 실패:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);
  // [한글 주석: 전역 다국어 번역 훅 연동]
  const { t, language } = useTranslation();

  // [실시간 시계] 매분 확인 — 정시가 바뀌면 X축 시간대와 '내일 같은 시각' 예측 기준이 따라 움직인다
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // [한글 주석] 카페 대표 운영 시간대(09시, 13시, 17시, 21시)를 X축 표준 4지점으로 설정합니다
  const axisHours = [9, 13, 17, 21];
  const currentHour = now.getHours(); // [한글 주석] 실제 로컬 현재 시각 (예: 오전 9시)

  // [한글 주석] 현재 시간(currentHour)에 가장 근접한 X축 시간대 지점 인덱스를 실시간 연산합니다
  let currentAxisIndex = 0;
  for (let i = axisHours.length - 1; i >= 0; i--) {
    if (currentHour >= axisHours[i]) {
      currentAxisIndex = i;
      break;
    }
  }

  // 실제 오늘 날짜 기준 캘린더 좌표
  const year = now.getFullYear();
  const month0 = now.getMonth(); // 0-based
  const todayDay = now.getDate();
  const monthCells = useMemo(() => buildMonthCells(year, month0), [year, month0]);

  // 일(day) → 실판매 집계 맵
  const calDayMap = useMemo(() => {
    const m: Record<number, CalendarDay> = {};
    calendar?.days.forEach((d) => {
      m[d.day] = d;
    });
    return m;
  }, [calendar]);

  // 일(day) → AI 예측 맵 — 예측 API가 준 이번 달 미래 날짜만 (하드코딩 폴백 없음)
  const futureForecasts = useMemo(() => {
    const m: Record<number, ForecastDay> = {};
    forecast?.week.forEach((d) => {
      const [fy, fm, fd] = d.date.split('-').map(Number);
      if (fy === year && fm === month0 + 1) m[fd] = d;
    });
    return m;
  }, [forecast, year, month0]);

  // 오늘 실적 — 백엔드 실데이터 (없으면 0: AI 경영 리포트와 같은 집계 기준)
  const todayActual = forecast?.today ?? null;
  const todayRevenueTotal = todayActual?.revenue ?? 0;
  const todayCupsTotal = todayActual?.cups ?? 0;

  const targetValue = isMonthly ? (calendar?.month_total.revenue ?? 0) : todayRevenueTotal;
  const amount = useCountUp(targetValue, 1100, [isMonthly, targetValue]);

  // 예측이 없으면 0 — 하드코딩 폴백 없이 '예측 준비 중'으로 표시한다
  const tomorrowRevenue = forecast?.tomorrow.revenue ?? 0;
  const tomorrowCups = forecast?.tomorrow.cups ?? 0;

  // 내일 시간(0~23시)별 예측 — 백엔드 분배가 없으면 기본 곡선으로 총량을 나눈다
  const tomorrowHourly24: HourlyPoint[] =
    forecast?.tomorrow_hourly_24 ??
    DEFAULT_HOUR_PROFILE.map((share, hour) => ({
      hour,
      cups: Math.round(tomorrowCups * share),
      revenue: Math.round(tomorrowRevenue * share),
    }));

  // 특정 시각까지의 누적값 (오늘 실적·내일 예측 공용)
  const cumUpTo = (points: HourlyPoint[] | undefined, hour: number, key: 'cups' | 'revenue') =>
    (points ?? []).reduce((acc, p) => (p.hour <= hour ? acc + p[key] : acc), 0);

  const todayCupsCum = axisHours.map((h) => cumUpTo(todayActual?.hourly, h, 'cups'));
  const todayRevCum = axisHours.map((h) => cumUpTo(todayActual?.hourly, h, 'revenue'));
  const tomorrowCupsCum = axisHours.map((h) => cumUpTo(tomorrowHourly24, h, 'cups'));
  const tomorrowRevCum = axisHours.map((h) => cumUpTo(tomorrowHourly24, h, 'revenue'));

  // 두 라인을 같은 스케일로 그린다 — Y좌표 범위: 25(상단) ~ 105(하단)
  const chartMax = Math.max(...todayRevCum, ...tomorrowRevCum, 1);
  const yOf = (v: number) => 105 - (v / chartMax) * 80;
  const todayY = todayRevCum.map(yOf);
  const tomorrowY = tomorrowRevCum.map(yOf);

  const linePath = (ys: number[]) =>
    `M ${CHART_X[0]} ${ys[0]} L ${CHART_X[1]} ${ys[1]} L ${CHART_X[2]} ${ys[2]} L ${CHART_X[3]} ${ys[3]}`;
  const fillPath = (ys: number[]) => `${linePath(ys)} L ${CHART_X[3]} 120 L ${CHART_X[0]} 120 Z`;

  const realtimeLinePath = linePath(todayY);
  const realtimeFillPath = fillPath(todayY);
  const forecastLinePath = linePath(tomorrowY);
  const forecastFillPath = fillPath(tomorrowY);

  // [한글 주석] 펄스 애니메이션 구동 제어
  const pulse = useRef(new Animated.Value(0)).current;
  const [pulseVal, setPulseVal] = useState(0);

  useEffect(() => {
    // [한글 주석] Web 환경의 Svg 렌더링 호환성 결함을 피하기 위해, Animated.Value의 변화량을
    // addListener로 직접 감지하여 React 상태(pulseVal)로 반영합니다.
    const listenerId = pulse.addListener(({ value }) => {
      setPulseVal(value);
    });

    const loop = Animated.loop(
      Animated.sequence([
        // [한글 주석] 수동 리스너 기반으로 동작하므로 useNativeDriver는 false로 세팅합니다.
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.removeListener(listenerId);
    };
  }, [pulse]);

  // [한글 주석] Svg 내부 펄스 링의 크기 및 투명도를 일반 숫자 값으로 실시간 계산합니다.
  const pulseRadius = 4 + pulseVal * 8; // [0, 1] -> [4, 12]
  const pulseOpacity = 0.6 - pulseVal * 0.6; // [0, 1] -> [0.6, 0]

  // 증감 뱃지 — 일간은 어제 매출 대비, 월간은 전월 같은 경과일 대비 (비교 대상 없으면 '비교 없음')
  const yesterdayRevenue = todayActual?.yesterday_revenue ?? 0;
  const deltaPct = isMonthly
    ? (calendar?.change_pct ?? null)
    : yesterdayRevenue > 0
      ? ((todayRevenueTotal - yesterdayRevenue) / yesterdayRevenue) * 100
      : null;
  const badgeText = deltaPct === null ? '비교 없음' : `${deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(1)}%`;
  const isBadgeDown = deltaPct !== null && deltaPct < 0;
  // [한글 주석] 사장님이 %의 비교 기준을 바로 알 수 있게 배지 아래에 붙이는 설명 문구 (한 줄 가로 배치를 위해 콤팩트화)
  const badgeHint =
    deltaPct === null
      ? isMonthly
        ? '지난달 기록 없음'
        : '어제 기록 없음'
      : isMonthly
        ? '지난달 대비'
        : '어제 대비';

  // 하단 세부 요약 수치 — 일간은 오늘 실적, 월간은 이번 달 집계 (데이터 없으면 '—')
  const monthCups = calendar?.month_total.cups ?? 0;
  const salesCount = isMonthly ? `${monthCups.toLocaleString()}잔` : `${todayCupsTotal.toLocaleString()}잔`;
  const averagePrice = isMonthly
    ? calendar?.avg_price
      ? `₩${calendar.avg_price.toLocaleString()}`
      : '—'
    : todayCupsTotal > 0
      ? `₩${Math.round(todayRevenueTotal / todayCupsTotal).toLocaleString()}`
      : '—';
  let peakTime = '—';
  if (isMonthly) {
    if (calendar?.peak_hour != null) peakTime = `${calendar.peak_hour}–${calendar.peak_hour + 1}시`;
  } else if (todayActual) {
    const best = todayActual.hourly.reduce((a, b) => (b.cups > a.cups ? b : a));
    if (best.cups > 0) peakTime = `${best.hour}–${best.hour + 1}시`;
  }



  return (
    <View style={styles.card}>
      {/* 헤더 영역 */}
      <View style={styles.headRow}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          {/* [한글 주석] 위치 칩은 웰컴 헤더(말풍선 아래)로 이동 — 탭 토글이 그 자리까지 넓게 쓴다 */}
          <SlidingTabToggle value={activeTab} onChange={setActiveTab} />
          {/* [한글 주석] todo 탭일 때는 매출 문구와 대비 퍼센트를 표시하지 않음 */}
          {activeTab !== 'todo' && (
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 10 }}>
              <Text style={styles.amount}>₩ {amount.toLocaleString()}</Text>
              <Text style={{ ...typography.L5, fontSize: 11.5, fontWeight: '800', color: isBadgeDown ? '#B23B2E' : colors.trendGreenText }}>
                {badgeHint} {badgeText}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* 실시간 차트 / 토스 달력 / 할 일 목록 전환 영역 */}
      {activeTab === 'month' ? (
        <View style={styles.calendarContainer}>
          {/* 요일 행 */}
          <View style={styles.calendarHeaderRow}>
            {DAYS.map(day => (
              <Text key={day} style={styles.calendarHeaderDay}>{day}</Text>
            ))}
          </View>
          {/* 날짜 그리드 행 — 실제 이번 달 달력 + DB 일별 판매 집계 */}
          <View style={styles.calendarGrid}>
            {monthCells.map((day, idx) => {
              const dayData = day !== null ? calDayMap[day] : undefined;
              const fDay = day !== null && day > todayDay ? futureForecasts[day] : undefined;
              const hasData = !!dayData && dayData.revenue > 0;
              const isFuture = !!fDay;
              const isToday = day === todayDay;
              const income = dayData?.revenue ?? 0;
              return (
                <PressableScale
                  key={idx}
                  disabled={!hasData && !isFuture}
                  onPress={() => {
                    if (hasData && day !== null) setSelectedDate(day);
                    else if (isFuture && day !== null) setSelectedFutureDate(day);
                  }}
                  style={[
                    styles.calendarCell,
                    isToday && styles.calendarTodayCell,
                    isFuture && { backgroundColor: 'rgba(140, 111, 86, 0.04)' }, // 미래 예측일은 연한 브라운 틴트
                    !hasData && !isFuture && { opacity: 0.35 } // 매출 데이터도 없고 미래 예측도 불가능하면 옅게
                  ]}
                  to={0.9}
                >
                  <Text style={[
                    styles.calendarDateText,
                    isToday && styles.calendarTodayText,
                    isFuture && { color: colors.mochaBrown }
                  ]}>{day ?? ''}</Text>
                  {income > 0 && (
                    <Text style={styles.calendarIncomeText}>
                      {/* [한글 주석: 사용자의 직관적인 '만' 단위 원복 요구 반영 (소수 첫째자리 내림 포맷)] */}
                      {`+${(income / 10000) % 1 === 0 ? income / 10000 : (Math.floor((income / 10000) * 10) / 10)}만`}
                    </Text>
                  )}
                  {isFuture && (
                    <Text style={[styles.calendarIncomeText, { color: colors.mochaBrown, fontSize: 7 }]}>
                      {`+${fDay.cups}잔`}
                    </Text>
                  )}
                </PressableScale>
              );
            })}
          </View>
        </View>
      ) : activeTab === 'todo' ? (
        <View style={styles.todoWrapper}>
          {/* [한글 주석: todo 탭 선택 시 완료/추가/수정/삭제 핸들러를 전달합니다] */}
          <TodoList
            todos={todos}
            onPressAction={onPressTodo || (() => {})}
            onToggleDone={onToggleDone}
            onAddTodo={onAddTodo}
            onEditTodo={onEditTodo}
            onDeleteTodo={onDeleteTodo}
            hideCard={true}
          />
        </View>
      ) : (
        <View>
          {/* 오늘 / 내일 예측 범례 (Legend) */}
          <View style={styles.legendContainer}>
            <View style={styles.legendItem}>
              <View style={[styles.legendColorDot, { backgroundColor: colors.espressoBrown }]} />
              <Text style={styles.legendText}>{t('todayLive')}</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendColorDot, { backgroundColor: colors.mochaBrown, opacity: 0.5 }]} />
              <Text style={styles.legendText}>{language === 'en' ? 'Tomorrow AI' : '내일 AI 예측'}</Text>
            </View>

            {/* [브루] 예측 원인 설명 트리거 버튼 */}
            <PressableScale style={styles.brewCta} onPress={() => setShowBrew(true)} to={0.95}>
              <Ionicons name="cafe" size={12} color={colors.pointOrange} />
              <Text style={styles.brewCtaText}>{language === 'en' ? 'Reason' : '예측 이유'}</Text>
            </PressableScale>
          </View>

          <View 
            style={styles.chartWrap}
            onLayout={(e) => setLayoutWidth(e.nativeEvent.layout.width)}
          >
            <Svg width="100%" height={120} viewBox="0 0 300 120" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="todayFill" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={colors.espressoBrown} stopOpacity="0.14" />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </LinearGradient>
                <LinearGradient id="tomorrowFill" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={colors.mochaBrown} stopOpacity="0.08" />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </LinearGradient>
              </Defs>

              {/* 툴팁 닫기용 투명 배경 클릭 타겟 (세로 확장 130 대응) */}
              <Rect width="300" height="130" fill="transparent" {...svgPress(() => setActiveTooltip(null))} />

              {/* 그리드 가로선 (세로 확장 정렬) */}
              <Line x1="15" y1="25" x2="285" y2="25" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
              <Line x1="15" y1="65" x2="285" y2="65" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
              <Line x1="15" y1="105" x2="285" y2="105" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />

              {/* 세로 보조 점선 눈금 (각 데이터 포인트 위치까지) */}
              {CHART_X.map((x, i) => (
                <Line key={`tick-${i}`} x1={x} y1="115" x2={x} y2={Math.min(todayY[i], tomorrowY[i]) + 3} stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="2,2" opacity="0.3" />
              ))}

              {/* 1. 오늘 그래프 드로잉 (부드럽고 자연스러운 에스프레소 브라운 실선) */}
              <Path d={realtimeFillPath} fill="url(#todayFill)" />
              <Path d={realtimeLinePath} stroke={colors.espressoBrown} strokeWidth={2.0} fill="none" strokeLinecap="round" />

              {/* 오늘 실시간 펄스 링 & 현재 시각 지점 — 하드코딩 275px 제거 및 currentAxisIndex 동적 연동 */}
              <Circle cx={CHART_X[currentAxisIndex]} cy={todayY[currentAxisIndex]} r={2.5} fill={colors.pointOrange} />
              <Circle
                cx={CHART_X[currentAxisIndex]}
                cy={todayY[currentAxisIndex]}
                r={pulseRadius * 0.7}
                fill={colors.pointOrange}
                opacity={pulseOpacity * 0.6}
              />

              {/* 2. 내일 그래프 드로잉 — 예측 API가 성공했을 때만 (폴백 가짜 예측 없음) */}
              {forecast && (
                <G>
                  <Path d={forecastFillPath} fill="url(#tomorrowFill)" />
                  <Path d={forecastLinePath} stroke={colors.mochaBrown} strokeWidth={1.2} strokeOpacity={0.38} strokeDasharray="1.2,2.0" fill="none" strokeLinecap="round" />

                  {/* 내일 펄스 링 & 최종 예측 피크 점 */}
                  <Circle cx={CHART_X[currentAxisIndex]} cy={tomorrowY[currentAxisIndex]} r={2.0} fill={colors.mochaBrown} opacity={0.4} />
                  <Circle
                    cx={CHART_X[currentAxisIndex]}
                    cy={tomorrowY[currentAxisIndex]}
                    r={pulseRadius * 0.6}
                    fill={colors.mochaBrown}
                    opacity={pulseOpacity * 0.3}
                  />
                </G>
              )}

              {/* 3. 오늘 데이터 포인트 (터치용 보이지 않는 큰 Circle 영역 포함, Y좌표 꺾은선 일치) */}
              {CHART_X.map((x, i) => (
                <G key={`today-pt-${i}`}>
                  <Circle cx={x} cy={todayY[i]} r={i === currentAxisIndex ? 3.0 : 2.2} fill={i === currentAxisIndex ? colors.pointOrange : colors.espressoBrown} />
                  <Circle
                    cx={x}
                    cy={todayY[i]}
                    r={14}
                    fill="transparent"
                    {...svgPress(() => setActiveTooltip({
                      x,
                      y: todayY[i],
                      title: i === currentAxisIndex ? `오늘 ${hourLabel(axisHours[i])} 실시간` : `오늘 ${hourLabel(axisHours[i])}`,
                      value: `실제 ${todayCupsCum[i]}잔`,
                    }))}
                  />
                </G>
              ))}

              {/* 4. 내일 데이터 포인트 — 오늘과 같은 시간대의 예측 (뒤로 부드럽게 감도는 모카 브라운 톤) */}
              {forecast && CHART_X.map((x, i) => (
                <G key={`tomorrow-pt-${i}`}>
                  <Circle cx={x} cy={tomorrowY[i]} r={i === 3 ? 2.5 : 2.2} fill={colors.mochaBrown} opacity={0.4} />
                  <Circle
                    cx={x}
                    cy={tomorrowY[i]}
                    r={14}
                    fill="transparent"
                    {...svgPress(() => setActiveTooltip({
                      x,
                      y: tomorrowY[i],
                      title: `내일 ${hourLabel(axisHours[i])}`,
                      value: `예측 ${tomorrowCupsCum[i]}잔`,
                    }))}
                  />
                </G>
              ))}


              {/* 5. activeTooltip 플로팅 말풍선 렌더링 */}
              {activeTooltip && (() => {
                const rectX = Math.max(10, Math.min(200, activeTooltip.x - 45));
                const textX = rectX + 45;
                return (
                  <G>
                    {/* 말풍선 배경 사각형 */}
                    <Rect
                      x={rectX}
                      y={activeTooltip.y - 30}
                      width={90}
                      height={18}
                      rx={5}
                      fill={colors.espressoBrown}
                    />
                    {/* 말풍선 꼬리 */}
                    <Path
                      d={`M ${activeTooltip.x - 4} ${activeTooltip.y - 12} L ${activeTooltip.x} ${activeTooltip.y - 7} L ${activeTooltip.x + 4} ${activeTooltip.y - 12} Z`}
                      fill={colors.espressoBrown}
                    />
                    <SvgText
                      x={textX}
                      y={activeTooltip.y - 18}
                      fontSize="8"
                      fontWeight="bold"
                      fill={colors.white}
                      textAnchor="middle"
                    >
                      {`${activeTooltip.title}: ${activeTooltip.value}`}
                    </SvgText>
                  </G>
                );
              })()}
            </Svg>


            {/* X축 — 현재 시각이 마지막 점, 시간이 지나면 자동으로 밀린다 */}
            {/* [한글 주석] 레이아웃 붕괴 방지를 위해 60px 영역 중앙 정렬 트릭 적용 — 차트 점(CHART_X) 바로 아래에 시간이 딱 들어맞습니다 */}
            <View style={styles.xAxis}>
              {axisHours.map((h, i) => (
                <View
                  key={`axis-${h}`}
                  style={{
                    position: 'absolute',
                    left: `${(CHART_X[i] / 300) * 100}%`,
                    transform: [{ translateX: -30 }],
                    width: 60,
                    alignItems: 'center',
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 11,
                      fontWeight: '800',
                      color: i === currentAxisIndex ? colors.pointOrange : colors.espressoBrown,
                      textAlign: 'center',
                    }}
                  >
                    {i === currentAxisIndex ? `${hourLabel(h)} (${t('now')})` : hourLabel(h)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      )}



      {/* 하단 요약 정보 그리드 (todo 탭이 아닐 때만 노출) */}
      {activeTab !== 'todo' && (
        <View style={styles.footRow}>
          <View style={styles.footItem}>
            <Text style={styles.footLabel}>{activeTab === 'month' ? t('soldCups') : t('soldCupsTodayTomorrow')}</Text>
            <Text style={styles.footValue}>
              {salesCount}
              {activeTab === 'day' && forecast && (
                <Text style={{ fontSize: 11, color: colors.mochaBrown, fontWeight: 'normal' }}>
                  {` / ${tomorrowCups}${t('cups')}`}
                </Text>
              )}
            </Text>
          </View>
          <View style={styles.footItem}>
            <Text style={styles.footLabel}>{t('avgPricePerCustomer')}</Text>
            <Text style={styles.footValue}>{averagePrice}</Text>
          </View>
          <View style={styles.footItem}>
            <Text style={styles.footLabel}>{t('peakTime')}</Text>
            <Text style={[styles.footValue, { color: colors.trendGreenText }]}>{peakTime}</Text>
          </View>
        </View>
      )}

      {/* [한글 주석: 통합형 주간 리포트 스마트 배너] 월간/할일 모드일 때는 레이아웃 과밀을 피하기 위해 띄우지 않고, 일간 모드에서만 노출시킵니다 */}
      {onPressReport && activeTab === 'day' && (
        <PressableScale onPress={onPressReport} style={styles.reportBanner}>
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '900', color: colors.espressoBrown }}>✉️ 브루의 주간 리포트 도착</Text>
              <View style={styles.reportLiveBadge}>
                <Text style={styles.reportLiveText}>NEW</Text>
              </View>
            </View>
            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.mochaBrown }}>
              이번 주 매출·비용·재고 요약 — 터치하여 편지 읽기
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
        </PressableScale>
      )}

      {/* [한글 주석: 일별 상세 매출 분석 모달] */}
      <Modal
        visible={selectedDate !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setSelectedDate(null)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectedDate(null)} />
          <View style={styles.modalContent}>
            {selectedDate !== null && calDayMap[selectedDate] && (() => {
              const d = calDayMap[selectedDate];
              const popular = d.top_menus.map((m) => `${m.name} (${m.qty}잔)`).join(' · ') || '판매 기록 없음';
              const brewComment =
                `이날 총 ${d.cups}잔이 팔렸어요.` +
                (d.top_menus[0] ? ` ${d.top_menus[0].name}가 가장 인기였고,` : '') +
                (d.peak_hour != null ? ` ${d.peak_hour}시대에 주문이 가장 몰렸습니다.` : '');
              return (
                <View style={{ gap: 16 }}>
                  {/* 헤더 */}
                  <View style={styles.modalHeader}>
                    <Text style={styles.modalDateTitle}>{month0 + 1}월 {selectedDate}일 매출 상세 리포트</Text>
                    <Pressable onPress={() => setSelectedDate(null)} style={{ padding: 4 }}>
                      <Ionicons name="close" size={22} color={colors.espressoBrown} />
                    </Pressable>
                  </View>

                  {/* 매출액 */}
                  <View style={styles.modalIncomeBox}>
                    <Text style={styles.modalIncomeLabel}>일일 총매출액</Text>
                    <Text style={styles.modalIncomeValue}>
                      ₩ {d.revenue.toLocaleString()}
                    </Text>
                  </View>

                  {/* 세부 분석 데이터 */}
                  <View style={styles.detailsList}>
                    <View style={styles.detailRow}>
                      <View style={styles.detailIconBg}>
                        <Ionicons name="star" size={16} color={colors.pointOrange} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailLabel}>그날따라 가장 잘 나간 메뉴</Text>
                        <Text style={styles.detailValue}>{popular}</Text>
                      </View>
                    </View>

                    <View style={styles.detailRow}>
                      <View style={styles.detailIconBg}>
                        <Ionicons name="cafe" size={16} color={colors.pointOrange} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailLabel}>판매 잔 수 / 피크 시간</Text>
                        <Text style={styles.detailValue}>
                          {d.cups}잔{d.peak_hour != null ? ` · 피크 ${d.peak_hour}:00 - ${d.peak_hour + 1}:00` : ''}
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* 브루의 한마디 */}
                  <View style={styles.brewCommentBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <Text style={{ fontSize: 18 }}>☕</Text>
                      <Text style={styles.brewCommentTitle}>브루의 한마디</Text>
                    </View>
                    <Text style={styles.brewCommentText}>
                      "{brewComment}"
                    </Text>
                  </View>

                  {/* 닫기 버튼 */}
                  <PressableScale onPress={() => setSelectedDate(null)} style={styles.modalCloseBtn}>
                    <Text style={styles.modalCloseText}>확인</Text>
                  </PressableScale>
                </View>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* [한글 주석: 미래 날짜용 AI 판매량 예측 상세 모달] */}
      <Modal
        visible={selectedFutureDate !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setSelectedFutureDate(null)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectedFutureDate(null)} />
          <View style={styles.modalContent}>
            {selectedFutureDate && (
              <View style={{ gap: 16 }}>
                {/* 헤더 */}
                <View style={styles.modalHeader}>
                  <Text style={styles.modalDateTitle}>{month0 + 1}월 {selectedFutureDate}일 AI 판매량 예측</Text>
                  <Pressable onPress={() => setSelectedFutureDate(null)} style={{ padding: 4 }}>
                    <Ionicons name="close" size={22} color={colors.espressoBrown} />
                  </Pressable>
                </View>

                {/* 데이터가 없거나 로딩 중일 때 */}
                {!futureForecasts[selectedFutureDate] ? (
                  <View style={{ paddingVertical: 32, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" color={colors.mochaBrown} style={{ marginBottom: 12 }} />
                    <Text style={{ ...typography.L5, color: colors.mochaBrown }}>예측 정보를 불러오는 중입니다...</Text>
                  </View>
                ) : (
                  (() => {
                    const fDay = futureForecasts[selectedFutureDate] as ForecastDay;
                    return (
                      <View style={{ gap: 14 }}>
                        {/* 예상 매출액 및 잔수 */}
                        <View style={styles.modalIncomeBox}>
                          <Text style={styles.modalIncomeLabel}>예상 판매량 및 매출</Text>
                          <Text style={styles.modalIncomeValue}>
                            {fDay.cups}잔{' '}
                            <Text style={{ fontSize: 13, color: colors.mochaBrown, fontWeight: 'normal' }}>
                              (₩{fDay.revenue.toLocaleString()})
                            </Text>
                          </Text>
                        </View>

                        {/* 세부 날씨 정보 */}
                        {fDay.weather && (
                          <View style={styles.detailRow}>
                            <View style={styles.detailIconBg}>
                              <Ionicons
                                name={WEATHER_ICON[fDay.weather] ?? 'cloud-outline'}
                                size={16}
                                color={colors.pointOrange}
                              />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.detailLabel}>예상 날씨</Text>
                              <Text style={styles.detailValue}>
                                {fDay.weather} {fDay.temp_max != null ? `· 최고 ${Math.round(fDay.temp_max)}°C` : ''}
                                {fDay.precip_prob != null && fDay.precip_prob > 0 ? ` (강수확률 ${fDay.precip_prob}%)` : ''}
                              </Text>
                            </View>
                          </View>
                        )}

                        {/* 공휴일 표기 */}
                        {fDay.holiday && (
                          <View style={[styles.detailRow, { backgroundColor: 'rgba(178,59,46,0.05)', borderRadius: 12, padding: 8 }]}>
                            <View style={[styles.detailIconBg, { backgroundColor: 'rgba(178,59,46,0.1)' }]}>
                              <Ionicons name="flag-outline" size={16} color="#B23B2E" />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.detailLabel, { color: '#B23B2E' }]}>공휴일 지정</Text>
                              <Text style={[styles.detailValue, { color: '#B23B2E' }]}>{fDay.holiday}</Text>
                            </View>
                          </View>
                        )}

                        {/* 보정 근거 / 주변 행사 리스트 */}
                        <View style={styles.brewCommentBox}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <Text style={{ fontSize: 16 }}>📊</Text>
                            <Text style={styles.brewCommentTitle}>예측 근거 상세</Text>
                          </View>
                          {fDay.adjustments.length === 0 ? (
                            <Text style={[styles.brewCommentText, { fontStyle: 'normal' }]}>
                              특별한 날씨 변화나 인근 행사가 없어 기본적인 시계열 추세를 기준으로 예측되었습니다.
                            </Text>
                          ) : (
                            fDay.adjustments.map((a, i) => (
                              <Text key={i} style={[styles.brewCommentText, { fontSize: 10, lineHeight: 14, marginBottom: 2 }]}>
                                ✦ {a}
                              </Text>
                            ))
                          )}
                        </View>
                      </View>
                    );
                  })()
                )}

                {/* 닫기 버튼 */}
                <PressableScale onPress={() => setSelectedFutureDate(null)} style={styles.modalCloseBtn}>
                  <Text style={styles.modalCloseText}>확인</Text>
                </PressableScale>
              </View>
            )}
          </View>
        </View>
      </Modal>


      {/* [브루 예측 설명 오버레이] 내일 예측 배지 탭 시 브루가 등장해 원인 설명 */}
      <BrewForecastOverlay
        visible={showBrew}
        onClose={() => setShowBrew(false)}
        cups={tomorrowCups}
        revenue={tomorrowRevenue}
        peak={peakTime}
        growth={badgeText}
      />
    </View>
  );
}

// [브루 등장 오버레이] 스프링으로 튀어올라오며 말풍선으로 예측 원인을 설명한다.
function BrewForecastOverlay({
  visible,
  onClose,
  cups,
  revenue,
  peak,
  growth,
}: {
  visible: boolean;
  onClose: () => void;
  cups: number;
  revenue: number;
  peak: string;
  growth: string;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      anim.setValue(0);
      Animated.spring(anim, {
        toValue: 1,
        useNativeDriver: true,
        friction: 7,
        tension: 80,
      }).start();
    }
  }, [visible, anim]);

  const growthClean = growth.replace(/[▲▼]/g, '').trim();
  const reasons = [
    // 피크 시간대를 아직 모르면(오늘 판매 기록 없음) 해당 문장은 생략
    ...(peak !== '—' ? [{ icon: '🕑', text: `${peak} 피크 시간대에 주문이 몰릴 거예요.` }] : []),
    // 어제 매출과 비교가 가능할 때만 증감 문장을 보여준다
    ...(growth.includes('%')
      ? [{ icon: '📈', text: `최근 판매 추세가 오늘 대비 ${growthClean} ${growth.includes('▼') ? '내림세' : '오름세'}예요.` }]
      : []),
    { icon: '🌤️', text: '요일·날씨 패턴도 판매에 유리한 편이에요.' },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.brewBackdrop} onPress={onClose}>
        <Animated.View
          style={[
            styles.brewSheet,
            {
              opacity: anim,
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) },
                { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
              ],
            },
          ]}
        >
          {/* 브루 등장 */}
          <View style={styles.brewMascotWrap} pointerEvents="none">
            <Brew mood="serving" size={132} />
          </View>

          {/* 말풍선 카드 */}
          <View style={styles.brewBubble}>
            <Text style={styles.brewTitle}>내일은 {cups}잔 예상이에요! ☕</Text>
            <Text style={styles.brewSub}>예상 매출 약 {Math.round(revenue / 10000)}만 원</Text>

            <View style={styles.brewDivider} />

            {reasons.map((r) => (
              <View key={r.text} style={styles.brewReasonRow}>
                <Text style={styles.brewReasonIcon}>{r.icon}</Text>
                <Text style={styles.brewReasonText}>{r.text}</Text>
              </View>
            ))}

            <Text style={styles.brewFoot}>최근 판매 데이터 기반 AI 예측 · — 브루 드림</Text>

            <PressableScale style={styles.brewBtn} onPress={onClose} to={0.97}>
              <Text style={styles.brewBtnText}>알겠어요</Text>
            </PressableScale>
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // [브루] 예측 이유 CTA 버튼 (범례 우측)
  brewCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    backgroundColor: '#FBF0E4',
    borderWidth: 1,
    borderColor: 'rgba(194,94,53,0.35)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  brewCtaText: { fontSize: 11, fontWeight: '700', color: colors.pointOrange },
  // [브루 예측 설명 오버레이]
  brewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(30,22,16,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  brewSheet: { width: '100%', maxWidth: 340, alignItems: 'center' },
  brewMascotWrap: { marginBottom: -34, zIndex: 2 },
  brewBubble: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: 24,
    paddingTop: 40,
    paddingHorizontal: 20,
    paddingBottom: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 22,
    elevation: 10,
  },
  brewTitle: { fontSize: 18, fontWeight: '800', color: colors.espressoBrown, textAlign: 'center' },
  brewSub: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', marginTop: 3, fontWeight: '600' },
  brewDivider: { height: 1, backgroundColor: colors.mutedSand, marginVertical: 14 },
  brewReasonRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 9 },
  brewReasonIcon: { fontSize: 15, marginTop: 1 },
  brewReasonText: { flex: 1, fontSize: 13, color: colors.espressoBrown, lineHeight: 19, fontWeight: '500' },
  brewFoot: { ...typography.L5, color: colors.mochaBrown, fontStyle: 'italic', textAlign: 'center', marginTop: 6, opacity: 0.85 },
  brewBtn: { backgroundColor: colors.pointOrange, borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginTop: 14 },
  brewBtnText: { ...typography.L3, color: colors.white, fontWeight: '700' },

  card: {
    backgroundColor: 'rgba(242, 236, 224, 0.55)', // 원래 0.55 크림 베이지 톤으로 복구
    borderRadius: 24,
    borderWidth: 0.8, // [iOS 스타일] 초슬림 베젤 가공
    borderColor: 'rgba(140, 111, 86, 0.08)',
    padding: spacing.globalPadding,
    ...shadows.soft, // [iOS 스타일] 부드럽게 매끄러운 섀도우 탑재
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  label: { ...typography.L5, color: colors.mochaBrown, marginBottom: 4 },
  amount: { fontSize: 26, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.5 },

  legendContainer: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    // [여백 비율 재조정] 금액↔범례는 넓게(18), 범례↔차트는 한 묶음처럼 좁게(8)
    marginBottom: 8,
    marginTop: 18,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendColorDot: {
    width: 8,
    height: 4,
    borderRadius: 1.5,
  },
  legendText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.mochaBrown,
  },

  todoWrapper: {
    paddingTop: 28,
    paddingBottom: 12,
    paddingHorizontal: 4,
    minHeight: 180,
    justifyContent: 'flex-start',
  },
  toggleTrack: {
    width: 200, // [가독성 개선] 위치 칩이 있던 자리까지 가로로 확장
    height: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(140, 111, 86, 0.08)', // [iOS 스타일] 투명감 도는 탭 트랙
    position: 'relative',
    justifyContent: 'center',
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.04)',
    // [한글 주석: 사용자의 시각적 요청에 맞춰 왼쪽과 위로 8px씩 살짝 오프셋 조정]
    marginLeft: -8,
    marginTop: -8,
  },
  toggleCapsule: {
    position: 'absolute',
    width: 64,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.white, // [iOS 스타일] 깨끗하고 정교한 화이트 캡슐
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 1.5 },
    shadowOpacity: 0.12,
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
    fontSize: 12,
    fontWeight: '600',
    color: '#9C8875', // 차분하게 뭉갠 비활성 텍스트
  },
  toggleLabelTextActive: {
    color: colors.espressoBrown, // 캡슐 위의 어두운 활성 텍스트
    fontWeight: '800',
  },
  chartToggleContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
    borderRadius: 10,
    padding: 2,
    alignSelf: 'flex-start',
    marginBottom: 10,
  },
  chartToggleBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  chartToggleBtnActive: {
    backgroundColor: colors.white,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1.5,
    elevation: 1.5,
  },
  chartToggleText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#9C8875',
  },
  chartToggleTextActive: {
    color: colors.espressoBrown,
    fontWeight: '800',
  },

  calendarContainer: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 0.8,
    borderTopColor: 'rgba(140, 111, 86, 0.08)', // 매출 카드 내부의 일부 영역처럼 배경을 통합하고 실선으로 구분
  },
  calendarHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 0.8,
    borderBottomColor: 'rgba(140, 111, 86, 0.06)',
    paddingBottom: 8,
    marginBottom: 6,
  },
  calendarHeaderDay: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: 8,
    fontWeight: '700',
    color: colors.mochaBrown,
    letterSpacing: 0.5,
    opacity: 0.8,
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
    marginVertical: 2,
    borderRadius: 8, // 오늘 날짜 둥근 하이라이트 대응
  },
  calendarTodayCell: {
    backgroundColor: 'rgba(226, 130, 87, 0.08)', // 은은한 오렌지 하이라이트 박스
  },
  calendarDateText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  calendarTodayText: {
    color: '#E28257', // 웰컴 테마 오렌지 포인트 컬러 적용
    fontWeight: '900',
  },
  calendarIncomeText: {
    fontSize: 8,
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
  // [한글 주석] 매출 하락(▼)일 때는 초록 대신 차분한 레드 톤으로 — 오르내림을 색으로도 구분
  badgeDown: { backgroundColor: 'rgba(178, 59, 46, 0.08)' },
  badgeTextDown: { color: '#B23B2E' },
  // [한글 주석] 배지 아래 비교 기준 설명 (예: 어제 하루 매출 대비)
  badgeHint: {
    fontSize: 8.5,
    fontWeight: '700',
    color: colors.mochaBrown,
    opacity: 0.75,
  },
  chartWrap: { marginTop: 8, position: 'relative' }, // [정렬 보정] 고정 높이를 없애 유연하게 배치
  xAxis: {
    flexDirection: 'row',
    width: '100%', // [정렬 보정] 너비를 명시적으로 100% 부여하여 absolute 자식들의 좌표 붕괴 예방
    height: 18,
    marginTop: 6,
    position: 'relative',
  },
  // [정렬 보정] 폭 0 앵커 + 넘치는 텍스트 중앙 정렬 트릭 — 라벨 중심이 차트 원 좌표와 일치
  xAxisTickWrap: {
    position: 'absolute',
    top: 0,
    width: 0,
    alignItems: 'center',
  },
  xAxisText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.mochaBrown,
    opacity: 0.9,
    width: 90,
    textAlign: 'center',
  },

  footRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    // [여백 비율 재조정] X축 라벨과 구분선 사이, 구분선과 요약 수치 사이 모두 여유 있게
    marginTop: 22,
    borderTopWidth: 0.8,
    borderTopColor: 'rgba(140, 111, 86, 0.08)',
    paddingTop: 14,
  },
  footItem: { alignItems: 'center', flex: 1 },
  footLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 2 },
  footValue: { ...typography.L3, color: colors.espressoBrown },
  reportBanner: {
    marginTop: 16,
    backgroundColor: 'rgba(226, 130, 87, 0.07)', // 웰컴 헤더 오로라 톤과 매칭되는 따뜻한 오렌지 틴트 배경
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(226, 130, 87, 0.18)', // 은은하게 빛나는 테라코타 오렌지 경계선
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reportLiveBadge: {
    backgroundColor: '#E28257', // 오렌지 컬러로 시선 강탈
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  reportLiveText: {
    fontSize: 8,
    fontWeight: '900',
    color: colors.white,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)', // 어두운 반투명 배경
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '90%',
    maxWidth: 340,
    backgroundColor: colors.creamSand, // 깔끔한 배경색
    borderRadius: 24,
    padding: 20,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 0.8,
    borderBottomColor: 'rgba(140, 111, 86, 0.08)',
    paddingBottom: 12,
  },
  modalDateTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  modalIncomeBox: {
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
    borderRadius: 16,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  modalIncomeLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.mochaBrown,
    marginBottom: 4,
  },
  modalIncomeValue: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  detailsList: {
    gap: 12,
    marginVertical: 4,
  },
  detailRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  detailIconBg: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(226, 130, 87, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.mochaBrown,
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  brewCommentBox: {
    backgroundColor: 'rgba(226, 130, 87, 0.06)',
    borderRadius: 16,
    padding: 12,
    borderWidth: 0.8,
    borderColor: 'rgba(226, 130, 87, 0.15)',
    marginVertical: 4,
  },
  brewCommentTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  brewCommentText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.espressoBrown,
    lineHeight: 16,
    fontStyle: 'italic',
  },
  modalCloseBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalCloseText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.white,
  },
  forecastBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'center',
  },
  forecastBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.white,
  },
  animatedTooltip: {
    position: 'absolute',
    backgroundColor: colors.espressoBrown,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 4,
    minWidth: 100,
  },
  animatedTooltipText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: colors.white,
    textAlign: 'center',
  },
  tooltipArrow: {
    position: 'absolute',
    bottom: -3.5,
    width: 7,
    height: 7,
    backgroundColor: colors.espressoBrown,
    transform: [{ rotate: '45deg' }],
  },
});
