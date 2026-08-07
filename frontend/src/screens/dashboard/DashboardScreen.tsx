// 대시보드 (프론트 A) — Design Spec 기반
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { createTodo, deleteTodo, getAiTodoSuggestions, listTodos, updateTodo, type AiSuggestedTodo } from '../../lib/api/todo';
import { fetchInsights } from '../../lib/api/insights';
import { getSalesForecast, getStoredStoreLocation, type SalesForecast } from '../../lib/api/forecast';
import { isNotable, moodFromForecast } from '../../components/brew/forecastMood';
import { loadCache, markAllStale, peekCache, saveCache } from '../../lib/cache';
import { awardDerivedTodo } from '../../lib/api/rewards';
import AlertCenterCard, { type AlertItem } from '../../components/dashboard/AlertCenterCard';
import { navigateToTarget } from '../../notifications/navigationTarget';
import RoomBackdrop, { useSheetTop } from '../../components/brew/RoomBackdrop';
import { getRoomTint } from '../../components/brew/roomBackgrounds';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, spacing, typography, shadows } from '../../theme';
import { s, useBottomInset, useResponsive } from '../../theme/responsive';

// [한글 주석: 삭제 처리된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const DISMISSED_TODOS_KEY = '@simplem_dismissed_todos';
// [한글 주석: 완료 처리(체크 표시)된 투두 항목 ID 저장 키 (AsyncStorage 영구 보관)]
const COMPLETED_TODOS_KEY = '@simplem_completed_todos';
// [한글 주석: 사장님이 지운 스마트 알림 센터 ID 저장 키 (AsyncStorage 영구 보관)]
const DISMISSED_ALERTS_KEY = '@simplem_dismissed_alerts';

// 방금 만든 할 일을 서버 목록이 따라올 때까지 화면에 붙들어 두는 시간.
// 조회 캐시가 60초라 그보다 조금만 길게 — 더 길면 서버에서 사라진 줄이 화면에만 남는다.
const PENDING_KEEP_MS = 90_000;

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

/** 오늘 날짜 키 (YYYY-MM-DD, 기기 시간대 기준) */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO 타임스탬프 → 기기 시간대의 YYYY-MM-DD.
 * created_at은 UTC라 split('T')[0]로 자르면 'UTC의 날짜'가 나온다 — KST 00:00~08:59에
 * 추가한 할 일(아침 오픈 준비 시간대)이 어제 키로 분류돼 오늘 탭에서 사라지는 버그의 원인. */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.split('T')[0];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 같은 일인지 판정하기 위한 제목 정규화 — 앞머리 태그·공백·'~하기' 어미를 걷어낸다.
 * (백엔드 todo_service._normalize_title과 같은 규칙)
 */
function normalizeTitle(title: string): string {
  const t = (title || '').replace(/^\[[^\]]{1,8}\]\s*/, '').replace(/\s+/g, '');
  return t.endsWith('하기') ? t.slice(0, -2) : t;
}

// ── 체크(완료) 표시는 '오늘 것'만 살린다 ──
// 재고·서류처럼 자동으로 만들어지는 줄은 id가 날마다 같다(stock-64). 날짜를 안 따지면
// 어제 체크한 발주가 오늘도 체크된 채로 떠서 이미 한 일처럼 보인다.
// 보관 형식은 { id: 'YYYY-MM-DD' } — 예전 형식(id 배열)은 오늘 것으로 받아들이고 넘어간다.
function parseCompletedMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const today = todayKey();
      return Object.fromEntries(parsed.map((id: string) => [id, today]));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function todayCompletedSet(raw: string | null): Set<string> {
  const today = todayKey();
  return new Set(
    Object.entries(parseCompletedMap(raw))
      .filter(([, day]) => day === today)
      .map(([id]) => id),
  );
}

// 날짜는 '2026-08-09'가 아니라 '8월 9일'로 — 알림은 훑어보는 글이라 숫자를 세게 하지 않는다
function formatKoreanDate(iso?: string): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  return `${Number(m)}월 ${Number(d)}일`;
}

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

// 홈을 채우는 다섯 갈래 응답. 캐시로 먼저 채워지고, 서버 응답이 오는 대로 갈아 끼워진다.
type DashboardSources = {
  stocks?: Awaited<ReturnType<typeof listStocks>>;
  compliance?: Awaited<ReturnType<typeof listCompliance>>;
  serverTodos?: Awaited<ReturnType<typeof listTodos>>;
  insights?: Awaited<ReturnType<typeof fetchInsights>>;
  aiSuggest?: Awaited<ReturnType<typeof getAiTodoSuggestions>>;
  // 브루 표정을 정하는 데만 쓴다 — 할 일·알림은 만들지 않는다 (forecastMood.ts).
  // null이면 '판단할 근거가 없음'(판매 기록 14일 미만 등) → 평소 포즈를 유지한다.
  forecast?: SalesForecast | null;
};

// 사장님이 지우거나 완료 표시한 항목 — 기기에만 남는 기록
type DashboardPrefs = {
  dismissed: Set<string>;
  completed: Set<string>;
  dismissedAlerts: Set<string>;
};

// 이 시간 안에 받아 둔 값이면 탭을 다시 열어도 서버를 다시 부르지 않는다.
// 인사이트·AI 제안은 서버가 매장 전체를 훑는 7초짜리 계산이라(그리고 시간 단위로만
// 바뀌는 정보라) 더 길게 잡는다 — 60초로 두면 탭을 오갈 때마다 서버가 그 계산을 다시 한다.
const FRESH_ENOUGH_MS = 60_000;
const SOURCE_FRESH_MS: Record<string, number> = {
  'dash:insights': 10 * 60_000,
  'dash:ai-suggestions': 10 * 60_000,
  // 예측은 날씨·행사가 바뀌어야 달라진다 — 탭을 오갈 때마다 다시 부를 이유가 없고,
  // 브루 표정이 몇 초 만에 기뻤다 슬펐다 하면 그게 더 이상하다.
  'dash:forecast': 30 * 60_000,
};

// 지난번 응답을 담아 두는 칸 이름 (lib/cache.ts가 앞에 접두어를 붙인다)
const CACHE_KEYS = {
  stocks: 'dash:stocks',
  compliance: 'dash:compliance',
  serverTodos: 'dash:todos',
  insights: 'dash:insights',
  aiSuggest: 'dash:ai-suggestions',
  forecast: 'dash:forecast',
} as const;

/**
 * 받은 응답들로 할 일·알림 목록을 만든다.
 *
 * 순수 함수로 빼 둔 이유: 캐시로 한 번, 서버 응답이 도착할 때마다 또 한 번 —
 * 같은 조립을 여러 번 돌려야 하기 때문이다. (예전에는 다섯 응답을 모두 기다린 뒤
 * 딱 한 번만 조립해서, 가장 느린 인사이트 7초 동안 홈이 통째로 비어 있었다)
 */
function buildDashboard(
  sources: DashboardSources,
  prefs: DashboardPrefs,
): { todos: Todo[]; alerts: AlertItem[] } {
  const { dismissed: dismissedSet, completed: completedSet, dismissedAlerts: dismissedAlertSet } = prefs;
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

  // [브루 제안] 재고·판매 데이터로 만든 투두 — 제목은 "에티오피아 원두 발주"처럼
  // 짧은 라벨로, 숫자 근거("다 떨어짐 · 최소 5kg 필요")는 meta 줄로 나뉘어 온다.
  // 여기에 '홍보할 메뉴 고르기' 링크가 붙는 promo 항목이 하나 따라온다.
  // id는 stock-<재료id>/promo-main 으로 안정적이라 숨김(X)·완료 기록이 유지된다.
  const aiSuggested: AiSuggestedTodo[] = sources.aiSuggest?.todos ?? [];
  // 브루가 이미 다루는 재료 — 아래 재고 블록이 같은 '<재료명> 발주' 줄을 또 만들지 않게 막는다.
  // 두 갈래를 모두 본다: 부족 재고 항목(stock-<재료id>)과 소진 예측 인사이트
  // (insight-stock_runout:<재료id>:<날짜>). 예전엔 앞의 것만 봐서, 브루가 상위 4개에서
  // 밀어낸 재료를 소진 예측으로 다시 얹으면 '바닐라 시럽 발주'가 두 줄로 떴다.
  const aiStockIds = new Set<string>();
  aiSuggested.forEach((s) => {
    if (s.kind === 'stock') {
      aiStockIds.add(s.id_hint);
      return;
    }
    const runout = /^insight-stock_runout:(\d+):/.exec(s.id_hint);
    if (runout) aiStockIds.add(`stock-${runout[1]}`);
  });
  // 서류 갱신은 인사이트도 만들고 아래 compliance 블록도 만든다 → 한 서류가 두 줄로 뜬다.
  // 인사이트 키가 `insight-renewal:<서류id>:<만료일>`이라 여기서 서류 id만 뽑아 막는다.
  const aiRenewalDocIds = new Set(
    aiSuggested
      .filter((s) => s.kind === 'insight' && s.id_hint.startsWith('insight-renewal:'))
      .map((s) => s.id_hint.split(':')[1]),
  );

  aiSuggested.forEach((s) => {
    if (dismissedSet.has(s.id_hint)) return;
    next.push({
      id: s.id_hint,
      title: s.title,
      subtitle: s.subtitle,
      // 홍보 항목만 근거 줄을 뺀다 — 아래에 '메뉴 고르기' 링크가 있어 중복이라서
      meta: s.kind === 'promo' ? undefined : s.subtitle,
      urgentLabel: s.urgent ? '급함' : undefined,
      // 눌러서 갈 곳이 있는 항목만 눌리게 한다 — 재고는 그 재료 화면, 메뉴 개선은 메뉴 화면,
      // 손익분기 미션은 손익분기점 화면으로 보낸다 (openTodoTarget).
      // 갈 곳이 없는데 눌리면 사장님은 앱이 먹통이라고 생각한다.
      actionable: s.kind === 'stock' || s.kind === 'breakeven' || /^insight-menu_/.test(s.id_hint),
      done: completedSet.has(s.id_hint),
      source: 'ai',
      ...(s.kind === 'promo' ? { action: 'marketing' as const, menu: s.menu ?? '' } : null),
    });
  });

  const lowStocks = (sources.stocks ?? []).filter(
    (s) => s.current_quantity <= (s.safety_quantity > 0 ? s.safety_quantity : 3),
  );

  lowStocks.forEach((s) => {
    // [한글 주석: 투두 아래 알림 센터에 들어갈 재고 부족 알림 수집]
    const alertId = `alert-stock-${s.ingredient_id}`;
    if (!dismissedAlertSet.has(alertId)) {
      const soldOut = s.current_quantity <= 0;
      // 투두·푸시와 같은 쉬운 말로 ('안전재고'·'재고 소진' 같은 용어는 쓰지 않는다)
      const need = s.safety_quantity > 0 ? s.safety_quantity : 3;
      nextAlerts.push({
        id: alertId,
        type: 'stock',
        severity: soldOut ? 'urgent' : 'high',
        title: soldOut ? `${s.name} 다 떨어졌어요` : `${s.name} 얼마 안 남았어요`,
        body: soldOut
          ? `지금 0${s.unit} · 최소 ${need}${s.unit} 필요`
          : `${s.current_quantity}${s.unit} 남음 · 최소 ${need}${s.unit} 필요`,
        timeText: getFormattedTimeText(),
        actionText: '재고 보기',
        target: { screen: 'Inventory' },
      });
    }
  });

  // 정렬 기준을 브루(ai_todo_service._gather)와 한 글자까지 맞춘다 —
  // ① 나눗셈의 분모는 '실제로 필요한 양'(안전재고가 0이면 3) ② 동점이면 재료 id 순.
  // 어긋나면 양쪽이 서로 다른 4개를 골라, 한쪽에만 남은 재료가 중복 줄로 되살아난다.
  const needOf = (s: { safety_quantity: number }) => (s.safety_quantity > 0 ? s.safety_quantity : 3);
  lowStocks
    .slice()
    .sort(
      (a, b) =>
        a.current_quantity / needOf(a) - b.current_quantity / needOf(b) ||
        a.ingredient_id - b.ingredient_id,
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
          urgentLabel: soldOut ? '급함' : undefined,
          actionable: true,
          done: completedSet.has(stockId), // [한글 주석] 기존 완료 기록이 있으면 체크 상태 유지
          source: 'ai',
        });
      }
    });

  (sources.compliance ?? [])
    .filter((c) => c.status !== 'ok')
    .forEach((c) => {
      const alertId = `alert-comp-${c.id}`;
      if (!dismissedAlertSet.has(alertId)) {
        const expired = c.status === 'expired';
        nextAlerts.push({
          id: alertId,
          type: 'document',
          severity: expired ? 'high' : 'medium',
          title: expired ? `${c.name} 기한 지남` : `${c.name} 갱신 준비`,
          body: expired
            ? `${formatKoreanDate(c.expiry_date)}까지였어요`
            : `${c.days_left}일 남음 · ${formatKoreanDate(c.expiry_date)}까지`,
          actionText: '서류 보기',
          target: { screen: 'Document' },
        });
      }

      const compId = `comp-${c.id}`;
      // 브루 인사이트가 이미 같은 서류의 갱신 할 일을 만들었으면 두 줄로 만들지 않는다
      if (!dismissedSet.has(compId) && !aiRenewalDocIds.has(String(c.id))) {
        const expired = c.status === 'expired';
        const compMeta = expired
          ? `기한 지남 · ${c.expiry_date}까지였어요`
          : `${c.days_left}일 남음 · ${c.expiry_date}까지`;
        next.push({
          id: compId,
          title: expired ? `${c.name} 갱신` : `${c.name} 갱신 준비`,
          subtitle: compMeta,
          meta: compMeta,
          urgentLabel: expired ? '급함' : undefined,
          actionable: false,
          done: completedSet.has(compId), // [한글 주석] 기존 완료 기록이 있으면 체크 상태 유지
          source: 'ai',
        });
      }
    });

  // [한글 주석: 과거 테스트용 더미 번호 항목(M1~M56 등)을 깔끔하게 필터링하여 카페 실무 투두만 노출]
  (sources.serverTodos ?? [])
    .filter((t: any) => !/^(미션|M)\d+/i.test((t.title || '').trim()))
    .forEach((t: any) => {
      const serverIdStr = `server-${t.id}`;
      if (!dismissedSet.has(serverIdStr)) {
        // due_date(사장님이 고른 날짜)가 최우선, 없으면 created_at을 '기기 시간대' 날짜로
        const parsedKey =
          t.due_date || (t.created_at ? localDateKey(t.created_at) : undefined);
        next.push({
          id: serverIdStr,
          title: t.title,
          subtitle:
            t.note && t.note !== '브루가 추가함'
              ? t.note
              : t.source === 'ai'
                ? '대화 중 추가됨'
                : '사장님 직접 추가',
          // 메모가 있을 때만 회색 줄로 — '사장님 직접 추가' 같은 안내는 줄만 늘린다.
          // (브루 추천을 고쳐서 내 업무로 가져온 경우 "다 떨어짐 · 최소 5kg 필요"가 여기 남는다)
          meta: t.note && t.note !== '브루가 추가함' ? t.note : undefined,
          actionable: false,
          done: completedSet.has(serverIdStr) || t.done,
          source: t.source,
          dateKey: parsedKey,
        });
      }
    });

  (sources.insights?.insights ?? []).slice(0, 3).forEach((ins) => {
    const alertId = `alert-ins-${ins.key}`;
    if (!dismissedAlertSet.has(alertId)) {
      nextAlerts.push({
        id: alertId,
        type: 'insight',
        severity: ins.severity === 'high' ? 'high' : ins.severity === 'medium' ? 'medium' : 'low',
        title: ins.title,
        body: ins.body,
        timeText: ins.due_date ? `${formatKoreanDate(ins.due_date)}까지` : undefined,
        actionText: '브루에게 물어보기',
        target: { screen: 'Chatbot' },
      });
    }
  });

  // 알림은 실제 재고·서류·인사이트에서만 만든다.
  // (예전에는 '서울우유 2팩 남음' 같은 고정 문구 5장을 항상 끼워 넣어서,
  //  매장에 없는 재료·없는 서류가 알림 센터에 그대로 떴다.)
  // 접힌 알림 센터는 맨 위 한 장만 보이므로 급한 것부터 정렬한다.
  const SEVERITY_ORDER: Record<AlertItem['severity'], number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  nextAlerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return { todos: dedupeTodos(next), alerts: nextAlerts };
}

/**
 * 같은 일이 두 줄로 뜨지 않게 하는 마지막 방어선.
 *
 * 할 일은 다섯 갈래(브루 제안·재고·서류·서버 저장·목업)에서 모이고, 갈래마다 id 규칙이
 * 달라서 id만으로는 겹침을 못 잡는다 — 'stock-67'과 'insight-stock_runout:67:…'은
 * id가 다르지만 화면엔 똑같이 '바닐라 시럽 발주' 한 줄로 보인다. 그래서 두 가지로 접는다:
 *   ① id가 같으면 (목록 key까지 겹쳐 화면이 깨진다)
 *   ② 같은 날짜에 뜨는 항목끼리 제목이 사실상 같으면
 * 겹칠 때는 서버에 행이 있는 쪽을 남긴다 — 고치고 지울 수 있는 건 그쪽뿐이다.
 */
function dedupeTodos(list: Todo[]): Todo[] {
  const today = todayKey();
  const seenIds = new Set<string>();
  const slotOfTitle = new Map<string, number>();
  const out: Todo[] = [];

  for (const t of list) {
    if (seenIds.has(t.id)) continue;
    seenIds.add(t.id);

    // 날짜가 없는 항목(재고·서류처럼 자동 도출된 것)은 오늘 줄에만 뜬다
    const key = `${t.dateKey || today}|${normalizeTitle(t.title)}`;
    const slot = slotOfTitle.get(key);
    if (slot === undefined) {
      slotOfTitle.set(key, out.length);
      out.push(t);
      continue;
    }
    if (t.id.startsWith('server-') && !out[slot].id.startsWith('server-')) {
      out[slot] = t;
    }
  }
  return out;
}

export default function DashboardScreen() {
  // [한글 주석] 하단 제스처 바 실측 높이 — 마지막 카드가 시스템 바에 물리지 않게
  const bottomInset = useBottomInset();
  // [한글 주석] 폴드 펼침·태블릿 판정 — 본문 폭 제한에 쓴다
  const { isWide, contentMaxWidth } = useResponsive();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  // 내일 매출 예측 — 브루 표정과 말풍선에만 쓴다 (할 일·알림은 만들지 않는다)
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [runId, setRunId] = useState(0);
  const notifiedStocksRef = useRef<Set<string>>(new Set());

  // 숨김·완료 기록은 화면과 같은 수명을 갖는다.
  // 예전에는 이 값들이 데이터 조회 이펙트 안에만 있어서, 지운 직후 늦게 도착한 응답
  // 하나가(인사이트는 7초까지 걸린다) 방금 지운 줄을 그대로 되살리고 체크도 풀었다.
  // 기기 보관소에 쓰는 것과 **같은 순간** 여기도 고쳐야 그 되살아남이 없다.
  const prefsRef = useRef<DashboardPrefs>({
    dismissed: new Set(),
    completed: new Set(),
    dismissedAlerts: new Set(),
  });
  const prefsLoadedRef = useRef(false);

  // 방금 추가하거나 고친 할 일 — 서버 목록이 따라올 때까지만 들고 있는다.
  // paint()는 서버 응답으로 목록을 통째로 다시 만들기 때문에, 이 보관이 없으면
  // 새 할 일을 적은 직후 느린 응답 하나만 도착해도 방금 적은 줄이 사라졌다
  // (다음 조회까지 최대 1분).
  const pendingTodosRef = useRef<Map<string, { todo: Todo; at: number }>>(new Map());

  const { user, token } = useAuth();
  const navigation = useNavigation<any>();
  const isFocused = useIsFocused();
  // 상점에서 산 카페 배경을 착용하면 홈 상단 색도 그 분위기로 물든다 (사진이 아니라 색만 — roomBackgrounds.ts)
  const { roomBgId } = useEquipped();
  const tint = getRoomTint(roomBgId);
  // 착용 배경 사진이 웰컴 영역을 꽉 채우도록, 크림 시트가 시작하는 y를 실측해 넘긴다 (네 탭 공통)
  const { sheetTop, onSheetLayout } = useSheetTop();

  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [pushBadgeSeen, setPushBadgeSeen] = useState(false);

  const handleOpenPushModal = () => {
    setPushBadgeSeen(true);
    setPushModalOpen(true);
  };

  // 홈 데이터 불러오기 — 기기에 남은 지난번 응답으로 먼저 그리고, 서버 응답이 오는 대로 갈아 끼운다.
  //
  // 예전에는 다섯 요청을 Promise.allSettled로 한꺼번에 기다렸다. 그중 인사이트는 매장 데이터를
  // 통째로 훑는 계산이라 서버 캐시가 식으면 7초가 걸리는데, 그동안 나머지 네 응답(0.6초)이
  // 이미 도착해 있어도 할 일과 알림이 통째로 비어 있었다. 지금은 도착 순서대로 채운다.
  useEffect(() => {
    if (!token || !isFocused) return;
    let cancelled = false;

    const sources: DashboardSources = {};

    // 숨김·완료 기록을 읽기 전에는 그리지 않는다 — 먼저 그리면 지운 항목이 잠깐 되살아난다
    const paint = () => {
      if (cancelled || !prefsLoadedRef.current) return;
      const built = buildDashboard(sources, prefsRef.current);

      // 방금 만든 줄은 서버 목록이 따라올 때까지만 얹는다. 서버가 같은 id를 돌려주기
      // 시작하면(=따라잡았으면) 즉시 놓아준다 — 계속 들고 있으면 서버에서 지워진
      // 뒤에도 화면에만 남는다. 응답이 끝내 안 와도 PENDING_KEEP_MS면 정리된다.
      const builtIds = new Set(built.todos.map((t) => t.id));
      const now = Date.now();
      pendingTodosRef.current.forEach((entry, id) => {
        if (builtIds.has(id) || now - entry.at > PENDING_KEEP_MS) {
          pendingTodosRef.current.delete(id);
        }
      });
      const pending = Array.from(pendingTodosRef.current.values()).map((e) => e.todo);

      // 붙여 놓은 줄까지 합친 다음 한 번 더 접는다 — 사장님이 직접 적은 제목이 자동
      // 도출된 줄과 같을 수 있다(예: '우유 발주'를 손으로 적었는데 재고에서도 같은 줄이 온다)
      setTodos(dedupeTodos([...pending, ...built.todos]));
      setAlerts(built.alerts);
      // 브루 표정 — 캐시로 그릴 때도, 예측이 늦게 도착할 때도 같은 자리에서 갱신된다
      setForecast(sources.forecast ?? null);
    };

    // 1) 네트워크부터 발사한다 (저장소 읽기를 기다리지 않게).
    //    단, 이번 세션에서 방금 받아 둔 값이면 건너뛴다 — 탭을 오갈 때마다 홈 이펙트가 다시 도는데,
    //    그때마다 7초짜리 인사이트를 새로 부르면 서버만 두드리고 화면은 어차피 같은 숫자다.
    //    당겨서 새로고침은 markAllStale()로 나이를 0으로 만들어 이 관문을 통과시킨다.
    const fetchers: Record<keyof DashboardSources, () => Promise<any>> = {
      stocks: () => listStocks(token),
      compliance: () => listCompliance(token),
      serverTodos: () => listTodos(token),
      insights: () => fetchInsights(token),
      aiSuggest: () => getAiTodoSuggestions(token),
      // 브루 표정용 예측 — 이미 저장된 매장 좌표만 쓴다. 홈을 열자마자 GPS 권한창을
      // 띄우면 표정 하나 때문에 사장님을 붙잡는 꼴이라, 좌표가 없으면 그냥 없이 부른다.
      forecast: async () => {
        try {
          const loc = await getStoredStoreLocation();
          return await getSalesForecast(token, loc?.lat, loc?.lon);
        } catch {
          // 판매 기록이 14일 미만이면 서버가 409로 거절한다 — 새 매장에선 정상이라
          // 에러로 시끄럽게 굴 이유가 없다. 근거가 없으면 표정을 바꾸지 않는다.
          return null;
        }
      },
    };

    const jobs = (Object.keys(fetchers) as (keyof DashboardSources)[])
      .filter((name) => {
        const hit = peekCache(CACHE_KEYS[name]);
        return !hit || Date.now() - hit.at >= (SOURCE_FRESH_MS[CACHE_KEYS[name]] ?? FRESH_ENOUGH_MS);
      })
      .map((name) => [name, fetchers[name]()] as [keyof DashboardSources, Promise<any>]);

    jobs.forEach(([name, promise]) => {
      promise
        .then((value) => {
          sources[name] = value;
          void saveCache(CACHE_KEYS[name], value);
          // 재고 부족 푸시는 '방금 받은' 재고에서만 — 캐시로 그린 화면이 지난 알림을 다시 쏘면 안 된다
          if (name === 'stocks' && !cancelled) {
            (value as Awaited<ReturnType<typeof listStocks>>)
              .filter((s) => s.current_quantity <= (s.safety_quantity > 0 ? s.safety_quantity : 3))
              .forEach((s) => {
                const idStr = String(s.ingredient_id);
                if (!notifiedStocksRef.current.has(idStr)) {
                  notifiedStocksRef.current.add(idStr);
                  sendStockPushNotification(s);
                }
              });
          }
          paint();
        })
        .catch((e) => {
          console.error(`홈 데이터 조회 실패 (${name}):`, e);
        });
    });

    // 2) 기기 저장소(숨김·완료 기록 + 지난번 응답)를 읽어 즉시 한 번 그린다
    (async () => {
      const [rawDismissed, rawCompleted, rawDismissedAlerts] = await Promise.all([
        AsyncStorage.getItem(DISMISSED_TODOS_KEY),
        AsyncStorage.getItem(COMPLETED_TODOS_KEY),
        AsyncStorage.getItem(DISMISSED_ALERTS_KEY),
      ]).catch((e) => {
        console.error('보관소 읽기 실패:', e);
        return [null, null, null];
      });

      const parseSet = (raw: string | null) => {
        try {
          return new Set<string>(raw ? JSON.parse(raw) : []);
        } catch {
          return new Set<string>();
        }
      };

      const cached = await Promise.all(
        (Object.keys(CACHE_KEYS) as (keyof DashboardSources)[]).map((name) =>
          loadCache<any>(CACHE_KEYS[name]).then((hit) => [name, hit?.data] as const),
        ),
      );
      if (cancelled) return;

      // 보관소를 읽는 사이에 사장님이 지운 항목은 그대로 둔다 — 읽기가 늦게 끝났다고
      // 방금 지운 줄이 되살아나면 안 된다 (지움 기록은 늘 더해지기만 한다)
      prefsRef.current = {
        dismissed: new Set([...parseSet(rawDismissed), ...prefsRef.current.dismissed]),
        completed: todayCompletedSet(rawCompleted),
        dismissedAlerts: new Set([
          ...parseSet(rawDismissedAlerts),
          ...prefsRef.current.dismissedAlerts,
        ]),
      };
      prefsLoadedRef.current = true;
      // 이미 서버 응답이 온 항목은 캐시로 덮지 않는다
      cached.forEach(([name, data]) => {
        if (data !== undefined && sources[name] === undefined) sources[name] = data;
      });
      paint();
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
    prefsRef.current.dismissedAlerts.add(id);   // 늦게 도착한 응답이 되살리지 않게
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
    ids.forEach((id) => prefsRef.current.dismissedAlerts.add(id));
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_ALERTS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      ids.forEach((id) => set.add(id));
      await AsyncStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('전체 알림 닫기 기록 실패:', e);
    }
  };

  // 지운 알림 되돌리기 — 지움 기록만 비우고 재고·서류·인사이트를 다시 읽는다.
  // (지금 매장에 해당하는 알림이 없으면 되돌려도 비어 있는 게 맞다)
  const handleRestoreAlerts = async () => {
    try {
      await AsyncStorage.removeItem(DISMISSED_ALERTS_KEY);
    } catch (e) {
      console.error('알림 기록 초기화 실패:', e);
    }
    prefsRef.current.dismissedAlerts.clear();
    toast('지운 알림을 다시 불러왔어요', '지금 확인이 필요한 알림만 보여드려요.');
    setRunId((x) => x + 1);
  };

  // 홈 헤더 마스코트 — 표정을 내일 매출 예측이 정한다 (components/brew/forecastMood.ts).
  // 평소보다 잘될 것 같으면 폴짝 뛰고(jump, 플립북 재생), 한산할 것 같으면 턱을 괸다(resting).
  // 판단할 근거가 없으면 기본 바리스타 포즈(top) 그대로다.
  const brewOutlook = useMemo(() => moodFromForecast(forecast), [forecast]);
  const scrollY = useRef(new Animated.Value(0)).current;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // 캐시를 지우지 않고 '낡음'으로만 표시한다 — 카드는 지난 값을 계속 보여 주면서
    // 서버를 반드시 다시 부른다. (지워 버리면 새로고침할 때마다 카드가 빈 채로 깜빡인다)
    markAllStale();
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

  /** 서버 목록이 따라올 때까지 화면에 붙들어 둘 항목으로 등록 (없으면 다음 응답에 사라진다) */
  const holdPending = (todo: Todo) => {
    pendingTodosRef.current.set(todo.id, { todo, at: Date.now() });
  };

  const handleAddTodo = async (title: string, dateKey?: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;

    const targetKey = dateKey || todayKey();
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

    holdPending(newTodo);
    setTodos((prev) => [newTodo, ...prev]);

    if (token) {
      try {
        // 선택한 날짜를 due_date로 함께 저장한다 — 안 보내면 서버 목록으로 대체되는 순간
        // created_at(오늘) 기준으로 분류돼, 다른 요일 밑에 적은 할 일이 오늘로 튀어 온다.
        const created = await createTodo(token, trimmed, undefined, targetKey);
        const realServerId = `server-${created.id}`;
        // [한글 주석] 서버 등록 완료 후 local- ID를 server- ID로 교체하여 삭제 시 서버 연동이 정상 동작하게 함
        pendingTodosRef.current.delete(tempLocalId);
        holdPending({ ...newTodo, id: realServerId });
        setTodos((prev) =>
          prev.map((t) => (t.id === tempLocalId ? { ...t, id: realServerId } : t))
        );
      } catch (e) {
        console.error('할 일 추가 실패:', e);
        // 저장에 실패한 줄을 계속 들고 있으면 '적혔다'고 오해한다 — 다음 그리기에서 놓아준다
        pendingTodosRef.current.delete(tempLocalId);
      }
    }
  };

  /** 자동 도출 항목이 새로고침 때 되살아나지 않게 숨김 목록에 넣는다 (기기에만 남는 기록) */
  const rememberDismissed = async (id: string) => {
    // 화면에 쓰는 기록을 먼저 고친다 — 보관소 쓰기를 기다리는 사이에 늦은 응답이 도착하면
    // 방금 지운 줄이 그대로 되살아난다
    prefsRef.current.dismissed.add(id);
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_TODOS_KEY);
      const set = new Set<string>(raw ? JSON.parse(raw) : []);
      set.add(id);
      await AsyncStorage.setItem(DISMISSED_TODOS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      console.error('숨김 항목 보관 실패:', e);
    }
  };

  const handleEditTodo = async (id: string, newTitle: string) => {
    const target = todos.find((t) => t.id === id);
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, title: newTitle } : t)));
    if (!token) return;

    const serverId = serverIdOf(id);
    if (serverId !== null) {
      const held = pendingTodosRef.current.get(id);
      if (held) holdPending({ ...held.todo, title: newTitle });
      try {
        await updateTodo(token, serverId, { title: newTitle });
      } catch (e) {
        console.error('할 일 수정 실패:', e);
        resync();
      }
      return;
    }

    // 아직 등록 응답을 기다리는 항목 — 화면만 바꿔 두고 서버는 건드리지 않는다
    if (id.startsWith('local-')) return;

    // 재고·서류·브루 추천처럼 자동으로 만들어진 항목은 서버에 행이 없다.
    // 사장님이 고쳤다는 건 '내 업무로 가져가겠다'는 뜻이라, 고친 내용으로 새로 저장하고
    // 원본 자동 항목은 숨긴다 — 이렇게 해야 수정한 제목이 새로고침 후에도 남는다.
    try {
      const created = await createTodo(token, newTitle, target?.meta || undefined);
      await rememberDismissed(id);
      const promoted: Todo = {
        ...(target ?? { id, title: newTitle, subtitle: '' }),
        id: `server-${created.id}`,
        title: newTitle,
        source: 'owner',
        actionable: false,
        urgentLabel: undefined,
        action: undefined,
      };
      // 원본은 숨겼고 새 행은 아직 서버 목록에 없다 — 붙들어 두지 않으면 다음 그리기에서 통째로 사라진다
      holdPending(promoted);
      setTodos((prev) => prev.map((t) => (t.id === id ? promoted : t)));
    } catch (e) {
      console.error('할 일 수정 실패:', e);
      resync();
    }
  };

  const handleDeleteTodo = async (id: string) => {
    // 1. [한글 주석] 화면 상태에서 즉시 삭제
    setTodos((prev) => prev.filter((t) => t.id !== id));

    // 2. [한글 주석] 삭제된 항목의 ID를 AsyncStorage에 추가하여 탭 이동 후 재생성되는 현상을 방지
    pendingTodosRef.current.delete(id);
    await rememberDismissed(id);

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
  const handleRestoreAiTodos = async () => {
    toast('✨ 브루 추천 복원 완료!', '삭제했던 브루의 업무 추천을 불러왔어요.');
    // 보관소를 먼저 비우고 나서 다시 그린다. 예전엔 둘을 동시에 걸어서, 지우기가 늦으면
    // 다시 그리는 쪽이 옛 숨김 목록을 그대로 읽어 아무것도 복원되지 않았다.
    try {
      await AsyncStorage.removeItem(DISMISSED_TODOS_KEY);
    } catch (e) {
      console.error('브루 추천 복원 실패:', e);
    }
    prefsRef.current.dismissed.clear();
    setRunId((x) => x + 1);
  };

  /** 코인이 실제로 쌓였을 때만 알린다 — 이미 받은 항목을 다시 체크하면 아무 말도 하지 않는다 */
  const celebrateCoins = (awarded?: number | null) => {
    if (!awarded) return;
    toast(`🪙 +${awarded}코인`, '상점에서 브루를 꾸며보세요.');
  };

  /**
   * 할 일 카드를 누르면 그 일을 처리할 수 있는 화면으로 보낸다.
   *
   * 재고 항목의 id는 'stock-<재료id>' 형식이라(ai_todo_service) 여기서 바로 꺼내
   * 그 재료만 보여주는 '재고 확인' 화면을 스택 위에 얹는다 — 목록에서 다시 찾게 하지 않는다.
   * 재고 탭으로 보내지 않는 이유: 탭이 통째로 바뀌면 보던 할 일 목록에서 튕겨 나가고,
   * 돌아오려면 홈 탭을 다시 눌러 스크롤 위치까지 잃는다. 스택이면 뒤로가기 한 번이면 된다.
   * ts를 함께 넘겨야 같은 재료를 연달아 눌러도 받는 화면이 새 요청으로 인식한다.
   */
  const openTodoTarget = (todo: { id: string }) => {
    // 메뉴 개선 추천('아메리카노 가격 올리기')은 메뉴 화면으로 — 거기에 개선안 카드가 있다.
    // 브루가 얼마로 올리라고까지 말해 놓고 갈 곳을 안 알려주면 사장님이 직접 찾아야 한다.
    if (/^insight-menu_/.test(todo.id)) {
      navigation.navigate('Menu');
      return;
    }
    // 손익분기 미션 — 목표 숫자를 눌렀으면 그 숫자가 어떻게 나왔는지 보고 싶은 것이다
    if (todo.id === 'breakeven-daily') {
      navigation.navigate('BreakEven');
      return;
    }
    const m = /^stock-(\d+)$/.exec(todo.id);
    if (!m) return; // 재고가 아닌 항목(홍보 등)은 각자 링크로 처리한다
    navigation.navigate('StockDetail', { ingredientId: Number(m[1]), ts: Date.now() });
  };

  const toggleDone = async (id: string) => {
    // 다음 상태를 지금 값에서 직접 계산한다 — setTodos 콜백 안에서 읽으면
    // 서버로 보낼 값과 화면 값이 어긋날 수 있다
    const target = todos.find((t) => t.id === id);
    const nextDone = !target?.done;
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: nextDone } : t)));

    // 화면이 보는 기록을 먼저 고친다 — 늦게 도착한 응답이 방금 누른 체크를 풀지 않게
    if (nextDone) {
      prefsRef.current.completed.add(id);
    } else {
      prefsRef.current.completed.delete(id);
    }
    const held = pendingTodosRef.current.get(id);
    if (held) holdPending({ ...held.todo, done: nextDone });

    // [한글 주석] 완료(done) 상태를 기기 보관소에 저장해 자동 갱신 때 체크가 풀리지 않게 보정.
    // 날짜를 함께 적는다 — 자동 도출 항목은 id가 날마다 같아서(stock-64) 날짜가 없으면
    // 어제 체크한 발주가 오늘도 완료로 떠서 이미 한 일처럼 보인다. 오늘 것만 살려 읽는다.
    try {
      const raw = await AsyncStorage.getItem(COMPLETED_TODOS_KEY);
      const today = todayKey();
      const map = parseCompletedMap(raw);
      // 지난 날짜 기록은 여기서 정리한다 (그냥 두면 한없이 쌓인다)
      const pruned: Record<string, string> = {};
      Object.entries(map).forEach(([key, day]) => {
        if (day === today) pruned[key] = day;
      });
      if (nextDone) {
        pruned[id] = today;
      } else {
        delete pruned[id];
      }
      await AsyncStorage.setItem(COMPLETED_TODOS_KEY, JSON.stringify(pruned));
    } catch (e) {
      console.error('완료 상태 보관소 저장 실패:', e);
    }

    if (!token) return;

    // 코인 적립은 완료할 때만. 저장된 할 일은 완료 API가 알아서 적립하고,
    // 재고·서류·브루 추천처럼 서버에 행이 없는 항목은 id를 키로 따로 알린다.
    // 어느 쪽이든 같은 항목은 한 번만 쌓인다(서버의 유니크 제약).
    const serverId = serverIdOf(id);
    try {
      if (serverId !== null) {
        const saved = await updateTodo(token, serverId, { done: nextDone });
        if (nextDone) celebrateCoins(saved.points_awarded);
      } else if (nextDone) {
        const { awarded } = await awardDerivedTodo(id, target?.title ?? '할 일', token);
        celebrateCoins(awarded);
      }
    } catch (e) {
      console.error('할 일 완료 처리 실패:', e);
      // 적립만 실패한 경우까지 되돌리면 체크가 풀려 더 혼란스럽다 — 저장된 할 일일 때만 재동기화
      if (serverId !== null) resync();
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
            {/* [한글 주석: 오로라 딥브라운 그라데이션 범위를 상단 25% 이내로만 제한하여 하단에 갈색 띠가 비치지 않도록 방지] */}
            {/* [한글 주석: 상단 딥 그라데이션 — 착용한 카페 배경이 있으면 그 분위기 색으로. 밝기는 그대로라 흰 아이콘 대비는 유지된다] */}
            <LinearGradient id="auroraGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor={tint.top[0]} />
              <Stop offset="18%" stopColor={tint.top[1]} />
              <Stop offset="30%" stopColor={colors.creamSand} />
              <Stop offset="100%" stopColor={colors.creamSand} />
            </LinearGradient>
            
            <Filter id="auroraGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="70" />
            </Filter>
          </Defs>
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#auroraGrad)" />
          {/* 글로우 원들을 상부 웰컴 영역에만 배치하여 하부 화이트 카드 부근엔 맑게 스며들도록 함 */}
          <Circle cx="85%" cy="12%" r="140" fill={tint.glow[0]} filter="url(#auroraGlow)" opacity="0.25" />
          <Circle cx="15%" cy="22%" r="130" fill={tint.glow[1]} filter="url(#auroraGlow)" opacity="0.2" />
          <Circle cx="60%" cy="4%" r="120" fill={tint.glow[2]} filter="url(#auroraGlow)" opacity="0.16" />
        </Svg>
      </View>

      {/* 착용한 카페 배경 '사진' — 브루룸과 같은 그림을 그대로 깐다.
          미착용이면 null이라 위 오로라가 그대로 보인다 (RoomBackdrop.tsx) */}
      <RoomBackdrop roomBgId={roomBgId} sheetTop={sheetTop} fadeAt={0.44} />

      {/* [한글 주석: 순정의 자연스럽고 부드러운 프리미엄 스크롤] */}
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
            mood={brewOutlook.mood}
            moodReason={brewOutlook.reason}
            moodOverridesPose={isNotable(brewOutlook.outlook)}
            moodTone={brewOutlook.outlook}
            onOpenMap={() => navigation.navigate('StoreMap')}
            onOpenPushModal={handleOpenPushModal}
            onOpenShop={() => navigation.navigate('BrewRoom')}
            hasUnreadPush={alerts.length > 0 && !pushBadgeSeen}
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
            { paddingBottom: s(20) + bottomInset }, // [한글 주석: 하단 과도한 뻥 뚫린 여백 축소 — 탭 바 및 플로팅 버튼과 밀착되도록 보정]
            // [한글 주석] 폴드를 펼치면 673dp라 카드가 가로로 늘어져 읽기 나쁘다 → 폭을 묶고 가운데 정렬
            isWide && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
          // 배경 사진이 어디까지 보일지 정하는 기준선 (RoomBackdrop)
          onLayout={onSheetLayout}
        >
          {/* runId를 key에 섞어 카드를 통째로 재마운트하지 않는다 — 재마운트는 캐시 훅·
              카운트업·투두 내부 상태를 전부 버려 새로고침마다 화면이 처음부터 다시 그려진다.
              대신 refreshToken으로 각 카드의 캐시 훅만 강제 갱신한다. */}
          <FadeInUp delay={80}>
            <SalesCard
              todos={todos}
              onPressTodo={openTodoTarget}
              onToggleDone={toggleDone}
              onAddTodo={handleAddTodo}
              onEditTodo={handleEditTodo}
              onDeleteTodo={handleDeleteTodo}
              onRestoreAiTodos={handleRestoreAiTodos}
              refreshToken={runId}
            />
          </FadeInUp>

          {/* 카드 대금 입금 예정 — 카드사마다 입금일이 달라 직접 세기 번거로운 숫자 */}
          <FadeInUp delay={110}>
            <CardDepositCard refreshToken={runId} />
          </FadeInUp>

          {/* AI 경영 리포트 — 일간/주간/월간 탭을 누르면 홈에서 바로 보인다 */}
          <FadeInUp delay={140}>
            <ManagementReportCard refreshToken={runId} />
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
    borderTopLeftRadius: s(36),
    borderTopRightRadius: s(36),
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap,
    // [한글 주석] paddingBottom 은 Dashboard 안에서 하단 탭 바 + 제스처 바 실측값으로 덮어쓴다
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

