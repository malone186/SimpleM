import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { useCountUp } from '../motion';
import { PressableScale } from '../motion';

// (삭제함 - Web 호환성을 위해 addListener + 일반 Circle을 사용하도록 개선)

// 차트 트렌드 라인 패스 정의 (원래의 부드럽고 정돈된 패스로 원상복구)
const LINE = 'M 10 90 C 60 85, 90 88, 130 80 C 170 72, 210 75, 250 62 L 290 50';
const FILL = `${LINE} L 290 100 L 10 100 Z`;

// 캘린더 요일 및 데이터 셋 (영어 대문자로 세련되게 전환)
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

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
  const [isMonthly, setIsMonthly] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null); // [한글 주석: 선택한 날짜의 상세 매출 분석 모달 노출 상태 변수]
  const targetValue = isMonthly ? 12480000 : 428500;
  const amount = useCountUp(targetValue, 1100, [isMonthly]);

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
            {CALENDAR_ITEMS.map((item, idx) => {
              const hasData = item.date && SALES_DETAILS[item.date];
              return (
                <PressableScale 
                  key={idx} 
                  disabled={!hasData}
                  onPress={() => hasData && setSelectedDate(item.date)}
                  style={[
                    styles.calendarCell,
                    item.date === '15' && styles.calendarTodayCell,
                    !hasData && { opacity: 0.35 } // 매출 데이터가 없는 비활성 날짜는 옅게 처리
                  ]}
                  to={0.9}
                >
                  <Text style={[
                    styles.calendarDateText,
                    item.date === '15' && styles.calendarTodayText
                  ]}>{item.date}</Text>
                  {item.income > 0 && (
                    <Text style={styles.calendarIncomeText}>
                      {/* [한글 주석: 사용자의 직관적인 '만' 단위 원복 요구 반영 (소수 첫째자리 내림 포맷)] */}
                      {`+${(item.income / 10000) % 1 === 0 ? item.income / 10000 : (Math.floor((item.income / 10000) * 10) / 10)}만`}
                    </Text>
                  )}
                </PressableScale>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.chartWrap}>
          <Svg width="100%" height="100" viewBox="0 0 300 100" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.mochaBrown} stopOpacity="0.12" />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
              </LinearGradient>
            </Defs>

            {/* 그리드 가로선 */}
            <Line x1="10" y1="20" x2="290" y2="20" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
            <Line x1="10" y1="50" x2="290" y2="50" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />
            <Line x1="10" y1="80" x2="290" y2="80" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="3,3" opacity="0.2" />

            {/* [한글 주석: 세로 보조 점선 눈금] 스크린샷 시안과 동일하게 시간대 텍스트 축에 맞춤 */}
            <Line x1="24" y1="90" x2="24" y2="82" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="2,2" opacity="0.3" />
            <Line x1="108" y1="90" x2="108" y2="76" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="2,2" opacity="0.3" />
            <Line x1="198" y1="90" x2="198" y2="60" stroke={colors.mutedSand} strokeWidth="1" strokeDasharray="2,2" opacity="0.3" />

            <Path d={FILL} fill="url(#salesFill)" />
            <Path d={LINE} stroke={colors.mochaBrown} strokeWidth={2} fill="none" strokeLinecap="round" />
            
            {/* 고정 피크 점 */}
            <Circle cx={290} cy={50} r={3} fill={colors.trendGreenText} />
            
            {/* 
              [한글 주석: Svg 내부 펄스 링] 
              cx={290}, cy={50} 좌표를 고정 피크 점과 완벽히 일치시켜
              화면 가로 폭 리사이징 시에도 단 0.1px의 엇갈림도 발생하지 않게 보장합니다.
            */}
            <Circle
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
    </View>
  );
}

const styles = StyleSheet.create({
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
});
