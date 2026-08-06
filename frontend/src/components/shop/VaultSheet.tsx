// 보관함 — 내가 산 꾸미기 아이템만 모아 보는 바텀시트.
//
// 예전에는 상점 화면 안에만 있어서, 게임 룸에서 '보관함'을 누르면 상점으로 화면이
// 통째로 넘어간 뒤 그 위에 시트가 떴다. 꾸민 브루를 보면서 갈아입히는 게 목적인데
// 정작 브루가 있는 화면을 떠나야 했다. 그래서 시트를 화면 바깥으로 빼서, 어느 화면에서
// 열든 그 화면 위에 그대로 올라오게 만들었다.
//
// 데이터도 스스로 불러온다 — 여는 쪽은 visible만 넘기면 된다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import Brew from '../brew/Brew';
import { ROOM_BGS } from '../brew/roomBackgrounds';
import { FadeInUp, PressableScale } from '../motion';
import { toast } from '../toast';
import { SwipeDownModal } from '../ui/SwipeDownModal';
import ItemArt from './ItemArt';
import { equipItem, getShop, type ItemSlot, type ShopItem, type ShopState } from '../../lib/api/rewards';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, typography } from '../../theme';
import { s as sc } from '../../theme/responsive';

// 위에서부터 눈에 띄는 것 순 (상점 목록과 같은 순서라 찾던 자리에 그대로 있다)
const SLOT_ORDER: ItemSlot[] = ['pose', 'apron', 'background', 'room'];

// 카페 배경은 프론트에 사진이 등록된 것만 — 사진이 없으면 착용해도 아무 변화가 없다
const itemVisible = (item: ShopItem) => item.slot !== 'room' || !!ROOM_BGS[item.id];

export default function VaultSheet({
  visible,
  onClose,
  onGoShop,
}: {
  visible: boolean;
  onClose: () => void;
  /** 보관함이 비었을 때 '상점 둘러보기'를 어디로 보낼지 — 안 넘기면 버튼을 숨긴다 */
  onGoShop?: () => void;
}) {
  const { token } = useAuth();
  // 착용을 바꾸면 홈 마스코트·게임 룸 배경도 같이 바뀌어야 한다
  const { refresh: refreshEquipped } = useEquipped();
  const [shop, setShop] = useState<ShopState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  // 부위 필터 — null이면 전체
  const [slotFilter, setSlotFilter] = useState<ItemSlot | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setShop(await getShop(token));
    } catch {
      toast('불러오기 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  // 열릴 때마다 다시 읽는다 — 상점에서 사고 바로 열어도 새 아이템이 보이도록
  useEffect(() => {
    if (visible) {
      setSlotFilter(null);
      load();
    }
  }, [visible, load]);

  const owned = useMemo(
    () => (shop?.items ?? []).filter((i) => i.owned && itemVisible(i)),
    [shop],
  );
  const equippedCount = owned.filter((i) => i.equipped).length;
  // 착용 중인 앞치마 색 — 포즈 썸네일에도 입혀서 실제로 보게 될 모습 그대로 보여준다
  const apronColor = owned.find((i) => i.equipped && i.slot === 'apron')?.color ?? undefined;

  // 가진 게 있는 부위만 칩으로 — 빈 탭을 눌러 보고 허탕 치지 않게
  const availableSlots = SLOT_ORDER.filter((slot) => owned.some((i) => i.slot === slot));
  const shownSlots = slotFilter ? [slotFilter] : availableSlots;

  const toggleEquip = async (item: ShopItem) => {
    setBusyItem(item.id);
    try {
      setShop(await equipItem(item.id, !item.equipped, token));
      await refreshEquipped();
    } catch (e) {
      toast('변경 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyItem(null);
    }
  };

  return (
    <SwipeDownModal visible={visible} onClose={onClose} sheetStyle={styles.sheet}>
      {/* ── 머리말 — 몇 개 가졌고 몇 개 입고 있는지 한 줄로 ── */}
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="albums" size={16} color={colors.white} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>보관함</Text>
          <Text style={styles.subtitle}>
            {owned.length}개 보유 · {equippedCount}개 착용 중
          </Text>
        </View>
        <PressableScale onPress={onClose} style={styles.closeBtn}>
          <Ionicons name="close" size={18} color={colors.mochaBrown} />
        </PressableScale>
      </View>

      {/* ── 부위 필터 ── 종류가 늘어나도 원하는 칸만 골라 볼 수 있게 */}
      {availableSlots.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <FilterChip label="전체" active={slotFilter === null} onPress={() => setSlotFilter(null)} />
          {availableSlots.map((slot) => (
            <FilterChip
              key={slot}
              label={owned.find((i) => i.slot === slot)?.slot_label ?? slot}
              active={slotFilter === slot}
              onPress={() => setSlotFilter(slot)}
            />
          ))}
        </ScrollView>
      )}

      {loading && !shop ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.mochaBrown} />
        </View>
      ) : owned.length === 0 ? (
        // ── 빈 보관함 — 그냥 "없어요"로 끝내지 않고 브루가 안내한다 ──
        <View style={styles.center}>
          <Brew mood="top" size={92} disableMotion />
          <Text style={styles.emptyTitle}>아직 가진 아이템이 없어요</Text>
          <Text style={styles.emptyBody}>
            할 일을 끝내면 코인이 쌓여요.{'\n'}상점에서 브루를 꾸며 보세요!
          </Text>
          {onGoShop && (
            <PressableScale style={styles.shopBtn} onPress={onGoShop}>
              <Ionicons name="cart" size={14} color={colors.white} />
              <Text style={styles.shopBtnText}>상점 둘러보기</Text>
            </PressableScale>
          )}
        </View>
      ) : (
        // flexShrink가 있어야 시트 높이 상한 안에서 목록만 줄어들며 스크롤된다
        // (없으면 내용이 길 때 머리말·필터까지 화면 밖으로 밀려난다)
        <ScrollView
          style={{ flexShrink: 1 }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 8 }}
        >
          {shownSlots.map((slot, si) => {
            const items = owned.filter((i) => i.slot === slot);
            if (!items.length) return null;
            return (
              <FadeInUp key={slot} delay={si * 50}>
                <View style={styles.slotBlock}>
                  <View style={styles.slotHead}>
                    <Text style={styles.slotLabel}>{items[0].slot_label}</Text>
                    <Text style={styles.slotCount}>{items.length}</Text>
                  </View>
                  {/* 칸을 나눠 늘어놓으면 한 화면에 더 많이 보이고 '수집한 느낌'이 산다 */}
                  <View style={styles.grid}>
                    {items.map((item) => (
                      <VaultTile
                        key={item.id}
                        item={item}
                        apronColor={apronColor}
                        busy={busyItem === item.id}
                        onPress={() => toggleEquip(item)}
                      />
                    ))}
                  </View>
                </View>
              </FadeInUp>
            );
          })}
          <Text style={styles.footHint}>칸을 누르면 바로 입고 벗을 수 있어요</Text>
        </ScrollView>
      )}
    </SwipeDownModal>
  );
}

/** 부위 필터 칩 */
function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale style={[styles.chip, active && styles.chipOn]} onPress={onPress} to={0.94}>
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </PressableScale>
  );
}

/** 아이템 한 칸 — 누르면 바로 착용/해제. 착용 중이면 테두리와 체크 배지로 표시 */
function VaultTile({
  item,
  apronColor,
  busy,
  onPress,
}: {
  item: ShopItem;
  apronColor?: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      style={[styles.tile, item.equipped && styles.tileOn]}
      onPress={busy ? undefined : onPress}
      disabled={busy}
      to={0.95}
    >
      <View style={[styles.tileArt, item.equipped && styles.tileArtOn]}>
        {busy ? <ActivityIndicator color={colors.mochaBrown} /> : <ItemArt item={item} apronColor={apronColor} size={46} />}
      </View>
      <Text style={[styles.tileName, item.equipped && styles.tileNameOn]} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={styles.tileAction}>{item.equipped ? '벗기' : '착용'}</Text>

      {item.equipped && (
        <View style={styles.tileCheck}>
          <Ionicons name="checkmark" size={11} color={colors.white} />
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  // 시트 자체 — 좌우 여백은 안에서 직접 잡는다 (칸 그리드가 가장자리까지 쓰도록).
  // 높이 상한은 SwipeDownModal이 화면 높이의 90%로 직접 건다.
  sheet: { paddingHorizontal: 16 },

  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    backgroundColor: colors.espressoBrown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.L3, fontSize: 18, fontWeight: '800', color: colors.espressoBrown },
  subtitle: { ...typography.L5, color: colors.mochaBrown, marginTop: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    alignItems: 'center',
    justifyContent: 'center',
  },

  chipRow: { gap: 6, paddingBottom: 12, paddingRight: 4 },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  chipOn: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  chipText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },
  chipTextOn: { color: colors.white },

  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 34, gap: 6 },
  emptyTitle: { ...typography.L3, color: colors.espressoBrown, marginTop: 8 },
  emptyBody: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },
  shopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 10,
  },
  shopBtnText: { ...typography.L5, fontWeight: '800', color: colors.white },

  slotBlock: { marginBottom: 14 },
  slotHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  slotLabel: { ...typography.L4, fontSize: 13, fontWeight: '800', color: colors.espressoBrown },
  slotCount: {
    ...typography.L5,
    fontWeight: '700',
    color: colors.mochaBrown,
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: 'hidden',
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: sc(8) },
  tile: {
    // 한 줄에 3칸 — gap 두 번을 뺀 나머지를 나눠 갖는다
    width: `${(100 - 7) / 3}%`,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 16,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  tileOn: { borderColor: colors.pointOrange, borderWidth: 1.6, backgroundColor: '#FFF9F2' },
  tileArt: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileArtOn: { backgroundColor: '#F7E4D6' },
  tileName: {
    ...typography.L5,
    fontWeight: '700',
    color: colors.espressoBrown,
    marginTop: 7,
    textAlign: 'center',
  },
  tileNameOn: { color: colors.pointOrange },
  tileAction: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  tileCheck: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
  },

  footHint: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', paddingVertical: 6 },
});
