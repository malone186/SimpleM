// AI 메뉴 재구성 & 원가·원재료 최적화 카드 컴포넌트 (Design Spec & 멘토 피드백 반영)
// 기존 메뉴의 판매량, 원가, 원재료 종류를 분석하여 비용은 낮추고 마진을 높이는 최적 라인업을 추천합니다.
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography } from '../../theme';
import { PressableScale } from '../motion';
import { Badge } from '../ui';

type MenuStatus = 'keep' | 'promote' | 'replace_ingredient' | 'discontinue';

interface MenuItemAnalysis {
  id: string;
  name: string;
  category: string;
  salesCount: number; // 월 판매 잔수
  price: number; // 판매가
  cost: number; // 잔당 원가
  costRatio: number; // 원가율 (%)
  ingredients: string[]; // 사용 원재료
  status: MenuStatus;
  statusLabel: string;
  badgeTone: 'green' | 'orange' | 'neutral' | 'danger';
  aiAdvice: string;
  alternativeSuggestion?: {
    originalIngredient: string;
    suggestedIngredient: string;
    expectedCostSavings: string;
  };
}

// [한글 주석: 가게의 전체 메뉴별 판매량, 원가, 원재료 구성 및 AI 평가 데이터]
const MENU_DATA: MenuItemAnalysis[] = [
  {
    id: 'm1',
    name: '아메리카노',
    category: '커피',
    salesCount: 1420,
    price: 3700,
    cost: 520,
    costRatio: 14.0,
    ingredients: ['에스프레소 원두(시그니처)'],
    status: 'keep',
    statusLabel: '효자 메뉴',
    badgeTone: 'green',
    aiAdvice: '최고 효자 상품입니다. 원가율이 14%로 매우 낮아 적극 유지를 권장합니다.',
  },
  {
    id: 'm2',
    name: '카페라떼',
    category: '커피',
    salesCount: 980,
    price: 4200,
    cost: 890,
    costRatio: 21.1,
    ingredients: ['에스프레소 원두', '매일우유(1L)'],
    status: 'keep',
    statusLabel: '안정 유지',
    badgeTone: 'green',
    aiAdvice: '꾸준한 판매량과 우수한 마진율을 유지하고 있습니다.',
  },
  {
    id: 'm3',
    name: '바닐라 라떼',
    category: '커피',
    salesCount: 750,
    price: 4800,
    cost: 1050,
    costRatio: 21.8,
    ingredients: ['에스프레소 원두', '매일우유', '프랑스 바닐라 시럽'],
    status: 'promote',
    statusLabel: '판촉 확대 권장',
    badgeTone: 'orange',
    aiAdvice: '마진 금액(잔당 ₩3,750)이 높아, 아몬드 라떼 대신 바닐라 라떼 추천 문구를 내걸면 수익이 증가합니다.',
  },
  {
    id: 'm4',
    name: '아몬드 크림라떼',
    category: '시그니처',
    salesCount: 210,
    price: 5500,
    cost: 2100,
    costRatio: 38.1,
    ingredients: ['에스프레소 원두', '아몬드 시럽(수입)', '동물성 생크림', '아몬드 토핑'],
    status: 'replace_ingredient',
    statusLabel: '원재료 대체 권장',
    badgeTone: 'orange',
    aiAdvice: '수입 아몬드 시럽 단가 인상(+14.2%)으로 원가율이 38%까지 높아졌습니다. 국산 대체 시럽 전환을 권장합니다.',
    alternativeSuggestion: {
      originalIngredient: '수입 아몬드 시럽 (₩18,500/병)',
      suggestedIngredient: '국산 프리미엄 아몬드 베이스 (₩12,900/병)',
      expectedCostSavings: '잔당 원가 ₩420 절감 (원가율 38.1% ➡️ 30.5%)',
    },
  },
  {
    id: 'm5',
    name: '민트초코 스무디',
    category: '스무디',
    salesCount: 45,
    price: 5800,
    cost: 2400,
    costRatio: 41.3,
    ingredients: ['민트 파우더(단독)', '초코 칩', '우유', '휘핑크림'],
    status: 'discontinue',
    statusLabel: '메뉴 정리 권장',
    badgeTone: 'danger',
    aiAdvice: '단독 사용하는 민트 파우더의 재고 로스 비율이 높고 판매량이 적어 메뉴 라인업 슬림화를 권장합니다.',
    alternativeSuggestion: {
      originalIngredient: '단독 사용 민트 파우더 3종',
      suggestedIngredient: '범용 초코 파우더 공유 (초코 스무디로 메뉴 통합)',
      expectedCostSavings: '월 재고 유통기한 로스 ₩140,000 즉시 감소',
    },
  },
];

const won = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;

export default function MenuOptimizationCard() {
  // [한글 주석: 특정 메뉴 클릭 시 세부 원재료 가이드 모달 표출 상태]
  const [selectedMenu, setSelectedMenu] = useState<MenuItemAnalysis | null>(null);
  // [한글 주석: 메뉴 상태별 필터 칩 (전체 / 조율 필요 메뉴만 / 효자 메뉴)]
  const [filter, setFilter] = useState<'all' | 'need_action' | 'keep'>('all');

  const filteredMenus = MENU_DATA.filter((m) => {
    if (filter === 'need_action') return m.status === 'replace_ingredient' || m.status === 'discontinue' || m.status === 'promote';
    if (filter === 'keep') return m.status === 'keep';
    return true;
  });

  return (
    <View style={styles.card}>
      {/* 1. 헤더 영역 — ManagementReportCard와 100% 동일 타이포그래피 L1 적용 */}
      <View style={styles.headRow}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleBadgeRow}>
            <Text style={styles.title}>AI 메뉴 재구성 & 원가 최적화</Text>
            <View style={styles.sparkleBadge}>
              <Ionicons name="sparkles" size={12} color="#D97706" />
              <Text style={styles.sparkleText}>AI 라인업 추천</Text>
            </View>
          </View>
          <Text style={styles.subtitle}>
            전체 메뉴의 판매량·원가·원재료를 분석하여 마진은 올리고 원재료 가짓수는 줄여드립니다.
          </Text>
        </View>
      </View>

      {/* 2. AI 경영 가이드 멘트 박스 — ManagementReportCard의 highlightWrap과 동일 감각 */}
      <View style={styles.aiAdviceBox}>
        <View style={styles.adviceHeaderRow}>
          <Ionicons name="bulb" size={16} color={colors.pointOrange} />
          <Text style={styles.adviceHeaderTitle}>AI 원가 분석 & 라인업 조정 가이드</Text>
        </View>
        <Text style={styles.adviceText}>
          ✦ <Text style={{ fontWeight: '700', color: colors.espressoBrown }}>[아몬드 시럽] 단가 인상 (+14.2%)</Text>으로 '아몬드 크림라떼' 원가율이 38.1%로 상승했어요.{'\n'}
          ✦ 단독 사용 원재료(민트 파우더 등) 메뉴를 정리하고 효자 라인업으로 슬림화 시, <Text style={{ fontWeight: '800', color: colors.pointOrange }}>월 +₩480,000 추가 순이익</Text>이 예상됩니다.
        </Text>
      </View>

      {/* 3. 메뉴 최적화 스탯 KPI 요약 칩 */}
      <View style={styles.kpiRow}>
        <View style={styles.kpiChip}>
          <Text style={styles.kpiLabel}>원재료 가짓수</Text>
          <Text style={styles.kpiValue}>
            14종 <Text style={styles.kpiSubValue}>➔ 9종 (-35%)</Text>
          </Text>
        </View>
        <View style={styles.kpiChip}>
          <Text style={styles.kpiLabel}>평균 원가율</Text>
          <Text style={styles.kpiValue}>
            26.4% <Text style={[styles.kpiSubValue, { color: colors.trendGreenText }]}>➔ 21.2% (-5.2%p)</Text>
          </Text>
        </View>
      </View>

      {/* 4. 필터 칩 레버 */}
      <View style={styles.filterRow}>
        <PressableScale
          style={[styles.filterChip, filter === 'all' && styles.filterChipActive]}
          onPress={() => setFilter('all')}
        >
          <Text style={[styles.filterChipText, filter === 'all' && styles.filterChipTextActive]}>전체 메뉴 ({MENU_DATA.length})</Text>
        </PressableScale>
        <PressableScale
          style={[styles.filterChip, filter === 'need_action' && styles.filterChipActiveAlert]}
          onPress={() => setFilter('need_action')}
        >
          <Text style={[styles.filterChipText, filter === 'need_action' && styles.filterChipTextActiveAlert]}>⚠️ 재구성/대체 추천 (3)</Text>
        </PressableScale>
        <PressableScale
          style={[styles.filterChip, filter === 'keep' && styles.filterChipActive]}
          onPress={() => setFilter('keep')}
        >
          <Text style={[styles.filterChipText, filter === 'keep' && styles.filterChipTextActive]}>효자/안정 (2)</Text>
        </PressableScale>
      </View>

      {/* 5. 메뉴별 판매량 · 원가 · 원재료 상세 카드 리스트 */}
      <View style={{ gap: 10 }}>
        {filteredMenus.map((menu) => (
          <PressableScale
            key={menu.id}
            style={styles.menuItemCard}
            onPress={() => setSelectedMenu(menu)}
          >
            <View style={styles.menuCardHeader}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.menuName}>{menu.name}</Text>
                  <Badge label={menu.statusLabel} tone={menu.badgeTone} />
                </View>
                <Text style={styles.menuSubInfo}>
                  월 {menu.salesCount}잔 판매 · 잔당 {won(menu.price)}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.costRatioText}>원가율 {menu.costRatio}%</Text>
                <Text style={styles.costDetailText}>원가 {won(menu.cost)} / 마진 {won(menu.price - menu.cost)}</Text>
              </View>
            </View>

            {/* 원재료 구성 태그 및 AI 처방 요약 */}
            <View style={styles.ingredientRow}>
              <Text style={styles.ingredientLabel}>사용 원재료:</Text>
              <Text style={styles.ingredientListText} numberOfLines={1}>
                {menu.ingredients.join(', ')}
              </Text>
            </View>

            {/* 대체 추천 가이드 팁 (있을 경우) */}
            {menu.alternativeSuggestion && (
              <View style={styles.altBox}>
                <Ionicons name="swap-horizontal-outline" size={13} color="#D97706" />
                <Text style={styles.altText} numberOfLines={1}>
                  <Text style={{ fontWeight: '700' }}>[대체재 추천]</Text> {menu.alternativeSuggestion.expectedCostSavings}
                </Text>
              </View>
            )}
          </PressableScale>
        ))}
      </View>

      {/* 6. 상세 메뉴 원재료 & 대체재 조율 팝업 모달 */}
      <Modal
        visible={selectedMenu !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedMenu(null)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSelectedMenu(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation?.()}>
            {selectedMenu && (
              <>
                <View style={styles.modalHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={styles.modalTitle}>{selectedMenu.name}</Text>
                      <Badge label={selectedMenu.statusLabel} tone={selectedMenu.badgeTone} />
                    </View>
                    <Text style={styles.modalSubtitle}>원가 구조 및 AI 원재료 대체 가이드</Text>
                  </View>
                  <Pressable onPress={() => setSelectedMenu(null)}>
                    <Ionicons name="close" size={22} color={colors.mochaBrown} />
                  </Pressable>
                </View>

                {/* 지표 리스트 */}
                <View style={styles.modalStatsGrid}>
                  <View style={styles.modalStatItem}>
                    <Text style={styles.modalStatLabel}>월 판매량</Text>
                    <Text style={styles.modalStatValue}>{selectedMenu.salesCount}잔</Text>
                  </View>
                  <View style={styles.modalStatItem}>
                    <Text style={styles.modalStatLabel}>판매가</Text>
                    <Text style={styles.modalStatValue}>{won(selectedMenu.price)}</Text>
                  </View>
                  <View style={styles.modalStatItem}>
                    <Text style={styles.modalStatLabel}>잔당 원가</Text>
                    <Text style={styles.modalStatValue}>{won(selectedMenu.cost)}</Text>
                  </View>
                  <View style={styles.modalStatItem}>
                    <Text style={styles.modalStatLabel}>원가율 / 마진</Text>
                    <Text style={[styles.modalStatValue, { color: colors.pointOrange }]}>
                      {selectedMenu.costRatio}% ({won(selectedMenu.price - selectedMenu.cost)})
                    </Text>
                  </View>
                </View>

                {/* 원재료 구성 목록 */}
                <View style={styles.sectionBox}>
                  <Text style={styles.sectionTitle}>🧪 사용 원재료 구성</Text>
                  <View style={styles.ingChipWrap}>
                    {selectedMenu.ingredients.map((ing, idx) => (
                      <View key={idx} style={styles.ingChip}>
                        <Text style={styles.ingChipText}>{ing}</Text>
                      </View>
                    ))}
                  </View>
                </View>

                {/* AI 코멘트 */}
                <View style={styles.sectionBox}>
                  <Text style={styles.sectionTitle}>💡 AI 진단 분석</Text>
                  <Text style={styles.modalAiText}>{selectedMenu.aiAdvice}</Text>
                </View>

                {/* 대체재 추천 정보 (해당시) */}
                {selectedMenu.alternativeSuggestion && (
                  <View style={styles.altDetailCard}>
                    <Text style={styles.altDetailTitle}>🔄 AI 원재료 대체 제안</Text>
                    <Text style={styles.altDetailItem}>
                      • 기존: <Text style={{ textDecorationLine: 'line-through' }}>{selectedMenu.alternativeSuggestion.originalIngredient}</Text>
                    </Text>
                    <Text style={styles.altDetailItem}>
                      • 추천: <Text style={{ fontWeight: '700', color: colors.pointOrange }}>{selectedMenu.alternativeSuggestion.suggestedIngredient}</Text>
                    </Text>
                    <View style={styles.altSavingsBadge}>
                      <Text style={styles.altSavingsText}>✨ {selectedMenu.alternativeSuggestion.expectedCostSavings}</Text>
                    </View>
                  </View>
                )}

                <PressableScale
                  style={styles.modalConfirmBtn}
                  onPress={() => setSelectedMenu(null)}
                >
                  <Text style={styles.modalConfirmText}>확인</Text>
                </PressableScale>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)', // ManagementReportCard / SalesCard와 동일한 카드 테두리 톤
    padding: spacing.globalPadding,
    gap: 14,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  title: {
    ...typography.L1,
    color: colors.espressoBrown,
  },
  sparkleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  sparkleText: {
    ...typography.L5,
    color: '#D97706',
    fontWeight: '800',
    fontSize: 11,
  },
  subtitle: {
    ...typography.L5,
    color: colors.mochaBrown,
    marginTop: 4,
    lineHeight: 16,
  },
  // AI 가이드 멘트 박스 — ManagementReportCard highlightWrap과 동일
  aiAdviceBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 12,
    gap: 6,
  },
  adviceHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  adviceHeaderTitle: {
    ...typography.L4,
    fontSize: 13,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  adviceText: {
    ...typography.L5,
    fontSize: 11,
    fontWeight: '500',
    color: colors.espressoBrown,
    lineHeight: 17,
  },
  // KPI 지표
  kpiRow: {
    flexDirection: 'row',
    gap: 8,
  },
  kpiChip: {
    flex: 1,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  kpiLabel: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
  },
  kpiValue: {
    ...typography.L3,
    fontSize: 14,
    color: colors.espressoBrown,
    fontWeight: '800',
    marginTop: 2,
  },
  kpiSubValue: {
    fontSize: 11,
    color: colors.pointOrange,
    fontWeight: '700',
  },
  // 필터 칩
  filterRow: {
    flexDirection: 'row',
    gap: 6,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterChipActive: {
    backgroundColor: colors.espressoBrown,
  },
  filterChipActiveAlert: {
    backgroundColor: '#F6DED8',
    borderColor: '#B23B2E',
  },
  filterChipText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontSize: 11,
  },
  filterChipTextActive: {
    color: colors.white,
    fontWeight: '700',
  },
  filterChipTextActiveAlert: {
    color: '#B23B2E',
    fontWeight: '700',
  },
  // 메뉴 카드
  menuItemCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.18)',
  },
  menuCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  menuName: {
    ...typography.L3,
    fontSize: 14,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  menuSubInfo: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
    marginTop: 2,
  },
  costRatioText: {
    ...typography.L4,
    fontSize: 12,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  costDetailText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontSize: 10,
    marginTop: 1,
  },
  ingredientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.coffeeCream,
  },
  ingredientLabel: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
    fontSize: 11,
  },
  ingredientListText: {
    ...typography.L5,
    color: colors.espressoBrown,
    fontSize: 11,
    flex: 1,
  },
  altBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    marginTop: 6,
  },
  altText: {
    ...typography.L5,
    color: '#B45309',
    fontSize: 11,
    flex: 1,
  },
  // 모달 스타일
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  modalTitle: {
    ...typography.L2,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  modalSubtitle: {
    ...typography.L5,
    color: colors.mochaBrown,
    marginTop: 2,
  },
  modalStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 12,
    gap: 10,
    marginBottom: 14,
  },
  modalStatItem: {
    width: '46%',
  },
  modalStatLabel: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontSize: 11,
  },
  modalStatValue: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '800',
    marginTop: 2,
  },
  sectionBox: {
    marginBottom: 14,
  },
  sectionTitle: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '800',
    marginBottom: 6,
  },
  ingChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  ingChip: {
    backgroundColor: colors.coffeeCream,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  ingChipText: {
    ...typography.L5,
    color: colors.espressoBrown,
    fontSize: 12,
  },
  modalAiText: {
    ...typography.L5,
    color: colors.espressoBrown,
    lineHeight: 18,
  },
  altDetailCard: {
    backgroundColor: '#FEF3C7',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FDE68A',
    marginBottom: 16,
  },
  altDetailTitle: {
    ...typography.L4,
    color: '#B45309',
    fontWeight: '800',
    marginBottom: 6,
  },
  altDetailItem: {
    ...typography.L5,
    color: colors.espressoBrown,
    fontSize: 12,
    marginBottom: 4,
  },
  altSavingsBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  altSavingsText: {
    ...typography.L5,
    color: colors.white,
    fontWeight: '800',
    fontSize: 11,
  },
  modalConfirmBtn: {
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalConfirmText: {
    ...typography.L3,
    color: colors.white,
    fontWeight: '700',
  },
});
