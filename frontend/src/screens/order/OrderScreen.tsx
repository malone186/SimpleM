// 발주 추천 (프론트 A) — PRD ERP-8, AI-3, §1.4
// AI가 부족 재고를 분석해 발주를 '추천'만 한다. 실제 발주는 사장님이 거래처에 직접 진행 (자동 발주 금지).
// 품목을 누르면 쇼핑몰 최저가순 검색 결과로 이동 — 현재 매입 단가를 기준점으로 비교할 수 있다.
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import EmptyState from '../../components/brew/EmptyState';
import { PressableScale } from '../../components/motion';
import { Badge, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';
import { listOrderDrafts, OrderDraft } from '../../lib/api/inventory';

// 쇼핑몰 최저가순 검색 링크 — 실시간 크롤링 대신 항상 최신 가격을 보는 정직한 방식
const SHOP_LINKS = [
  {
    name: '네이버 최저가',
    url: (q: string) =>
      `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}&sort=price_asc`,
  },
  {
    name: '쿠팡',
    url: (q: string) =>
      `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}&sorter=salePriceAsc`,
  },
];

// "종이컵 12oz (줄(50개))" 같은 단위 괄호를 떼서 검색어 품질을 높인다
const searchTerm = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim();

export default function OrderScreen() {
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const [loading, setLoading] = useState(true);

  // 로컬 세션 보관소에서 암호화 로그인 출입증(Token)을 획득합니다.
  const getAuthToken = async () => {
    const raw = await AsyncStorage.getItem('simplem:session');
    if (raw) {
      const session = JSON.parse(raw);
      return session?.token || null;
    }
    return null;
  };

  // 백엔드 주방에 물어보고 부족 재고 기반 발주 추천 리스트를 새로 채워옵니다.
  const loadDrafts = async () => {
    try {
      setLoading(true);
      const token = await getAuthToken();
      if (!token) return;

      const data = await listOrderDrafts(token);
      // 추천 화면이므로 검토 대기(DRAFT) 추천만 보여준다
      setDrafts(data.filter((d) => d.status === 'DRAFT'));
    } catch (e) {
      console.error('발주 추천 목록 조회 실패:', e);
    } finally {
      setLoading(false);
    }
  };

  // 화면이 활성화될 때 자동으로 발주 추천을 갱신합니다.
  useEffect(() => {
    loadDrafts();
  }, []);

  // 1. 데이터 로딩 화면
  if (loading) {
    return (
      <Screen>
        <ScreenTitle title="발주 추천" />
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.espressoBrown} />
          <Text style={styles.loadingText}>실시간 매장 재고 현황을 분석하고 있어요...</Text>
        </View>
      </Screen>
    );
  }

  // 2. 추천할 발주가 아예 없는 안전한 상태 — 턱 괸 브루 빈 화면 (#2)
  if (drafts.length === 0) {
    return (
      <Screen>
        <ScreenTitle title="발주 추천" />
        <EmptyState
          mood="resting"
          title="지금은 추천할 발주가 없어요"
          description="모든 식재료 재고가 안전 수량 이상으로 넉넉해요. 재고가 부족해지면 브루가 여기에 추천 발주안을 올릴게요."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenTitle
        title="발주 추천"
        subtitle={`부족 재고 기반 추천 ${drafts.length}건 · 실제 발주는 거래처에 직접 진행하세요`}
      />

      {drafts.map((d) => (
        <Card key={d.id}>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.vendor}>{d.vendor}</Text>
              <Text style={styles.reason}>{d.reason}</Text>
            </View>
            <Badge label={d.source} tone="orange" />
          </View>

          <View style={styles.itemBox}>
            {d.items.map((it, i) => (
              <View key={i} style={styles.itemBlock}>
                <View style={styles.itemRow}>
                  <Text style={styles.itemName}>{it.ingredient_name}</Text>
                  <Text style={styles.itemQty}>{it.quantity}개</Text>
                  <Text style={styles.itemPrice}>₩{(it.quantity * it.price_at_order).toLocaleString()}</Text>
                </View>
                {/* 현재 매입 단가를 기준점으로, 쇼핑몰 최저가순 결과로 바로 이동 */}
                <View style={styles.linkRow}>
                  <Text style={styles.unitPrice}>
                    현재 단가 ₩{it.price_at_order.toLocaleString()} — 더 싸게:
                  </Text>
                  {SHOP_LINKS.map((s) => (
                    <PressableScale
                      key={s.name}
                      style={styles.linkChip}
                      onPress={() => Linking.openURL(s.url(searchTerm(it.ingredient_name)))}
                    >
                      <Ionicons name="open-outline" size={10} color={colors.pointOrange} />
                      <Text style={styles.linkChipText}>{s.name}</Text>
                    </PressableScale>
                  ))}
                </View>
              </View>
            ))}
            <Divider />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>예상 금액</Text>
              <Text style={styles.totalValue}>₩{d.total_amount.toLocaleString()}</Text>
            </View>
          </View>
        </Card>
      ))}

      <Text style={styles.footNote}>
        추천 수량은 안전재고와 최근 판매량 기준이에요. 링크는 최저가순 검색 결과로 연결되니,
        현재 단가와 비교해 더 저렴한 곳에서 직접 발주해 주세요.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  loadingText: { marginTop: 12, color: colors.mochaBrown, ...typography.L4 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  vendor: { ...typography.L3, color: colors.espressoBrown },
  reason: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, lineHeight: 15 },
  itemBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  itemBlock: { gap: 5 },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  linkRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  unitPrice: { ...typography.L5, fontSize: 9, color: colors.mochaBrown },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  linkChipText: { ...typography.L5, fontSize: 9, fontWeight: '700', color: colors.pointOrange },
  itemName: { ...typography.L5, color: colors.espressoBrown, flex: 1 },
  itemQty: { ...typography.L5, color: colors.mochaBrown, width: 52, textAlign: 'right' },
  itemPrice: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 76, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { ...typography.L4, color: colors.mochaBrown },
  totalValue: { ...typography.L3, color: colors.pointOrange },
  footNote: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 15, marginTop: 4 },
});
