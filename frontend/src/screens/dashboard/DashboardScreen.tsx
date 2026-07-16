// 대시보드 (프론트 A) — Design Spec 기반
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, RefreshControl, StyleSheet, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import ManagementReportCard from '../../components/dashboard/ManagementReportCard';
import QuickOrderModal from '../../components/dashboard/QuickOrderModal';
import SalesCard from '../../components/dashboard/SalesCard';
import TodoList, { type Todo } from '../../components/dashboard/TodoList';
import WelcomeHeader from '../../components/dashboard/WelcomeHeader';
import { FadeInUp } from '../../components/motion';
import { colors, spacing } from '../../theme';

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

  // 오늘 상태 → 브루 표정 (매출 상승 = 활짝 웃는 브루)
  const brewMood = 'happy';
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

  const confirmOrder = (todo: Todo) => {
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, done: true } : t)));
    setSelected(null);
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

        <View style={styles.body}>
          <FadeInUp key={`sales-${runId}`} delay={80}>
            <SalesCard key={`salescard-${runId}`} />
          </FadeInUp>

          {/* AI 경영 리포트 — 일간/주간/월간 탭을 누르면 홈에서 바로 보인다
              (runId 키로 당겨서 새로고침 시 리마운트 → 최신 수치 재조회) */}
          <FadeInUp key={`report-${runId}`} delay={140}>
            <ManagementReportCard key={`reportcard-${runId}`} />
          </FadeInUp>

          <FadeInUp key={`todo-${runId}`} delay={200}>
            <TodoList todos={todos} onPressAction={openOrder} />
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
  root: { flex: 1, backgroundColor: colors.creamSand },
  scroll: { flex: 1 },
  content: { paddingBottom: 40 },
  body: {
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap,
    gap: spacing.verticalGap,
  },
});

