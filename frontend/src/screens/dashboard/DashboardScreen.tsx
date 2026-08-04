// 대시보드 (프론트 A) — Design Spec 기반
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Filter, FeGaussianBlur } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import CardDepositCard from '../../components/dashboard/CardDepositCard';
import ManagementReportCard from '../../components/dashboard/ManagementReportCard';
import SalesCard from '../../components/dashboard/SalesCard';
import TodoList, { type Todo } from '../../components/dashboard/TodoList';
import WelcomeHeader from '../../components/dashboard/WelcomeHeader';
import BriefingButton from '../../components/voice/BriefingButton';
import VoiceCommandButton from '../../components/voice/VoiceCommandButton';
import { toast } from '../../components/toast';
import { FadeInUp, PressableScale } from '../../components/motion';
import { listCompliance } from '../../lib/api/documents';
import { listStocks } from '../../lib/api/inventory';
import { createTodo, deleteTodo, getAiTodoSuggestions, listTodos, updateTodo, type AiSuggestedTodo } from '../../lib/api/todo';
import { colors, spacing, typography, shadows } from '../../theme';
import { s, useBottomInset, useResponsive } from '../../theme/responsive';

// [한글 주석: 삭제 처리된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const DISMISSED_TODOS_KEY = '@simplem_dismissed_todos';
// [한글 주석: 완료 처리(체크 표시)된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const COMPLETED_TODOS_KEY = '@simplem_completed_todos';

// [한글 주석: 웹/앱 푸시 알림 권한 요청 및 재고 부족 푸시 알림 발송 함수]
function sendStockPushNotification(item: { name: string; current_quantity: number; safety_quantity: number; unit: string }) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  const triggerNotif = () => {
    const soldOut = item.current_quantity <= 0;
    // 투두와 같은 쉬운 말로 — '재고 소진'·'안전재고' 같은 용어는 쓰지 않는다
    const title = soldOut ? `🚨 ${item.name} 다 떨어졌어요` : `⚠️ ${item.name} 얼마 안 남았어요`;
    const need = item.safety_quantity > 0 ? item.safety_quantity : 3;
    const body = `${item.current_quantity}${item.unit} 남음 · 최소 ${need}${item.unit} 필요\n홈 할 일에서 바로 발주할 수 있어요 ☕`;

    try {
      new window.Notification(title, {
        body,
        icon: '/favicon.ico',
        tag: `stock-${item.name}`,
      });
    } catch (e) {
      console.warn('푸시 알림 발송 실패:', e);
    }
  };

  if (window.Notification.permission === 'granted') {
    triggerNotif();
  } else if (window.Notification.permission !== 'denied') {
    window.Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        triggerNotif();
      }
    });
  }
}

export default function DashboardScreen() {
  // [한글 주석] 하단 제스처 바 실측 높이 — 마지막 카드가 시스템 바에 물리지 않게
  const bottomInset = useBottomInset();
  // [한글 주석] 폴드 펼침·태블릿 판정 — 본문 폭 제한에 쓴다
  const { isWide, contentMaxWidth } = useResponsive();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [runId, setRunId] = useState(0);
  const notifiedStocksRef = useRef<Set<string>>(new Set());

  const { user, token } = useAuth();
  const navigation = useNavigation<any>();
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!token || !isFocused) return;
    let cancelled = false;
    (async () => {
      // [한글 주석: 사장님이 이미 삭제한 투두 ID 목록 및 완료한 투두 ID 목록을 AsyncStorage에서 불러옵니다]
      let dismissedSet = new Set<string>();
      let completedSet = new Set<string>();
      try {
        const [rawDismissed, rawCompleted] = await Promise.all([
          AsyncStorage.getItem(DISMISSED_TODOS_KEY),
          AsyncStorage.getItem(COMPLETED_TODOS_KEY),
        ]);
        if (rawDismissed) dismissedSet = new Set(JSON.parse(rawDismissed));
        if (rawCompleted) completedSet = new Set(JSON.parse(rawCompleted));
      } catch (e) {
        console.error('투두 보관소 읽기 실패:', e);
      }

      const next: Todo[] = [];

      // [개발 전용] 어제 날짜 샘플 업무 3종 — 화면 확인용 목업이라 프로덕션엔 넣지 않는다.
      // 예전엔 __DEV__ 가드가 없어 실제 사장님 홈에도 가짜 완료 업무 3건이 떴다.
      if (__DEV__) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

        const mockItems: Todo[] = [
          {
            id: 'mock-yesterday-1',
            title: '[일일업무] 에스프레소 머신 스팀 노즐 소독 및 마감',
            subtitle: '마감 전 스팀 소독 완결 · 정기 점검 완료',
            done: true,
            source: 'owner',
            dateKey: yesterdayKey,
          },
          {
            id: 'mock-yesterday-2',
            title: '[발주·재고] 서울우유 20L 입고 및 검수 완료',
            subtitle: '잔여 20L 채움 완료 · 입고 검수 완료',
            done: true,
            source: 'ai',
            dateKey: yesterdayKey,
          },
          {
            id: 'mock-yesterday-3',
            title: '[서류·행정] 7월 매장 지출 명세서 입고 점검',
            subtitle: '명세서 OCR 3건 정산 반영 완료',
            done: true,
            source: 'owner',
            dateKey: yesterdayKey,
          },
        ];

        mockItems.forEach((item) => {
          if (!dismissedSet.has(item.id)) {
            next.push({ ...item, done: completedSet.has(item.id) || item.done });
          }
        });
      }

      const [stocksResult, complianceResult, serverTodosResult, aiSuggestResult] = await Promise.allSettled([
        listStocks(token),
        listCompliance(token),
        listTodos(token),
        getAiTodoSuggestions(token),
      ]);

      // [브루 제안] 재고·판매 데이터로 만든 투두 — 제목은 "에티오피아 원두 발주"처럼
      // 짧은 라벨로, 숫자 근거("다 떨어짐 · 최소 5kg 필요")는 meta 줄로 나뉘어 온다.
      // 여기에 '홍보할 메뉴 고르기' 링크가 붙는 promo 항목이 하나 따라온다.
      // id는 stock-<재료id>/promo-main 으로 안정적이라 숨김(X)·완료 기록이 유지된다.
      const aiSuggested: AiSuggestedTodo[] =
        aiSuggestResult.status === 'fulfilled' ? aiSuggestResult.value.todos : [];
      const aiStockIds = new Set(
        aiSuggested.filter((s) => s.kind === 'stock').map((s) => s.id_hint),
      );

      aiSuggested.forEach((s) => {
        if (dismissedSet.has(s.id_hint)) return;
        next.push({
          id: s.id_hint,
          title: s.title,
          subtitle: s.subtitle,
          // 재고 항목만 근거 줄을 붙인다 — 홍보 항목은 아래에 '메뉴 고르기' 링크가 있어 중복
          meta: s.kind === 'stock' ? s.subtitle : undefined,
          urgentLabel: s.urgent ? '없음' : undefined,
          actionable: s.kind === 'stock',
          done: completedSet.has(s.id_hint),
          source: 'ai',
          ...(s.kind === 'promo' ? { action: 'marketing' as const, menu: s.menu ?? '' } : null),
        });
      });

      try {
        if (stocksResult.status === 'rejected') throw stocksResult.reason;
        const stocks = stocksResult.value;
        const lowStocks = stocks.filter((s) => s.current_quantity <= (s.safety_quantity > 0 ? s.safety_quantity : 3));

        lowStocks.forEach((s) => {
          const idStr = String(s.ingredient_id);
          if (!notifiedStocksRef.current.has(idStr)) {
            notifiedStocksRef.current.add(idStr);
            sendStockPushNotification(s);
          }
        });

        lowStocks
          .sort(
            (a, b) =>
              a.current_quantity / (a.safety_quantity || 1) -
              b.current_quantity / (b.safety_quantity || 1),
          )
          .slice(0, 4)
          .forEach((s) => {
            const stockId = `stock-${s.ingredient_id}`;
            // 브루 제안에 이미 들어간 재료는 중복으로 넣지 않는다
            if (aiStockIds.has(stockId)) return;
            if (!dismissedSet.has(stockId)) {
              const soldOut = s.current_quantity <= 0;
              // 브루 제안과 같은 형식·같은 쉬운 말로 ('안전재고' 같은 용어는 쓰지 않는다)
              const need = `최소 ${s.safety_quantity > 0 ? s.safety_quantity : 3}${s.unit} 필요`;
              const meta = soldOut
                ? `다 떨어짐 · ${need}`
                : `${s.current_quantity}${s.unit} 남음 · ${need}`;
              next.push({
                id: stockId,
                title: `${s.name} 발주`,
                subtitle: meta,
                meta,
                urgentLabel: soldOut ? '없음' : undefined,
                actionable: true,
                done: completedSet.has(stockId), // [한글 주석] 기존 완료 기록이 있으면 체크 상태 유지
                source: 'ai',
              });
            }
          });
      } catch (e) {
        console.error('재고 할 일 조회 실패:', e);
      }
      try {
        if (complianceResult.status === 'rejected') throw complianceResult.reason;
        const items = complianceResult.value;
        items
          .filter((c) => c.status !== 'ok')
          .slice(0, 2)
          .forEach((c) => {
            const compId = `comp-${c.id}`;
            if (!dismissedSet.has(compId)) {
              const expired = c.status === 'expired';
              const compMeta = expired
                ? `기한 지남 · ${c.expiry_date}까지였어요`
                : `${c.days_left}일 남음 · ${c.expiry_date}까지`;
              next.push({
                id: compId,
                title: expired ? `${c.name} 갱신` : `${c.name} 갱신 준비`,
                subtitle: compMeta,
                meta: compMeta,
                urgentLabel: expired ? '지남' : undefined,
                actionable: false,
                done: completedSet.has(compId), // [한글 주석] 기존 완료 기록이 있으면 체크 상태 유지
                source: 'ai',
              });
            }
          });
      } catch (e) {
        console.error('서류 갱신 할 일 조회 실패:', e);
      }
      try {
        if (serverTodosResult.status === 'rejected') throw serverTodosResult.reason;
        serverTodosResult.value.forEach((t: any) => {
          const serverIdStr = `server-${t.id}`;
          if (!dismissedSet.has(serverIdStr)) {
            const parsedKey = t.date_key || (t.created_at ? t.created_at.split('T')[0] : undefined);
            next.push({
              id: serverIdStr,
              title: t.title,
              subtitle:
                t.note && t.note !== '브루가 추가함'
                  ? t.note
                  : t.source === 'ai'
                    ? '대화 중 추가됨'
                    : '사장님 직접 추가',
              actionable: false,
              done: completedSet.has(serverIdStr) || t.done,
              source: t.source,
              dateKey: parsedKey,
            });
          }
        });
      } catch (e) {
        console.error('할 일 조회 실패:', e);
      }
      if (!cancelled) {
        setTodos((prev) => {
          const localItems = prev.filter((p) => p.id.startsWith('local-'));
          return [...localItems, ...next];
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, runId, isFocused]);

  // 홈 헤더 마스코트 — 모자 쓰고 커피 든 바리스타 브루(brew_top)
  const brewMood = 'top';
  const scrollY = useRef(new Animated.Value(0)).current;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setRunId((x) => x + 1);
      setRefreshing(false);
    }, 650);
  }, []);

  /** 서버에 저장된 할 일인지 — 재고·서류에서 자동 도출된 항목은 서버에 없다 */
  const serverIdOf = (id: string): number | null =>
    id.startsWith('server-') ? Number(id.slice('server-'.length)) : null;

  // 아래 핸들러들은 화면을 먼저 바꾸고(낙관적) 서버에 반영한다.
  const resync = () => setRunId((x) => x + 1);

  const handleAddTodo = async (title: string, dateKey?: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;

    const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    const targetKey = dateKey || todayStr;
    const tempLocalId = `local-${Date.now()}`;

    const newTodo: Todo = {
      id: tempLocalId,
      title: trimmed,
      subtitle: '사장님 직접 추가',
      actionable: false,
      done: false,
      dateKey: targetKey,
      source: 'owner',
    };

    setTodos((prev) => [newTodo, ...prev]);

    if (token) {
      try {
        const created = await createTodo(token, trimmed);
        const realServerId = `server-${created.id}`;
        // [한글 주석] 서버 등록 완료 후 local- ID를 server- ID로 교체하여 삭제 시 서버 연동이 정상 동작하게 함
        setTodos((prev) =>
          prev.map((t) => (t.id === tempLocalId ? { ...t, id: realServerId } : t))
        );
      } catch (e) {
        console.error('할 일 추가 실패:', e);
      }
    }
  };

  const handleEditTodo = async (id: string, newTitle: string) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, title: newTitle } : t)));

    const serverId = serverIdOf(id);
    if (serverId === null || !token) return; // 자동 도출 항목 — 서버에 보낼 것이 없다
    try {
      await updateTodo(token, serverId, { title: newTitle });
    } catch (e) {
      console.error('할 일 수정 실패:', e);
      resync();
    }
  };

  const handleDeleteTodo = async (id: string) => {
    // 1. [한글 주석] 화면 상태에서 즉시 삭제
    setTodos((prev) => prev.filter((t) => t.id !== id));

    // 2. [한글 주석] 삭제된 항목의 ID를 AsyncStorage에 추가하여 탭 이동 후 재생성되는 현상을 방지
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_TODOS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      set.add(id);
      await AsyncStorage.setItem(DISMISSED_TODOS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('삭제 항목 영구 보관 실패:', e);
    }

    // 3. [한글 주석] 서버 DB 항목인 경우 서버에서도 삭제 API 호출
    const serverId = serverIdOf(id);
    if (serverId !== null && token) {
      try {
        await deleteTodo(token, serverId);
      } catch (e) {
        console.error('할 일 삭제 실패:', e);
        resync();
      }
    }
  };

  // [한글 주석: 0.01초 딜레이 없는 초스피드 브루 추천 복원 핸들러 — 누르는 즉시 즉각 반응]
  const handleRestoreAiTodos = () => {
    toast('✨ 브루 추천 복원 완료!', '삭제했던 브루의 업무 추천을 불러왔어요.');
    setRunId((x) => x + 1);
    AsyncStorage.removeItem(DISMISSED_TODOS_KEY).catch((e) =>
      console.error('브루 추천 복원 실패:', e),
    );
  };

  const toggleDone = async (id: string) => {
    // 다음 상태를 지금 값에서 직접 계산한다 — setTodos 콜백 안에서 읽으면
    // 서버로 보낼 값과 화면 값이 어긋날 수 있다
    const nextDone = !todos.find((t) => t.id === id)?.done;
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: nextDone } : t)));

    // [한글 주석] 완료(done) 상태 변경 시 기기 보관소(AsyncStorage)에 영구 저장하여 자동 갱신 시에도 체크가 풀리지 않게 보정
    try {
      const raw = await AsyncStorage.getItem(COMPLETED_TODOS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      if (nextDone) {
        set.add(id);
      } else {
        set.delete(id);
      }
      await AsyncStorage.setItem(COMPLETED_TODOS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('완료 상태 보관소 저장 실패:', e);
    }

    const serverId = serverIdOf(id);
    if (serverId === null || !token) return;
    try {
      await updateTodo(token, serverId, { done: nextDone });
    } catch (e) {
      console.error('할 일 완료 처리 실패:', e);
      resync();
    }
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
              <Stop offset="60%" stopColor="#6E5544" stopOpacity="0.35" />
              {/* 하단 25%는 완전 불투명 크림 — 바운스로 배경이 드러나도 갈색이 비치지 않게 */}
              <Stop offset="75%" stopColor={colors.creamSand} />
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

      {/* [한글 주석: UI 카드 아래로 텅 빈 여백이 무한정 스크롤되어 내려가는 현상을 막기 위해 오버스크롤 제한 지정] */}
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + s(16) }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
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
            mood={brewMood}
            onOpenMap={() => navigation.navigate('StoreMap')}
            refreshTrigger={runId}
          />
        </Animated.View>

        {/* 
          [한글 주석: 대형 모서리 라운딩 바디 카드시트]
          배경 오로라와 툭 끊김 없이 자연스럽게 감싸안는 화이트-그레이 베이지 시트를 얹었습니다.
        */}
        {/* [한글 주석] 하단 여백 = 탭 바(≈72) + 기기 제스처 바 실측값.
            예전 고정 150은 홈 인디케이터 없는 기기에서 과했고, 큰 제스처 바에서는 모자랐다 */}
        <View
          style={[
            styles.body,
            { paddingBottom: s(72) + bottomInset + s(24) },
            // [한글 주석] 폴드를 펼치면 673dp라 카드가 가로로 늘어져 읽기 나쁘다 → 폭을 묶고 가운데 정렬
            isWide && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
        >
          <FadeInUp key={`sales-${runId}`} delay={80}>
            <SalesCard
              key={`salescard-${runId}`}
              todos={todos}
              onPressTodo={() => {}}
              onToggleDone={toggleDone}
              onAddTodo={handleAddTodo}
              onEditTodo={handleEditTodo}
              onDeleteTodo={handleDeleteTodo}
              onRestoreAiTodos={handleRestoreAiTodos}
            />
          </FadeInUp>

          {/* 카드 대금 입금 예정 — 카드사마다 입금일이 달라 직접 세기 번거로운 숫자 */}
          <FadeInUp key={`deposit-${runId}`} delay={110}>
            <CardDepositCard key={`depositcard-${runId}`} />
          </FadeInUp>

          {/* AI 경영 리포트 — 일간/주간/월간 탭을 누르면 홈에서 바로 보인다 */}
          <FadeInUp key={`report-${runId}`} delay={140}>
            <ManagementReportCard key={`reportcard-${runId}`} />
          </FadeInUp>


        </View>
      </Animated.ScrollView>

      {/* [한글 주석: 홈 화면(대시보드) 전용 음성 비서 브리핑 및 마이크 플로팅 버튼 배치] */}
      <BriefingButton />
      <VoiceCommandButton />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand }, // [한글 주석: 화면 바탕 배경색을 크림샌드로 통일하여 불필요한 색상 이질감 차단]
  scroll: { flex: 1 },
  content: { paddingBottom: 16 }, // [한글 주석: 하단 과도한 여백 제거 — 콤팩트한 16px 패딩으로 밀착]
  body: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: s(36),
    borderTopRightRadius: s(36),
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap,
    // [한글 주석] paddingBottom 은 Dashboard 안에서 하단 탭 바 + 제스처 바 실측값으로 덮어쓴다
    gap: spacing.verticalGap,
  },
});

