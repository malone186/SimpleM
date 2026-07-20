// 판매 입력 (ERP-5) — POS 연동/수동 입력 → 재고 자동 차감
// 데이터: /inventory/menus(메뉴) + /chatbot/sales(판매 등록·최근 내역) — 하드코딩 없음
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { Badge, Card, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { listMenus, listRecentSales, recordSales, type MenuItem, type RecentSale } from '../../lib/api/sales';
import { colors, typography } from '../../theme';

// 판매 시각 → "방금" / "N분 전" / "N시간 전" / 날짜
function timeAgo(soldAt: string): string {
  const t = new Date(soldAt.replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) return soldAt.slice(0, 10);
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}시간 전`;
  return soldAt.slice(0, 10);
}

export default function SalesInputScreen() {
  const { token } = useAuth();
  const [menus, setMenus] = useState<MenuItem[] | null>(null);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadRecent = useCallback(async () => {
    if (!token) return;
    try {
      setRecent(await listRecentSales(token, 10));
    } catch (e) {
      console.error('최근 판매 조회 실패:', e);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listMenus(token);
        if (!cancelled) setMenus(rows.filter((m) => m.selling_price > 0));
      } catch (e) {
        console.error('메뉴 조회 실패:', e);
        if (!cancelled) setFailed(true);
      }
    })();
    loadRecent();
    return () => {
      cancelled = true;
    };
  }, [token, loadRecent]);

  const add = (id: number) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  const sub = (id: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) - 1) }));

  const total = Object.entries(cart).reduce((s, [id, q]) => {
    const m = menus?.find((x) => x.id === Number(id));
    return s + (m ? m.selling_price * q : 0);
  }, 0);
  const count = Object.values(cart).reduce((s, q) => s + q, 0);

  const register = async () => {
    if (!token || submitting) return;
    const items = Object.entries(cart)
      .filter(([, q]) => q > 0)
      .map(([id, q]) => ({ menu_id: Number(id), quantity: q }));
    if (items.length === 0) return;
    setSubmitting(true);
    try {
      await recordSales(token, items);
      setCart({});
      await loadRecent();
    } catch (e) {
      console.error('판매 등록 실패:', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title="판매 입력" subtitle="입력하면 레시피 기준 재고가 자동 차감돼요" />

      {/* POS 연동 안내 */}
      <Card tone="cream">
        <View style={styles.posRow}>
          <Ionicons name="sync-outline" size={18} color={colors.mochaBrown} />
          <Text style={styles.posText}>POS 자동 동기화 외 판매는 여기서 수동 입력하세요</Text>
        </View>
      </Card>

      {/* 메뉴 선택 */}
      <SectionTitle>메뉴 선택</SectionTitle>

      {menus === null && !failed && (
        <Card>
          <View style={styles.stateWrap}>
            <ActivityIndicator color={colors.mochaBrown} />
            <Text style={styles.stateText}>메뉴를 불러오는 중…</Text>
          </View>
        </Card>
      )}

      {failed && (
        <Card>
          <Text style={styles.stateText}>메뉴를 가져오지 못했어요. 로그인과 서버를 확인해 주세요.</Text>
        </Card>
      )}

      {menus !== null && menus.length === 0 && (
        <Card>
          <Text style={styles.stateText}>등록된 메뉴가 없어요. 메뉴 관리에서 먼저 메뉴를 등록해 주세요.</Text>
        </Card>
      )}

      {(menus ?? []).map((m) => {
        const q = cart[m.id] ?? 0;
        return (
          <Card key={m.id}>
            <View style={styles.menuRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuName}>{m.name}</Text>
                <Text style={styles.menuPrice}>₩{m.selling_price.toLocaleString()}</Text>
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
        <PressableScale style={[styles.registerBtn, submitting && { opacity: 0.6 }]} onPress={register}>
          <Text style={styles.registerText}>
            {submitting ? '등록 중…' : `${count}잔 · ₩${total.toLocaleString()} 판매 등록`}
          </Text>
        </PressableScale>
      )}

      {/* 최근 판매 */}
      <SectionTitle>최근 판매</SectionTitle>
      {recent.length === 0 && (
        <Card>
          <Text style={styles.stateText}>아직 판매 기록이 없어요.</Text>
        </Card>
      )}
      {recent.map((s) => (
        <Card key={s.id}>
          <View style={styles.recentRow}>
            <Text style={styles.recentName}>{s.name}</Text>
            <Text style={styles.recentQty}>{s.quantity}잔</Text>
            <Badge label={timeAgo(s.sold_at)} tone="neutral" />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  posRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  posText: { ...typography.L5, color: colors.mochaBrown, flex: 1 },
  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 },
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
