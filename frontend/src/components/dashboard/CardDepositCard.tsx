// 홈 화면 '통장에 들어올 돈' 카드 — 카드사별 입금 예정을 한눈에.
//
// 사장님이 매일 궁금해하는 건 "오늘 얼마 팔았나"만이 아니라 "언제 얼마가 들어오나"다.
// 카드사마다 입금일이 달라 직접 세기 번거로운데, 매출만 넣어 두면 앱이 계산해 준다.
// 입력된 카드 매출이 없으면 카드 자체를 띄우지 않는다 — 빈 카드는 화면만 어지럽힌다.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../motion';
import { getDeposits, type DepositSchedule } from '../../lib/api/settlement';
import { colors, shadows, spacing, typography } from '../../theme';

const won = (n: number) => `₩${Math.round(n || 0).toLocaleString('ko-KR')}`;

export default function CardDepositCard() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  const [data, setData] = useState<DepositSchedule | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getDeposits(token, 14)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => console.error('입금 예정 조회 실패:', e));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const pending = (data?.schedule ?? []).filter((s) => !s.settled);
  if (!data || pending.length === 0) return null;

  const next = data.next_deposit;
  const today = data.today;
  const daysTo = next
    ? Math.round(
        (new Date(`${next.deposit_date}T00:00:00`).getTime() -
          new Date(`${today}T00:00:00`).getTime()) /
          86_400_000,
      )
    : null;

  return (
    <PressableScale style={styles.card} onPress={() => navigation.navigate('SalesInput')} to={0.98}>
      <View style={styles.head}>
        <Ionicons name="wallet-outline" size={16} color={colors.espressoBrown} />
        <Text style={styles.title}>통장에 들어올 돈</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.mochaBrown} style={{ marginLeft: 'auto' }} />
      </View>

      {next && (
        <View style={styles.nextBox}>
          <Text style={styles.nextLabel}>
            {daysTo === 0 ? '오늘' : daysTo === 1 ? '내일' : `${daysTo}일 뒤`} 들어와요
          </Text>
          <Text style={styles.nextValue}>{won(next.net)}</Text>
          <Text style={styles.nextMeta}>
            {next.deposit_date.slice(5).replace('-', '/')} ({next.weekday}) ·{' '}
            {next.items.map((i) => i.issuer_name).slice(0, 3).join(' · ')}
          </Text>
        </View>
      )}

      <View style={styles.row}>
        <View style={styles.col}>
          <Text style={styles.colLabel}>이번 주</Text>
          <Text style={styles.colValue}>{won(data.this_week_net)}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <Text style={styles.colLabel}>미입금 잔액</Text>
          <Text style={styles.colValue}>{won(data.pending_net)}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <Text style={styles.colLabel}>떼이는 수수료</Text>
          <Text style={[styles.colValue, { color: '#B23B2E' }]}>{won(data.pending_fee)}</Text>
        </View>
      </View>

      {/* 다가오는 입금일 3개까지 미니 타임라인 */}
      <View style={styles.timeline}>
        {pending.slice(0, 3).map((s) => (
          <View key={s.deposit_date} style={styles.tlRow}>
            <View style={styles.tlDot} />
            <Text style={styles.tlDate}>
              {s.deposit_date.slice(5).replace('-', '/')} ({s.weekday})
            </Text>
            <Text style={styles.tlIssuers} numberOfLines={1}>
              {s.items.map((i) => i.issuer_name).join(' · ')}
            </Text>
            <Text style={styles.tlNet}>{won(s.net)}</Text>
          </View>
        ))}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)',
    padding: spacing.globalPadding,
    ...shadows.soft,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { ...typography.L3, color: colors.espressoBrown },
  nextBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
  },
  nextLabel: { ...typography.L5, color: colors.mochaBrown },
  nextValue: { fontSize: 24, fontWeight: '900', color: colors.espressoBrown, marginTop: 3 },
  nextMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'stretch', marginTop: 14 },
  col: { flex: 1, alignItems: 'center', gap: 3 },
  divider: { width: 1, backgroundColor: colors.mutedSand, marginHorizontal: 6 },
  colLabel: { ...typography.L5, color: colors.mochaBrown },
  colValue: { ...typography.L4, color: colors.espressoBrown },
  timeline: { marginTop: 14, gap: 8, borderTopWidth: 1, borderTopColor: colors.mutedSand, paddingTop: 12 },
  tlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tlDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.mochaBrown },
  tlDate: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800', width: 74 },
  tlIssuers: { ...typography.L5, color: colors.mochaBrown, flex: 1 },
  tlNet: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
});
