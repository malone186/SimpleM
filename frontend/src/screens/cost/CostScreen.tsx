// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
import { useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';

import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Row = { name: string; price: number; cost: number; category: '커피' | '티' | '논커피' };

// [한글 주석] 커피, 티, 논커피 카테고리 필드를 각각 추가하여 데이터를 구성합니다.
const ROWS: Row[] = [
  { name: '아메리카노', price: 4000, cost: 599, category: '커피' },
  { name: '카페라떼', price: 4500, cost: 1199, category: '커피' },
  { name: '카페모카', price: 5000, cost: 1499, category: '커피' },
  { name: '캐모마일', price: 4500, cost: 900, category: '티' },
  { name: '말차라떼', price: 4800, cost: 1200, category: '논커피' },
  { name: '유자무스', price: 5500, cost: 1650, category: '논커피' },
];

export default function CostScreen() {
  const [activeCategory, setActiveCategory] = useState<'전체' | '커피' | '티' | '논커피'>('전체');

  // [한글 주석] 선택된 카테고리에 맞는 메뉴 리스트만 필터링합니다.
  const filteredRows = activeCategory === '전체'
    ? ROWS
    : ROWS.filter((r) => r.category === activeCategory);

  // 평균 원가율 계산 (전체 대비 기준 유지)
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

      <View style={styles.sectionHeader}>
        <SectionTitle>메뉴별 원가율</SectionTitle>

        {/* [그리드 정렬] 커피, 티, 논커피 카테고리 선택 탭 세그먼트 */}
        <View style={styles.tabContainer}>
          {(['전체', '커피', '티', '논커피'] as const).map((cat) => {
            const isActive = activeCategory === cat;
            return (
              <Pressable
                key={cat}
                onPress={() => setActiveCategory(cat)}
                style={[styles.tabButton, isActive && styles.activeTabButton]}
              >
                <Text style={[styles.tabText, isActive && styles.activeTabText]}>
                  {cat}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {filteredRows.map((r) => {
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
  sectionHeader: { gap: 10, marginTop: 8 },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    marginBottom: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  activeTabButton: {
    backgroundColor: colors.pointOrange,
  },
  tabText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  activeTabText: {
    color: colors.white,
    fontWeight: '800',
  },
  head: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'baseline', // [한글 주석] center 대신 baseline 정렬을 주어 이름과 퍼센트 텍스트 수직 밸런스를 잡습니다.
    marginBottom: 12, 
    paddingHorizontal: 2 
  },
  name: { 
    ...typography.L3, 
    color: colors.espressoBrown, 
    fontSize: 17, 
    fontWeight: '800', // [한글 주석] 기존 L3 굵기보다 더 진하고 선명하게 조절하여 가독성을 극대화합니다.
  },
  rate: { ...typography.L2, fontSize: 22 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }, // [한글 주석] ProgressBar 아래 여백 보강
  detail: { flex: 1, alignItems: 'center' },
  detailLabel: { ...typography.L5, color: colors.mochaBrown },
  detailValue: { ...typography.L4, color: colors.espressoBrown, marginTop: 3 },
});
