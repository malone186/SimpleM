// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
import { useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';

import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { colors, typography, shadows } from '../../theme';
import { FadeInUp, PressableScale } from '../../components/motion';
import { Ionicons } from '@expo/vector-icons';

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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // [한글 주석] 선택된 카테고리에 맞는 메뉴 리스트만 필터링합니다.
  const filteredRows = activeCategory === '전체'
    ? ROWS
    : ROWS.filter((r) => r.category === activeCategory);

  // 평균 원가율 계산 (전체 대비 기준 유지)
  const avg = Math.round(
    (ROWS.reduce((s, r) => s + r.cost / r.price, 0) / ROWS.length) * 100
  );

  const selectCategory = (cat: '전체' | '커피' | '티' | '논커피') => {
    setActiveCategory(cat);
    setIsDropdownOpen(false);
  };

  return (
    <Screen>
      <ScreenTitle title="원가 분석" subtitle="메뉴별 원가율 · 단가 변동 자동 반영" />

      {/* 요약 */}
      <Card>
        <Text style={styles.summaryLabel}>전체 평균 원가율</Text>
        <Text style={styles.summaryValue}>{avg}%</Text>
        <Text style={styles.summaryHint}>일반적으로 30~35% 이하를 권장해요</Text>
      </Card>

      {/* 
        [한글 주석: Z-index 캡슐화 버그 완전 차단]
        Screen 컴포넌트가 각각의 자식을 독립된 FadeInUp 애니메이션 래퍼로 감싸서 생겼던 z-index 격리 문제를 해결하기 위해,
        드롭다운 헤더와 카드 목록을 하나의 동일한 View 레이어로 묶어 위로 안전하게 플로팅되도록 했습니다.
      */}
      <View style={{ zIndex: 10, position: 'relative', gap: 10 }}>
        <View style={styles.sectionHeader}>
          <SectionTitle>메뉴별 원가율</SectionTitle>

          {/* [한글 주석: 드롭다운 카테고리 필터] 카테고리 개수가 많아져도 무너지지 않도록 iOS 스타일 드롭다운 이식 */}
          <View style={styles.dropdownWrap}>
            <PressableScale
              style={styles.dropdownTrigger}
              onPress={() => setIsDropdownOpen(!isDropdownOpen)}
            >
              <Text style={styles.dropdownTriggerText}>
                카테고리: <Text style={{ fontWeight: '800', color: colors.espressoBrown }}>{activeCategory}</Text>
              </Text>
              <Ionicons
                name={isDropdownOpen ? 'chevron-up-outline' : 'chevron-down-outline'}
                size={15}
                color={colors.mochaBrown}
              />
            </PressableScale>

            {isDropdownOpen && (
              <FadeInUp distance={8} style={styles.dropdownMenu}>
                {(['전체', '커피', '티', '논커피'] as const).map((cat, idx, arr) => {
                  const isSelected = activeCategory === cat;
                  return (
                    <Pressable
                      key={cat}
                      style={[
                        styles.dropdownItem,
                        idx === arr.length - 1 && { borderBottomWidth: 0 },
                        isSelected && { backgroundColor: 'rgba(107, 94, 85, 0.04)' },
                      ]}
                      onPress={() => selectCategory(cat)}
                    >
                      <Text style={[styles.dropdownItemText, isSelected && styles.dropdownItemTextActive]}>
                        {cat}
                      </Text>
                      {isSelected && (
                        <Ionicons name="checkmark-sharp" size={15} color={colors.pointOrange} />
                      )}
                    </Pressable>
                  );
                })}
              </FadeInUp>
            )}
          </View>
        </View>

        {filteredRows.map((r) => {
          const rate = Math.round((r.cost / r.price) * 100);
          const margin = r.price - r.cost;
          const high = rate > 35;
          return (
            <Card key={r.name} style={{ zIndex: 1 }}>
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
      </View>
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
  // [한글 주석: 레이어 위계 설정] position: 'relative'를 추가하여 브라우저가 zIndex를 인식하게 하고, 드롭다운이 아래 카드들을 덮도록 조치
  sectionHeader: { gap: 10, marginTop: 8, zIndex: 100, position: 'relative' },
  dropdownWrap: { position: 'relative', width: '100%', marginBottom: 4, zIndex: 110 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(140, 111, 86, 0.06)', // [iOS 위젯 스타일] 은은한 웜 그레이-베이지
    borderRadius: 12,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.12)',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  dropdownTriggerText: { fontSize: 13, color: colors.mochaBrown, fontWeight: '600', letterSpacing: -0.2 },
  dropdownMenu: {
    position: 'absolute',
    top: 48,
    left: 0,
    right: 0,
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.15)',
    zIndex: 999,
    elevation: 5,
    ...shadows.medium, // [iOS 플로팅 섀도우 적용]
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderBottomWidth: 0.8,
    borderBottomColor: 'rgba(140, 111, 86, 0.06)',
  },
  dropdownItemText: { fontSize: 13, fontWeight: '600', color: colors.mochaBrown, letterSpacing: -0.2 },
  dropdownItemTextActive: { color: colors.espressoBrown, fontWeight: '800' },
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
