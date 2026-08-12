import { useEffect, useRef, useState, useMemo } from 'react';
import { ActivityIndicator, Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line, Text as SvgText, Rect, G } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { dateKey } from '../../lib/dateKey';
import { useResponsive } from '../../theme/responsive';
import { useCountUp } from '../motion';
import { PressableScale } from '../motion';
import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import {
  getStoredStoreLocation,
  getSalesCalendar,
  getSalesForecast,
  type CalendarDay,
  type ForecastDay,
  type HourlyPoint,
  type SalesCalendar,
  type SalesForecast,
} from '../../lib/api/forecast';
import { describeApiFailure, type ApiFailure } from '../../lib/api/errors';
import { useCachedResource } from '../../lib/cache';
import Brew from '../brew/Brew';
import TodoList, { type Todo } from './TodoList';
import AlertCenterCard, { type AlertItem } from './AlertCenterCard';

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

export type DateInfo = {
  dayName: string;
  dateNum: number;
  monthNum: number;
  dateKey: string;
  isToday: boolean;
  isPast: boolean;
};

// [한글 주석: 동적 주간 날짜 계산 함수 - 오늘 기준 이번 주 월~일 7일 구하기]
function getWeekDays(referenceDate: Date = new Date()): DateInfo[] {
  const current = new Date(referenceDate);
  const day = current.getDay(); // 0: 일, 1: 월 ... 6: 토
  const diffToMon = current.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(current.setDate(diffToMon));

  const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
  const todayStr = dateKey();

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const year = d.getFullYear();
    const monthNum = d.getMonth() + 1;
    const dateNum = d.getDate();
    const dateKey = `${year}-${String(monthNum).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`;

    return {
      dayName: dayNames[i],
      dateNum,
      monthNum,
      dateKey,
      isToday: dateKey === todayStr,
      isPast: dateKey < todayStr,
    };
  });
}

// 월간 캘린더 그리드 — 실제 연·월 기준으로 셀을 만든다 (월요일 시작, 6주 42칸 고정으로 모달 높이 고정)
function buildMonthCells(year: number, month0: number): (number | null)[] {
  const firstOffset = (new Date(year, month0, 1).getDay() + 6) % 7; // 월=0 … 일=6
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstOffset }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // [한글 주석: 42칸(6주×7일)을 고정 채움하여 월이 이동할 때 모달 네모 박스 높이가 덜컹거리지 않게 방지]
  while (cells.length < 42) {
    cells.push(null);
  }
  return cells;
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
  // [반응형] 트랙 실제 폭을 측정해 캡슐 위치·크기를 셀에 맞춘다.
  // 하드코딩(트랙 200 / 캡슐 64 / 위치 2·68·134)은 기기·폰트에 따라 트랙 폭이
  // 달라지면 캡슐이 라벨과 어긋나고 긴 라벨(todo)이 넘친다 — 폭 기반 계산으로 대체.
  const [trackW, setTrackW] = useState(0);
  const cellW = trackW > 0 ? trackW / 3 : 66; // 측정 전 초기값(트랙 200 기준 66)
  // 트랙은 borderRadius 999(양 끝이 반원)라 여백이 좁으면 첫/마지막 캡슐 모서리가
  // 곡선 밖으로 삐져나온다. 트랙 높이(34)의 반경을 고려해 여백을 넉넉히 준다.
  const capsuleGap = 6;

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
    outputRange: [capsuleGap, cellW + capsuleGap, cellW * 2 + capsuleGap],
  });

  return (
    <View
      style={StyleSheet.flatten([styles.toggleTrack, Platform.OS === 'web' && { cursor: 'pointer' }])}
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[styles.toggleCapsule, { width: cellW - capsuleGap * 2, transform: [{ translateX }] }]}
      />

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

// [한글 주석: 아이폰 물방울처럼 쫀득하고 통통 튀는 Bouncy Elastic Spring 애니메이션의 날짜 선택 셀]
function DateStripCell({
  item,
  isSelected,
  onSelect,
}: {
  item: DateInfo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const scaleAnim = useRef(new Animated.Value(isSelected ? 1.08 : 1.0)).current;

  useEffect(() => {
    if (isSelected) {
      // 선택되는 순간 순간적으로 0.85까지 축소되었다가 1.15로 퐁 튀어오른 후 1.08에 쫀득하게 안착
      scaleAnim.setValue(0.85);
      Animated.spring(scaleAnim, {
        toValue: 1.08,
        friction: 3.8,
        tension: 190,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.spring(scaleAnim, {
        toValue: 1.0,
        friction: 6,
        tension: 140,
        useNativeDriver: true,
      }).start();
    }
  }, [isSelected]);

  return (
    <PressableScale
      onPress={onSelect}
      style={styles.dateStripItem}
      to={0.82}
    >
      {/* [한글 주석: 요일 라벨 - 지나간 날(isPast)은 연한 톤, 오늘~미래는 또렷하고 선명한 톤] */}
      <Text
        style={[
          styles.dateDayText,
          item.isPast && styles.dateDayTextPast,
          isSelected && styles.dateDayTextActive,
        ]}
      >
        {item.dayName}
      </Text>

      <Animated.View
        style={[
          styles.dateCircle,
          item.isToday && styles.dateCircleToday,
          isSelected && styles.dateCircleActive,
          { transform: [{ scale: scaleAnim }] },
        ]}
      >
        {/* [한글 주석: 날짜 숫자 - 지나간 날은 소프트 연한 톤, 오늘부터는 또렷하게 진한 톤] */}
        <Text
          style={[
            styles.dateNumberText,
            item.isPast && styles.dateNumberTextPast,
            item.isToday && styles.dateNumberTextToday,
            isSelected && styles.dateNumberTextActive,
          ]}
        >
          {item.dateNum}
        </Text>
      </Animated.View>
    </PressableScale>
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
  onRestoreAiTodos,
  alerts = [],
  onPressAlert,
  onDismissAlert,
  onClearAllAlerts,
  onRestoreAlerts,
  refreshToken = 0,
}: {
  onPressReport?: () => void;
  todos?: Todo[];
  onPressTodo?: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onAddTodo?: (title: string, dateKey?: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
  onRestoreAiTodos?: () => void;
  alerts?: AlertItem[];
  onPressAlert?: (alert: AlertItem) => void;
  onDismissAlert?: (id: string) => void;
  onClearAllAlerts?: () => void;
  onRestoreAlerts?: () => void;
  /** 당겨서 새로고침 카운터 — 값이 바뀌면 캐시 나이와 무관하게 다시 받는다.
   *  예전엔 카드 key에 runId를 섞어 통째로 재마운트했는데, 그러면 캐시 훅·카운트업·
   *  투두 내부 상태까지 전부 버려져 새로고침마다 화면이 처음부터 다시 그려졌다. */
  refreshToken?: number;
}) {
  // [한글 주석] 뷰포트 비례 계산 — 분석 모달이 작은 화면에서 넘치지 않게
  const { vh } = useResponsive();
  const { token } = useAuth();
  // [한글 주석: 월간 달력 넘김을 위한 선택 연도/월 상태 관리]
  const [selectedYear, setSelectedYear] = useState<number>(() => new Date().getFullYear());
  const [selectedMonth0, setSelectedMonth0] = useState<number>(() => new Date().getMonth());

  // 판매 예측 — 매장 데이터를 통째로 훑어 만드는 계산이라 서버 캐시가 식어 있으면 한 번에 7초가 걸린다.
  // 그래서 지난번 예측을 기기에 남겨 두고 먼저 그린 뒤, 새 예측이 오면 조용히 갈아 끼운다.
  //
  // 예측 기준 좌표는 '등록된 매장 위치'다 — 기기 GPS를 기다리지 않는다.
  // (사장님이 집에서 앱을 켜도 매장 날씨로 예측해야 하고, 측위 대기도 사라진다.
  //  기기 캐시가 없으면 좌표 없이 부르고 백엔드가 계정의 매장 좌표를 쓴다.)
  const {
    data: forecast,
    loading: loadingForecast,
    error: forecastError,
  } = useCachedResource<SalesForecast>(
    token ? 'sales:forecast' : null,
    async () => {
      const pos = await getStoredStoreLocation();
      return getSalesForecast(token!, pos?.lat, pos?.lon);
    },
    { maxAgeMs: 5 * 60_000, refreshToken },
  );

  // 이번 달 일별 실판매 집계 — 달을 넘기면 그 달 값을 따로 캐시한다
  const { data: calendar } = useCachedResource<SalesCalendar>(
    token ? `sales:calendar:${selectedYear}-${String(selectedMonth0 + 1).padStart(2, '0')}` : null,
    () => getSalesCalendar(token!, selectedYear, selectedMonth0 + 1),
    { maxAgeMs: 5 * 60_000, refreshToken },
  );

  const todayKey = dateKey();
  // todayKey를 의존성으로 — 마운트 1회 고정([])이면 자정을 넘겨도 isToday/isPast가
  // 어제 기준으로 남아, 날짜 미지정 할 일들이 전날 칸에 계속 그려졌다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const weekDays = useMemo(() => getWeekDays(), [todayKey]);
  const [selectedDateKey, setSelectedDateKey] = useState<string>(todayKey);

  const selectedDateInfo = useMemo(() => {
    return weekDays.find((w) => w.dateKey === selectedDateKey) || weekDays.find((w) => w.isToday) || weekDays[0];
  }, [weekDays, selectedDateKey]);

  const [activeTab, setActiveTab] = useState<SalesTab>('todo');
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  const [analyticsTab, setAnalyticsTab] = useState<'day' | 'month'>('day');

  // [한글 주석: 매출 확인 버튼을 눌러 모달에 들어올 때는 무조건 'day'(일간 차트)만 나오게 고정 초기화합니다]
  const handleOpenAnalyticsModal = () => {
    setAnalyticsTab('day');
    setShowAnalyticsModal(true);
  };
  const isMonthly = analyticsTab === 'month'; // 월간 탭 여부 — 실데이터 집계 분기에 사용
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

  // [한글 주석: 전역 다국어 번역 훅 연동]
  const { t, language } = useTranslation();

  // 예측을 못 받은 이유 — 신규 계정은 판매 기록이 14일 미만이라 백엔드가 409로 조건을 알려준다.
  // 예전엔 콘솔에만 남겨서 화면에는 예측이 조용히 사라졌고, 미래 날짜를 누르면 '불러오는 중'만 돌았다.
  const forecastFailure: ApiFailure | null = forecastError
    ? describeApiFailure(forecastError, language === 'en' ? 'forecast' : '예측', language)
    : null;

  // [실시간 시계] 매분 확인 — 정시가 바뀌면 X축 시간대와 '내일 같은 시각' 예측 기준이 따라 움직인다
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const currentHour = now.getHours(); // [한글 주석] 실제 로컬 현재 시각

  // [한글 주석] 현재 시각에 따라 4개 시간 지점을 동적으로 자동 변환하는 헬퍼 연산
  // 1) 12시 이전 (오전): 9시, 10시, 11시, 12시 (1시간 단위 촘촘한 간격)
  // 2) 12시 ~ 15시 (점심/초오후): 9시, 11시, 13시, 16시 (주요 시간 흐름)
  // 3) 16시 이후 (오후 4시~마감): 9시, 13시, 18시, 21시 (전체 영업 관점 넓은 간격)
  const axisHours = useMemo(() => {
    if (currentHour < 12) {
      return [9, 10, 11, 12];
    } else if (currentHour < 16) {
      return [9, 11, 13, 16];
    } else {
      return [9, 13, 18, 21];
    }
  }, [currentHour]);

  // [한글 주석] 현재 시간(currentHour)에 가장 근접한 X축 시간대 지점 인덱스를 실시간 연산합니다
  let currentAxisIndex = 0;
  for (let i = axisHours.length - 1; i >= 0; i--) {
    if (currentHour >= axisHours[i]) {
      currentAxisIndex = i;
      break;
    }
  }

  // [한글 주석: 월간 캘린더 부드러운 전환을 위한 페이드 & 슬라이드 애니메이션 제어]
  const monthAnim = useRef(new Animated.Value(1)).current;
  const monthSlideAnim = useRef(new Animated.Value(0)).current;

  const triggerMonthTransition = (updateFn: () => void, direction: 'prev' | 'next') => {
    Animated.parallel([
      Animated.timing(monthAnim, {
        toValue: 0,
        duration: 90,
        useNativeDriver: true,
      }),
      Animated.timing(monthSlideAnim, {
        toValue: direction === 'next' ? -24 : 24,
        duration: 90,
        useNativeDriver: true,
      }),
    ]).start(() => {
      updateFn();
      monthSlideAnim.setValue(direction === 'next' ? 24 : -24);
      Animated.parallel([
        Animated.timing(monthAnim, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.spring(monthSlideAnim, {
          toValue: 0,
          friction: 7.5,
          tension: 95,
          useNativeDriver: true,
        }),
      ]).start();
    });
  };

  const handlePrevMonth = () => {
    triggerMonthTransition(() => {
      if (selectedMonth0 === 0) {
        setSelectedYear((prev) => prev - 1);
        setSelectedMonth0(11);
      } else {
        setSelectedMonth0((prev) => prev - 1);
      }
    }, 'prev');
  };

  const handleNextMonth = () => {
    triggerMonthTransition(() => {
      if (selectedMonth0 === 11) {
        setSelectedYear((prev) => prev + 1);
        setSelectedMonth0(0);
      } else {
        setSelectedMonth0((prev) => prev + 1);
      }
    }, 'next');
  };

  // 실제 선택된 연/월 기준 캘린더 좌표
  const todayYear = now.getFullYear();
  const todayMonth0 = now.getMonth();
  const todayDay = now.getDate();
  const isCurrentMonthView = selectedYear === todayYear && selectedMonth0 === todayMonth0;
  const monthCells = useMemo(() => buildMonthCells(selectedYear, selectedMonth0), [selectedYear, selectedMonth0]);

  // 일(day) → 실판매 집계 맵
  const calDayMap = useMemo(() => {
    const m: Record<number, CalendarDay> = {};
    calendar?.days.forEach((d) => {
      m[d.day] = d;
    });
    return m;
  }, [calendar]);

  // 일(day) → AI 예측 맵 — 예측 API가 준 해당 연/월의 미래 날짜만
  const futureForecasts = useMemo(() => {
    const m: Record<number, ForecastDay> = {};
    forecast?.week.forEach((d) => {
      const [fy, fm, fd] = d.date.split('-').map(Number);
      if (fy === selectedYear && fm === selectedMonth0 + 1) m[fd] = d;
    });
    return m;
  }, [forecast, selectedYear, selectedMonth0]);

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
    // 펄스 링은 분석 모달의 DAY 탭에서만 보인다 — 그때만 돌린다.
    // 조건 없이 돌리면 setPulseVal이 초당 ~60번 카드 전체(투두 목록 포함)를 재렌더해,
    // 홈 화면이 항상 램프를 켜 둔 것처럼 무거워진다 (스크롤 버벅임·배터리 소모의 주범이었다).
    if (!showAnalyticsModal || analyticsTab !== 'day') {
      setPulseVal(0);
      return;
    }
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
  }, [pulse, showAnalyticsModal, analyticsTab]);

  // [한글 주석] Svg 내부 펄스 링의 크기 및 투명도를 일반 숫자 값으로 실시간 계산합니다.
  const pulseRadius = 4 + pulseVal * 8; // [0, 1] -> [4, 12]
  const pulseOpacity = 0.6 - pulseVal * 0.6; // [0, 1] -> [0.6, 0]

  // 증감 뱃지 — 일간은 '지난주 같은 요일' 대비가 기본이다.
  // 어제 대비는 요일 효과(월요일은 원래 한산하다)에 눌려 사장님 체감과 어긋난다는 피드백이 있었다.
  // 지난주 같은 요일 기록이 아예 없을 때만 어제 값으로 물러선다.
  const lastWeekRevenue = todayActual?.last_week_revenue ?? 0;
  const yesterdayRevenue = todayActual?.yesterday_revenue ?? 0;
  const dayBase = lastWeekRevenue > 0 ? lastWeekRevenue : yesterdayRevenue;
  const comparingLastWeek = lastWeekRevenue > 0;
  const deltaPct = isMonthly
    ? (calendar?.change_pct ?? null)
    : dayBase > 0
      ? ((todayRevenueTotal - dayBase) / dayBase) * 100
      : null;
  const badgeText = deltaPct === null ? '비교 없음' : `${deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(1)}%`;
  const isBadgeDown = deltaPct !== null && deltaPct < 0;
  // [한글 주석] 사장님이 %의 비교 기준을 바로 알 수 있게 배지 아래에 붙이는 설명 문구 (한 줄 가로 배치를 위해 콤팩트화)
  const badgeHint =
    deltaPct === null
      ? isMonthly
        ? '지난달 기록 없음'
        : '비교할 기록 없음'
      : isMonthly
        ? '지난달 대비'
        : comparingLastWeek
          ? '지난주 같은 요일 대비'
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
    <View style={styles.cardContainer}>
      {/* ── [한글 주석: iOS 카드 레이아웃 기반 대시보드 헤더 & 한국어 3D 주간 날짜 선택기] ── */}
      <View style={styles.journeyHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.journeyTitle}>오늘의 할 일</Text>
          <Text style={styles.journeySub}>매장 관리와 오늘의 업무를 한눈에 확인하세요</Text>
        </View>

        {/* ━━━ [한글 주석: 아이콘 없이 관리 탭 설정 UI 감성으로 다듬은 미니멀 매출 확인 버튼] ━━━ */}
        <PressableScale
          style={styles.analyticsCtaBtn}
          onPress={handleOpenAnalyticsModal}
          to={0.95}
        >
          <Text style={styles.analyticsCtaText}>매출 확인 ›</Text>
        </PressableScale>
      </View>

      {/* 3D 블랙 서클 주간 날짜 선택기 (월~일 동적 계산 및 픽셀 칼정렬) */}
      <View style={styles.dateStripRow}>
        {weekDays.map((item) => {
          const isSelected = selectedDateKey === item.dateKey;
          return (
            <DateStripCell
              key={item.dateKey}
              item={item}
              isSelected={isSelected}
              onSelect={() => setSelectedDateKey(item.dateKey)}
            />
          );
        })}
      </View>

      {/* [한글 주석: 홈 카드는 오늘의 할 일(TodoList)에서 상자를 깔끔히 마감합니다] */}
      <View style={styles.todoWrapper}>
        <TodoList
          todos={todos}
          selectedDateInfo={selectedDateInfo}
          onPressAction={onPressTodo || (() => { })}
          onToggleDone={onToggleDone}
          onAddTodo={onAddTodo}
          onEditTodo={onEditTodo}
          onDeleteTodo={onDeleteTodo}
          onRestoreAiTodos={onRestoreAiTodos}
          hideCard={false}
        />
      </View>

      {/* ━━━ [한글 주석: 매출 확인하기 버튼 클릭 시 시원하게 뜨는 일간·월간 매출 분석 모달] ━━━ */}
      <Modal
        visible={showAnalyticsModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAnalyticsModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowAnalyticsModal(false)}>
          <Pressable style={styles.analyticsModalBox} onPress={(e) => e.stopPropagation()}>
            {/* ━━━ [한글 주석: 정갈한 타이틀과 ✕ 닫기 버튼 헤더] ━━━ */}
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>매출 분석 리포트</Text>
              <Pressable style={styles.modalCloseIconBtn} onPress={() => setShowAnalyticsModal(false)}>
                <Ionicons name="close" size={22} color="#71717A" />
              </Pressable>
            </View>

            {/* ━━━ [한글 주석: 투명 미니멀리즘 2단 세그먼트 탭 컨트롤러 — DAY | MONTH] ━━━ */}
            <View style={styles.fullTabTrack}>
              <Pressable
                onPress={() => setAnalyticsTab('day')}
                style={[styles.fullTabCell, analyticsTab === 'day' && styles.fullTabCellActive]}
              >
                <Text style={[styles.fullTabText, analyticsTab === 'day' && styles.fullTabTextActive]}>DAY</Text>
              </Pressable>

              <Pressable
                onPress={() => setAnalyticsTab('month')}
                style={[styles.fullTabCell, analyticsTab === 'month' && styles.fullTabCellActive]}
              >
                <Text style={[styles.fullTabText, analyticsTab === 'month' && styles.fullTabTextActive]}>MONTH</Text>
              </Pressable>
            </View>

            {/* ━━━ [한글 주석: 금액 스포트라이트 수치] ━━━ */}
            <View style={styles.modalHeroAmountRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalAmountText}>₩ {amount.toLocaleString()}</Text>
                <Text style={{ fontSize: 11, fontWeight: '800', color: isBadgeDown ? '#B23B2E' : colors.trendGreenText, marginTop: 2 }}>
                  {badgeHint} {badgeText}
                </Text>
              </View>
            </View>

            {/* 모달 본문 — 일간 차트 또는 월간 달력 */}
            {/* [한글 주석] 고정 440 은 작은 기기에서 모달이 화면을 넘겼다 → 뷰포트 비례 + 상한 */}
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: Math.min(vh(56), 440) }}>
              {analyticsTab === 'month' ? (
                <View style={styles.calendarContainer}>
                  {/* ━━━ [한글 주석: 연/월 이동 넘김 컨트롤러 UI 헤더] ━━━ */}
                  <View style={styles.monthHeaderRow}>
                    <PressableScale onPress={handlePrevMonth} style={styles.monthNavBtn} to={0.88}>
                      <Ionicons name="chevron-back" size={18} color={colors.espressoBrown} />
                    </PressableScale>

                    <Animated.View style={{ opacity: monthAnim, transform: [{ translateX: monthSlideAnim }] }}>
                      <Text style={styles.monthTitleText}>
                        {selectedYear}년 {selectedMonth0 + 1}월
                      </Text>
                    </Animated.View>

                    <PressableScale onPress={handleNextMonth} style={styles.monthNavBtn} to={0.88}>
                      <Ionicons name="chevron-forward" size={18} color={colors.espressoBrown} />
                    </PressableScale>
                  </View>

                  {/* 요일 행 */}
                  <View style={styles.calendarHeaderRow}>
                    {DAYS.map(day => (
                      <Text key={day} style={styles.calendarHeaderDay}>{day}</Text>
                    ))}
                  </View>

                  {/* [한글 주석: 달 이동 시 부드러운 페이드 & 스무스 슬라이드가 적용되는 날짜 그리드 영역] */}
                  <Animated.View style={[styles.calendarGridContainer, { opacity: monthAnim, transform: [{ translateX: monthSlideAnim }] }]}>
                    <View style={styles.calendarGrid}>
                      {monthCells.map((day, idx) => {
                        const dayData = day !== null ? calDayMap[day] : undefined;
                        const fDay = day !== null && isCurrentMonthView && day > todayDay ? futureForecasts[day] : undefined;
                        const hasData = !!dayData && dayData.revenue > 0;
                        const isFuture = !!fDay;
                        const isToday = isCurrentMonthView && day === todayDay;
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
                              isFuture && { backgroundColor: 'rgba(140, 111, 86, 0.04)' },
                              !hasData && !isFuture && { opacity: 0.35 }
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
                  </Animated.View>
                </View>
              ) : (
                /* ━━━ [한글 주석: 착시를 제거하고 안정적인 시각을 제공하는 독립 캔버스 카드 (chartCanvasCard)] ━━━ */
                <View style={styles.chartCanvasCard}>
                  {/* 오늘 / 내일 예측 범례 */}
                  <View style={styles.legendContainer}>
                    <View style={styles.legendItem}>
                      <View style={[styles.legendColorDot, { backgroundColor: colors.espressoBrown }]} />
                      <Text style={styles.legendText}>{t('todayLive')}</Text>
                    </View>
                    <View style={styles.legendItem}>
                      <View style={[styles.legendColorDot, { backgroundColor: colors.mochaBrown, opacity: 0.5 }]} />
                      <Text style={styles.legendText}>{language === 'en' ? 'Tomorrow AI' : '내일 AI 예측'}</Text>
                    </View>

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

                      <Rect width="300" height="130" fill="transparent" {...svgPress(() => setActiveTooltip(null))} />

                      <Line x1="15" y1="25" x2="285" y2="25" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
                      <Line x1="15" y1="65" x2="285" y2="65" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
                      <Line x1="15" y1="105" x2="285" y2="105" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />

                      {CHART_X.map((x, i) => (
                        <Line key={`tick-${i}`} x1={x} y1="115" x2={x} y2={Math.min(todayY[i], tomorrowY[i]) + 3} stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="2,2" opacity="0.3" />
                      ))}

                      <Path d={realtimeFillPath} fill="url(#todayFill)" />
                      <Path d={realtimeLinePath} stroke={colors.espressoBrown} strokeWidth={2.0} fill="none" strokeLinecap="round" />

                      <Circle cx={CHART_X[currentAxisIndex]} cy={todayY[currentAxisIndex]} r={2.5} fill={colors.pointOrange} />
                      <Circle
                        cx={CHART_X[currentAxisIndex]}
                        cy={todayY[currentAxisIndex]}
                        r={pulseRadius * 0.7}
                        fill={colors.pointOrange}
                        opacity={pulseOpacity * 0.6}
                      />

                      {forecast && (
                        <G>
                          <Path d={forecastFillPath} fill="url(#tomorrowFill)" />
                          <Path d={forecastLinePath} stroke={colors.mochaBrown} strokeWidth={1.2} strokeOpacity={0.38} strokeDasharray="1.2,2.0" fill="none" strokeLinecap="round" />

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

                      {activeTooltip && (() => {
                        const rectX = Math.max(10, Math.min(200, activeTooltip.x - 45));
                        const textX = rectX + 45;
                        return (
                          <G>
                            <Rect
                              x={rectX}
                              y={activeTooltip.y - 30}
                              width={90}
                              height={18}
                              rx={5}
                              fill={colors.espressoBrown}
                            />
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
            </ScrollView>

            {/* ━━━ [한글 주석: 아담한 3개 모카 틴트 칩 카드 그리드] ━━━ */}
            <View style={styles.modalFootCardRow}>
              <View style={styles.modalFootChip}>
                <Text style={styles.footLabel} numberOfLines={1}>
                  {analyticsTab === 'month' ? '총 판매 잔' : '판매 잔 (오늘/내일)'}
                </Text>
                <Text style={styles.footValue}>
                  {salesCount}
                  {analyticsTab === 'day' && forecast && (
                    <Text style={{ fontSize: 10, color: colors.mochaBrown, fontWeight: 'normal' }}>
                      {` / ${tomorrowCups}${t('cups')}`}
                    </Text>
                  )}
                </Text>
              </View>
              <View style={styles.modalFootChip}>
                <Text style={styles.footLabel}>{t('avgPricePerCustomer')}</Text>
                <Text style={styles.footValue}>{averagePrice}</Text>
              </View>
              <View style={styles.modalFootChip}>
                <Text style={styles.footLabel}>{t('peakTime')}</Text>
                <Text style={[styles.footValue, { color: colors.trendGreenText }]}>{peakTime}</Text>
              </View>
            </View>

            {/* [한글 주석: 통합형 주간 리포트 스마트 배너] */}
            {onPressReport && (
              <PressableScale onPress={onPressReport} style={styles.reportBanner}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reportTitle}>{language === 'en' ? 'Weekly Sales Report' : '이번 주 매출 리포트'}</Text>
                  <Text style={styles.reportSub}>{language === 'en' ? 'AI summary & optimization tips' : 'AI가 분석한 주간 성과 및 개선 팁'}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.espressoBrown} />
              </PressableScale>
            )}
          </Pressable>
        </Pressable>
      </Modal>

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
                    <Text style={styles.modalDateTitle}>{selectedMonth0 + 1}월 {selectedDate}일 매출 상세 리포트</Text>
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
                  <Text style={styles.modalDateTitle}>{selectedMonth0 + 1}월 {selectedFutureDate}일 AI 판매량 예측</Text>
                  <Pressable onPress={() => setSelectedFutureDate(null)} style={{ padding: 4 }}>
                    <Ionicons name="close" size={22} color={colors.espressoBrown} />
                  </Pressable>
                </View>

                {/* 데이터가 없거나 로딩 중일 때 — 예측이 아예 안 열린 계정에서는
                    영원히 도는 스피너 대신 열리는 조건(판매 기록 14일 등)을 알려준다 */}
                {!futureForecasts[selectedFutureDate] ? (
                  <View style={{ paddingVertical: 32, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' }}>
                    {forecastFailure && !loadingForecast ? (
                      <>
                        <Ionicons
                          name={forecastFailure.kind === 'needs_data' ? 'hourglass-outline' : 'alert-circle-outline'}
                          size={22}
                          color={colors.mochaBrown}
                          style={{ marginBottom: 10 }}
                        />
                        <Text style={{ ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 16 }}>
                          {forecastFailure.message}
                        </Text>
                      </>
                    ) : (
                      <>
                        <ActivityIndicator size="small" color={colors.mochaBrown} style={{ marginBottom: 12 }} />
                        <Text style={{ ...typography.L5, color: colors.mochaBrown }}>예측 정보를 불러오는 중입니다...</Text>
                      </>
                    )}
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
    // (삭제됨) '요일·날씨 패턴도 판매에 유리한 편이에요' — 조건 없이 항상 붙던 문장이라,
    // 비가 오든 한파든 늘 유리하다고 말했다. 위 두 근거는 실제 데이터가 있을 때만 나온다.
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
    // 베이지 반투명 배경은 크림 시트 위에서 카드가 '액자 프레임'처럼 떠 보였다 —
    // 아래 AI 경영 리포트 카드와 같은 흰색+동일 테두리로 통일해 이중 테두리 느낌 제거
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)', // ManagementReportCard와 동일 톤
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

  // AI 예측이 아직 열리지 않았을 때의 안내 줄 (판매 기록 14일 조건 등)
  forecastNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 11,
    marginBottom: 8,
  },
  forecastNoticeText: {
    flex: 1,
    fontSize: 10.5,
    fontWeight: '600',
    lineHeight: 15,
    color: colors.mochaBrown,
  },

  todoWrapper: {
    marginTop: 2,
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    backgroundColor: '#FAF8F5',
    borderRadius: 22,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(110, 85, 68, 0.08)',
  },
  toggleTrack: {
    // 고정폭(200)은 카드 폭보다 좁아 금액·달력과 정렬이 어긋났다(세그먼트만 왼쪽에 치우침).
    // 카드 콘텐츠 폭을 그대로 쓰게 해 세 요소의 좌우 기준선을 맞춘다.
    // 캡슐은 트랙 폭을 측정해 따라가므로(SlidingTabToggle) 폭이 바뀌어도 라벨과 정렬된다.
    width: '100%',
    height: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(140, 111, 86, 0.08)', // [iOS 스타일] 투명감 도는 탭 트랙
    position: 'relative',
    justifyContent: 'center',
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.04)',
    // 음수 마진(왼쪽·위 -8)은 세그먼트를 카드 콘텐츠 영역 밖으로 밀어 테두리와 어긋나고
    // 위 요소와 겹치게 만들었다 — 제거해 카드 콘텐츠(매출 숫자 등)와 왼쪽 정렬을 맞춘다.
  },
  toggleCapsule: {
    position: 'absolute',
    // width는 SlidingTabToggle에서 트랙 폭 기반으로 동적 지정 (하드코딩 64 제거)
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
  footLabel: { fontSize: 8.8, fontWeight: '700', color: colors.mochaBrown, marginBottom: 3, textAlign: 'center' },
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
  cardContainer: {
    paddingHorizontal: 2,
    marginBottom: 16,
  },
  journeyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  journeyTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: '#18181B',
    letterSpacing: -0.6,
  },
  journeySub: {
    fontSize: 12.5,
    fontWeight: '500',
    color: '#71717A',
    marginTop: 3,
    letterSpacing: -0.2,
  },
  floatingAddBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#18181B',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  dateStripRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: 'rgba(110, 85, 68, 0.04)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(110, 85, 68, 0.07)',
  },

  dateStripItem: {
    alignItems: 'center',
    width: 40,
    gap: 3,
  },
  dateDayText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#3F3F46',
    textAlign: 'center',
  },
  dateDayTextPast: {
    color: '#D4D4D8',
    fontWeight: '600',
  },
  dateDayTextActive: {
    fontSize: 11.5,
    fontWeight: '900',
    color: colors.espressoBrown,
    textAlign: 'center',
  },
  dateCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dateCircleToday: {
    borderWidth: 1.5,
    borderColor: colors.espressoBrown,
    backgroundColor: 'transparent',
  },
  dateCircleActive: {
    backgroundColor: colors.espressoBrown,
    borderWidth: 0,
    borderColor: 'transparent',
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  dateNumberText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#18181B',
    textAlign: 'center',
  },
  dateNumberTextPast: {
    color: '#A1A1AA',
    fontWeight: '600',
  },
  dateNumberTextToday: {
    fontSize: 14,
    fontWeight: '900',
    color: colors.espressoBrown,
    textAlign: 'center',
  },
  dateNumberTextActive: {
    fontSize: 14,
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
  },


  analyticsCtaBtn: {
    backgroundColor: 'rgba(110, 85, 68, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(110, 85, 68, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  analyticsCtaText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.espressoBrown,
    letterSpacing: -0.3,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: colors.espressoBrown,
    letterSpacing: -0.4,
  },
  modalSub: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.mochaBrown,
    marginTop: 2,
  },
  modalCloseIconBtn: {
    padding: 4,
    borderRadius: 20,
    marginLeft: 6,
  },
  modalHeroAmountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(140, 111, 86, 0.08)',
  },
  modalAmountText: {
    ...typography.hero, // 토스식 히어로 숫자 — 금액이 화면의 주인공 (Pretendard ExtraBold 34)
    color: colors.espressoBrown,
  },
  fullTabTrack: {
    flexDirection: 'row',
    backgroundColor: 'transparent',
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(140, 111, 86, 0.1)',
    marginBottom: 16,
  },
  fullTabCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderBottomWidth: 2.5,
    borderBottomColor: 'transparent',
    marginBottom: -1.5,
  },
  fullTabCellActive: {
    borderBottomColor: colors.espressoBrown,
  },
  fullTabText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.mochaBrown,
    letterSpacing: 1.0,
  },
  fullTabTextActive: {
    color: colors.espressoBrown,
    fontWeight: '900',
  },
  analyticsModalBox: {
    width: '88%',
    maxWidth: 360,
    backgroundColor: '#FAF8F5',
    borderRadius: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  chartCanvasCard: {
    backgroundColor: 'rgba(140, 111, 86, 0.04)',
    borderRadius: 22,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.11)',
    marginBottom: 4,
  },
  modalFootCardRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  modalFootChip: {
    flex: 1,
    backgroundColor: 'rgba(140, 111, 86, 0.04)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.07)',
  },
  reportTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  reportSub: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  // [한글 주석: 월 선택 넘김 UI 헤더 및 달력 그리드 고정 용기 스타일 정의]
  calendarGridContainer: {
    minHeight: 250,
  },
  monthHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    gap: 16,
  },
  monthNavBtn: {
    padding: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
  },
  monthTitleText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.espressoBrown,
    letterSpacing: -0.3,
  },
});
