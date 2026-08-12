// 할 일 목록 (Design Spec §4-③ 연동 — iOS 팝업 모달 기반 새 업무 등록 및 1줄 세련 레이아웃 최종)
import { useEffect, useRef, useState, useMemo } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import {
  addChecklistItem, listChecklist, toggleChecklist, type ChecklistItem,
} from '../../lib/api/checklist';
import { listMenus, type MenuItem } from '../../lib/api/sales';
import { fetchStaffAccounts, type StaffAccount } from '../../lib/api/staffAccounts';
import { forwardTodo } from '../../lib/api/todo';
import { colors, radius, shadows, spacing, typography } from '../../theme';
import { useResponsive } from '../../theme/responsive';
import { PopIn, PressableScale, SlideUp } from '../motion';
import { toast } from '../toast';
import { glassSurface } from '../../theme/glass';
import { type DateInfo } from './SalesCard';

export type TodoCategory = 'order' | 'hygiene' | 'admin' | 'daily';

export type Todo = {
  id: string;
  title: string;
  subtitle: string;
  actionable?: boolean; // [한글 주석] 카테고리 판별 등에 쓰는 플래그 (재고·발주성 항목)
  done?: boolean;
  qty?: string;
  // [한글 주석] 누가 넣었는지 — 'ai'면 챗봇(브루)이 대화 중 추가한 항목이라 배지를 붙인다.
  source?: 'owner' | 'ai';
  timeGroup?: string;
  dateKey?: string;
  category?: TodoCategory;
  // [한글 주석] 브루 추천 액션 — 'marketing'이면 항목 아래 '홍보하러 가기' 링크가 붙고,
  // 누르면 홍보 스튜디오로 이동하며 menu(홍보할 메뉴명)가 프롬프트에 자동 입력된다.
  action?: 'marketing';
  menu?: string;
  // [한글 주석] 제목 아래 회색 한 줄 — 숫자 근거만 담는다 ("0kg 남음 · 안전재고 5kg").
  // 제목은 '무엇을 할지'만, 근거는 여기로 나눠야 훑어볼 때 읽힌다.
  // subtitle과 따로 두는 이유: subtitle엔 '사장님 직접 추가' 같은 안 보여줄 값도 들어온다.
  meta?: string;
  // [한글 주석] 재료가 다 떨어졌거나 서류 기한이 지난 급한 항목 — 제목 옆 빨간 배지 문구
  // ('없음'·'지남'처럼 어려운 말 없이 짧게)
  urgentLabel?: string;
  // 알바에게 보낸 할 일 — 받은 직원 이름과 그쪽(체크리스트)에서의 완료 여부.
  // 서버 저장 항목(server-*)에만 붙는다. forwardedDone이 없으면(null) 아직 미완료.
  forwardedTo?: string | null;
  forwardedDone?: boolean | null;
};

const CATEGORIES: { id: TodoCategory; label: string; icon: string; tag: string }[] = [
  { id: 'daily', label: '일일업무', icon: 'cafe-outline', tag: '일일업무' },
  { id: 'order', label: '발주·재고', icon: 'cart-outline', tag: '발주·재고' },
  { id: 'hygiene', label: '위생·청소', icon: 'sparkles-outline', tag: '위생·청소' },
  { id: 'admin', label: '서류·행정', icon: 'document-text-outline', tag: '서류·행정' },
];

// ── [한글 주석: 쫀득하고 부드러운 iOS 물방울 Bouncy Spring 모션 카테고리 칩 컴포넌트] ──
function CategoryChipCell({
  cat,
  isSelected,
  onPress,
}: {
  cat: { id: TodoCategory; label: string; icon: string; tag: string };
  isSelected: boolean;
  onPress: () => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    // 쫀득하게 축소되었다 퐁~ 하고 튀어 오르는 물방울 스프링 애니메이션
    Animated.sequence([
      Animated.spring(scaleAnim, {
        toValue: 0.88,
        friction: 4,
        tension: 240,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 3.5,
        tension: 190,
        useNativeDriver: true,
      }),
    ]).start();
    onPress();
  };

  return (
    <Animated.View style={{ width: '48.5%', transform: [{ scale: scaleAnim }] }}>
      <PressableScale
        onPress={handlePress}
        style={[styles.modalCatChip, isSelected && styles.modalCatChipActive]}
        to={0.92}
      >
        <Ionicons
          name={cat.icon as any}
          size={13}
          color={isSelected ? '#FFFFFF' : '#71717A'}
        />
        <Text style={[styles.modalCatChipText, isSelected && styles.modalCatChipTextActive]}>
          {cat.label}
        </Text>
      </PressableScale>
    </Animated.View>
  );
}

function getCategoryMeta(todo: Todo): { label: string; icon: string; color: string; bg: string } {
  const text = (todo.title + ' ' + todo.subtitle).toLowerCase();
  // [한글 주석] 메뉴 개선 추천('아메리카노 가격 올리기')이 먼저다 — 이 항목도 눌러서 이동하므로
  // actionable이 켜져 있는데, 아래 발주 조건이 actionable만 보고 '발주·재고'로 채가 버린다.
  if (text.includes('가격') || text.includes('메뉴판') || text.includes('팔리는 메뉴')) {
    return { label: '☕ 메뉴·가격', icon: 'pricetags-outline', color: '#9333EA', bg: '#F3E8FF' };
  }
  if (todo.category === 'order' || todo.actionable || text.includes('재고') || text.includes('발주') || text.includes('소진') || text.includes('부족')) {
    return { label: '📦 발주·재고', icon: 'cart-outline', color: '#16A34A', bg: '#DCFCE7' };
  }
  if (todo.category === 'admin' || text.includes('서류') || text.includes('만료') || text.includes('갱신') || text.includes('영수증') || text.includes('세무')) {
    return { label: '🧾 서류·행정', icon: 'document-text-outline', color: '#D97706', bg: '#FEF3C7' };
  }
  if (todo.category === 'hygiene' || text.includes('청소') || text.includes('위생') || text.includes('소독') || text.includes('행주') || text.includes('마감')) {
    return { label: '🧼 위생·청소', icon: 'sparkles-outline', color: '#0284C7', bg: '#E0F2FE' };
  }
  return { label: '☕ 일일업무', icon: 'cafe-outline', color: '#4F46E5', bg: '#EEF2FF' };
}

export default function TodoList({
  todos,
  selectedDateInfo,
  onPressAction,
  onToggleDone,
  onAddTodo,
  onEditTodo,
  onDeleteTodo,
  onRestoreAiTodos,
}: {
  todos: Todo[];
  selectedDateInfo?: DateInfo;
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onAddTodo?: (title: string, dateKey?: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
  onRestoreAiTodos?: () => void;
  hideCard?: boolean;
}) {
  // [한글 주석] 뷰포트 비례 계산 — 모달 목록이 작은 화면에서 넘치지 않게
  const { vh } = useResponsive();
  const [modalVisible, setModalVisible] = useState(false);
  // [한글 주석] 수정 중인 Todo 대상 상태 (null이면 신규 등록 모드, 존재하면 팝업 모달 수정 모드)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [newTitle, setNewTitle] = useState('');

  // [홍보할 메뉴 고르기] '주 메뉴를 홍보하세요' 투두에서 열리는 메뉴 선택 모달 —
  // 메뉴 관리에 등록된 전체 메뉴 중 하나를 고르면 홍보 스튜디오로 이동하며 자동 입력된다.
  const { token, user } = useAuth();
  const navigation = useNavigation<any>();
  const [promoPickerOpen, setPromoPickerOpen] = useState(false);
  const [promoMenus, setPromoMenus] = useState<MenuItem[] | null>(null);
  const openPromoPicker = async () => {
    setPromoPickerOpen(true);
    if (promoMenus !== null || !token) return;
    try {
      setPromoMenus(await listMenus(token));
    } catch (e) {
      console.error('홍보 메뉴 목록 조회 실패:', e);
      setPromoMenus([]);
    }
  };
  const pickPromoMenu = (name: string) => {
    setPromoPickerOpen(false);
    navigation.navigate('Marketing', { prefillMenu: name, ts: Date.now() });
  };

  // [알바에게 보내기] 할 일을 담당 지정 일회성 항목으로 근무 체크리스트에 넘긴다.
  // 알바 계정이 등록된 사장님에게만 보이는 기능 — 직원 계정이나 알바 없는 매장에선
  // staffList가 비어 버튼 자체가 안 나온다. 원본 할 일은 그대로 둔다(사장님이 추적할 수
  // 있게). 알바가 끝내면 체크리스트 쪽에 '누가 했는지'가 남는다.
  const [staffList, setStaffList] = useState<StaffAccount[]>([]);
  const [sendTarget, setSendTarget] = useState<Todo | null>(null);
  const [sendingStaffId, setSendingStaffId] = useState<number | null>(null);
  useEffect(() => {
    if (!token || user?.isStaff) return;
    // 실패해도 화면은 그대로 쓴다 — 보내기 버튼만 안 보일 뿐이다
    fetchStaffAccounts(token)
      .then((rows) => setStaffList(rows.filter((r) => r.is_active)))
      .catch(() => {});
  }, [token, user?.isStaff]);

  // [내 할 일 | 직원 할 일] 탭 — 사장님이 홈에서 직원 체크리스트까지 한눈에 본다.
  // 직원 할 일은 '오늘' 기준(체크리스트는 날짜 개념이 자정 리셋뿐)이라 날짜 스트립과 무관하다.
  const [viewTab, setViewTab] = useState<'mine' | 'staff'>('mine');
  const [staffTasks, setStaffTasks] = useState<ChecklistItem[] | null>(null); // null = 아직 안 불러옴
  const [staffTaskBusyId, setStaffTaskBusyId] = useState<number | null>(null);
  // 직원별 모아보기 — null=전체, '공용'=담당 없는 루틴, 그 외=그 직원 이름
  const [staffPanelFilter, setStaffPanelFilter] = useState<string | null>(null);

  // 직원별 완료 현황 — "박알바 2/3"처럼 누가 얼마나 했는지 한눈에. 공용 루틴은 맨 뒤.
  const staffProgress = useMemo(() => {
    if (!staffTasks) return [] as { name: string; done: number; total: number }[];
    const acc = new Map<string, { done: number; total: number }>();
    for (const it of staffTasks) {
      const key = it.assigned_staff_name ?? '공용';
      const cur = acc.get(key) ?? { done: 0, total: 0 };
      cur.total += 1;
      if (it.done) cur.done += 1;
      acc.set(key, cur);
    }
    return Array.from(acc.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => (a.name === '공용' ? 1 : b.name === '공용' ? -1 : a.name.localeCompare(b.name)));
  }, [staffTasks]);

  const visibleStaffTasks = useMemo(() => {
    if (!staffTasks) return null;
    if (staffPanelFilter === null) return staffTasks;
    if (staffPanelFilter === '공용') return staffTasks.filter((it) => !it.assigned_staff_name);
    return staffTasks.filter((it) => it.assigned_staff_name === staffPanelFilter);
  }, [staffTasks, staffPanelFilter]);

  // 고른 담당이 목록에서 사라지면(재조회로 항목 소멸 등) 필터를 풀어 빈 화면에 갇히지 않게
  useEffect(() => {
    if (staffPanelFilter && !staffProgress.some((p) => p.name === staffPanelFilter)) {
      setStaffPanelFilter(null);
    }
  }, [staffProgress, staffPanelFilter]);

  const openStaffTab = async () => {
    setViewTab('staff');
    if (!token) return;
    try {
      setStaffTasks(await listChecklist(token)); // 탭을 열 때마다 최신으로 — 알바가 방금 체크한 게 보여야 한다
    } catch {
      setStaffTasks((prev) => prev ?? []);
      toast('직원 할 일 불러오기 실패', '잠시 후 다시 시도해 주세요.');
    }
  };

  // 사장님도 홈에서 바로 체크할 수 있다 (체크리스트 화면과 같은 권한 규칙 — 토글은 모두 가능)
  const toggleStaffTask = async (it: ChecklistItem) => {
    if (!token || staffTaskBusyId !== null) return;
    setStaffTaskBusyId(it.id);
    setStaffTasks((prev) => prev?.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) ?? prev);
    try {
      const r = await toggleChecklist(token, it.id);
      setStaffTasks((prev) =>
        prev?.map((x) => (x.id === it.id ? { ...x, done: r.done, done_by: r.done_by ?? null } : x)) ?? prev,
      );
    } catch (e) {
      setStaffTasks((prev) => prev?.map((x) => (x.id === it.id ? { ...x, done: it.done } : x)) ?? prev);
      toast('체크 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setStaffTaskBusyId(null);
    }
  };

  const sendTodoToStaff = async (staff: StaffAccount) => {
    if (!token || !sendTarget || sendingStaffId !== null) return;
    setSendingStaffId(staff.id);
    try {
      const serverId = sendTarget.id.startsWith('server-')
        ? Number(sendTarget.id.slice('server-'.length))
        : null;
      if (serverId) {
        // 서버 저장 할 일은 전용 API로 — 할 일에 전달 흔적이 남아 홈에서 완료를 추적한다
        await forwardTodo(token, serverId, staff.id);
      } else {
        // 재고·손익분기처럼 조건에서 파생된 항목은 서버에 원본이 없어 흔적을 못 남긴다.
        // 체크리스트에 넣는 것까지만 한다 (제목의 "[서류·행정] " 태그는 소음이라 뗀다).
        const label = sendTarget.title.replace(/^\[[^\]]{1,8}\]\s*/, '').trim();
        await addChecklistItem(token, label, staff.id, true);
      }
      setSendTarget(null);
      toast('알바에게 보냈어요', `${staff.name}님의 근무 체크리스트에 담았어요. 완료하면 여기서도 표시돼요.`);
      // 직원 할 일 탭을 이미 열어 봤다면 방금 보낸 항목이 바로 보이게 갱신
      if (staffTasks !== null) listChecklist(token).then(setStaffTasks).catch(() => {});
    } catch (e) {
      toast('보내기 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSendingStaffId(null);
    }
  };
  // [한글 주석] 초기 카테고리는 선택되지 않은 null 상태 (아무 카테고리 칩도 누르지 않고 등록 시 태그 없이 생성)
  const [selectedCategory, setSelectedCategory] = useState<TodoCategory | null>(null);

  // 선택된 날짜에 맞게 투두 목록 필터링 (각 요일별 개별 독립 투두 리스트)
  const dateFilteredTodos = useMemo(() => {
    // [한글 주석: 테스트용 더미 번호 항목(미션1~미션30, M1~M56 등)을 100% 깔끔 소독]
    const cleanTodos = todos.filter((t) => !/^(미션|M)\d+/i.test((t.title || '').trim()));
    if (!selectedDateInfo) return cleanTodos;
    const currentKey = selectedDateInfo.dateKey;
    return cleanTodos.filter((t) => {
      // 1) dateKey가 지정되어 있는 경우 해당 날짜와 정확히 일치할 때만 보임
      if (t.dateKey) {
        return t.dateKey === currentKey;
      }
      // 2) dateKey가 없는 기존 항목들은 오늘 날짜(isToday)에만 보임
      return selectedDateInfo.isToday;
    });
  }, [todos, selectedDateInfo]);

  // ── [한 화면에 몇 줄까지 보일지] ──
  // 브루가 자동으로 만드는 항목(재고 발주·인사이트·서류·홍보)은 많은 날 10줄이 넘는다.
  // 다 펼쳐 두면 정작 급한 게 안 읽혀서, 급한 순으로 3줄만 두고 나머지는 접는다.
  const AI_VISIBLE = 3;
  const [showAllAi, setShowAllAi] = useState(false);

  // 급한 것 → 브루 추천 → 홍보 → 내가 적은 것 → 끝낸 것 순. (JS sort는 안정 정렬이라
  // 같은 등급 안에서는 서버가 준 순서, 즉 심각한 순이 그대로 유지된다)
  const orderedTodos = useMemo(() => {
    const rank = (t: Todo) => {
      if (t.done) return 4;              // 끝낸 건 항상 맨 아래
      if (t.source !== 'ai') return 3;   // 사장님이 직접 적은 업무
      if (t.urgentLabel) return 0;       // 다 떨어짐 · 기한 지남
      if (t.action === 'marketing') return 2;
      return 1;
    };
    return [...dateFilteredTodos].sort((a, b) => rank(a) - rank(b));
  }, [dateFilteredTodos]);

  // 접기 대상은 브루 항목 중 앞 3개를 뺀 나머지 (내가 적은 업무는 절대 숨기지 않는다)
  const collapsibleAi = useMemo(
    () => orderedTodos.filter((t) => t.source === 'ai' && !t.done).slice(AI_VISIBLE),
    [orderedTodos],
  );
  const hiddenAiIds = useMemo(
    () => new Set(showAllAi ? [] : collapsibleAi.map((t) => t.id)),
    [collapsibleAi, showAllAi],
  );

  const visibleTodos = orderedTodos.filter((t) => !hiddenAiIds.has(t.id));

  const dateLabel = selectedDateInfo
    ? `${selectedDateInfo.monthNum}월 ${selectedDateInfo.dateNum}일`
    : '오늘';

  const isToday = !selectedDateInfo || selectedDateInfo.isToday;

  // 신규 등록 팝업 모달 열기 (카테고리 미선택 상태로 초기화)
  const openCreateModal = () => {
    setEditingTodo(null);
    setNewTitle('');
    setSelectedCategory(null);
    setModalVisible(true);
  };

  // 연필(수정) 버튼 클릭 시 동일한 팝업 모달을 '수정 모드'로 채워서 열기
  const startEdit = (todo: Todo) => {
    setEditingTodo(todo);
    let rawTitle = todo.title;
    let foundCat: TodoCategory | null = null;
    for (const cat of CATEGORIES) {
      if (rawTitle.startsWith(`[${cat.tag}]`)) {
        foundCat = cat.id;
        rawTitle = rawTitle.replace(`[${cat.tag}]`, '').trim();
        break;
      }
    }
    setSelectedCategory(foundCat);
    setNewTitle(rawTitle);
    setModalVisible(true);
  };

  // 모달에서 추가하기 또는 수정하기 저장 처리
  const handleSaveTodo = () => {
    const titleText = newTitle.trim();
    if (!titleText) return;

    let fullTitle = titleText;
    // [한글 주석] 사용자가 카테고리 칩을 선택한 경우에만 해당 카테고리 태그(예: [일일업무], [발주·재고])를 앞머리에 부여
    if (selectedCategory) {
      const catMeta = CATEGORIES.find((c) => c.id === selectedCategory);
      if (catMeta) {
        fullTitle = `[${catMeta.tag}] ${fullTitle}`;
      }
    }

    if (editingTodo) {
      // [한글 주석] 수정 모드일 때 해당 ID의 투두 내용 업데이트
      onEditTodo?.(editingTodo.id, fullTitle);
    } else {
      // [한글 주석] 신규 등록 모드일 때 새로 추가
      onAddTodo?.(fullTitle, selectedDateInfo?.dateKey);
    }

    setNewTitle('');
    setEditingTodo(null);
    setSelectedCategory(null);
    setModalVisible(false);
  };

  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  // 선택 날짜 변경 시 실크처럼 부드러운 패이드 + 슬라이딩 연동 애니메이션
  useEffect(() => {
    fadeAnim.setValue(0.1);
    slideAnim.setValue(14);

    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 9,
        tension: 50,
        useNativeDriver: true,
      }),
    ]).start();
  }, [selectedDateInfo?.dateKey]);

  const isPastDate = selectedDateInfo?.isPast ?? false;

  return (
    <View style={{ gap: 8 }}>
      {/* ── [내 할 일 | 직원 할 일] 탭 — 사장님 계정에서만. 직원 탭은 오늘 체크리스트를 그대로 비춘다 ── */}
      {!user?.isStaff && (
        <View style={styles.viewTabRow}>
          <Pressable
            onPress={() => setViewTab('mine')}
            style={[styles.viewTab, viewTab === 'mine' && styles.viewTabOn]}
          >
            <Ionicons name="person-outline" size={12} color={viewTab === 'mine' ? '#FFFFFF' : '#8C6F56'} />
            <Text style={[styles.viewTabText, viewTab === 'mine' && styles.viewTabTextOn]}>내 할 일</Text>
          </Pressable>
          <Pressable
            onPress={openStaffTab}
            style={[styles.viewTab, viewTab === 'staff' && styles.viewTabOn]}
          >
            <Ionicons name="people-outline" size={12} color={viewTab === 'staff' ? '#FFFFFF' : '#8C6F56'} />
            <Text style={[styles.viewTabText, viewTab === 'staff' && styles.viewTabTextOn]}>
              직원 할 일
              {staffTasks ? ` ${staffTasks.filter((t) => t.done).length}/${staffTasks.length}` : ''}
            </Text>
          </Pressable>
        </View>
      )}

      {/* ── [직원 할 일 패널] 오늘 체크리스트 — 담당·완료·누가 했는지까지 홈에서 바로 ── */}
      {viewTab === 'staff' && (
        <View style={{ gap: 6 }}>
          {staffTasks === null ? (
            <Text style={styles.staffTaskHint}>불러오는 중…</Text>
          ) : staffTasks.length === 0 ? (
            <View style={styles.emptyStateContainer}>
              <Ionicons name="checkmark-done-outline" size={24} color="#A1A1AA" />
              <Text style={styles.emptyStateText}>
                등록된 근무 체크리스트가 없어요.{'\n'}체크리스트 화면에서 루틴을 등록해 보세요.
              </Text>
            </View>
          ) : (
            <>
            {/* 직원별 완료 현황 — 누르면 그 직원 항목만 모아 본다 (다시 누르면 해제).
                다 끝낸 직원은 초록으로 바뀌어 "오늘 몫을 끝냈다"가 멀리서도 보인다. */}
            {staffProgress.length > 1 && (
              <View style={styles.staffProgRow}>
                {staffProgress.map((p) => {
                  const on = staffPanelFilter === p.name;
                  const complete = p.done === p.total;
                  return (
                    <Pressable
                      key={p.name}
                      onPress={() => setStaffPanelFilter(on ? null : p.name)}
                      style={[
                        styles.staffProgChip,
                        complete && styles.staffProgChipDone,
                        on && styles.staffProgChipOn,
                      ]}
                    >
                      <Text style={[styles.staffProgName, on && styles.staffProgTextOn]}>{p.name}</Text>
                      <Text
                        style={[
                          styles.staffProgCount,
                          complete && { color: '#3E9B4F' },
                          on && styles.staffProgTextOn,
                        ]}
                      >
                        {p.done}/{p.total}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {(visibleStaffTasks ?? []).map((it) => (
              <Pressable
                key={it.id}
                onPress={() => toggleStaffTask(it)}
                disabled={staffTaskBusyId === it.id}
                style={[styles.taskCardItem, it.done && styles.itemDone]}
              >
                <Ionicons
                  name={it.done ? 'checkmark-circle' : 'ellipse-outline'}
                  size={23}
                  color={it.done ? colors.espressoBrown : '#C4B5A5'}
                />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={[styles.taskItemTitle, it.done && styles.strike]} numberOfLines={2}>
                    {it.label}
                  </Text>
                  {(!!it.assigned_staff_name || it.one_off || (it.done && !!it.done_by)) && (
                    <Text style={styles.taskItemMeta} numberOfLines={1}>
                      {[
                        it.assigned_staff_name && `담당 · ${it.assigned_staff_name}`,
                        it.one_off && '오늘만',
                        it.done && it.done_by && `✓ ${it.done_by}`,
                      ]
                        .filter(Boolean)
                        .join('  ·  ')}
                    </Text>
                  )}
                </View>
              </Pressable>
            ))}
            </>
          )}
          {/* 항목 관리(추가·수정·담당 변경)는 체크리스트 화면이 원본 — 여기선 보기·체크만 */}
          <TouchableOpacity
            onPress={() => navigation.navigate('Checklist')}
            style={styles.moreRow}
            hitSlop={{ top: 6, bottom: 6 }}
            activeOpacity={0.7}
          >
            <Text style={styles.moreText}>근무 체크리스트 관리</Text>
            <Ionicons name="chevron-forward" size={12} color="#8C6F56" />
          </TouchableOpacity>
        </View>
      )}

      {/* ── [통합 업무 목록 (날짜 변경 시 부드러운 패이드+슬라이딩 전환)] ── */}
      {viewTab === 'mine' && (
      <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
        {dateFilteredTodos.length === 0 ? (
          /* [한글 주석] 해당 날짜에 등록된 업무가 없을 때 깔끔하게 안내하는 빈 뷰 */
          <View style={styles.emptyStateContainer}>
            <Ionicons
              name={isPastDate ? "calendar-clear-outline" : "sparkles-outline"}
              size={24}
              color="#A1A1AA"
            />
            <Text style={styles.emptyStateText}>
              {isPastDate
                ? `${dateLabel}에는 기록된 업무가 없습니다`
                : `${dateLabel} 진행할 업무를 새로 등록해 보세요`}
            </Text>
          </View>
        ) : (
          visibleTodos.map((todo) => {
            const disabled = !!todo.done;

            return (
              <SlideUp key={todo.id}>
                <TodoItem
                  todo={todo}
                  isPastDate={isPastDate}
                  onPressAction={onPressAction}
                  onToggleDone={onToggleDone}
                  onDeleteTodo={onDeleteTodo}
                  disabled={disabled}
                  startEdit={startEdit}
                  onPromoPress={openPromoPicker}
                  onSendToStaff={staffList.length > 0 ? (t) => setSendTarget(t) : undefined}
                />
              </SlideUp>
            );
          })
        )}

        {/* 접어 둔 브루 항목 — 줄 수를 늘리지 않게 링크 한 줄로만 */}
        {collapsibleAi.length > 0 && (
          <TouchableOpacity
            onPress={() => setShowAllAi((v) => !v)}
            style={styles.moreRow}
            hitSlop={{ top: 6, bottom: 6 }}
            activeOpacity={0.7}
          >
            <Text style={styles.moreText}>
              {showAllAi ? '간단히 보기' : `${collapsibleAi.length}개 더 보기`}
            </Text>
            <Ionicons
              name={showAllAi ? 'chevron-up' : 'chevron-down'}
              size={12}
              color="#8C6F56"
            />
          </TouchableOpacity>
        )}
      </Animated.View>
      )}

      {/* ── [한 줄 가로 정렬: 메인 새 업무 등록하기 + ✨ 브루 추천 미니 칩] ── */}
      {viewTab === 'mine' && !isPastDate && (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <PressableScale
            onPress={openCreateModal}
            style={[styles.openModalBtn, { flex: 1, height: 42, paddingVertical: 0 }]}
            to={0.96}
          >
            <Ionicons name="add-circle" size={17} color="#FFFFFF" />
            <Text style={styles.openModalBtnText}>새 업무 등록하기</Text>
          </PressableScale>

          {onRestoreAiTodos && (
            <PressableScale
              onPress={onRestoreAiTodos}
              style={{
                height: 42,
                paddingHorizontal: 12,
                borderRadius: 14,
                backgroundColor: 'rgba(245, 239, 232, 0.9)',
                borderWidth: 1,
                borderColor: 'rgba(226, 215, 199, 0.9)',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
              to={0.94}
            >
              <Ionicons name="sparkles" size={13} color="#8C6F56" />
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#5B4333' }}>
                브루 추천
              </Text>
            </PressableScale>
          )}
        </View>
      )}

      {/* ── [홍보할 메뉴 고르기 모달] 등록된 전체 메뉴에서 선택 → 홍보 스튜디오로 이동 ── */}
      <Modal
        visible={promoPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPromoPickerOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdropPress} onPress={() => setPromoPickerOpen(false)} />
          <SlideUp style={styles.promoPickerCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="megaphone" size={15} color="#8C6F56" />
              <Text style={styles.promoPickerTitle}>홍보할 메뉴 고르기</Text>
            </View>
            <Text style={styles.promoPickerSub}>
              고르면 홍보 스튜디오에 메뉴가 자동 입력돼요
            </Text>
            {promoMenus === null ? (
              <Text style={styles.promoPickerEmpty}>메뉴를 불러오는 중…</Text>
            ) : promoMenus.length === 0 ? (
              <Text style={styles.promoPickerEmpty}>
                등록된 메뉴가 없어요. 메뉴 관리에서 먼저 메뉴를 등록해 주세요.
              </Text>
            ) : (
              // [한글 주석] 고정 320 은 세로가 짧은 기기(가로모드·플립)에서 하단 버튼을 밀어냈다 → 뷰포트 비례
              <ScrollView style={{ maxHeight: Math.min(vh(42), 320) }} showsVerticalScrollIndicator={false}>
                {promoMenus.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.promoMenuRow}
                    onPress={() => pickPromoMenu(m.name)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.promoMenuName} numberOfLines={1}>{m.name}</Text>
                    <Text style={styles.promoMenuPrice}>₩{m.selling_price.toLocaleString()}</Text>
                    <Ionicons name="chevron-forward" size={14} color="#8C6F56" />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </SlideUp>
        </View>
      </Modal>

      {/* ── [알바에게 보내기 모달] 담당 알바를 고르면 그 알바의 근무 체크리스트로 넘어간다 ── */}
      <Modal
        visible={sendTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSendTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdropPress} onPress={() => setSendTarget(null)} />
          <SlideUp style={styles.promoPickerCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="paper-plane" size={15} color="#8C6F56" />
              <Text style={styles.promoPickerTitle}>알바에게 보내기</Text>
            </View>
            <Text style={styles.promoPickerSub} numberOfLines={2}>
              “{(sendTarget?.title ?? '').replace(/^\[[^\]]{1,8}\]\s*/, '')}” — 고른 알바의 근무
              체크리스트에 담겨요. 완료하면 다음 날 자동으로 사라져요.
            </Text>
            <ScrollView style={{ maxHeight: Math.min(vh(42), 320) }} showsVerticalScrollIndicator={false}>
              {staffList.map((st) => (
                <TouchableOpacity
                  key={st.id}
                  style={styles.promoMenuRow}
                  onPress={() => sendTodoToStaff(st)}
                  activeOpacity={0.8}
                  disabled={sendingStaffId !== null}
                >
                  <Ionicons name="person-circle-outline" size={18} color="#8C6F56" />
                  <Text style={[styles.promoMenuName, { marginLeft: 6 }]} numberOfLines={1}>
                    {st.name}
                  </Text>
                  {sendingStaffId === st.id ? (
                    <Text style={styles.promoMenuPrice}>보내는 중…</Text>
                  ) : (
                    <Ionicons name="chevron-forward" size={14} color="#8C6F56" />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SlideUp>
        </View>
      </Modal>

      {/* ── [iOS 팝업 모달 다이얼로그: 새 업무 등록 / 업무 수정 통합 모달] ── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.modalBackdropPress}
            onPress={() => setModalVisible(false)}
          />
          
          <SlideUp style={styles.modalContainer}>
            {/* 모달 헤더 - [한글 주석] 등록/수정 모드에 따라 타이틀('업무 등록' / '업무 수정') 자동 변경 */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalDateText}>
                  {dateLabel} ({selectedDateInfo?.dayName || '오늘'})
                </Text>
                <Text style={styles.modalTitle}>{editingTodo ? '업무 수정' : '업무 등록'}</Text>
              </View>
              <PressableScale
                onPress={() => setModalVisible(false)}
                style={styles.modalCloseBtn}
                to={0.88}
              >
                <Ionicons name="close" size={16} color="#52525B" />
              </PressableScale>
            </View>

            {/* [한글 주석] 군더더기 '카테고리 선택' 라벨 제거 후 쫀득한 물방울 스프링 칩 그리드배치 */}
            <View style={styles.modalCategoryGrid}>
              {CATEGORIES.map((cat) => (
                <CategoryChipCell
                  key={cat.id}
                  cat={cat}
                  isSelected={selectedCategory === cat.id}
                  onPress={() => setSelectedCategory((prev) => (prev === cat.id ? null : cat.id))}
                />
              ))}
            </View>

            {/* 업무 제목 입력 */}
            <Text style={styles.inputFieldLabel}>업무 제목</Text>
            <TextInput
              style={styles.modalTextInput}
              placeholder="예: 에스프레소 머신 수압 체크, 우유 10L 발주"
              placeholderTextColor="#A1A1AA"
              value={newTitle}
              onChangeText={setNewTitle}
              autoFocus
            />

            {/* 모달 하단 액션 버튼 */}
            <View style={styles.modalActionRow}>
              <PressableScale
                onPress={() => setModalVisible(false)}
                style={styles.modalCancelBtn}
                to={0.95}
              >
                <Text style={styles.modalCancelText}>취소</Text>
              </PressableScale>
              <PressableScale
                onPress={handleSaveTodo}
                style={[
                  styles.modalSubmitBtn,
                  !newTitle.trim() && { opacity: 0.5 },
                ]}
                disabled={!newTitle.trim()}
                to={0.95}
              >
                <Text style={styles.modalSubmitText}>
                  {editingTodo ? '업무 수정하기' : '업무 추가하기'}
                </Text>
              </PressableScale>
            </View>
          </SlideUp>
        </View>
      </Modal>
    </View>
  );
}

// ── [개별 할 일 아이템 컴포넌트 — 쫀득한 젤리 탄성 Checkbox 적용] ──
function TodoItem({
  todo,
  isPastDate,
  onPressAction,
  onToggleDone,
  onDeleteTodo,
  disabled,
  startEdit,
  onPromoPress,
  onSendToStaff,
}: {
  todo: Todo;
  isPastDate?: boolean;
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onDeleteTodo?: (id: string) => void;
  disabled: boolean;
  startEdit: (todo: Todo) => void;
  onPromoPress?: () => void;
  // 알바에게 보내기 — 사장님 계정에서만 내려온다 (없으면 버튼 자체가 안 보인다)
  onSendToStaff?: (todo: Todo) => void;
}) {
  const animX = useRef(new Animated.Value(0)).current;
  const animOpacity = useRef(new Animated.Value(1)).current;
  const checkScale = useRef(new Animated.Value(1)).current;
  const cardScale = useRef(new Animated.Value(1)).current;
  // 제목은 '무엇을 할지'만 남긴다.
  // - "[일일업무] 머신 청소"의 앞 태그는 떼어서 아래 회색 줄로 내린다 (제목이 길어지는 주범)
  // - 구버전 서버 응답·DB에 남은 "… — 오늘 발주하세요" 형태의 대시는 잘라내 한 줄로
  const tagMatch = todo.title.match(/^\[([^\]]{1,8})\]\s*/);
  const displayTitle = todo.title
    .replace(/^\[[^\]]{1,8}\]\s*/, '')
    .split(/\s+[—–-]\s+/)[0]
    .trim();
  // 회색 보조줄: 서버가 준 근거(meta)가 우선, 없으면 사장님이 고른 카테고리 태그
  const metaText = todo.meta || tagMatch?.[1];

  const handleToggle = () => {
    // [한글 주석: 산디과 감성 과하지 않고 쫀득한 명품 절제형 Bouncy Spring 완료 인터랙션]
    Animated.sequence([
      Animated.parallel([
        Animated.timing(checkScale, { toValue: 0.85, duration: 70, useNativeDriver: true }),
        Animated.timing(cardScale, { toValue: 0.985, duration: 70, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.spring(checkScale, {
          toValue: 1.15,
          friction: 5,
          tension: 240,
          useNativeDriver: true,
        }),
        Animated.spring(cardScale, {
          toValue: 1.01,
          friction: 5,
          tension: 200,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.spring(checkScale, {
          toValue: 1,
          friction: 6,
          tension: 180,
          useNativeDriver: true,
        }),
        Animated.spring(cardScale, {
          toValue: 1,
          friction: 6,
          tension: 180,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    onToggleDone?.(todo.id);
  };

  const handleDelete = () => {
    Animated.parallel([
      Animated.timing(animX, {
        toValue: -400,
        duration: 320,
        useNativeDriver: true,
      }),
      Animated.timing(animOpacity, {
        toValue: 0,
        duration: 280,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDeleteTodo?.(todo.id);
    });
  };

  return (
    <Animated.View style={{ transform: [{ translateX: animX }, { scale: cardScale }], opacity: animOpacity }}>
      <PressableScale
        disabled={disabled || !todo.actionable}
        onPress={() => onPressAction(todo)}
        style={[
          styles.taskCardItem,
          // 급한 항목만 왼쪽 띠를 빨갛게 — 배지 대신 색으로 알려서 글자를 늘리지 않는다
          !!todo.urgentLabel && !disabled && styles.itemUrgent,
          disabled && styles.itemDone,
        ]}
      >
        {/* [1. 쫀득하게 튕겨 올라가는 체크박스 아이콘] */}
        <Animated.View style={{ transform: [{ scale: checkScale }] }}>
          <Pressable
            onPress={handleToggle}
            style={styles.checkTouch}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={disabled ? 'checkmark-circle' : 'ellipse-outline'}
              size={23}
              color={disabled ? colors.espressoBrown : '#C4B5A5'}
            />
          </Pressable>
        </Animated.View>

        {/* [2. 제목 한 줄 + 회색 근거 한 줄 — 두 층으로만 읽히게] */}
        <View style={{ flex: 1, marginLeft: 8 }}>
          {/* 브루 항목은 이미 짧은 라벨이라 한 줄 고정, 직접 적은 업무는 잘리지 않게 두 줄까지 */}
          <Text
            style={[styles.taskItemTitle, disabled && styles.strike]}
            numberOfLines={todo.source === 'ai' ? 1 : 2}
          >
            {displayTitle}
          </Text>
          {/* 근거 한 줄 — 급한 항목은 빨간 글씨로 (배지를 없앤 자리) */}
          {!!metaText && (
            <Text
              style={[
                styles.taskItemMeta,
                !!todo.urgentLabel && !disabled && styles.taskItemMetaUrgent,
                disabled && styles.taskItemMetaDone,
              ]}
              numberOfLines={1}
            >
              {metaText}
            </Text>
          )}
          {/* 홍보 추천 항목 — 누르면 등록된 전체 메뉴에서 홍보할 메뉴를 고르는 모달이 열린다 */}
          {todo.action === 'marketing' && !disabled && (
            <TouchableOpacity
              onPress={() => onPromoPress?.()}
              style={styles.promoLink}
              hitSlop={{ top: 6, bottom: 6 }}
            >
              <Ionicons name="megaphone-outline" size={11} color="#8C6F56" />
              <Text style={styles.promoLinkText}>홍보할 메뉴 고르기 ›</Text>
            </TouchableOpacity>
          )}
          {/* 재고 항목 — 카드를 누르면 그 재료로 가지만, 표시가 없으면 누를 수 있는 걸 모른다.
              (홍보 항목과 달리 링크 자체는 장식이고 실제 이동은 카드 전체가 처리한다) */}
          {todo.id.startsWith('stock-') && !disabled && (
            <View style={styles.promoLink} pointerEvents="none">
              <Ionicons name="file-tray-stacked-outline" size={11} color="#8C6F56" />
              <Text style={styles.promoLinkText}>재고 보기 ›</Text>
            </View>
          )}
          {/* 손익분기 미션 — 목표 숫자가 어떻게 나왔는지 눌러서 볼 수 있다는 표시
              (재고 항목과 마찬가지로 실제 이동은 카드 전체가 처리한다) */}
          {todo.id === 'breakeven-daily' && !disabled && (
            <View style={styles.promoLink} pointerEvents="none">
              <Ionicons name="calculator-outline" size={11} color="#8C6F56" />
              <Text style={styles.promoLinkText}>손익분기점 보기 ›</Text>
            </View>
          )}
          {/* 알바에게 보낸 항목 — 전달·완료 상태를 사장님이 여기서 바로 본다.
              완료(체크리스트 쪽에서 체크됨)면 초록으로 바뀐다. */}
          {!!todo.forwardedTo && (
            <View style={styles.promoLink} pointerEvents="none">
              <Ionicons
                name={todo.forwardedDone ? 'checkmark-circle' : 'paper-plane-outline'}
                size={11}
                color={todo.forwardedDone ? '#3E9B4F' : '#8C9BAB'}
              />
              <Text style={[styles.promoLinkText, { color: todo.forwardedDone ? '#3E9B4F' : '#8C9BAB' }]}>
                {todo.forwardedTo}
                {todo.forwardedDone ? ' 완료' : '에게 전달됨'}
              </Text>
            </View>
          )}
        </View>

        {/* [3. 우측 액션: 수정·삭제 — 지난 날짜(isPastDate)일 때만 숨김] */}
        {!isPastDate && (
          <View style={styles.actionsRight}>
            {/* 알바에게 보내기 — 이 할 일을 담당 지정해 근무 체크리스트로 넘긴다.
                핸들러가 있을 때만 보인다 (사장님 계정 + 등록된 알바 계정이 있을 때) */}
            {onSendToStaff && !disabled && (
              <PressableScale onPress={() => onSendToStaff(todo)} style={styles.iconBtn} to={0.85}>
                <Ionicons name="paper-plane-outline" size={14} color="#8C9BAB" />
              </PressableScale>
            )}

            {/* 수정 — 브루가 만든 항목도 고칠 수 있다. 고치는 순간 내 업무로 바뀌어 서버에 저장된다 */}
            <PressableScale onPress={() => startEdit(todo)} style={styles.iconBtn} to={0.85}>
              <Ionicons name="pencil-outline" size={14} color="#A79C92" />
            </PressableScale>

            {/* 삭제 */}
            <PressableScale onPress={handleDelete} style={styles.iconBtn} to={0.85}>
              <Ionicons name="trash-outline" size={14} color="#E07A7A" />
            </PressableScale>
          </View>
        )}
      </PressableScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // [내 할 일 | 직원 할 일] 탭 — 카테고리 칩과 구분되게 알약 두 개만 나란히
  viewTabRow: { flexDirection: 'row', gap: 6 },
  viewTab: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14,
    backgroundColor: 'rgba(245, 239, 232, 0.9)',
    borderWidth: 1, borderColor: 'rgba(226, 215, 199, 0.9)',
  },
  viewTabOn: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  viewTabText: { fontSize: 11.5, fontWeight: '700', color: '#5B4333' },
  viewTabTextOn: { color: '#FFFFFF' },
  staffTaskHint: { fontSize: 12, color: '#8C827A', textAlign: 'center', paddingVertical: 16 },
  // 직원별 완료 현황 칩 — 이름 + n/m. 완료(n=m)면 초록 테두리, 선택하면 갈색 채움.
  staffProgRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 2 },
  staffProgChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12,
    backgroundColor: '#FFFDF9', borderWidth: 1, borderColor: '#E9E2D8',
  },
  staffProgChipDone: { borderColor: 'rgba(62,155,79,0.45)', backgroundColor: 'rgba(62,155,79,0.06)' },
  staffProgChipOn: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  staffProgName: { fontSize: 11.5, fontWeight: '700', color: '#5B4333' },
  staffProgCount: { fontSize: 11.5, fontWeight: '800', color: '#8C6F56' },
  staffProgTextOn: { color: '#FFFFFF' },
  emptyStateContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
    backgroundColor: '#FFFDF9',
    borderRadius: 18,
    borderWidth: 1.2,
    borderColor: '#EFECE6',
    borderStyle: 'dashed',
    gap: 6,
    marginBottom: 4,
  },
  emptyStateText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8C827A',
    textAlign: 'center',
  },

  // 트리거 버튼
  openModalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.espressoBrown,
    borderRadius: 18,
    paddingVertical: 14,
    marginTop: 6,
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
  },
  openModalBtnText: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.3,
  },

  // 모달 레이아웃
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalBackdropPress: {
    ...StyleSheet.absoluteFillObject,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 350,
    backgroundColor: '#FFFDF9',
    borderRadius: 22,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
    gap: 10,
    borderWidth: 1,
    borderColor: '#EFECE6',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  modalDateText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8C827A',
    marginBottom: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#2C221E',
    letterSpacing: -0.5,
  },
  modalSub: {
    fontSize: 11,
    fontWeight: '500',
    color: '#8C827A',
    marginTop: 2,
  },
  modalCloseBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#F4F1EA',
    justifyContent: 'center',
    alignItems: 'center',
  },

  inputFieldLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#3F3F46',
    marginTop: 2,
  },

  // 모달 카테고리 (2x2 대칭 세련된 그리드)
  modalCategoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  modalCatChip: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#F4F1EA',
    borderRadius: 10,
    paddingVertical: 8,
  },
  modalCatChipActive: {
    backgroundColor: colors.espressoBrown,
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  modalCatChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#71717A',
  },
  modalCatChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },

  // 텍스트 입력창
  modalTextInput: {
    height: 38,
    backgroundColor: '#F4F1EA',
    borderRadius: 12,
    paddingHorizontal: 11,
    fontSize: 11.5,
    fontWeight: '600',
    color: '#2C221E',
  },

  // 액션 버튼
  modalActionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  modalCancelBtn: {
    flex: 1,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#F4F1EA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#71717A',
  },
  modalSubmitBtn: {
    flex: 2,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.espressoBrown,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalSubmitText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFFFFF',
  },

  // 메모장 감성 투두 할 일 항목 카드
  taskCardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    ...glassSurface, // 리퀴드 글라스 — 크림 메모지 단색 대신 유리 표면
    borderRadius: radius.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 6,   // 줄 사이를 좁혀 목록이 한눈에 들어오게
    // 테두리 없음(radius·shadows 토큰 통일) — 좌측 마진 라인만 메모지 정체성으로 남긴다
    borderLeftWidth: 3,
    borderLeftColor: colors.espressoBrown,
    ...shadows.soft,
  },
  itemUrgent: {
    borderLeftColor: '#DC2626',   // 다 떨어짐 · 기한 지남
  },
  itemDone: {
    backgroundColor: '#F5F2EB', // 완료 시 차분한 에이징 노트 배경
    borderLeftColor: colors.espressoBrown, // 완료 시 클래식 에스프레소 갈색 라인
    borderColor: '#E7E2D8',
    opacity: 0.75,
  },
  checkTouch: {
    padding: 2,
    marginRight: 2,
  },
  taskIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  taskItemTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#2C221E', // 에스프레소 잉크 톤
    letterSpacing: -0.3,
    flexShrink: 1,   // 옆의 '브루' 배지에 밀려 잘리지 않고 줄바꿈되도록
    lineHeight: 18,  // 두 줄일 때 답답하지 않게
  },
  taskItemSub: {
    fontSize: 11.5,
    fontWeight: '500',
    color: '#8C827A',
    flexShrink: 1,
  },
  // 제목 아래 근거 줄 (다 떨어짐 · 최소 5kg 필요)
  taskItemMeta: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9A8E84',
    letterSpacing: -0.2,
    marginTop: 1.5,
  },
  taskItemMetaUrgent: {
    color: '#DC2626',
  },
  taskItemMetaDone: {
    color: '#B5ABA2',
  },
  // 접어 둔 브루 항목 펼치기 링크
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
    marginBottom: 2,
  },
  moreText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#8C6F56',
  },
  strike: {
    textDecorationLine: 'line-through',
    color: '#8C827A',
    textDecorationColor: colors.espressoBrown, // 에스프레소 갈색 취소선
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // ('브루' 보라색 배지는 뺐다 — 자동 항목 거의 전부에 붙어서 글자만 늘렸다.
  //  브루가 만든 항목인지는 목록 순서와 '더 보기' 줄로 충분히 구분된다)
  // 브루 홍보 추천 항목의 '홍보하러 가기' 링크
  promoLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 3,
    alignSelf: 'flex-start',
  },
  promoLinkText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8C6F56',
    textDecorationLine: 'underline',
  },
  // 홍보할 메뉴 고르기 모달
  promoPickerCard: {
    width: '86%',
    maxWidth: 360,
    borderRadius: radius.md,
    padding: 18,
    ...shadows.medium,
    ...glassSurface, // 리퀴드 글라스 — 모달 카드도 유리 표면 (테두리 없음)
  },
  promoPickerTitle: { fontSize: 15.5, fontWeight: '900', color: colors.espressoBrown },
  promoPickerSub: { fontSize: 11.5, fontWeight: '600', color: colors.mochaBrown, marginBottom: 10 },
  promoPickerEmpty: { fontSize: 12, color: colors.mochaBrown, paddingVertical: 16, textAlign: 'center' },
  promoMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(60, 60, 67, 0.08)',
  },
  promoMenuName: { flex: 1, fontSize: 13.5, fontWeight: '700', color: colors.espressoBrown },
  promoMenuPrice: { fontSize: 12, fontWeight: '600', color: colors.mochaBrown },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
  },

  // 발주 칩 & 완료 배지 (에스프레소 갈색 톤 통합)
  actionHint: {
    backgroundColor: 'rgba(110, 85, 68, 0.12)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
  },
  actionHintText: {
    fontSize: 9.5,
    color: colors.espressoBrown,
    fontWeight: '800',
    letterSpacing: -0.1,
  },
  doneBadge: {
    backgroundColor: '#DCFCE7',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  doneBadgeText: {
    fontSize: 10,
    color: '#16A34A',
    fontWeight: '800',
  },

  // 인라인 수정
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editInput: {
    flex: 1,
    height: 32,
    backgroundColor: '#F4F1EA',
    borderRadius: 8,
    paddingHorizontal: 8,
    fontSize: 12,
    fontWeight: '700',
    color: '#2C221E',
  },
  iconBtn: {
    padding: 5,   // 손가락으로 눌러도 빗나가지 않게 (아이콘은 작게, 터치 영역은 넉넉히)
  },
});
