// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
import { StyleSheet, Text, View } from 'react-native';

import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Row = { name: string; price: number; cost: number };

const ROWS: Row[] = [
  { name: '아메리카노', price: 4000, cost: 599 },
  { name: '카페라떼', price: 4500, cost: 1199 },
  { name: '카페모카', price: 5000, cost: 1499 },
  { name: '캐모마일', price: 4500, cost: 900 },
];

export default function CostScreen() {
  const avg = Math.round(
    (ROWS.reduce((s, r) => s + r.cost / r.price, 0) / ROWS.length) * 100
  );

  return (
    <Screen>
      <ScreenTitle title="원가 분석" subtitle="메뉴별 원가율 · 단가 변동 자동 반영" />

      {/* 요약 */}
      <Card>
        <Text style={styles.summaryLabel}>전체 평균 원가율</Text>
        <Text style={styles.summaryValue}>{avg}%</Text>
        <Text style={styles.summaryHint}>일반적으로 30~35% 이하를 권장해요</Text>
      </Card>

      <SectionTitle>메뉴별 원가율</SectionTitle>
      {ROWS.map((r) => {
        const rate = Math.round((r.cost / r.price) * 100);
        const margin = r.price - r.cost;
        const high = rate > 35;
        return (
          <Card key={r.name}>
            <View style={styles.head}>
              <Text style={styles.name}>{r.name}</Text>
              <Text style={[styles.rate, { color: high ? '#B23B2E' : colors.trendGreenText }]}>
                {rate}%
              </Text>
            </View>
            <ProgressBar ratio={rate / 100} tone={high ? 'danger' : 'green'} />
            <Divider />
            <View style={styles.detailRow}>
              <Detail label="판매가" value={`₩${r.price.toLocaleString()}`} />
              <Detail label="원가" value={`₩${r.cost.toLocaleString()}`} />
              <Detail label="마진" value={`₩${margin.toLocaleString()}`} accent />
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}

function Detail({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, accent && { color: colors.pointOrange }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryLabel: { ...typography.L5, color: colors.mochaBrown },
  summaryValue: { fontSize: 34, fontWeight: '900', color: colors.espressoBrown, marginTop: 4 },
  summaryHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  name: { ...typography.L3, color: colors.espressoBrown },
  rate: { ...typography.L2, fontSize: 22 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between' },
  detail: { flex: 1, alignItems: 'center' },
  detailLabel: { ...typography.L5, color: colors.mochaBrown },
  detailValue: { ...typography.L4, color: colors.espressoBrown, marginTop: 3 },
});
