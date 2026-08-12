// 홈 '오늘 본전' 카드 — 사장님이 매일 제일 먼저 봐야 할 숫자를 게임룸에서 홈으로 끌어온다.
//
// "오늘 62 / 약 67잔"처럼 본전까지 얼마 남았는지 홈 맨 위에서 바로 본다. 손익분기(고정비)를
// 아직 설정 안 했으면 목표를 만들 수 있게 설정 화면으로 유도한다. 게임룸 카드(오늘의 목표)와
// 같은 데이터(getDailyQuest)를 쓰되, 여기서는 코인·수령 없이 '진행 상황'만 보여준다.
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale, useCountUp } from '../motion';
import { getDailyQuest, type DailyQuest } from '../../lib/api/rewards';
import { useCachedResource } from '../../lib/cache';
import { colors, shadows, spacing, typography } from '../../theme';

export default function BreakevenTodayCard({ refreshToken = 0 }: { refreshToken?: number }) {
  const { token } = useAuth();
  const navigation = useNavigation<any>();

  const { data } = useCachedResource<DailyQuest>(
    token ? 'dash:breakeven-today' : null,
    () => getDailyQuest(token!),
    { maxAgeMs: 3 * 60_000, refreshToken },
  );

  if (!data) return null;

  // 손익분기 미설정 — 목표를 만들 수 있게 설정으로 유도 (기능 유입 통로)
  if (!data.available) {
    return (
      <PressableScale style={styles.card} onPress={() => navigation.navigate('BreakEven')} to={0.98}>
        <View style={styles.head}>
          <Ionicons name="flag-outline" size={16} color={colors.espressoBrown} />
          <Text style={styles.title}>오늘 본전</Text>
          <Ionicons name="chevron-forward" size={15} color={colors.mochaBrown} style={{ marginLeft: 'auto' }} />
        </View>
        <Text style={styles.setupMsg}>
          고정비를 한 번 넣어 두면 "오늘 몇 잔 팔아야 본전인지"를 매일 알려드려요.
        </Text>
        <View style={styles.setupPill}>
          <Ionicons name="calculator-outline" size={14} color={colors.white} />
          <Text style={styles.setupPillText}>손익분기 설정하기</Text>
        </View>
      </PressableScale>
    );
  }

  const goal = data.goal ?? 0;
  const sold = data.sold_cups ?? 0;
  // 판 잔 수가 촤르륵 차오른다 — 매출 카드 금액과 같은 카운트업 (토스식)
  const soldAnim = useCountUp(sold, 800, [sold]);
  const pct = Math.min(100, goal > 0 ? (sold / goal) * 100 : 0);
  const remain = Math.max(0, goal - sold);

  return (
    // 탭하면 매출 입력으로 — 본전을 채우는 행동이 곧 매출 등록이다
    <PressableScale style={styles.card} onPress={() => navigation.navigate('SalesInput')} to={0.98}>
      <View style={styles.head}>
        <Ionicons name="flag" size={16} color={data.done ? '#3E9B4F' : colors.espressoBrown} />
        <Text style={styles.title}>오늘 본전</Text>
        {data.done && <Text style={styles.doneTag}>넘었어요 🎉</Text>}
        <Ionicons name="chevron-forward" size={15} color={colors.mochaBrown} style={{ marginLeft: 'auto' }} />
      </View>

      <View style={styles.countRow}>
        <Text style={styles.count}>
          <Text style={[styles.countNow, data.done && { color: '#3E9B4F' }]}>{soldAnim}</Text>
          <Text style={styles.countGoal}> / 약 {goal}잔</Text>
        </Text>
        <Text style={[styles.remain, data.done && { color: '#3E9B4F' }]}>
          {data.done ? '오늘치 고정비를 다 갚았어요' : `${remain}잔 남았어요`}
        </Text>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%` }, data.done && { backgroundColor: '#3E9B4F' }]} />
      </View>

      <Text style={styles.hint}>
        {(data.prepaid_cups ?? 0) > 0
          ? `단골 결제 ${data.prepaid_cups}잔 실시간 반영 중 · 매출을 올리면 더 채워져요`
          : '매출을 올리면 채워져요'}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white, borderRadius: 16, padding: spacing.globalPadding,
    marginBottom: spacing.gridGap, ...shadows.soft,
    borderWidth: 1, borderColor: 'rgba(192,112,48,0.18)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  title: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown },
  doneTag: { ...typography.L5, fontWeight: '800', color: '#3E9B4F', marginLeft: 6 },
  countRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
  count: { ...typography.L3 },
  // 히어로 숫자 (토스식) — 판 잔 수가 주인공, 목표는 작고 연하게
  countNow: { ...typography.hero, fontSize: 28, color: colors.espressoBrown },
  countGoal: { ...typography.heroLabel, fontSize: 15, color: colors.mochaBrown },
  remain: { ...typography.L5, fontWeight: '700', color: colors.pointOrange },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.mutedSand, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: '#C07030' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 8 },
  setupMsg: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18, marginBottom: 12 },
  setupPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.espressoBrown, borderRadius: 12, paddingVertical: 11,
  },
  setupPillText: { ...typography.L5, fontWeight: '800', color: colors.white },
});
