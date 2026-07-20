import { useEffect, useRef, useState, useMemo } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line, Text as SvgText, Rect, G } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { useCountUp } from '../motion';
import { PressableScale } from '../motion';
import { useAuth } from '../../auth/AuthContext';
import { getSalesForecast, getDevicePosition, type SalesForecast, type ForecastDay, type HourlyPoint } from '../../lib/api/forecast';
import Brew from '../brew/Brew';

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

type DailyDetail = {
  income: number;
  popular: string;
  beans: string;
  customers: number;
  peak: string;
  brewComment: string;
};

// [한글 주석: 달력 날짜별 상세 매출 분석 데이터셋] 7월 1일부터 15일까지의 세부 가상 데이터
const SALES_DETAILS: Record<string, DailyDetail> = {
  '1': {
    income: 420000,
    popular: '☕ 아메리카노 (48잔) · 🥐 크로와상 (15개)',
    beans: '1.9 kg',
    customers: 82,
    peak: '11:30 - 12:30',
    brewComment: '오전 브런치 타임에 디저트류 판매가 평소보다 25% 상승했어요. 빵 굽는 고소한 냄새가 한몫했네요!',
  },
  '2': {
    income: 380000,
    popular: '🥛 바닐라라떼 (25잔) · ☕ 아메리카노 (38잔)',
    beans: '1.6 kg',
    customers: 76,
    peak: '13:00 - 14:00',
    brewComment: '비가 내려 따뜻하고 달달한 라떼 음료가 큰 사랑을 받았습니다. 매장의 안온한 온도가 한몫했네요.',
  },
  '3': {
    income: 450000,
    popular: '☕ 아메리카노 (55잔) · 🍰 딸기케이크 (12개)',
    beans: '2.0 kg',
    customers: 90,
    peak: '14:30 - 15:30',
    brewComment: '금요일 오후 피크타임 매출이 아주 훌륭해요! 주말을 앞두고 시그니처 케이크 주문율이 높았습니다.',
  },
  '4': {
    income: 620000,
    popular: '☕ 아메리카노 (72잔) · 🥐 크로와상 (28개)',
    beans: '2.8 kg',
    customers: 125,
    peak: '14:00 - 16:00',
    brewComment: '주말 토요일 매출 스파이크 달성! 아메리카노와 베이커리 세트 구성이 대단히 성공적이었습니다.',
  },
  '5': {
    income: 580000,
    popular: '☕ 아메리카노 (64잔) · 🍋 레몬에이드 (20잔)',
    beans: '2.4 kg',
    customers: 110,
    peak: '15:00 - 17:30',
    brewComment: '화창한 일요일 오후, 갈증을 해소하는 아이스 에이드류의 주문이 어제보다 30% 증가했습니다.',
  },
  '6': {
    income: 390000,
    popular: '☕ 아메리카노 (45잔) · 🥯 베이글 (14개)',
    beans: '1.7 kg',
    customers: 79,
    peak: '08:30 - 10:00',
    brewComment: '월요일 아침 출근길 직장인분들의 모닝 세트(커피+🥯) 구매율이 대폭 치솟았습니다.',
  },
  '7': {
    income: 410000,
    popular: '☕ 아메리카노 (50잔) · 🥛 카페라떼 (30잔)',
    beans: '1.9 kg',
    customers: 84,
    peak: '12:00 - 13:30',
    brewComment: '점심 식사 이후 12:30부터 1시간 동안 라떼 주문량이 많았습니다. 빠른 제조 덕분에 회전율을 지켰어요.',
  },
  '8': {
    income: 430000,
    popular: '☕ 아메리카노 (53잔) · 🥐 크로와상 (18개)',
    beans: '2.0 kg',
    customers: 86,
    peak: '13:00 - 14:30',
    brewComment: '수요일 오후 미팅용 단체 주문 건 덕분에 안정적으로 일일 목표 매출을 빠르게 달성했습니다.',
  },
  '9': {
    income: 350000,
    popular: '☕ 아메리카노 (36잔) · 🥛 바닐라라떼 (18잔)',
    beans: '1.5 kg',
    customers: 68,
    peak: '14:00 - 15:00',
    brewComment: '목요일 평일 오후 시간대의 매장 유동 인구가 다소 적었습니다. 인근 사무실 할인 이벤트를 추천해요.',
  },
  '10': {
    income: 490000,
    popular: '☕ 아메리카노 (58잔) · 🍰 초코케이크 (15개)',
    beans: '2.2 kg',
    customers: 98,
    peak: '15:00 - 16:30',
    brewComment: '금요일 오후, 당 충전을 원하는 직장인 손님 덕에 단 디저트류 판매가 평소 대비 폭증했습니다.',
  },
  '11': {
    income: 710000,
    popular: '☕ 아메리카노 (85잔) · 🥐 크로와상 (32개)',
    beans: '3.1 kg',
    customers: 140,
    peak: '13:30 - 16:00',
    brewComment: '이번 달 일일 최고 매출을 경신했습니다! 근처 축제 행사 덕분에 테이크아웃 회전이 훌륭했어요.',
  },
  '12': {
    income: 630000,
    popular: '☕ 아메리카노 (70잔) · 🍋 레몬에이드 (25잔)',
    beans: '2.7 kg',
    customers: 120,
    peak: '14:30 - 16:30',
    brewComment: '일요일 오후 아이스 패밀리 세트가 주문 급상승하여 재재료 소진이 평소보다 2시간 빨랐습니다.',
  },
  '13': {
    income: 380000,
    popular: '☕ 아메리카노 (42잔) · 🥯 베이글 (12개)',
    beans: '1.6 kg',
    customers: 75,
    peak: '12:00 - 13:00',
    brewComment: '월요일 점심 직장인 유입 비중이 높았습니다. 간편한 모바일 포인트를 통한 결제가 대다수였어요.',
  },
  '14': {
    income: 400000,
    popular: '☕ 아메리카노 (48잔) · 🥛 카페라떼 (28잔)',
    beans: '1.8 kg',
    customers: 82,
    peak: '13:00 - 14:00',
    brewComment: '카페라떼 우유 소비량이 다소 많아 내일 안전 재고를 평소 대비 1팩 더 주문해두는 것이 안전합니다.',
  },
  '15': {
    income: 428500,
    popular: '☕ 아메리카노 (52잔) · 🍋 레몬에이드 (18잔)',
    beans: '1.9 kg',
    customers: 88,
    peak: '14:00 - 15:00',
    brewComment: '폭염 주의보 여파로 시원한 음료와 에이드가 날개 돋친 듯이 많이 팔려 나갔습니다!',
  }
};

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

// [한글 주석] onPressReport 콜백을 받아와 리포트 배너의 이벤트를 바인딩합니다.
export default function SalesCard({ onPressReport }: { onPressReport?: () => void }) {
  const { token, user } = useAuth();
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [loadingForecast, setLoadingForecast] = useState(false);

  const [isMonthly, setIsMonthly] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null); // [한글 주석: 선택한 날짜의 상세 매출 분석 모달 노출 상태 변수]
  const [selectedFutureDate, setSelectedFutureDate] = useState<string | null>(null);
  const [showBrew, setShowBrew] = useState(false); // [브루 예측 설명 오버레이]
  const [activeTooltip, setActiveTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    value: string;
  } | null>(null);
  const [locationModalVisible, setLocationModalVisible] = useState(false);

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

  const FALLBACK_FORECASTS: Record<string, ForecastDay> = {
    '17': { date: '2026-07-17', weekday: '금', cups: 172, revenue: 512000, weather: 'Sunny', temp_max: 29.5, precip_prob: 0, adjustments: [], base_cups: 172, holiday: null },
    '18': { date: '2026-07-18', weekday: '토', cups: 185, revenue: 554000, weather: 'Cloudy', temp_max: 28.0, precip_prob: 10, adjustments: [], base_cups: 185, holiday: null },
    '19': { date: '2026-07-19', weekday: '일', cups: 190, revenue: 570000, weather: 'Rainy', temp_max: 26.5, precip_prob: 80, adjustments: ['강수 확률 80% 보정 (-10%)'], base_cups: 190, holiday: null },
    '20': { date: '2026-07-20', weekday: '월', cups: 155, revenue: 462000, weather: 'Sunny', temp_max: 30.1, precip_prob: 0, adjustments: [], base_cups: 155, holiday: null },
    '21': { date: '2026-07-21', weekday: '화', cups: 160, revenue: 480000, weather: 'Sunny', temp_max: 31.0, precip_prob: 0, adjustments: [], base_cups: 160, holiday: null },
    '22': { date: '2026-07-22', weekday: '수', cups: 165, revenue: 495000, weather: 'Sunny', temp_max: 29.8, precip_prob: 0, adjustments: [], base_cups: 165, holiday: null },
    '23': { date: '2026-07-23', weekday: '목', cups: 162, revenue: 486000, weather: 'Sunny', temp_max: 30.2, precip_prob: 0, adjustments: [], base_cups: 162, holiday: null },
  };

  const futureForecasts = {
    ...FALLBACK_FORECASTS,
    ...(forecast ? forecast.week.reduce<Record<string, ForecastDay>>((acc, d) => {
      const day = String(Number(d.date.slice(-2))); 
      acc[day] = d;
      return acc;
    }, {}) : {})
  };

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
    return () => {
      cancelled = true;
    };
  }, [token]);
  // [실시간 시계] 매분 확인 — 정시가 바뀌면 X축 시간대와 '내일 같은 시각' 예측 기준이 따라 움직인다
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // X축 4개 시간대: 현재 시각을 마지막 점으로 3시간 간격 (새벽에는 09시를 하한으로 고정)
  const anchorHour = Math.min(23, Math.max(9, now.getHours()));
  const axisHours = [anchorHour - 9, anchorHour - 6, anchorHour - 3, anchorHour];

  // 오늘 실적 — 백엔드 실데이터 (없으면 0: AI 경영 리포트와 같은 집계 기준)
  const todayActual = forecast?.today ?? null;
  const todayRevenueTotal = todayActual?.revenue ?? 0;
  const todayCupsTotal = todayActual?.cups ?? 0;

  const targetValue = isMonthly ? 12480000 : todayRevenueTotal;
  const amount = useCountUp(targetValue, 1100, [isMonthly, targetValue]);

  const tomorrowRevenue = forecast?.tomorrow.revenue ?? 480000;
  const tomorrowCups = forecast?.tomorrow.cups ?? 165;

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

  // 일/월별 상승 뱃지 텍스트 — 일간은 어제 매출 대비 실제 증감 (비교 대상 없으면 '비교 없음')
  const yesterdayRevenue = todayActual?.yesterday_revenue ?? 0;
  const dailyDeltaPct = yesterdayRevenue > 0 ? ((todayRevenueTotal - yesterdayRevenue) / yesterdayRevenue) * 100 : null;
  const badgeText = isMonthly
    ? '▲ 8.7%'
    : dailyDeltaPct === null
      ? '비교 없음'
      : `${dailyDeltaPct >= 0 ? '▲' : '▼'} ${Math.abs(dailyDeltaPct).toFixed(1)}%`;

  // 하단 세부 요약 수치 — 일간은 오늘 실적 기반 (데이터 없으면 '—')
  const salesCount = isMonthly ? '4,120잔' : `${todayCupsTotal.toLocaleString()}잔`;
  const averagePrice = isMonthly
    ? '₩3,085'
    : todayCupsTotal > 0
      ? `₩${Math.round(todayRevenueTotal / todayCupsTotal).toLocaleString()}`
      : '—';
  let peakTime = '—';
  if (isMonthly) {
    peakTime = '주말 오후';
  } else if (todayActual) {
    const best = todayActual.hourly.reduce((a, b) => (b.cups > a.cups ? b : a));
    if (best.cups > 0) peakTime = `${best.hour}–${best.hour + 1}시`;
  }

  const lat = forecast?.location.lat ?? 37.5562;
  const lon = forecast?.location.lon ?? 126.9223;
  const regionName = forecast?.location.region ?? "서울특별시 마포구 서교동";
  // [한글 주석] 지도 마커에 표기할 매장명 — 회원가입 시 지정한 상호명(user.name)과 연동
  const shopLabel = user?.name ? `내 매장 (${user.name})` : '내 매장';
  const nearbyEvents = forecast?.nearby_events ?? [];
  const serializedEvents = JSON.stringify(nearbyEvents);

  // [네이버 지도 연동 설정 가이드]
  // 1. 네이버 클라우드 플랫폼(NCP)에서 Maps > Web Dynamic Map 서비스를 신청하고 발급받은 Client ID를 아래에 기입해 줍니다.
  //    ※ NCP 콘솔의 해당 애플리케이션에 Web 서비스 URL(예: http://localhost:8081)이 등록되어 있어야 인증됩니다.
  // 2. 아래 ID가 비어있거나 'YOUR_NAVER_CLIENT_ID' 상태일 때는 자동으로 Leaflet.js 오픈맵이 폴백 구동되어 공백 없이 정상 동작합니다.
  const NAVER_CLIENT_ID = process.env.EXPO_PUBLIC_NAVER_CLIENT_ID || "6amak4awt7";


  // [네이버 지도 다이렉트 DOM 렌더링 훅]
  // iframe 격리 시 브라우저가 Referer 오리진을 null/about:srcdoc으로 훼손하여 네이버가 차단하는 문제를 원천 해결합니다.
  // 부모 창의 실제 도메인 주소(http://localhost:8081)가 100% 온전하게 네이버에 송신되어 에러 없이 가동됩니다.
  useEffect(() => {
    if (Platform.OS !== 'web' || !locationModalVisible) return;

    // 1. 네이버 지도 API 스크립트 로드
    const loadNaverScript = () => {
      const existing = document.getElementById('naver-map-script-direct');
      if (existing) {
        // 스크립트 태그는 있지만 아직 로딩 중일 수 있음(모달 빠른 재오픈 등) — 로드 완료를 기다린 뒤 초기화
        if ((window as any).naver?.maps) {
          initNaverMapDirectly();
        } else {
          existing.addEventListener('load', initNaverMapDirectly, { once: true });
        }
        return;
      }

      const script = document.createElement('script');
      script.id = 'naver-map-script-direct';
      script.type = 'text/javascript';
      // 신규 NCP Maps API는 oapi 도메인 + ncpKeyId 파라미터로만 인증됨 (구 openapi/ncpClientId는 인증 실패 처리)
      script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NAVER_CLIENT_ID}`;
      script.onload = initNaverMapDirectly;
      script.onerror = () => {
        console.error("네이버 지도 로딩 실패: Leaflet으로 전환");
        initLeafletFallback();
      };
      document.head.appendChild(script);
    };

    // 2. 실제 DOM에 네이버 지도 생성 및 마킹
    const initNaverMapDirectly = () => {
      try {
        const container = document.getElementById('naver-map-container');
        if (!container) return;
        container.innerHTML = "";

        const naverObj = (window as any).naver;
        if (!naverObj || !naverObj.maps) {
          initLeafletFallback();
          return;
        }

        const map = new naverObj.maps.Map(container, {
          center: new naverObj.maps.LatLng(lat, lon),
          zoom: 14,
          zoomControl: false
        });

        // 내 매장 마커 마킹
        const shopMarker = new naverObj.maps.Marker({
          position: new naverObj.maps.LatLng(lat, lon),
          map: map,
          icon: {
            content: '<div style="width:16px;height:16px;background:#4E3629;border:3px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.3)"></div>',
            anchor: new naverObj.maps.Point(8, 8)
          }
        });

        const infoWindow = new naverObj.maps.InfoWindow({
          content: '<div style="padding:10px;min-width:140px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>📍 ' + shopLabel + '</b><br/>' + regionName + '</div>',
          borderWidth: 1,
          borderColor: '#8C6F56',
          borderRadius: 8,
          backgroundColor: '#FFFFFF',
          anchorSize: new naverObj.maps.Size(10, 10)
        });

        infoWindow.open(map, shopMarker);

        // 인근 축제 마커들 생성 (열린 정보창을 모아두었다가 지도 빈 곳 클릭 시 일괄 닫기)
        const eventWindows: any[] = [];
        nearbyEvents.forEach((e: any) => {
          if (e.lat && e.lon) {
            const eventMarker = new naverObj.maps.Marker({
              position: new naverObj.maps.LatLng(e.lat, e.lon),
              map: map,
              icon: {
                content: '<div style="width:12px;height:12px;background:#E28257;border:2.5px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3)"></div>',
                anchor: new naverObj.maps.Point(6, 6)
              }
            });

            const eWindow = new naverObj.maps.InfoWindow({
              content: '<div style="padding:10px;min-width:160px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>🎉 ' + e.name + '</b><br/>장소: ' + e.place + '<br/>거리: ' + e.distance_km + 'km<br/>날짜: ' + e.date + '</div>',
              borderWidth: 1,
              borderColor: '#E28257',
              borderRadius: 8,
              backgroundColor: '#FFFFFF'
            });
            eventWindows.push(eWindow);

            naverObj.maps.Event.addListener(eventMarker, "click", () => {
              if (eWindow.getMap()) {
                eWindow.close();
              } else {
                eWindow.open(map, eventMarker);
              }
            });
          }
        });

        // 지도 빈 곳을 클릭하면 열려 있는 행사 정보창을 모두 닫는다
        naverObj.maps.Event.addListener(map, "click", () => {
          eventWindows.forEach((w) => {
            if (w.getMap()) w.close();
          });
        });
      } catch (err) {
        console.error("네이버 지도 직접 초기화 중 에러, 폴백 가동:", err);
        initLeafletFallback();
      }
    };

    // 3. Leaflet.js 폴백 복원 함수
    const initLeafletFallback = () => {
      try {
        const container = document.getElementById('naver-map-container');
        if (!container) return;
        container.innerHTML = "";

        let existingCss = document.getElementById('leaflet-css-direct');
        if (!existingCss) {
          const link = document.createElement('link');
          link.id = 'leaflet-css-direct';
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }

        const startLeaflet = () => {
          const L = (window as any).L;
          if (!L) return;
          const map = L.map(container, { zoomControl: false }).setView([lat, lon], 14);
          
          L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
          }).addTo(map);

          const shopMarker = L.circleMarker([lat, lon], {
            color: '#4E3629',
            fillColor: '#8C6F56',
            fillOpacity: 1,
            radius: 8,
            weight: 3
          }).addTo(map);
          
          shopMarker.bindPopup("<div style='font-size:11px'><b>📍 " + shopLabel + "</b><br/>" + regionName + "</div>").openPopup();

          nearbyEvents.forEach((e: any) => {
            if (e.lat && e.lon) {
              L.circleMarker([e.lat, e.lon], {
                color: '#E28257',
                fillColor: '#FFFFFF',
                fillOpacity: 0.9,
                radius: 6,
                weight: 3.5
              }).addTo(map)
                .bindPopup("<div style='font-size:11px'><b>🎉 " + e.name + "</b><br/>장소: " + e.place + "<br/>거리: " + e.distance_km + "km<br/>날짜: " + e.date + "</div>");
            }
          });
        };

        const existingScript = document.getElementById('leaflet-js-direct');
        if (existingScript) {
          startLeaflet();
        } else {
          const script = document.createElement('script');
          script.id = 'leaflet-js-direct';
          script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
          script.onload = startLeaflet;
          document.head.appendChild(script);
        }
      } catch (err) {
        console.error("Leaflet 로딩 실패:", err);
      }
    };

    // 네이버 지도 인증 실패 전역 콜백 연결
    (window as any).navermap_authFailure = () => {
      console.warn("네이버 지도 인증 실패: 즉시 Leaflet 오픈 지도로 안전 전환합니다.");
      initLeafletFallback();
    };

    const timer = setTimeout(loadNaverScript, 50);
    return () => clearTimeout(timer);
  }, [locationModalVisible, lat, lon, regionName, shopLabel, serializedEvents, NAVER_CLIENT_ID]);

  return (
    <View style={styles.card}>
      {/* 헤더 영역 */}
      <View style={styles.headRow}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <SlidingTabToggle value={isMonthly} onChange={setIsMonthly} />
            {forecast?.location && (
              <PressableScale 
                onPress={() => setLocationModalVisible(true)} 
                style={styles.locationTag}
                to={0.95}
              >
                <Ionicons name="location" size={10.5} color={colors.mochaBrown} style={{ opacity: 0.8 }} />
                <Text style={styles.locationTagText}>
                  {forecast.location.region}
                </Text>
              </PressableScale>
            )}
          </View>
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
            {CALENDAR_ITEMS.map((item, idx) => {
              const hasData = item.date && SALES_DETAILS[item.date];
              const isFuture = item.date && (Number(item.date) >= 17 && Number(item.date) <= 23);
              return (
                <PressableScale 
                  key={idx} 
                  disabled={!hasData && !isFuture}
                  onPress={() => {
                    if (hasData) setSelectedDate(item.date);
                    else if (isFuture) setSelectedFutureDate(item.date);
                  }}
                  style={[
                    styles.calendarCell,
                    item.date === '15' && styles.calendarTodayCell,
                    isFuture && { backgroundColor: 'rgba(140, 111, 86, 0.04)' }, // 미래 예측일은 연한 브라운 틴트
                    !hasData && !isFuture && { opacity: 0.35 } // 매출 데이터도 없고 미래 예측도 불가능하면 옅게
                  ]}
                  to={0.9}
                >
                  <Text style={[
                    styles.calendarDateText,
                    item.date === '15' && styles.calendarTodayText,
                    isFuture && { color: colors.mochaBrown }
                  ]}>{item.date}</Text>
                  {item.income > 0 && (
                    <Text style={styles.calendarIncomeText}>
                      {/* [한글 주석: 사용자의 직관적인 '만' 단위 원복 요구 반영 (소수 첫째자리 내림 포맷)] */}
                      {`+${(item.income / 10000) % 1 === 0 ? item.income / 10000 : (Math.floor((item.income / 10000) * 10) / 10)}만`}
                    </Text>
                  )}
                  {isFuture && (
                    <Text style={[styles.calendarIncomeText, { color: colors.mochaBrown, fontSize: 7 }]}>
                      {futureForecasts[item.date] ? `+${futureForecasts[item.date].cups}잔` : '예측'}
                    </Text>
                  )}
                </PressableScale>
              );
            })}
          </View>
        </View>
      ) : (
        <View>
          {/* 오늘 / 내일 예측 범례 (Legend) */}
          <View style={styles.legendContainer}>
            <View style={styles.legendItem}>
              <View style={[styles.legendColorDot, { backgroundColor: colors.espressoBrown }]} />
              <Text style={styles.legendText}>오늘 실시간</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendColorDot, { backgroundColor: colors.mochaBrown, opacity: 0.5 }]} />
              <Text style={styles.legendText}>내일 AI 예측</Text>
            </View>

            {/* [브루] 예측 원인 설명 트리거 버튼 */}
            <PressableScale style={styles.brewCta} onPress={() => setShowBrew(true)} to={0.95}>
              <Ionicons name="cafe" size={12} color={colors.pointOrange} />
              <Text style={styles.brewCtaText}>예측 이유</Text>
            </PressableScale>
          </View>

          <View 
            style={styles.chartWrap}
            onLayout={(e) => setLayoutWidth(e.nativeEvent.layout.width)}
          >
            <Svg width="100%" height="120" viewBox="0 0 300 130" preserveAspectRatio="none">
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

              {/* 오늘 실시간 펄스 링 & 현재 시각 지점 */}
              <Circle cx={275} cy={todayY[3]} r={2.0} fill={colors.espressoBrown} />
              <Circle
                cx={275}
                cy={todayY[3]}
                r={pulseRadius * 0.7}
                fill={colors.espressoBrown}
                opacity={pulseOpacity * 0.5}
              />

              {/* 2. 내일 그래프 드로잉 (부드럽고 고급스러운 모카 브라운 미세 대시선) */}
              <Path d={forecastFillPath} fill="url(#tomorrowFill)" />
              <Path d={forecastLinePath} stroke={colors.mochaBrown} strokeWidth={1.2} strokeOpacity={0.38} strokeDasharray="1.2,2.0" fill="none" strokeLinecap="round" />

              {/* 내일 펄스 링 & 최종 예측 피크 점 */}
              <Circle cx={275} cy={tomorrowY[3]} r={2.0} fill={colors.mochaBrown} opacity={0.4} />
              <Circle
                cx={275}
                cy={tomorrowY[3]}
                r={pulseRadius * 0.6}
                fill={colors.mochaBrown}
                opacity={pulseOpacity * 0.3}
              />

              {/* 3. 오늘 데이터 포인트 (터치용 보이지 않는 큰 Circle 영역 포함, Y좌표 꺾은선 일치) */}
              {CHART_X.map((x, i) => (
                <G key={`today-pt-${i}`}>
                  <Circle cx={x} cy={todayY[i]} r={i === 3 ? 2.5 : 2.2} fill={colors.espressoBrown} />
                  <Circle
                    cx={x}
                    cy={todayY[i]}
                    r={14}
                    fill="transparent"
                    {...svgPress(() => setActiveTooltip({
                      x,
                      y: todayY[i],
                      title: i === 3 ? `오늘 ${hourLabel(axisHours[i])} 실시간` : `오늘 ${hourLabel(axisHours[i])}`,
                      value: `실제 ${todayCupsCum[i]}잔`,
                    }))}
                  />
                </G>
              ))}

              {/* 4. 내일 데이터 포인트 — 오늘과 같은 시간대의 예측 (뒤로 부드럽게 감도는 모카 브라운 톤) */}
              {CHART_X.map((x, i) => (
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
            <View style={styles.xAxis}>
              {axisHours.map((h, i) => (
                <Text
                  key={`axis-${h}`}
                  style={
                    i === 3
                      ? [styles.xAxisText, { color: colors.mochaBrown, fontWeight: '700' as const, opacity: 0.95 }]
                      : styles.xAxisText
                  }
                >
                  {i === 3 ? `${hourLabel(h)} (지금)` : hourLabel(h)}
                </Text>
              ))}
            </View>
          </View>
        </View>
      )}



      {/* 하단 요약 정보 그리드 */}
      <View style={styles.footRow}>
        <View style={styles.footItem}>
          <Text style={styles.footLabel}>{isMonthly ? '판매 잔' : '판매 잔 (오늘 / 내일예상)'}</Text>
          <Text style={styles.footValue}>
            {salesCount}
            {!isMonthly && forecast && (
              <Text style={{ fontSize: 11, color: colors.mochaBrown, fontWeight: 'normal' }}>
                {` / ${tomorrowCups}잔`}
              </Text>
            )}
          </Text>
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

      {/* [한글 주석: 통합형 주간 리포트 스마트 배너] 월간 모드일 때는 레이아웃 과밀을 피하기 위해 띄우지 않고, 일간 모드에서만 노출시킵니다 */}
      {onPressReport && !isMonthly && (
        <PressableScale onPress={onPressReport} style={styles.reportBanner}>
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '900', color: colors.espressoBrown }}>✉️ 브루의 주간 리포트 도착</Text>
              <View style={styles.reportLiveBadge}>
                <Text style={styles.reportLiveText}>NEW</Text>
              </View>
            </View>
            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.mochaBrown }}>
              매출 +8.2% · 원가율 주의 — 터치하여 편지 읽기
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
            {selectedDate && SALES_DETAILS[selectedDate] && (
              <View style={{ gap: 16 }}>
                {/* 헤더 */}
                <View style={styles.modalHeader}>
                  <Text style={styles.modalDateTitle}>7월 {selectedDate}일 매출 상세 리포트</Text>
                  <Pressable onPress={() => setSelectedDate(null)} style={{ padding: 4 }}>
                    <Ionicons name="close" size={22} color={colors.espressoBrown} />
                  </Pressable>
                </View>

                {/* 매출액 */}
                <View style={styles.modalIncomeBox}>
                  <Text style={styles.modalIncomeLabel}>일일 총매출액</Text>
                  <Text style={styles.modalIncomeValue}>
                    ₩ {SALES_DETAILS[selectedDate].income.toLocaleString()}
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
                      <Text style={styles.detailValue}>{SALES_DETAILS[selectedDate].popular}</Text>
                    </View>
                  </View>

                  <View style={styles.detailRow}>
                    <View style={styles.detailIconBg}>
                      <Ionicons name="people" size={16} color={colors.pointOrange} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailLabel}>방문 객수 / 피크 시간</Text>
                      <Text style={styles.detailValue}>
                        {SALES_DETAILS[selectedDate].customers}명 · 피크 {SALES_DETAILS[selectedDate].peak}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.detailRow}>
                    <View style={styles.detailIconBg}>
                      <Ionicons name="leaf" size={16} color={colors.pointOrange} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailLabel}>주요 원재료 소모량</Text>
                      <Text style={styles.detailValue}>{SALES_DETAILS[selectedDate].beans} (원두)</Text>
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
                    "{SALES_DETAILS[selectedDate].brewComment}"
                  </Text>
                </View>

                {/* 닫기 버튼 */}
                <PressableScale onPress={() => setSelectedDate(null)} style={styles.modalCloseBtn}>
                  <Text style={styles.modalCloseText}>확인</Text>
                </PressableScale>
              </View>
            )}
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
                  <Text style={styles.modalDateTitle}>7월 {selectedFutureDate}일 AI 판매량 예측</Text>
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

      {/* [한글 주석: 매장 위치 및 주변 행사 지리 분석 지도 모달] */}
      <Modal
        visible={locationModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setLocationModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setLocationModalVisible(false)} />
          <View style={[styles.modalContent, { width: '92%', maxWidth: 450, height: 420, padding: 0, overflow: 'hidden' }]}>
            {/* 헤더 */}
            <View style={[styles.modalHeader, { paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 0.8, borderBottomColor: 'rgba(140, 111, 86, 0.08)' }]}>
              <Text style={styles.modalDateTitle}>📍 매장 주변 지리 분석 지도</Text>
              <Pressable onPress={() => setLocationModalVisible(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </Pressable>
            </View>

            {/* 지도 본문 (웹 환경 대응 브라우저 표준 iframe) */}
            <View style={{ flex: 1, backgroundColor: '#F8F6F2', position: 'relative' }}>
              {Platform.OS === 'web' ? (
                <View
                  id="naver-map-container"
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                  <Ionicons name="map-outline" size={32} color={colors.mochaBrown} style={{ marginBottom: 8 }} />
                  <Text style={{ ...typography.L5, color: colors.mochaBrown, textAlign: 'center' }}>
                    웹 브라우저 환경에서 인터랙티브 실지도 분석 모드가 지원됩니다.
                  </Text>
                </View>
              )}
            </View>

            {/* 범례 및 안내 */}
            <View style={{ paddingVertical: 10, paddingHorizontal: 16, backgroundColor: 'rgba(140, 111, 86, 0.05)', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#8C6F56' }} />
                <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.espressoBrown }}>내 매장</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#E28257' }} />
                <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.espressoBrown }}>인근 행사 (3km)</Text>
              </View>
            </View>
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
    marginBottom: 16,
    marginTop: 14,
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

  toggleTrack: {
    width: 76,
    height: 28,
    borderRadius: 999,
    backgroundColor: 'rgba(140, 111, 86, 0.08)', // [iOS 스타일] 투명감 도는 탭 트랙
    position: 'relative',
    justifyContent: 'center',
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.04)',
  },
  toggleCapsule: {
    position: 'absolute',
    width: 36,
    height: 22,
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
    fontSize: 9,
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
  chartWrap: { marginTop: 16, height: 140, position: 'relative' },
  xAxis: {
    position: 'absolute',
    bottom: -10,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  xAxisText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.mochaBrown,
    opacity: 0.9,
  },

  footRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
    borderTopWidth: 0.8,
    borderTopColor: 'rgba(140, 111, 86, 0.08)',
    paddingTop: 12,
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
  locationTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 10,
  },
  locationTagText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.mochaBrown,
    opacity: 0.85,
  },
});
