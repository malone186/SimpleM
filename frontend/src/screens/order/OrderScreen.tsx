// 발주 승인 (프론트 A) — PRD ERP-8, AI-3, §1.4
// AI/챗봇이 만든 발주 '초안'을 사람이 검토 후 확정. 자동 발주 금지.
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import Brew from '../../components/brew/Brew';
import EmptyState from '../../components/brew/EmptyState';
import { PopIn } from '../../components/motion';
import { Badge, Button, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type OrderItem = { name: string; qty: string; price: number };
type OrderDraft = {
  id: string;
  vendor: string;
  reason: string;
  source: string;
  items: OrderItem[];
  status: 'pending' | 'approved' | 'rejected';
};

const DRAFTS: OrderDraft[] = [
  {
    id: 'd1',
    vendor: '커피리브레 (로스터리)',
    reason: '예가체프 안전재고 미달 · 판매예측 기준 3일 내 소진 예상',
    source: 'AI 예측 추천',
    items: [
      { name: '에티오피아 예가체프 1kg', qty: '5 kg', price: 140000 },
      { name: '콜롬비아 수프리모 1kg', qty: '3 kg', price: 75000 },
    ],
    status: 'pending',
  },
  {
    id: 'd2',
    vendor: '서울F&B',
    reason: '우유 잔여 3팩 · 주말 수요 대비',
    source: '챗봇 발주 초안',
    items: [
      { name: '서울우유 1L', qty: '24 팩', price: 57600 },
      { name: '휘핑크림 500ml', qty: '6 개', price: 21000 },
    ],
    status: 'pending',
  },
];

export default function OrderScreen() {
  const [drafts, setDrafts] = useState<OrderDraft[]>(DRAFTS);

  const setStatus = (id: string, status: OrderDraft['status']) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d)));

  const pendingCount = drafts.filter((d) => d.status === 'pending').length;
  const allSettled = drafts.length > 0 && pendingCount === 0;

  // 검토할 발주가 아예 없을 때 — 턱 괸 브루 빈 화면 (#2)
  if (drafts.length === 0) {
    return (
      <Screen>
        <ScreenTitle title="발주 승인" />
        <EmptyState
          mood="resting"
          title="지금은 검토할 발주가 없어요"
          description="재고가 부족해지면 브루가 발주 초안을 여기에 올려둘게요."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenTitle title="발주 승인" subtitle={`검토 대기 ${pendingCount}건 · 승인해야 발주가 확정돼요`} />

      {/* 모두 처리한 순간 — 웃는 브루 + 하트 (#6 성취) */}
      {allSettled && (
        <PopIn>
          <Card tone="cream" style={styles.celebrate}>
            <Brew mood="happy" size={64} />
            <View style={{ flex: 1 }}>
              <Text style={styles.celebrateTitle}>오늘 발주를 다 처리했어요! 💛</Text>
              <Text style={styles.celebrateSub}>브루가 꼼꼼히 챙겼어요. 고생하셨어요 사장님!</Text>
            </View>
          </Card>
        </PopIn>
      )}

      {drafts.map((d) => {
        const total = d.items.reduce((sum, it) => sum + it.price, 0);
        return (
          <Card key={d.id} style={d.status !== 'pending' ? styles.settled : undefined}>
            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.vendor}>{d.vendor}</Text>
                <Text style={styles.reason}>{d.reason}</Text>
              </View>
              {d.status === 'pending' && <Badge label={d.source} tone="orange" />}
              {d.status === 'approved' && <Badge label="발주 확정" tone="green" />}
              {d.status === 'rejected' && <Badge label="반려됨" tone="neutral" />}
            </View>

            <View style={styles.itemBox}>
              {d.items.map((it, i) => (
                <View key={i} style={styles.itemRow}>
                  <Text style={styles.itemName}>{it.name}</Text>
                  <Text style={styles.itemQty}>{it.qty}</Text>
                  <Text style={styles.itemPrice}>₩{it.price.toLocaleString()}</Text>
                </View>
              ))}
              <Divider />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>합계</Text>
                <Text style={styles.totalValue}>₩{total.toLocaleString()}</Text>
              </View>
            </View>

            {d.status === 'pending' ? (
              <View style={styles.actions}>
                <Button
                  label="반려"
                  variant="secondary"
                  onPress={() => setStatus(d.id, 'rejected')}
                  style={{ flex: 1 }}
                />
                <Button
                  label="승인하고 발주"
                  onPress={() => setStatus(d.id, 'approved')}
                  style={{ flex: 1.6 }}
                />
              </View>
            ) : (
              <View style={styles.settledRow}>
                <Ionicons
                  name={d.status === 'approved' ? 'checkmark-circle' : 'close-circle'}
                  size={16}
                  color={d.status === 'approved' ? colors.trendGreenText : colors.mochaBrown}
                />
                <Text style={styles.settledText}>
                  {d.status === 'approved' ? '발주가 확정되었습니다' : '초안을 반려했습니다'}
                </Text>
              </View>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  settled: { opacity: 0.72 },
  celebrate: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  celebrateTitle: { ...typography.L3, color: colors.espressoBrown },
  celebrateSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, lineHeight: 15 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  vendor: { ...typography.L3, color: colors.espressoBrown },
  reason: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, lineHeight: 15 },
  itemBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  itemName: { ...typography.L5, color: colors.espressoBrown, flex: 1 },
  itemQty: { ...typography.L5, color: colors.mochaBrown, width: 52, textAlign: 'right' },
  itemPrice: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 76, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { ...typography.L4, color: colors.mochaBrown },
  totalValue: { ...typography.L3, color: colors.pointOrange },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  settledRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  settledText: { ...typography.L5, color: colors.mochaBrown },
});
