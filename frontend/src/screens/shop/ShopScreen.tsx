// 상점 — 할 일을 끝내 모은 코인으로 브루를 꾸민다 (게임화 보상)
// 상단: 브루 미리보기 + 코인 잔액 / 중단: 부위별 아이템 / 하단: 적립·사용 내역
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import Brew, { type BrewMood } from '../../components/brew/Brew';
import { ACCESSORY_ART } from '../../components/brew/accessories';
import { FadeInUp, PressableScale, useCountUp } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import {
  buyItem,
  equipItem,
  getShop,
  getWallet,
  type ItemSlot,
  type PointHistoryItem,
  type ShopItem,
  type ShopState,
  type Wallet,
} from '../../lib/api/rewards';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, typography } from '../../theme';

// 화면에 보여줄 부위 순서 — 위에서부터 눈에 띄는 것 순
const SLOT_ORDER: ItemSlot[] = ['pose', 'background'];

export default function ShopScreen() {
  const { token } = useAuth();
  // 구매·착용하면 홈 화면 마스코트도 같이 바뀌어야 한다
  const { refresh: refreshEquipped } = useEquipped();
  const [shop, setShop] = useState<ShopState | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [s, w] = await Promise.all([getShop(token), getWallet(token)]);
      setShop(s);
      setWallet(w);
    } catch {
      toast('불러오기 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // 잔액이 촤르륵 올라가면 모은 느낌이 산다
  const coins = useCountUp(shop?.balance ?? 0, 700, [shop?.balance]);

  const handleBuy = (item: ShopItem) => {
    confirmDialog(`${item.name}을(를) ${item.price}코인에 구매할까요?`, {
      confirmLabel: '구매',
      onConfirm: async () => {
        setBusyItem(item.id);
        try {
          const next = await buyItem(item.id, token);
          setShop(next);
          setWallet(await getWallet(token));
          await refreshEquipped(); // 홈 화면 마스코트에도 즉시 반영
          toast('구매 완료', `${item.name} 적용! 홈 화면 브루도 같이 바뀌었어요.`);
        } catch (e) {
          toast('구매 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        } finally {
          setBusyItem(null);
        }
      },
    });
  };

  const handleToggleEquip = async (item: ShopItem) => {
    setBusyItem(item.id);
    try {
      setShop(await equipItem(item.id, !item.equipped, token));
      await refreshEquipped(); // 홈 화면 마스코트에도 즉시 반영
    } catch (e) {
      toast('변경 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyItem(null);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={colors.pointOrange} />
        </View>
      </Screen>
    );
  }

  // 착용 중인 포즈가 있으면 그 모습으로 미리 보여준다 (없으면 기본 인사 포즈)
  const equippedPose = (shop?.items ?? []).find((i) => i.equipped && i.slot === 'pose');
  const previewMood = (equippedPose?.mood as BrewMood | undefined) ?? 'top';
  const equipped = (shop?.items ?? [])
    .filter((i) => i.equipped && i.slot === 'background')
    .map((i) => ({ id: i.id, slot: 'background' as const, emoji: i.emoji }));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.creamSand }}
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.mochaBrown} />}
    >
      <ScreenTitle title="상점" subtitle="할 일을 끝내면 코인이 쌓여요" />

      {/* ── 브루 미리보기 + 잔액 ── */}
      <FadeInUp>
        <Card style={styles.heroCard}>
          <Brew mood={previewMood} size={130} accessories={equipped} />
          <View style={styles.coinRow}>
            <Text style={styles.coinIcon}>🪙</Text>
            <Text style={styles.coinValue}>{coins.toLocaleString()}</Text>
            <Text style={styles.coinUnit}>코인</Text>
          </View>
          {wallet && (
            <Text style={styles.earnedHint}>지금까지 {wallet.total_earned.toLocaleString()}코인을 모았어요</Text>
          )}
        </Card>
      </FadeInUp>

      {/* ── 부위별 아이템 ── */}
      {SLOT_ORDER.map((slot, si) => {
        const items = (shop?.items ?? []).filter((i) => i.slot === slot);
        if (!items.length) return null;
        return (
          <FadeInUp key={slot} delay={60 + si * 50}>
            <SectionTitle>{items[0].slot_label}</SectionTitle>
            <View style={{ gap: 10, marginBottom: 6 }}>
              {items.map((item) => (
                <ShopRow
                  key={item.id}
                  item={item}
                  busy={busyItem === item.id}
                  onBuy={() => handleBuy(item)}
                  onToggle={() => handleToggleEquip(item)}
                />
              ))}
            </View>
          </FadeInUp>
        );
      })}

      {/* ── 적립·사용 내역 ── */}
      <FadeInUp delay={300}>
        <SectionTitle>코인 내역</SectionTitle>
        <Card>
          {!wallet?.history.length ? (
            <Text style={styles.emptyText}>
              아직 내역이 없어요. 대시보드에서 할 일을 완료하면 코인이 쌓여요!
            </Text>
          ) : (
            wallet.history.map((h, i) => (
              <HistoryRow key={h.id} item={h} last={i === wallet.history.length - 1} />
            ))
          )}
        </Card>
      </FadeInUp>
    </ScrollView>
  );
}

function ShopRow({
  item,
  busy,
  onBuy,
  onToggle,
}: {
  item: ShopItem;
  busy: boolean;
  onBuy: () => void;
  onToggle: () => void;
}) {
  return (
    <Card style={[styles.itemCard, item.equipped && styles.itemCardOn]}>
      {/* 사기 전 미리보기와 산 뒤 모습이 정확히 같아야 한다 */}
      <View style={styles.itemEmojiWrap}>
        <ItemArt item={item} />
      </View>

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.itemName}>{item.name}</Text>
          {item.equipped && <Badge label="착용 중" tone="green" />}
        </View>
        <Text style={styles.itemDesc}>{item.desc}</Text>
      </View>

      {busy ? (
        <ActivityIndicator color={colors.mochaBrown} style={{ width: 78 }} />
      ) : item.owned ? (
        <PressableScale
          style={[styles.actionBtn, item.equipped ? styles.actionBtnOff : styles.actionBtnOn]}
          onPress={onToggle}
        >
          <Text style={[styles.actionText, item.equipped && styles.actionTextOff]}>
            {item.equipped ? '벗기' : '착용'}
          </Text>
        </PressableScale>
      ) : (
        <PressableScale
          style={[styles.actionBtn, item.affordable ? styles.actionBtnBuy : styles.actionBtnLocked]}
          onPress={item.affordable ? onBuy : undefined}
          disabled={!item.affordable}
        >
          <Ionicons
            name={item.affordable ? 'cart' : 'lock-closed'}
            size={12}
            color={item.affordable ? colors.white : colors.mochaBrown}
          />
          <Text style={[styles.actionText, !item.affordable && styles.actionTextLocked]}>{item.price}</Text>
        </PressableScale>
      )}
    </Card>
  );
}

/** 목록 썸네일 — 사면 실제로 보게 될 그림을 그대로 작게 보여준다 (포즈는 브루 자신) */
function ItemArt({ item }: { item: ShopItem }) {
  if (item.slot === 'pose' && item.mood) {
    return <Brew mood={item.mood as BrewMood} size={42} disableMotion />;
  }
  const Art = ACCESSORY_ART[item.id];
  return Art ? <Art size={30} /> : <Text style={{ fontSize: 24 }}>{item.emoji}</Text>;
}

function HistoryRow({ item, last }: { item: PointHistoryItem; last: boolean }) {
  const earned = item.delta > 0;
  return (
    <View style={[styles.historyRow, !last && styles.historyRowBorder]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.historyLabel}>{item.reason_label}</Text>
        {!!item.memo && (
          <Text style={styles.historyMemo} numberOfLines={1}>
            {item.memo}
          </Text>
        )}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.historyDelta, earned ? styles.deltaPlus : styles.deltaMinus]}>
          {earned ? '+' : ''}
          {item.delta}
        </Text>
        <Text style={styles.historyDate}>{formatDate(item.created_at)}</Text>
      </View>
    </View>
  );
}

// 'YYYY-MM-DDTHH:mm:ss' → 'M월 D일'. 서버가 tz 없는 값을 줄 때도 깨지지 않게 문자열을 직접 자른다.
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  heroCard: { alignItems: 'center', paddingVertical: 22, marginBottom: 6 },
  coinRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 10 },
  coinIcon: { fontSize: 24, marginBottom: 2 },
  coinValue: { ...typography.L2, color: colors.espressoBrown },
  coinUnit: { ...typography.L3, color: colors.mochaBrown, marginBottom: 3 },
  earnedHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },

  itemCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  itemCardOn: { borderWidth: 1.2, borderColor: colors.pointOrange + '55' },
  itemEmojiWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemEmoji: { fontSize: 24 },
  itemName: { ...typography.L3, color: colors.espressoBrown },
  itemDesc: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 78,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  actionBtnBuy: { backgroundColor: colors.pointOrange },
  actionBtnOn: { backgroundColor: colors.mochaBrown },
  actionBtnOff: { backgroundColor: colors.coffeeCream },
  actionBtnLocked: { backgroundColor: colors.coffeeCream },
  actionText: { ...typography.L4, color: colors.white },
  actionTextOff: { color: colors.mochaBrown },
  actionTextLocked: { color: colors.mochaBrown },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 10 },
  historyRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.mutedSand },
  historyLabel: { ...typography.L4, color: colors.espressoBrown },
  historyMemo: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  historyDelta: { ...typography.L3 },
  deltaPlus: { color: colors.trendGreenText },
  deltaMinus: { color: colors.mochaBrown },
  historyDate: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  emptyText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', paddingVertical: 18, lineHeight: 17 },
});
