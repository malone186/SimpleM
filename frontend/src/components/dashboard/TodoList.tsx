// 할 일 목록 (Design Spec §4-③ 연동)
import { useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography, shadows } from '../../theme';
import { PopIn, PressableScale, SlideUp } from '../motion';

export type Todo = {
  id: string;
  title: string;
  subtitle: string;
  actionable?: boolean; // 발주 액션 대상
  done?: boolean;
  qty?: string; // 발주 추천 수량 (예: "5 kg") — 재고 API 기준 계산값
};

export default function TodoList({
  todos,
  onPressAction,
  onToggleDone,
  onAddTodo,
  onEditTodo,
  onDeleteTodo,
  hideCard = false,
}: {
  todos: Todo[];
  onPressAction: (todo: Todo) => void;
  onToggleDone?: (id: string) => void;
  onAddTodo?: (title: string) => void;
  onEditTodo?: (id: string, newTitle: string) => void;
  onDeleteTodo?: (id: string) => void;
  hideCard?: boolean;
}) {
  const [newTitle, setNewTitle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const handleAdd = () => {
    if (!newTitle.trim()) return;
    onAddTodo?.(newTitle.trim());
    setNewTitle('');
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

  const content = (
    <View style={{ gap: spacing.gridGap }}>
      {todos.length === 0 && (
        <Text style={styles.emptyText}>오늘 처리할 일이 없어요 ☕ 재고와 서류가 모두 안정 상태예요.</Text>
      )}
      {todos.map((todo) => {
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

      {/* [한글 주석: 사장님이 직접 할 일을 추가할 수 있는 새 할 일 입력 UI - 기존 투두 리스트 항목과 비주얼 정렬 통일] */}
      <View style={styles.addInputRow}>
        {/* 기존 투두 아이콘과 동일하게 정렬용 비활성 체크 링 배치 */}
        <Ionicons
          name="ellipse-outline"
          size={22}
          color={colors.mochaBrown}
          style={{ opacity: 0.25, marginRight: 4 }}
        />
        <TextInput
          style={styles.addInput}
          placeholder="새 할 일 입력 (예: 행주 소독, 우유 구매)"
          placeholderTextColor="rgba(140, 111, 86, 0.4)"
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={handleAdd}
          returnKeyType="done"
        />
        <PressableScale style={styles.addBtn} onPress={handleAdd} to={0.92}>
          <Text style={styles.addBtnText}>+ 추가</Text>
        </PressableScale>
      </View>
    </View>
  );

  if (hideCard) {
    return content;
  }

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>오늘 할 일</Text>
      {content}
    </View>
  );
}

// ── [한글 주석: 개별 할 일 아이템 컴포넌트 - 삭제 시 왼쪽으로 미끄러져 사라지는 아이메시지 슬라이드 효과 주입] ──
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
    // 왼쪽으로 -400px 미끄러지며 스르륵 투명화되는 스프링/타이밍 병렬 모션
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
      // 쫀득하게 화면 밖으로 날아간 직후 최종 데이터를 삭감하여 레이아웃 꼬임 방지
      onDeleteTodo?.(todo.id);
    });
  };

  return (
    <Animated.View style={{ transform: [{ translateX: animX }], opacity: animOpacity }}>
      <PressableScale
        disabled={disabled || !todo.actionable}
        onPress={() => onPressAction(todo)}
        style={[styles.item, disabled && styles.itemDone]}
      >
        {/* [한글 주석] 완료 체크 토글 동그라미 아이콘 버튼 */}
        <PressableScale
          onPress={() => onToggleDone && onToggleDone(todo.id)}
          style={styles.checkTouch}
          to={0.85}
        >
          <Ionicons
            name={disabled ? 'checkmark-circle-outline' : 'ellipse-outline'}
            size={22}
            color={disabled ? colors.trendGreenText : colors.mochaBrown}
            style={{ opacity: disabled ? 0.8 : 0.4 }}
          />
        </PressableScale>

        <View style={{ flex: 1, marginLeft: 8 }}>
          {isEditing ? (
            /* [한글 주석] 인라인 수정 모드 스타일 */
            <View style={styles.editRow}>
              <TextInput
                style={styles.editInput}
                value={editingText}
                onChangeText={setEditingText}
                autoFocus
                onSubmitEditing={() => saveEdit(todo.id)}
              />
              <PressableScale onPress={() => saveEdit(todo.id)} style={styles.iconBtn}>
                <Ionicons name="checkmark" size={16} color={colors.pointOrange} />
              </PressableScale>
              <PressableScale onPress={() => setEditingId(null)} style={styles.iconBtn}>
                <Ionicons name="close" size={16} color={colors.mochaBrown} />
              </PressableScale>
            </View>
          ) : (
            <>
              <Text style={[styles.itemTitle, disabled && styles.strike]}>{todo.title}</Text>
              <Text style={[styles.itemSub, disabled && styles.strike]}>{todo.subtitle}</Text>
            </>
          )}
        </View>

        {/* [한글 주석] 우측 액션 버튼 및 수정/삭제 아이콘 버튼 */}
        {!isEditing && (
          <View style={styles.actionsRight}>
            {disabled ? (
              <PopIn style={styles.doneBadge}>
                <Text style={styles.doneBadgeText}>✓ 완료</Text>
              </PopIn>
            ) : todo.actionable ? (
              <View style={styles.actionHint}>
                <Text style={styles.actionHintText}>발주 ›</Text>
              </View>
            ) : null}

            {/* 수정 버튼 */}
            <PressableScale
              onPress={() => startEdit(todo)}
              style={styles.iconBtn}
              to={0.85}
            >
              <Ionicons name="pencil-outline" size={15} color={colors.mochaBrown} style={{ opacity: 0.35 }} />
            </PressableScale>

            {/* 삭제 버튼 */}
            <PressableScale
              onPress={handleDelete}
              style={styles.iconBtn}
              to={0.85}
            >
              <Ionicons name="trash-outline" size={15} color="#B23B2E" style={{ opacity: 0.45 }} />
            </PressableScale>
          </View>
        )}
      </PressableScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(242, 236, 224, 0.45)', // [iOS 스타일] 반투명 커피크림 백그라운드
    borderRadius: 24,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.1)',
    padding: spacing.globalPadding,
    ...shadows.soft,
  },
  heading: { fontSize: 13, fontWeight: '800', color: colors.espressoBrown, marginBottom: 12, letterSpacing: -0.2 },
  emptyText: { fontSize: 11, fontWeight: '500', color: colors.mochaBrown, lineHeight: 16 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 0.8,
    borderBottomColor: 'rgba(140, 111, 86, 0.1)',
  },
  checkTouch: {
    paddingRight: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemDone: { opacity: 0.45 },
  itemTitle: { fontSize: 13, fontWeight: '700', color: colors.espressoBrown, letterSpacing: -0.2 },
  itemSub: { fontSize: 10, fontWeight: '500', color: colors.mochaBrown, marginTop: 2, letterSpacing: -0.1 },
  strike: { textDecorationLine: 'line-through' },
  actionHint: {
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.1)',
  },
  actionHintText: { fontSize: 10, color: colors.mochaBrown, fontWeight: '800', letterSpacing: -0.1 },
  doneBadge: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  doneBadgeText: { fontSize: 10, color: colors.trendGreenText, fontWeight: '800', letterSpacing: -0.1 },

  // [한글 주석] 오른쪽 버튼 모음
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // [한글 주석] 인라인 수정 스타일
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editInput: {
    flex: 1,
    height: 32,
    backgroundColor: 'rgba(242, 236, 224, 0.5)',
    borderRadius: 8,
    paddingHorizontal: 8,
    fontSize: 12,
    fontWeight: '700',
    color: colors.espressoBrown,
  },

  // [한글 주석] 새 할 일 추가 인풋 스타일
  addInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  addInput: {
    flex: 1,
    height: 36,
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    fontSize: 13,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  addBtn: {
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.1)',
    marginLeft: 6,
  },
  addBtnText: {
    color: colors.mochaBrown,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: -0.1,
  },
});
