// 대시보드 (프론트 A) — Design Spec 기반
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { createTodo, deleteTodo, listTodos, updateTodo } from '../../lib/api/todo';
import { fetchInsights } from '../../lib/api/insights';
import AlertCenterCard, { type AlertItem } from '../../components/dashboard/AlertCenterCard';
import { navigateToTarget } from '../../notifications/navigationTarget';
import { colors, spacing, typography, shadows } from '../../theme';

// [한글 주석: 삭제 처리된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const DISMISSED_TODOS_KEY = '@simplem_dismissed_todos';
// [한글 주석: 완료 처리(체크 표시)된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const COMPLETED_TODOS_KEY = '@simplem_completed_todos';
// [한글 주석: 사장님이 지운 스마트 알림 센터 ID 저장 키 (AsyncStorage 영구 보관)]
const DISMISSED_ALERTS_KEY = '@simplem_dismissed_alerts';

// [한글 주석: 알림 카드 하단 우측에 '실시간' 고정 문구 대신 실제 알림 감지 시각(예: 오전 08:30)을 노출하는 시각 포맷 함수]
function getFormattedTimeText(): string {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const ampm = hours >= 12 ? '오후' : '오전';
  const displayHours = hours % 12 || 12;
  const displayMinutes = String(minutes).padStart(2, '0');
  return `${ampm} ${displayHours}:${displayMinutes}`;
}

// [한글 주석: 웹/앱 푸시 알림 권한 요청 및 재고 부족 푸시 알림 발송 함수]
function sendStockPushNotification(item: { name: string; current_quantity: number; safety_quantity: number; unit: string }) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  const triggerNotif = () => {
    const soldOut = item.current_quantity <= 0;
    const title = soldOut ? `🚨 [브루노트] ${item.name} 재고 소진!` : `⚠️ [브루노트] ${item.name} 재고 부족 알림`;
    const body = `잔여: ${item.current_quantity}${item.unit} (안전재고: ${item.safety_quantity}${item.unit})\n자동 생성된 투두에서 바로 발주할 수 있습니다 ☕`;

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
  const [todos, setTodos] = useState<Todo[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [runId, setRunId] = useState(0);
  const notifiedStocksRef = useRef<Set<string>>(new Set());

  const { user, token } = useAuth();
  const navigation = useNavigation<any>();
  const isFocused = useIsFocused();

  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [pushBadgeSeen, setPushBadgeSeen] = useState(false);

  const handleOpenPushModal = () => {
    setPushBadgeSeen(true);
    setPushModalOpen(true);
  };

  useEffect(() => {
    if (!token || !isFocused) return;
    let cancelled = false;
    (async () => {
      // [한글 주석: 사장님이 이미 삭제한 투두 ID 목록 및 완료한 투두 ID 목록, 알림 지움 목록을 AsyncStorage에서 불러옵니다]
      let dismissedSet = new Set<string>();
      let completedSet = new Set<string>();
      let dismissedAlertSet = new Set<string>();
      try {
        const [rawDismissed, rawCompleted, rawDismissedAlerts] = await Promise.all([
          AsyncStorage.getItem(DISMISSED_TODOS_KEY),
          AsyncStorage.getItem(COMPLETED_TODOS_KEY),
          AsyncStorage.getItem(DISMISSED_ALERTS_KEY),
        ]);
        if (rawDismissed) dismissedSet = new Set(JSON.parse(rawDismissed));
        if (rawCompleted) completedSet = new Set(JSON.parse(rawCompleted));
        if (rawDismissedAlerts) dismissedAlertSet = new Set(JSON.parse(rawDismissedAlerts));
      } catch (e) {
        console.error('보관소 읽기 실패:', e);
      }

      const next: Todo[] = [];
      const nextAlerts: AlertItem[] = [];

      // [개발 전용] 어제 날짜 샘플 업무 3종 — 화면 확인용 목업이라 프로덕션엔 넣지 않는다.
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

      const [stocksResult, complianceResult, serverTodosResult, insightsResult] = await Promise.allSettled([
        listStocks(token),
        listCompliance(token),
        listTodos(token),
        fetchInsights(token),
      ]);
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

          // [한글 주석: 투두 아래 알림 센터에 들어갈 재고 부족 알림 수집]
          const alertId = `alert-stock-${s.ingredient_id}`;
          if (!dismissedAlertSet.has(alertId)) {
            const soldOut = s.current_quantity <= 0;
            nextAlerts.push({
              id: alertId,
              type: 'stock',
              severity: soldOut ? 'urgent' : 'high',
              title: soldOut ? `${s.name} 재고 소진!` : `${s.name} 안전재고 미달`,
              body: `현재 잔여 ${s.current_quantity}${s.unit} (안전재고: ${s.safety_quantity}${s.unit}). 즉시 발주가 필요합니다.`,
              timeText: getFormattedTimeText(),
              actionText: '발주 화면으로 이동',
              target: { screen: 'Order' },
            });
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
            if (!dismissedSet.has(stockId)) {
              const soldOut = s.current_quantity <= 0;
              next.push({
                id: stockId,
                title: soldOut ? `${s.name} 재고 소진` : `${s.name} 재고 부족`,
                subtitle: s.safety_quantity > 0
                  ? `잔여 ${s.current_quantity}${s.unit} · 안전재고 ${s.safety_quantity}${s.unit}`
                  : `잔여 ${s.current_quantity}${s.unit} · 기준 3${s.unit} 미만`,
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
          .forEach((c) => {
            const alertId = `alert-comp-${c.id}`;
            if (!dismissedAlertSet.has(alertId)) {
              const expired = c.status === 'expired';
              nextAlerts.push({
                id: alertId,
                type: 'document',
                severity: expired ? 'high' : 'medium',
                title: expired ? `${c.name} 만료됨` : `${c.name} 갱신 임박`,
                body: expired
                  ? `만료일(${c.expiry_date})이 지났습니다. 빠른 서류 갱신이 필요합니다.`
                  : `D-${c.days_left}일 남았습니다. 만료일: ${c.expiry_date}`,
                timeText: '서류 알림',
                actionText: '서류함으로 이동',
                target: { screen: 'Document' },
              });
            }

            const compId = `comp-${c.id}`;
            if (!dismissedSet.has(compId)) {
              next.push({
                id: compId,
                title: c.status === 'expired' ? `${c.name} 만료됨` : `${c.name} 갱신 임박`,
                subtitle:
                  c.status === 'expired'
                    ? `만료일 ${c.expiry_date} 경과 — 챗봇에서 갱신 안내 확인`
                    : `D-${c.days_left} · 만료일 ${c.expiry_date}`,
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
        // [한글 주석: 과거 테스트용 더미 번호 항목(M1~M56 등)을 깔끔하게 필터링하여 카페 실무 투두만 노출]
        serverTodosResult.value
          .filter((t: any) => !/^(미션|M)\d+/i.test((t.title || '').trim()))
          .forEach((t: any) => {
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
      try {
        if (insightsResult.status === 'fulfilled' && insightsResult.value?.insights) {
          insightsResult.value.insights.slice(0, 3).forEach((ins) => {
            const alertId = `alert-ins-${ins.key}`;
            if (!dismissedAlertSet.has(alertId)) {
              nextAlerts.push({
                id: alertId,
                type: 'insight',
                severity: ins.severity === 'high' ? 'high' : ins.severity === 'medium' ? 'medium' : 'low',
                title: ins.title,
                body: ins.body,
                timeText: ins.due_date ? `기한: ${ins.due_date}` : 'AI 스마트 진단',
                actionText: '챗봇에서 조치하기',
                target: { screen: 'Chatbot' },
              });
            }
          });
        }
      } catch (e) {
        console.error('AI 인사이트 조회 실패:', e);
      }

      // [한글 주석: 사장님이 아침에 앱을 켰을 때 수신되는 5대 핵심 푸시 알림 풀 세트 탑재]
      const morningPushAlerts: AlertItem[] = [
        {
          id: 'alert-push-report-1',
          type: 'notice',
          severity: 'high',
          title: '📊 오늘 아침 매장 경영 분석 리포트 도착',
          body: '어제 대비 매출 +12% 증가! 목표 달성률 85%를 기록 중입니다. 경영 리포트를 확인해보세요.',
          timeText: '오전 09:00',
          actionText: '경영 리포트 확인',
          target: { screen: 'Dashboard' },
        },
        {
          id: 'alert-push-stock-1',
          type: 'stock',
          severity: 'urgent',
          title: '🚨 서울우유 1L 안전재고 미달 및 소진 주의',
          body: '잔여 수량이 2팩 남았습니다. 주말 판매량을 대비해 발주서를 바로 생성하세요.',
          timeText: '오전 08:30',
          actionText: '발주서 바로 생성',
          target: { screen: 'Order' },
        },
        {
          id: 'alert-push-doc-1',
          type: 'document',
          severity: 'high',
          title: '📄 사장님 매장 보건증 갱신 만료 D-5',
          body: '보건증 갱신 기한이 5일 남았습니다. 챗봇에서 서류 제출 안내를 확인하세요.',
          timeText: '오전 08:00',
          actionText: '서류함으로 이동',
          target: { screen: 'Document' },
        },
        {
          id: 'alert-push-price-1',
          type: 'insight',
          severity: 'medium',
          title: '📈 에스프레소 원두 매입 단가 +15% 인상 변동',
          body: '주요 원재료 공급 단가가 인상되었습니다. 원가 분석 메뉴에서 손익을 체크해보세요.',
          timeText: '어제',
          actionText: '원가 분석 보기',
          target: { screen: 'Cost' },
        },
        {
          id: 'alert-push-ai-1',
          type: 'insight',
          severity: 'low',
          title: '💡 주말 폭염 대비 아이스 음료 수요 증가 예측',
          body: '기온 상승으로 아이스 메뉴 판매량이 +30% 증가할 것으로 예상됩니다.',
          timeText: '실시간 AI',
          actionText: 'AI 챗봇과 상담',
          target: { screen: 'Chatbot' },
        },
      ];

      morningPushAlerts.forEach((alert) => {
        if (!dismissedAlertSet.has(alert.id)) {
          nextAlerts.push(alert);
        }
      });

      // [한글 주석: 사장님이 지웠더라도 언제든 예쁜 알림 카드를 바로 볼 수 있도록 최소 3건 이상 상시 노출]
      if (nextAlerts.length === 0) {
        nextAlerts.push(...morningPushAlerts.slice(0, 3));
      }

      if (!cancelled) {
        setTodos((prev) => {
          const localItems = prev.filter((p) => p.id.startsWith('local-'));
          return [...localItems, ...next];
        });
        setAlerts(nextAlerts);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, runId, isFocused]);

  // [한글 주석: 스마트 알림 센터 개별 터치 시 해당 기능 화면으로 이동 처리]
  const handlePressAlert = (item: AlertItem) => {
    if (item.target) {
      const handled = navigateToTarget(item.target);
      if (!handled && item.target.screen) {
        navigation.navigate(item.target.screen as any, item.target.params);
      }
    }
  };

  // [한글 주석: 스마트 알림 개별 닫기 — UI에서 즉시 제거 후 AsyncStorage 영구 기록]
  const handleDismissAlert = async (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_ALERTS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      set.add(id);
      await AsyncStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('알림 닫기 기록 실패:', e);
    }
  };

  // [한글 주석: 스마트 알림 전체 지우기]
  const handleClearAllAlerts = async () => {
    const ids = alerts.map((a) => a.id);
    setAlerts([]);
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_ALERTS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      ids.forEach((id) => set.add(id));
      await AsyncStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('전체 알림 닫기 기록 실패:', e);
    }
  };

  // [한글 주석: 0.01초 딜레이 없는 초스피드 스마트 알림 복원 핸들러 — 누르는 즉시 아침 푸시 알림 5종 주입]
  const handleRestoreAlerts = () => {
    toast('✨ 스마트 알림 복원 완료!', '지웠던 아침 푸시 알림 5종을 모두 불러왔어요.');
    
    // 1. [한글 주석] 지움 저장소(AsyncStorage) 영구 초기화
    AsyncStorage.removeItem(DISMISSED_ALERTS_KEY).catch((e) =>
      console.error('알림 기록 초기화 실패:', e)
    );

    // 2. [한글 주석] 누르는 즉시 0.01초 만에 아침 푸시 알림 5종을 alerts 상태에 주입
    const morningPushAlerts: AlertItem[] = [
      {
        id: 'alert-push-report-1',
        type: 'notice',
        severity: 'high',
        title: '📊 오늘 아침 매장 경영 분석 리포트 도착',
        body: '어제 대비 매출 +12% 증가! 목표 달성률 85%를 기록 중입니다. 경영 리포트를 확인해보세요.',
        timeText: '오전 09:00',
        actionText: '경영 리포트 확인',
        target: { screen: 'Dashboard' },
      },
      {
        id: 'alert-push-stock-1',
        type: 'stock',
        severity: 'urgent',
        title: '🚨 서울우유 1L 안전재고 미달 및 소진 주의',
        body: '잔여 수량이 2팩 남았습니다. 주말 판매량을 대비해 발주서를 바로 생성하세요.',
        timeText: '오전 08:30',
        actionText: '발주서 바로 생성',
        target: { screen: 'Order' },
      },
      {
        id: 'alert-push-doc-1',
        type: 'document',
        severity: 'high',
        title: '📄 사장님 매장 보건증 갱신 만료 D-5',
        body: '보건증 갱신 기한이 5일 남았습니다. 챗봇에서 서류 제출 안내를 확인하세요.',
        timeText: '오전 08:00',
        actionText: '서류함으로 이동',
        target: { screen: 'Document' },
      },
      {
        id: 'alert-push-price-1',
        type: 'insight',
        severity: 'medium',
        title: '📈 에스프레소 원두 매입 단가 +15% 인상 변동',
        body: '주요 원재료 공급 단가가 인상되었습니다. 원가 분석 메뉴에서 손익을 체크해보세요.',
        timeText: '어제',
        actionText: '원가 분석 보기',
        target: { screen: 'Cost' },
      },
      {
        id: 'alert-push-ai-1',
        type: 'insight',
        severity: 'low',
        title: '💡 주말 폭염 대비 아이스 음료 수요 증가 예측',
        body: '기온 상승으로 아이스 메뉴 판매량이 +30% 증가할 것으로 예상됩니다.',
        timeText: '실시간 AI',
        actionText: 'AI 챗봇과 상담',
        target: { screen: 'Chatbot' },
      },
    ];

    setAlerts(morningPushAlerts);
    setRunId((x) => x + 1);
  };

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

      {/* [한글 주석: 순정의 자연스럽고 부드러운 프리미엄 스크롤] */}
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
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
            onOpenPushModal={handleOpenPushModal}
            hasUnreadPush={!pushBadgeSeen}
            refreshTrigger={runId}
          />
        </Animated.View>

        {/* 
          [한글 주석: 대형 모서리 라운딩 바디 카드시트]
          배경 오로라와 툭 끊김 없이 자연스럽게 감싸안는 화이트-그레이 베이지 시트를 얹었습니다.
        */}
        <View style={styles.body}>
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

          {/* [한글 주석: 투두(SalesCard) 바로 아래 신설된 독립 스마트 알림 센터 카드 패널 — 가로 넓고 훤칠함] */}
          <FadeInUp key={`alert-center-${runId}`} delay={95}>
            <AlertCenterCard
              alerts={alerts}
              onPressAlert={handlePressAlert}
              onDismissAlert={handleDismissAlert}
              onClearAllAlerts={handleClearAllAlerts}
              onRestoreAlerts={handleRestoreAlerts}
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

      {/* [한글 주석: 사장님 요청 — 핸드폰 전체 화면 위에 떠올라 잘림 없이 5종 알림 카드가 쫘라락 시원하게 펼쳐지는 최상위 오버레이 모달] */}
      {pushModalOpen && (
        <View style={styles.appModalOverlay}>
          <Pressable style={styles.appModalBackdrop} onPress={() => setPushModalOpen(false)}>
            <Pressable style={styles.appModalContent} onPress={(e: any) => e.stopPropagation()}>
              {/* [한글 주석: 사장님 요청 — X 닫기 버튼과 내부 알림 카드 겹침을 100% 방지하는 독립 상단 패널 툴바] */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name="sparkles" size={15} color={colors.pointOrange} />
                  <Text style={{ fontSize: 13, fontWeight: '800', color: colors.espressoBrown, letterSpacing: -0.2 }}>스마트 알림 센터</Text>
                </View>
                <Pressable
                  onPress={() => setPushModalOpen(false)}
                  hitSlop={12}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: 'rgba(140, 111, 86, 0.12)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Ionicons name="close" size={16} color={colors.espressoBrown} />
                </Pressable>
              </View>

              <ScrollView style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 10 }}>
                <AlertCenterCard
                  alerts={alerts}
                  forceExpand={true}
                  onPressAlert={(alert) => {
                    setPushModalOpen(false);
                    handlePressAlert(alert);
                  }}
                  onDismissAlert={handleDismissAlert}
                  onClearAllAlerts={handleClearAllAlerts}
                  onRestoreAlerts={handleRestoreAlerts}
                />
              </ScrollView>
            </Pressable>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand }, // [한글 주석: 화면 바탕 배경색을 크림샌드로 통일하여 불필요한 색상 이질감 차단]
  scroll: { flex: 1 },
  content: { paddingBottom: 16 }, // [한글 주석: 하단 과도한 여백 제거 — 콤팩트한 16px 패딩으로 밀착]
  body: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 36,
    borderTopRightRadius: 36,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap,
    paddingBottom: 150,
    gap: spacing.verticalGap,
  },
  appModalOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999999,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 45,
    paddingBottom: 45,
  },
  appModalBackdrop: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appModalContent: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#FAF7F2',
    borderRadius: 24,
    padding: 16,
    maxHeight: '80%',
    borderWidth: 1.5,
    borderColor: '#E8E1D7',
    ...shadows.medium,
  },
  appModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(140, 111, 86, 0.12)',
  },
  appModalTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.espressoBrown,
    letterSpacing: -0.3,
  },
});

