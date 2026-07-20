// 대시보드 (프론트 A) — Design Spec 기반
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Filter, FeGaussianBlur } from 'react-native-svg';

import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import ManagementReportCard from '../../components/dashboard/ManagementReportCard';
import QuickOrderModal from '../../components/dashboard/QuickOrderModal';
import SalesCard from '../../components/dashboard/SalesCard';
import TodoList, { type Todo } from '../../components/dashboard/TodoList';
import WelcomeHeader from '../../components/dashboard/WelcomeHeader';
import { FadeInUp, PressableScale } from '../../components/motion';
import { colors, spacing, typography, shadows } from '../../theme';

const INITIAL_TODOS: Todo[] = [
  {
    id: 'beans',
    title: '원두 재고 부족',
    subtitle: '에티오피아 예가체프 · 안전재고 미달',
    actionable: true,
  },
  {
    id: 'milk',
    title: '우유 소진 임박',
    subtitle: '서울우유 1L · 잔여 3팩',
    actionable: true,
  },
  {
    id: 'report',
    title: '주간 리포트 도착',
    subtitle: '이번 주 원가율 +3%p — 챗봇에서 확인',
    actionable: false,
  },
];

export default function DashboardScreen() {
  const [todos, setTodos] = useState<Todo[]>(INITIAL_TODOS);
  const [selected, setSelected] = useState<Todo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [runId, setRunId] = useState(0);

  const { user } = useAuth();
  const navigation = useNavigation<any>();
  const isFocused = useIsFocused();

  // 홈 헤더 마스코트 — 모자 쓰고 커피 든 바리스타 브루(brew_top)
  const brewMood = 'top';
  const scrollY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isFocused) setRunId((x) => x + 1); // 탭 돌아올 때 재생
  }, [isFocused]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setRunId((x) => x + 1);
      setRefreshing(false);
    }, 650);
  }, []);

  const openOrder = (todo: Todo) => {
    if (!todo.actionable || todo.done) return;
    setSelected(todo);
  };

  // [한글 주석: 직접 발주 안내 Alert 처리]
  // 오너가 외부 공급처에서 직접 주문하도록 안내 팝업을 띄우고, 확인 클릭 시 할 일 목록에서 해당 항목을 완료(done) 처리합니다.
  const confirmOrder = (todo: Todo) => {
    Alert.alert(
      '직접 발주 안내',
      '앱 내 직접 발주 기능은 지원하지 않습니다. 외부 공급처를 통해 별도로 주문해주시기 바랍니다.\n\n발주 완료 후 재료의 재고 수량은 [재고] 탭에서 수동으로 업데이트해주세요.',
      [
        {
          text: '확인',
          onPress: () => {
            setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, done: true } : t)));
            setSelected(null);
          },
        },
      ]
    );
  };

  // 스크롤에 따라 헤더가 반 속도로 따라오는 패럴럭스 + 부드러운 페이드
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 300],
    outputRange: [0, 140],
    extrapolateLeft: 'clamp',
  });
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 180],
    outputRange: [1, 0.35],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.root}>
      {/* 
        [한글 주석: 전역 오로라 배경]
        헤더 내에 갇혀 끊겨 보이던 오로라 가우시안 블러 배경을 스크린 전역 백그라운드로 배치했습니다.
      */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            {/* [한글 주석: 수직 오로라 그라데이션] 상단은 딥 브라운이나 아래로 갈수록 바디 시트 색상(creamSand)으로 자연스럽게 녹아듭니다 */}
            <LinearGradient id="auroraGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor="#1E1612" />
              <Stop offset="35%" stopColor="#251C17" />
              <Stop offset="70%" stopColor="#6E5544" stopOpacity="0.35" />
              <Stop offset="100%" stopColor={colors.creamSand} />
            </LinearGradient>
            
            <Filter id="auroraGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="70" />
            </Filter>
          </Defs>
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#auroraGrad)" />
          {/* 글로우 원들을 상부 웰컴 영역에만 배치하여 하부 화이트 카드 부근엔 맑게 스며들도록 함 */}
          <Circle cx="85%" cy="12%" r="140" fill="#E28257" filter="url(#auroraGlow)" opacity="0.25" />
          <Circle cx="15%" cy="22%" r="130" fill="#C29D7A" filter="url(#auroraGlow)" opacity="0.2" />
          <Circle cx="60%" cy="4%" r="120" fill="#88BCB5" filter="url(#auroraGlow)" opacity="0.16" />
        </Svg>
      </View>

      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.mochaBrown}
            colors={[colors.pointOrange]}
          />
        }
      >
        <Animated.View
          style={{ transform: [{ translateY: headerTranslate }], opacity: headerOpacity }}
        >
          <WelcomeHeader
            storeName={user?.name || '포자카페'}
            photo={user?.photo}
            mood={brewMood}
            onOpenProfile={() => navigation.navigate('Profile')}
          />
        </Animated.View>

        {/* 
          [한글 주석: 대형 모서리 라운딩 바디 카드시트]
          배경 오로라와 툭 끊김 없이 자연스럽게 감싸안는 화이트-그레이 베이지 시트를 얹었습니다.
        */}
        <View style={styles.body}>
          <FadeInUp key={`sales-${runId}`} delay={80}>
            {/* [한글 주석: todos 리스트와 발주 액션 핸들러를 SalesCard에 전달하여 탭 전환 시 할 일 목록이 노출되도록 연동합니다] */}
            <SalesCard
              key={`salescard-${runId}`}
              todos={todos}
              onPressTodo={openOrder}
            />
          </FadeInUp>

          {/* AI 경영 리포트 — 일간/주간/월간 탭을 누르면 홈에서 바로 보인다
              (runId 키로 당겨서 새로고침 시 리마운트 → 최신 수치 재조회) */}
          <FadeInUp key={`report-${runId}`} delay={140}>
            <ManagementReportCard key={`reportcard-${runId}`} />
          </FadeInUp>
        </View>
      </Animated.ScrollView>

      <QuickOrderModal
        visible={selected !== null}
        todo={selected}
        onClose={() => setSelected(null)}
        onConfirm={confirmOrder}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1E1612' }, // Svg 로딩 지연 중 어두운 광원을 채우기 위한 딥 브라운 지정
  scroll: { flex: 1 },
  content: { paddingBottom: 0 }, // [한글 주석: 여백 컬러 단절 버그 패치] content 패딩을 없애고 body 패딩으로 통합하여 갈색 띠 노출 차단
  body: {
    backgroundColor: colors.creamSand, // 원래 100% 불투명 오프화이트로 원복
    borderTopLeftRadius: 36, // [iOS 스타일] 부드럽게 얹어지는 시트
    borderTopRightRadius: 36,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap, // 원래 패딩값으로 복원
    paddingBottom: 110, // [한글 주석: 하단 탭 바 가림 방지 여백 확보] 원래 48에서 110으로 확장하여 탭 바 위로 부드럽게 스크롤되도록 조율
    gap: spacing.verticalGap,
  },
});

