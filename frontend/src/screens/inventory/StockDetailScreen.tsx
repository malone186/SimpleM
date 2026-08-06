// 재고 확인 (한 재료만) — 홈 할 일에서 재고 항목을 눌렀을 때 열리는 화면.
//
// 재고 탭으로 보내면 탭이 통째로 바뀌어 하던 일(할 일 목록)에서 튕겨 나가고,
// 긴 목록에서 그 재료를 다시 찾아야 한다. 그래서 스택 위에 이 화면만 얹는다 —
// 뒤로가기 한 번이면 누르던 할 일로 그대로 돌아온다.
//
// 이 화면이 하는 일은 딱 세 가지다: 얼마나 남았는지 보여주고, 바로 채워 넣고,
// 필요하면 전체 재고 목록으로 넘겨준다.
import { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { FadeInUp, PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Button, Card, ProgressBar } from '../../components/ui';
import { adjustStock, listStocks, type StockItem } from '../../lib/api/inventory';
import { colors, spacing, typography } from '../../theme';
import { useBottomInset } from '../../theme/responsive';

/** 남은 양이 안전 수량 대비 어느 정도인지 — 배지·진행바·안내 문구를 한 번에 정한다 */
function getStatus(s: StockItem) {
  // 안전 수량을 정해두지 않은 재료는 3을 기준으로 본다 (대시보드 할 일과 같은 규칙)
  const safety = s.safety_quantity > 0 ? s.safety_quantity : 3;
  const ratio = safety > 0 ? s.current_quantity / safety : 1;

  if (s.current_quantity <= 0) {
    return {
      safety,
      ratio: 0,
      tone: 'danger' as const,
      label: '다 떨어짐',
      message: `지금 ${s.name}이(가) 하나도 없어요. 바로 채워 넣어야 해요.`,
    };
  }
  if (s.current_quantity <= safety) {
    return {
      safety,
      ratio,
      tone: 'danger' as const,
      label: '부족',
      message: `최소 ${safety}${s.unit}은 있어야 하는데 ${s.current_quantity}${s.unit} 남았어요.`,
    };
  }
  return {
    safety,
    ratio,
    tone: 'green' as const,
    label: '넉넉함',
    message: `최소 ${safety}${s.unit} 기준으로 여유가 있어요.`,
  };
}

export default function StockDetailScreen() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const bottomInset = useBottomInset();

  // 푸시 알림으로 들어오면 문자열("12")이고 앱 안에서 넘기면 숫자(12)다 — 숫자로 통일한다
  const ingredientId = Number(route.params?.ingredientId) || undefined;

  const [stock, setStock] = useState<StockItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);

  // 재고는 단건 조회 API가 없다 — 목록에서 골라 쓴다 (품목 수가 많지 않아 부담이 없다)
  const load = useCallback(async () => {
    if (!token || !ingredientId) {
      setLoading(false);
      return;
    }
    try {
      const list = await listStocks(token);
      setStock(list.find((s) => s.ingredient_id === ingredientId) ?? null);
    } catch (e) {
      toast('불러오기 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [token, ingredientId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // 입고(+) / 차감(−) — 반영 후 목록을 다시 읽어 남은 양을 바로 갱신한다
  const apply = async (sign: 1 | -1) => {
    if (!token || !stock) return;
    const n = Number(qty);
    if (!n || n <= 0) return toast('입력 확인', '0보다 큰 수량을 입력해 주세요.');

    setSaving(true);
    try {
      await adjustStock(token, {
        ingredient_id: stock.ingredient_id,
        quantity_change: sign * n,
        description: sign > 0 ? '직접 입고' : '직접 차감',
      });
      setQty('');
      await load();
      toast('반영 완료', `${stock.name} ${sign > 0 ? '+' : '−'}${n}${stock.unit} 반영했어요.`);
    } catch (e) {
      toast('반영 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const openFullInventory = () => {
    navigation.navigate('Tabs', {
      screen: 'Inventory',
      params: { focusIngredientId: ingredientId, ts: Date.now() },
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.mochaBrown} />
      </View>
    );
  }

  // 재료가 그 사이 삭제됐거나 파라미터가 빠진 경우 — 막다른 길로 두지 않고 전체 목록으로 보낸다
  if (!stock) {
    return (
      <View style={styles.centered}>
        <Ionicons name="file-tray-outline" size={34} color={colors.mochaBrown} />
        <Text style={styles.emptyTitle}>재료를 찾지 못했어요</Text>
        <Text style={styles.emptyBody}>
          삭제됐거나 다른 매장의 재료일 수 있어요. 전체 재고에서 확인해 주세요.
        </Text>
        <Button label="전체 재고 보기" onPress={openFullInventory} style={{ marginTop: 14 }} />
      </View>
    );
  }

  const status = getStatus(stock);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 28 }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.mochaBrown} />
      }
    >
      {/* ── 남은 양 ── 이 화면에서 제일 먼저 읽혀야 하는 한 줄 */}
      <FadeInUp>
        <Card>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={2}>
              {stock.name}
            </Text>
            <Badge label={status.label} tone={status.tone === 'danger' ? 'danger' : 'green'} />
          </View>

          <View style={styles.qtyRow}>
            <Text style={[styles.qty, status.tone === 'danger' && styles.qtyDanger]}>
              {stock.current_quantity}
            </Text>
            <Text style={styles.unit}>{stock.unit}</Text>
            <Text style={styles.safety}>／ 최소 {status.safety}{stock.unit}</Text>
          </View>

          <ProgressBar ratio={status.ratio} tone={status.tone} />
          <Text style={[styles.statusMsg, status.tone === 'danger' && styles.statusMsgDanger]}>
            {status.message}
          </Text>
        </Card>
      </FadeInUp>

      {/* ── 바로 채워 넣기 ── 목록으로 되돌아가지 않고 여기서 끝낼 수 있게 */}
      <FadeInUp delay={60}>
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.sectionLabel}>수량 조정</Text>
          <View style={styles.adjustRow}>
            <TextInput
              style={styles.input}
              value={qty}
              onChangeText={setQty}
              keyboardType="numeric"
              placeholder={`수량 (${stock.unit})`}
              placeholderTextColor="#A1A1AA"
              editable={!saving}
            />
            <PressableScale
              onPress={() => apply(-1)}
              disabled={saving}
              style={[styles.stepBtn, styles.stepMinus, saving && styles.btnBusy]}
            >
              <Ionicons name="remove" size={18} color={colors.espressoBrown} />
            </PressableScale>
            <PressableScale
              onPress={() => apply(1)}
              disabled={saving}
              style={[styles.stepBtn, styles.stepPlus, saving && styles.btnBusy]}
            >
              <Ionicons name="add" size={18} color={colors.white} />
            </PressableScale>
          </View>
          <Text style={styles.hint}>＋는 입고, －는 차감·폐기로 기록돼요.</Text>
        </Card>
      </FadeInUp>

      {/* ── 단가·갱신 시각 ── 발주 금액을 가늠할 때만 필요한 정보라 아래로 */}
      <FadeInUp delay={120}>
        <Card style={{ marginTop: 12 }}>
          <View style={styles.metaRow}>
            <Text style={styles.metaKey}>단가</Text>
            <Text style={styles.metaVal}>
              ₩{stock.current_price.toLocaleString()} / {stock.unit}
            </Text>
          </View>
          <View style={[styles.metaRow, { marginTop: 8 }]}>
            <Text style={styles.metaKey}>마지막 변동</Text>
            <Text style={styles.metaVal}>
              {stock.updated_at ? new Date(stock.updated_at).toLocaleString('ko-KR') : '기록 없음'}
            </Text>
          </View>
        </Card>
      </FadeInUp>

      <Button
        label="전체 재고 보기"
        variant="secondary"
        onPress={openFullInventory}
        style={{ marginTop: 14 }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  content: { padding: spacing.globalPadding },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.creamSand,
    padding: spacing.globalPadding,
    gap: 6,
  },
  emptyTitle: { ...typography.L3, color: colors.espressoBrown, marginTop: 6 },
  emptyBody: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { ...typography.L1, color: colors.espressoBrown, flex: 1 },

  qtyRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 12, marginBottom: 10 },
  qty: { ...typography.L2, color: colors.espressoBrown },
  qtyDanger: { color: '#B23B2E' },
  unit: { ...typography.L3, color: colors.espressoBrown },
  safety: { ...typography.L5, color: colors.mochaBrown, marginLeft: 4 },

  statusMsg: { ...typography.L5, color: colors.mochaBrown, marginTop: 8, lineHeight: 16 },
  statusMsgDanger: { color: '#B23B2E', fontWeight: '700' },

  sectionLabel: { ...typography.L4, color: colors.espressoBrown, marginBottom: 8 },
  adjustRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    color: colors.espressoBrown,
    fontSize: 13,
    fontWeight: '700',
  },
  stepBtn: { width: 46, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stepMinus: { backgroundColor: colors.coffeeCream, borderWidth: 1, borderColor: colors.mutedSand },
  stepPlus: { backgroundColor: colors.espressoBrown },
  btnBusy: { opacity: 0.5 },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 8 },

  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  metaKey: { ...typography.L5, color: colors.mochaBrown },
  metaVal: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
});
