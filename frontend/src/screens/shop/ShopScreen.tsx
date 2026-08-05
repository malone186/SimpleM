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
  getProgress,
  getShop,
  getWallet,
  type ItemSlot,
  type PointHistoryItem,
  type Progress,
  type ShopItem,
  type ShopState,
  type Wallet,
} from '../../lib/api/rewards';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, typography } from '../../theme';
// [한글 주석] load() 안의 지역변수 s(shop 응답)와 겹치지 않게 스케일 함수는 sc 로 별칭 처리
import { s as sc, useBottomInset, useResponsive, useTopInset } from '../../theme/responsive';

// 화면에 보여줄 부위 순서 — 위에서부터 눈에 띄는 것 순
const SLOT_ORDER: ItemSlot[] = ['pose', 'apron', 'background'];

export default function ShopScreen() {
  const { token } = useAuth();
  // [한글 주석] 기기 안전영역 실측 — 탭 직속 화면이라 위·아래를 직접 비워 줘야 한다
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { gutter, isWide, contentMaxWidth } = useResponsive();
  // 구매·착용하면 홈 화면 마스코트도 같이 바뀌어야 한다
  const { refresh: refreshEquipped } = useEquipped();
  const [shop, setShop] = useState<ShopState | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [s, w, p] = await Promise.all([getShop(token), getWallet(token), getProgress(token)]);
      setShop(s);
      setWallet(w);
      setProgress(p);
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
      <Screen safeTop withTabBar>
        <View style={styles.center}>
          <ActivityIndicator color={colors.pointOrange} />
        </View>
      </Screen>
    );
  }

  // 착용 중인 포즈가 있으면 그 모습으로 미리 보여준다 (없으면 기본 인사 포즈)
  const equippedPose = (shop?.items ?? []).find((i) => i.equipped && i.slot === 'pose');
  const previewMood = (equippedPose?.mood as BrewMood | undefined) ?? 'top';
  // 착용한 앞치마 색 — 미리보기 브루에 그대로 반영
  const previewApron = (shop?.items ?? []).find((i) => i.equipped && i.slot === 'apron')?.color ?? undefined;
  // 겹쳐 그리는 배경 효과만 accessories로 (포즈·앞치마는 그림 자체가 바뀌므로 제외)
  const equipped = (shop?.items ?? [])
    .filter((i) => i.equipped && i.slot === 'background')
    .map((i) => ({ id: i.id, slot: 'background' as const, emoji: i.emoji }));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.creamSand }}
      // [한글 주석] 탭 직속 화면 — 위는 노치/펀치홀 실측 여백, 아래는 제스처 바 + 탭 바 높이만큼 비운다.
      // 예전 고정값(padding 20 / paddingBottom 40)은 마지막 카드가 탭 바에 가려졌다.
      contentContainerStyle={{
        paddingHorizontal: gutter,
        paddingTop: topInset + sc(8),
        paddingBottom: bottomInset + sc(88),
        ...(isWide ? { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' } : null),
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.mochaBrown} />}
    >
      <ScreenTitle title="상점" subtitle="할 일을 끝내면 코인이 쌓여요" />

      {/* ── 브루 미리보기 + 잔액 ── */}
      <FadeInUp>
        <Card style={styles.heroCard}>
          <Brew mood={previewMood} size={130} accessories={equipped} apronColor={previewApron} />
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

      {/* ── 브루 키우기 (레벨·EXP·스트릭·일일 도전) ── */}
      {progress && (
        <FadeInUp delay={40}>
          <GrowthCard progress={progress} />
        </FadeInUp>
      )}

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
                  apronColor={previewApron}
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
  apronColor,
  busy,
  onBuy,
  onToggle,
}: {
  item: ShopItem;
  apronColor?: string; // 지금 착용 중인 앞치마 색 — 포즈 썸네일에도 입혀서 보여준다
  busy: boolean;
  onBuy: () => void;
  onToggle: () => void;
}) {
  return (
    <Card style={[styles.itemCard, item.equipped && styles.itemCardOn]}>
      {/* 사기 전 미리보기와 산 뒤 모습이 정확히 같아야 한다 */}
      <View style={styles.itemEmojiWrap}>
        <ItemArt item={item} apronColor={apronColor} />
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

/** 브루 키우기 카드 — 레벨·EXP 바·스트릭 불꽃·오늘의 도전 */
function GrowthCard({ progress }: { progress: Progress }) {
  const expPct = Math.max(0, Math.min(1, progress.exp_in_level / Math.max(1, progress.exp_to_next)));
  const remain = Math.max(0, progress.exp_to_next - progress.exp_in_level);
  const d = progress.daily;
  const dailyPct = Math.max(0, Math.min(1, d.progress / Math.max(1, d.goal)));
  return (
    <Card style={styles.growthCard}>
      <View style={styles.growthTop}>
        <View style={styles.levelBadge}>
          <Text style={styles.levelBadgeText}>Lv.{progress.level}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.growthTitle}>{progress.level_title}</Text>
          <Text style={styles.growthSub}>다음 레벨까지 {remain} EXP</Text>
        </View>
        <View style={[styles.streakPill, !progress.streak_active_today && styles.streakPillDim]}>
          <Text style={styles.streakEmoji}>🔥</Text>
          <Text style={styles.streakText}>{progress.streak}일</Text>
        </View>
      </View>

      <View style={styles.expTrack}>
        <View style={[styles.expFill, { width: `${expPct * 100}%` }]} />
      </View>

      <View style={styles.dailyRow}>
        <Text style={styles.dailyLabel}>
          오늘의 도전 · 할 일 {d.progress}/{d.goal}
        </Text>
        {d.claimed ? (
          <Badge label={`+${d.reward} 완료`} tone="green" />
        ) : (
          <Text style={styles.dailyReward}>달성 시 +{d.reward} 🪙</Text>
        )}
      </View>
      <View style={styles.dailyTrack}>
        <View style={[styles.dailyFill, { width: `${dailyPct * 100}%` }]} />
      </View>
    </Card>
  );
}

/** 목록 썸네일 — 사면 실제로 보게 될 그림을 그대로 작게 보여준다 (포즈는 브루 자신) */
function ItemArt({ item, apronColor }: { item: ShopItem; apronColor?: string }) {
  if (item.slot === 'pose' && item.mood) {
    // 착용 중인 앞치마 색을 입혀서 '이 포즈를 고르면 실제로 보일 모습' 그대로 미리 보여준다
    return <Brew mood={item.mood as BrewMood} apronColor={apronColor} size={42} disableMotion />;
  }
  // 앞치마 색: 기본 포즈에 그 색을 입힌 미니 브루로 미리보기 (실제 착용 모습 그대로)
  if (item.slot === 'apron' && item.color) {
    return <Brew mood="top" apronColor={item.color} size={42} disableMotion />;
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

  // 브루 키우기 성장 카드
  growthCard: { paddingVertical: 14, marginBottom: 6, gap: 10 },
  growthTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  levelBadge: {
    backgroundColor: colors.pointOrange,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 46,
    alignItems: 'center',
  },
  levelBadgeText: { ...typography.L4, color: colors.white },
  growthTitle: { ...typography.L3, color: colors.espressoBrown },
  growthSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 1 },
  streakPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  streakPillDim: { opacity: 0.5 },
  streakEmoji: { fontSize: 13 },
  streakText: { ...typography.L4, color: colors.espressoBrown },
  expTrack: { height: 9, borderRadius: 5, backgroundColor: colors.mutedSand, overflow: 'hidden' },
  expFill: { height: '100%', borderRadius: 5, backgroundColor: colors.pointOrange },
  dailyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  dailyLabel: { ...typography.L5, color: colors.espressoBrown },
  dailyReward: { ...typography.L5, color: colors.mochaBrown },
  dailyTrack: { height: 7, borderRadius: 4, backgroundColor: colors.mutedSand, overflow: 'hidden' },
  dailyFill: { height: '100%', borderRadius: 4, backgroundColor: colors.trendGreenText },
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
