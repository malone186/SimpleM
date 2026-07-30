// 할 일 목록 (Design Spec §4-③ 연동 — iOS 팝업 모달 기반 새 업무 등록 UI)
import { useEffect, useRef, useState, useMemo } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { PopIn, PressableScale, SlideUp } from '../motion';
import { type DateInfo } from './SalesCard';

export type TodoCategory = 'order' | 'hygiene' | 'admin' | 'daily';

export type Todo = {
  id: string;
  title: string;
  subtitle: string;
  actionable?: boolean; // [한글 주석] 누르면 동작하는 항목 (예: 재고 부족 → 브루 챗봇 열기)
  chatPrefill?: string; // [한글 주석] 누르면 챗봇 입력창에 미리 채워 보낼 질문
  done?: boolean;
  qty?: string;
  // [한글 주석] 누가 넣었는지 — 'ai'면 챗봇(브루)이 대화 중 추가한 항목이라 배지를 붙인다.
  source?: 'owner' | 'ai';
  timeGroup?: string;
  dateKey?: string;
  category?: TodoCategory;
};

const CATEGORIES: { id: TodoCategory; label: string; icon: string; tag: string }[] = [
  { id: 'daily', label: '일일업무', icon: 'cafe-outline', tag: '일일업무' },
  { id: 'order', label: '발주·재고', icon: 'cart-outline', tag: '발주·재고' },
  { id: 'hygiene', label: '위생·청소', icon: 'sparkles-outline', tag: '위생·청소' },
  { id: 'admin', label: '서류·행정', icon: 'document-text-outline', tag: '서류·행정' },
];

function getCategoryMeta(todo: Todo): { label: string; icon: string; color: string; bg: string } {
  const text = (todo.title + ' ' + todo.subtitle).toLowerCase();
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
}: {
  todos: Todo[];
  selectedDateInfo?: DateInfo;
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onAddTodo?: (title: string, dateKey?: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
  hideCard?: boolean;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSub, setNewSub] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<TodoCategory>('daily');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  // 선택된 날짜에 맞게 투두 목록 필터링 (각 요일별 개별 독립 투두 리스트)
  const dateFilteredTodos = useMemo(() => {
    if (!selectedDateInfo) return todos;
    const currentKey = selectedDateInfo.dateKey;
    return todos.filter((t) => {
      // 1) dateKey가 지정되어 있는 경우 해당 날짜와 정확히 일치할 때만 보임
      if (t.dateKey) {
        return t.dateKey === currentKey;
      }
      // 2) dateKey가 없는 기존 항목들은 오늘 날짜(isToday)에만 보임
      return selectedDateInfo.isToday;
    });
  }, [todos, selectedDateInfo]);

  const dateLabel = selectedDateInfo
    ? `${selectedDateInfo.monthNum}월 ${selectedDateInfo.dateNum}일`
    : '오늘';

  const isToday = !selectedDateInfo || selectedDateInfo.isToday;

  const handleCreateTodo = () => {
    // [한글 주석] 업무 제목이 비어있으면 세부 메모 내용을 제목으로 자동 사용하여 등록 실패 방지
    const titleText = newTitle.trim() || newSub.trim();
    if (!titleText) return;

    const catMeta = CATEGORIES.find((c) => c.id === selectedCategory);
    let fullTitle = titleText;
    if (selectedCategory !== 'daily' && catMeta) {
      fullTitle = `[${catMeta.tag}] ${fullTitle}`;
    }
    // [한글 주석] 제목과 메모가 둘 다 존재할 경우에만 연결 기호(·) 추가
    if (newTitle.trim() && newSub.trim()) {
      fullTitle += ` · ${newSub.trim()}`;
    }

    // 선택된 요일의 dateKey를 함께 전달하여 해당 날짜에만 귀속되도록 처리
    onAddTodo?.(fullTitle, selectedDateInfo?.dateKey);
    setNewTitle('');
    setNewSub('');
    setSelectedCategory('daily');
    setModalVisible(false);
  };

  const startEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setEditingText(todo.title);
  };

  const saveEdit = (id: string) => {
    if (editingText.trim() && onEditTodo) {
      onEditTodo(id, editingText.trim());
    }
    setEditingId(null);
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

  return (
    <View style={{ gap: 8 }}>
      {/* ── [통합 업무 목록 (날짜 변경 시 부드러운 패이드+슬라이딩 전환)] ── */}
      <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
        {dateFilteredTodos.map((todo) => {
          const disabled = !!todo.done;
          const isEditing = editingId === todo.id;

          return (
            <SlideUp key={todo.id}>
              <TodoItem
                todo={todo}
                onPressAction={onPressAction}
                onToggleDone={onToggleDone}
                onEditTodo={onEditTodo}
                onDeleteTodo={onDeleteTodo}
                disabled={disabled}
                isEditing={isEditing}
                startEdit={startEdit}
                editingText={editingText}
                setEditingText={setEditingText}
                saveEdit={saveEdit}
                setEditingId={setEditingId}
              />
            </SlideUp>
          );
        })}
      </Animated.View>

      {/* ── [새 업무 등록 모달 오픈 트리거 버튼 - 단일 깔끔 아이콘] ── */}
      <PressableScale
        onPress={() => setModalVisible(true)}
        style={styles.openModalBtn}
        to={0.96}
      >
        <Ionicons name="add-circle" size={18} color="#FFFFFF" />
        <Text style={styles.openModalBtnText}>새 업무 등록하기</Text>
      </PressableScale>

      {/* ── [iOS 팝업 모달 다이얼로그: 새 업무 등록] ── */}
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
            {/* 모달 헤더 - [한글 주석] 군더더기 수식어('새 매장', '진행 업무' 등)를 없애고 날짜와 '업무 등록'만 깔끔하게 표기 */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalDateText}>
                  {dateLabel} ({selectedDateInfo?.dayName || '오늘'})
                </Text>
                <Text style={styles.modalTitle}>업무 등록</Text>
              </View>
              <PressableScale
                onPress={() => setModalVisible(false)}
                style={styles.modalCloseBtn}
                to={0.88}
              >
                <Ionicons name="close" size={16} color="#52525B" />
              </PressableScale>
            </View>

            {/* 업무 카테고리 선택 칩 (2x2 세련된 그리드 배치) */}
            <Text style={styles.inputFieldLabel}>카테고리 선택</Text>
            <View style={styles.modalCategoryGrid}>
              {CATEGORIES.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <PressableScale
                    key={cat.id}
                    onPress={() => setSelectedCategory(cat.id)}
                    style={[styles.modalCatChip, isSelected && styles.modalCatChipActive]}
                    to={0.94}
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
                );
              })}
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

            {/* 세부 내용 / 메모 입력 (선택) */}
            <Text style={styles.inputFieldLabel}>세부 메모 (선택)</Text>
            <TextInput
              style={styles.modalTextInput}
              placeholder="예: 마감 전 소독 후 인증 사진 촬영"
              placeholderTextColor="#A1A1AA"
              value={newSub}
              onChangeText={setNewSub}
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
                onPress={handleCreateTodo}
                style={[
                  styles.modalSubmitBtn,
                  !newTitle.trim() && !newSub.trim() && { opacity: 0.5 },
                ]}
                disabled={!newTitle.trim() && !newSub.trim()}
                to={0.95}
              >
                <Text style={styles.modalSubmitText}>업무 추가하기</Text>
              </PressableScale>
            </View>
          </SlideUp>
        </View>
      </Modal>
    </View>
  );
}

// ── [개별 할 일 아이템 컴포넌트] ──
function TodoItem({
  todo,
  onPressAction,
  onToggleDone,
  onEditTodo,
  onDeleteTodo,
  disabled,
  isEditing,
  startEdit,
  editingText,
  setEditingText,
  saveEdit,
  setEditingId,
}: {
  todo: Todo;
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
  disabled: boolean;
  isEditing: boolean;
  startEdit: (todo: Todo) => void;
  editingText: string;
  setEditingText: (val: string) => void;
  saveEdit: (id: string) => void;
  setEditingId: (id: string | null) => void;
}) {
  const animX = useRef(new Animated.Value(0)).current;
  const animOpacity = useRef(new Animated.Value(1)).current;

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

  const catMeta = getCategoryMeta(todo);

  return (
    <Animated.View style={{ transform: [{ translateX: animX }], opacity: animOpacity }}>
      <PressableScale
        disabled={disabled || !todo.actionable}
        onPress={() => onPressAction(todo)}
        style={[styles.taskCardItem, disabled && styles.itemDone]}
      >
        {/* [1. 체크박스 아이콘] */}
        <PressableScale
          onPress={() => onToggleDone && onToggleDone(todo.id)}
          style={styles.checkTouch}
          to={0.85}
        >
          <Ionicons
            name={disabled ? 'checkmark-circle' : 'ellipse-outline'}
            size={22}
            color={disabled ? '#16A34A' : '#D4D4D8'}
          />
        </PressableScale>

        {/* [2. 카테고리 소형 아이콘 뱃지] */}
        <View style={[styles.taskIconBadge, { backgroundColor: disabled ? '#F4F4F5' : catMeta.bg }]}>
          <Ionicons
            name={catMeta.icon as any}
            size={14}
            color={disabled ? '#71717A' : catMeta.color}
          />
        </View>

        {/* [3. 타이틀 및 하단 조그마한 카테고리 텍스트 라벨] */}
        <View style={{ flex: 1, marginLeft: 10 }}>
          {isEditing ? (
            <View style={styles.editRow}>
              <TextInput
                style={styles.editInput}
                value={editingText}
                onChangeText={setEditingText}
                autoFocus
                onSubmitEditing={() => saveEdit(todo.id)}
              />
              <PressableScale onPress={() => saveEdit(todo.id)} style={styles.iconBtn}>
                <Ionicons name="checkmark" size={16} color="#16A34A" />
              </PressableScale>
              <PressableScale onPress={() => setEditingId(null)} style={styles.iconBtn}>
                <Ionicons name="close" size={16} color="#71717A" />
              </PressableScale>
            </View>
          ) : (
            <>
              <View style={styles.titleRow}>
                <Text style={[styles.taskItemTitle, disabled && styles.strike]} numberOfLines={1}>
                  {todo.title}
                </Text>
                {/* AI 출처 배지 */}
                {todo.source === 'ai' && (
                  <View style={[styles.aiBadge, disabled && styles.aiBadgeDone]}>
                    <Ionicons name="sparkles" size={9} color={disabled ? '#71717A' : '#A855F7'} />
                    <Text style={[styles.aiBadgeText, disabled && styles.aiBadgeTextDone]}>브루</Text>
                  </View>
                )}
              </View>

              {/* [하단 부제 — 카테고리 라벨 텍스트는 제거하고 부제만 한 줄로 표시] */}
              {todo.subtitle ? (
                <View style={{ marginTop: 2 }}>
                  <Text style={[styles.taskItemSub, disabled && styles.strike]} numberOfLines={1}>
                    {todo.subtitle}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>

        {/* [4. 우측 액션 기능 모음] */}
        {!isEditing && (
          <View style={styles.actionsRight}>
            {disabled ? (
              <PopIn style={styles.doneBadge}>
                <Text style={styles.doneBadgeText}>✓ 완료</Text>
              </PopIn>
            ) : todo.actionable ? (
              <View style={styles.actionHint}>
                <Text style={styles.actionHintText}>브루에게 ›</Text>
              </View>
            ) : null}

            {/* 수정 연필 버튼 */}
            <PressableScale
              onPress={() => startEdit(todo)}
              style={styles.iconBtn}
              to={0.85}
            >
              <Ionicons name="pencil-outline" size={15} color="#71717A" style={{ opacity: 0.5 }} />
            </PressableScale>

            {/* 삭제 휴지통 버튼 */}
            <PressableScale
              onPress={handleDelete}
              style={styles.iconBtn}
              to={0.85}
            >
              <Ionicons name="trash-outline" size={15} color="#EF4444" style={{ opacity: 0.6 }} />
            </PressableScale>
          </View>
        )}
      </PressableScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 트리거 버튼
  openModalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.espressoBrown,
    borderRadius: 18,
    paddingVertical: 13,
    marginTop: 4,
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
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
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
    gap: 10,
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
    color: '#71717A',
    marginBottom: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#18181B',
    letterSpacing: -0.5,
  },
  modalSub: {
    fontSize: 11,
    fontWeight: '500',
    color: '#71717A',
    marginTop: 2,
  },
  modalCloseBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#F4F4F5',
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
    width: '48.5%', // [한글 주석] 2x2 대칭 배치로 화면 깨짐 없는 깔끔한 세그먼트
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#F4F4F5',
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
    backgroundColor: '#F4F4F5',
    borderRadius: 12,
    paddingHorizontal: 11,
    fontSize: 11.5,
    fontWeight: '600',
    color: '#18181B',
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
    backgroundColor: '#F4F4F5',
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

  // 할 일 항목 카드
  taskCardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.05)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 2,
  },
  itemDone: {
    backgroundColor: '#F9FAFB',
    opacity: 0.6,
  },
  checkTouch: {
    padding: 2,
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
    fontSize: 12.5,
    fontWeight: '700',
    color: '#18181B',
    letterSpacing: -0.3,
  },
  taskItemSub: {
    fontSize: 10,
    fontWeight: '500',
    color: '#A1A1AA',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  aiBadgeDone: {
    backgroundColor: '#F4F4F5',
  },
  aiBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#A855F7',
  },
  aiBadgeTextDone: {
    color: '#71717A',
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 4,
  },

  // 발주 칩 & 완료 배지
  actionHint: {
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
  },
  actionHintText: {
    fontSize: 9.5,
    color: '#16A34A',
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
    backgroundColor: '#F4F4F5',
    borderRadius: 8,
    paddingHorizontal: 8,
    fontSize: 12,
    fontWeight: '700',
    color: '#18181B',
  },
  iconBtn: {
    padding: 4,
  },
});
