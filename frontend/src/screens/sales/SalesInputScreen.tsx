// 판매 입력 (ERP-5) — POS 연동/수동 입력 → 재고 자동 차감
import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '../../components/motion';
import { Badge, Button, Card, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

const MENUS = [
  { id: 'americano', name: '아메리카노', price: 4000 },
  { id: 'latte', name: '카페라떼', price: 4500 },
  { id: 'mocha', name: '카페모카', price: 5000 },
  { id: 'tea', name: '캐모마일', price: 4500 },
];

type Sale = { id: string; name: string; qty: number; time: string };

export default function SalesInputScreen() {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<Sale[]>([
    { id: 's1', name: '카페라떼', qty: 2, time: '방금' },
    { id: 's2', name: '아메리카노', qty: 1, time: '3분 전' },
  ]);

  const add = (id: string) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  const sub = (id: string) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) - 1) }));

  const total = Object.entries(cart).reduce((s, [id, q]) => {
    const m = MENUS.find((x) => x.id === id);
    return s + (m ? m.price * q : 0);
  }, 0);
  const count = Object.values(cart).reduce((s, q) => s + q, 0);

  const register = () => {
    const now: Sale[] = Object.entries(cart)
      .filter(([, q]) => q > 0)
      .map(([id, q]) => ({
        id: `${id}-${Date.now()}`,
        name: MENUS.find((m) => m.id === id)?.name ?? id,
        qty: q,
        time: '방금',
      }));
    setRecent((r) => [...now, ...r]);
    setCart({});
  };

  return (
    <Screen>
      <ScreenTitle title="판매 입력" subtitle="입력하면 레시피 기준 재고가 자동 차감돼요" />

      {/* POS 연동 안내 */}
      <Card tone="cream">
        <View style={styles.posRow}>
          <Ionicons name="sync-outline" size={18} color={colors.mochaBrown} />
          <Text style={styles.posText}>POS 연동 준비 중 — 지금은 수동 입력으로 사용하세요</Text>
        </View>
      </Card>

      {/* 메뉴 선택 */}
      <SectionTitle>메뉴 선택</SectionTitle>
      {MENUS.map((m) => {
        const q = cart[m.id] ?? 0;
        return (
          <Card key={m.id}>
            <View style={styles.menuRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuName}>{m.name}</Text>
                <Text style={styles.menuPrice}>₩{m.price.toLocaleString()}</Text>
              </View>
              <View style={styles.stepper}>
                <TouchableOpacity onPress={() => sub(m.id)} style={styles.stepBtn}>
                  <Ionicons name="remove" size={18} color={colors.espressoBrown} />
                </TouchableOpacity>
                <Text style={styles.qty}>{q}</Text>
                <TouchableOpacity onPress={() => add(m.id)} style={styles.stepBtn}>
                  <Ionicons name="add" size={18} color={colors.espressoBrown} />
                </TouchableOpacity>
              </View>
            </View>
          </Card>
        );
      })}

      {count > 0 && (
        <PressableScale style={styles.registerBtn} onPress={register}>
          <Text style={styles.registerText}>
            {count}잔 · ₩{total.toLocaleString()} 판매 등록
          </Text>
        </PressableScale>
      )}

      {/* 최근 판매 */}
      <SectionTitle>최근 판매</SectionTitle>
      {recent.map((s) => (
        <Card key={s.id}>
          <View style={styles.recentRow}>
            <Text style={styles.recentName}>{s.name}</Text>
            <Text style={styles.recentQty}>{s.qty}잔</Text>
            <Badge label={s.time} tone="neutral" />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  posRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  posText: { ...typography.L5, color: colors.mochaBrown, flex: 1 },
  menuRow: { flexDirection: 'row', alignItems: 'center' },
  menuName: { ...typography.L3, color: colors.espressoBrown },
  menuPrice: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: { ...typography.L3, color: colors.espressoBrown, minWidth: 18, textAlign: 'center' },
  registerBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  registerText: { ...typography.L3, color: colors.white },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recentName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  recentQty: { ...typography.L4, color: colors.mochaBrown },
});
