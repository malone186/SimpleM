// 할 일 목록 (Design Spec §4-③ 연동)
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../../theme';
import { PopIn, PressableScale } from '../motion';

export type Todo = {
  id: string;
  title: string;
  subtitle: string;
  actionable?: boolean; // 발주 액션 대상
  done?: boolean;
};

export default function TodoList({
  todos,
  onPressAction,
}: {
  todos: Todo[];
  onPressAction: (todo: Todo) => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>오늘 할 일</Text>
      <View style={{ gap: spacing.gridGap }}>
        {todos.map((todo) => {
          const disabled = todo.done;
          return (
            <PressableScale
              key={todo.id}
              disabled={disabled || !todo.actionable}
              onPress={() => onPressAction(todo)}
              style={[styles.item, disabled && styles.itemDone]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.itemTitle, disabled && styles.strike]}>{todo.title}</Text>
                <Text style={[styles.itemSub, disabled && styles.strike]}>{todo.subtitle}</Text>
              </View>
              {disabled ? (
                <PopIn style={styles.doneBadge}>
                  <Text style={styles.doneBadgeText}>✓ 발주 완료</Text>
                </PopIn>
              ) : todo.actionable ? (
                <View style={styles.actionHint}>
                  <Text style={styles.actionHintText}>발주 ›</Text>
                </View>
              ) : null}
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: spacing.globalPadding,
  },
  heading: { ...typography.L4, color: colors.espressoBrown, marginBottom: 12 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  itemDone: { opacity: 0.4 },
  itemTitle: { ...typography.L4, color: colors.espressoBrown },
  itemSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  strike: { textDecorationLine: 'line-through' },
  actionHint: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  actionHintText: { ...typography.L5, color: colors.pointOrange, fontWeight: '700' },
  doneBadge: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  doneBadgeText: { ...typography.L5, color: colors.trendGreenText, fontWeight: '700' },
});
