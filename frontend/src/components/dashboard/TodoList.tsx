// 할 일 목록 (Design Spec §4-③ 연동 — iOS 팝업 모달 기반 새 업무 등록 및 1줄 세련 레이아웃 최종)
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
  actionable?: boolean; // [한글 주석] 카테고리 판별 등에 쓰는 플래그 (재고·발주성 항목)
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
  const [modalVisible, setModalVisible] = useState(false);
  // [한글 주석] 수정 중인 Todo 대상 상태 (null이면 신규 등록 모드, 존재하면 팝업 모달 수정 모드)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [newTitle, setNewTitle] = useState('');
  // [한글 주석] 초기 카테고리는 선택되지 않은 null 상태 (아무 카테고리 칩도 누르지 않고 등록 시 태그 없이 생성)
  const [selectedCategory, setSelectedCategory] = useState<TodoCategory | null>(null);

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
      {/* ── [통합 업무 목록 (날짜 변경 시 부드러운 패이드+슬라이딩 전환)] ── */}
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
          dateFilteredTodos.map((todo) => {
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
                />
              </SlideUp>
            );
          })
        )}
      </Animated.View>

      {/* ── [한 줄 가로 정렬: 메인 새 업무 등록하기 + ✨ 브루 추천 미니 칩] ── */}
      {!isPastDate && (
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
}: {
  todo: Todo;
  isPastDate?: boolean;
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onDeleteTodo?: (id: string) => void;
  disabled: boolean;
  startEdit: (todo: Todo) => void;
}) {
  const animX = useRef(new Animated.Value(0)).current;
  const animOpacity = useRef(new Animated.Value(1)).current;
  const checkScale = useRef(new Animated.Value(1)).current;
  const cardScale = useRef(new Animated.Value(1)).current;

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
        style={[styles.taskCardItem, disabled && styles.itemDone]}
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

        {/* [2. 한 줄로 깔끔하게 정돈된 타이틀 텍스트] */}
        <View style={{ flex: 1, marginLeft: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
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
        </View>

        {/* [3. 우측 액션 버튼 - [한글 주석] 지난 날짜(isPastDate)일 때는 수정/삭제 버튼 숨김] */}
        {!isPastDate && (
          <View style={styles.actionsRight}>
            {/* 수정 연필 버튼 (클릭 시 팝업 모달이 수정 모드로 열림) */}
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
    backgroundColor: '#FFFDF9', // 클래식 아날로그 크림 메모지 톤
    borderRadius: 16,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginBottom: 9,
    borderWidth: 1,
    borderColor: '#EFECE6', // 따뜻하고 은은한 메모지 테두리
    borderLeftWidth: 4,
    borderLeftColor: colors.espressoBrown, // 메모지 좌측 감성 마진 라인
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
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
  },
  taskItemSub: {
    fontSize: 11.5,
    fontWeight: '500',
    color: '#8C827A',
    flexShrink: 1,
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
    backgroundColor: '#EFECE6',
  },
  aiBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#A855F7',
  },
  aiBadgeTextDone: {
    color: '#8C827A',
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
    padding: 4,
  },
});
