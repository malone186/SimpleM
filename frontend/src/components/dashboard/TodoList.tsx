// 할 일 목록 (Design Spec §4-③ 연동)
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography, shadows } from '../../theme';
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
    backgroundColor: 'rgba(242, 236, 224, 0.45)', // [iOS 스타일] 미세하게 반투명해진 커피크림 백그라운드
    borderRadius: 24,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.1)',
    padding: spacing.globalPadding,
    ...shadows.soft,
  },
  heading: { fontSize: 13, fontWeight: '800', color: colors.espressoBrown, marginBottom: 12, letterSpacing: -0.2 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 0.8, // [iOS 스타일] 얇은 인입식 테두리
    borderColor: 'rgba(140, 111, 86, 0.08)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    // [iOS 스타일] 개별 리스트 아이템에 미세 섀도우를 주어 부유감 이식
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 1,
  },
  itemDone: { opacity: 0.45 },
  itemTitle: { fontSize: 13, fontWeight: '700', color: colors.espressoBrown, letterSpacing: -0.2 },
  itemSub: { fontSize: 10, fontWeight: '500', color: colors.mochaBrown, marginTop: 3, letterSpacing: -0.1 },
  strike: { textDecorationLine: 'line-through' },
  actionHint: {
    backgroundColor: 'rgba(194, 94, 53, 0.08)', // [알약 배지] 투명 오렌지 틴트
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  actionHintText: { fontSize: 10, color: colors.pointOrange, fontWeight: '800', letterSpacing: -0.1 },
  doneBadge: {
    backgroundColor: colors.trendGreenBg, // [알약 배지] 투명 그린 틴트
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  doneBadgeText: { fontSize: 10, color: colors.trendGreenText, fontWeight: '800', letterSpacing: -0.1 },
});
