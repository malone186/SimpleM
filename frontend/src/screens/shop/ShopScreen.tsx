// 상점 — 할 일을 끝내 모은 코인으로 브루를 꾸민다 (게임화 보상)
// 상단: 브루 미리보기 + 코인 잔액 / 중단: 부위별 아이템 / 하단: 적립·사용 내역
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import Brew, { type BrewMood } from '../../components/brew/Brew';
import { FadeInUp, PressableScale, useCountUp } from '../../components/motion';
import ItemArt from '../../components/shop/ItemArt';
import VaultSheet from '../../components/shop/VaultSheet';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import {
  buyItem,
  claimQuest,
  drawCapsule,
  equipItem,
  getProgress,
  getQuests,
  getShop,
  getWallet,
  type GachaResult,
  type ItemSlot,
  type PointHistoryItem,
  type Progress,
  type Quest,
  type QuestBoard,
  type ShopItem,
  type ShopState,
  type Wallet,
} from '../../lib/api/rewards';
import { ROOM_BGS } from '../../components/brew/roomBackgrounds';
import { loadCache, peekCache, saveCache } from '../../lib/cache';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, typography } from '../../theme';
// [한글 주석] load() 안의 지역변수 s(shop 응답)와 겹치지 않게 스케일 함수는 sc 로 별칭 처리
import { s as sc, useBottomInset, useResponsive, useTopInset } from '../../theme/responsive';
import { startLoop } from '../../lib/animLoop';

// 화면에 보여줄 부위 순서 — 위에서부터 눈에 띄는 것 순
const SLOT_ORDER: ItemSlot[] = ['pose', 'apron', 'background', 'room'];

// 카페 배경(room) 아이템은 프론트에 사진이 등록된 것만 보여준다 — 백엔드 카탈로그에
// 미리 올라가 있어도 사진이 없으면 사고 나서 아무 변화가 없기 때문. (roomBackgrounds.ts)
const itemVisible = (item: ShopItem) => item.slot !== 'room' || !!ROOM_BGS[item.id];

// 코인 내역 기본 노출 줄 수 — 이보다 많으면 '더보기'로 접는다
const HISTORY_PREVIEW_COUNT = 5;

export default function ShopScreen({ route }: { route?: { params?: { openVault?: boolean } } }) {
  const { token } = useAuth();
  // [한글 주석] 기기 안전영역 실측 — 탭 직속 화면이라 위·아래를 직접 비워 줘야 한다
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { gutter, isWide, contentMaxWidth } = useResponsive();
  // 구매·착용하면 홈 화면 마스코트도 같이 바뀌어야 한다
  const { refresh: refreshEquipped } = useEquipped();
  // 지난 방문 값으로 먼저 그린다 — 매번 풀스크린 스피너를 보이지 않게 (서버 응답이 오면 조용히 갱신)
  const [shop, setShop] = useState<ShopState | null>(() => peekCache<ShopState>('shop:shop')?.data ?? null);
  const [wallet, setWallet] = useState<Wallet | null>(() => peekCache<Wallet>('shop:wallet')?.data ?? null);
  const [progress, setProgress] = useState<Progress | null>(() => peekCache<Progress>('shop:progress')?.data ?? null);
  const [loading, setLoading] = useState(() => !peekCache<ShopState>('shop:shop'));
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false); // 보관함(보유 아이템 모음) 시트
  // 게임 룸의 '보관함' 버튼으로 들어오면 시트를 바로 연다
  useEffect(() => {
    if (route?.params?.openVault) setVaultOpen(true);
  }, [route?.params?.openVault]);
  const [quests, setQuests] = useState<QuestBoard | null>(() => peekCache<QuestBoard>('shop:quests')?.data ?? null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false); // 코인 내역 — 기본 5줄, 더보기로 전체 펼침
  // 브루 캡슐 뽑기 — 모달이 열리고 캡슐이 흔들리다 결과가 공개된다
  const [gachaOpen, setGachaOpen] = useState(false);
  const [gachaResult, setGachaResult] = useState<GachaResult | null>(null);
  const [gachaError, setGachaError] = useState<string | null>(null);

  const handleGacha = async () => {
    setGachaResult(null);
    setGachaError(null);
    setGachaOpen(true); // 캡슐 흔들리는 상태로 먼저 열어 두근거림을 만든다
    try {
      // 결과가 너무 빨리 오면 김이 새서, 최소 1.3초는 흔들리게 한다
      const [res] = await Promise.all([
        drawCapsule(token),
        new Promise((r) => setTimeout(r, 1300)),
      ]);
      setGachaResult(res);
      // 잔액·보유·착용 갱신 (아이템이 나왔으면 보관함에 이미 들어가 있다)
      const [s, w] = await Promise.all([getShop(token), getWallet(token)]);
      setShop(s);
      setWallet(w);
      await refreshEquipped();
    } catch (e) {
      setGachaError(e instanceof Error ? e.message : '뽑기에 실패했어요. 잠시 후 다시 시도해 주세요.');
    }
  };

  // 이미 산 아이템은 상점 목록에서 빼고 보관함에만 둔다 — 상점은 '아직 없는 것'만 보이게.
  // 다만 방금 산 것은 바로 착용해 볼 수 있게 이번 방문 동안만 목록에 남겨 둔다.
  // 화면을 벗어나면(탭 이동 등) 비워서, 다시 들어오면 보관함에만 남는다.
  const isFocused = useIsFocused();
  const [justBought, setJustBought] = useState<string[]>([]);
  useEffect(() => {
    if (!isFocused) setJustBought([]);
  }, [isFocused]);
  const inShopList = (i: ShopItem) => itemVisible(i) && (!i.owned || justBought.includes(i.id));

  // 조회 순번. 캐시로 먼저 그려 주기 때문에 목록이 뜬 순간 바로 구매·착용을 누를 수 있는데,
  // 그때까지 날아가던 조회가 뒤늦게 도착하면 구매 이전 상태로 되돌려 놓는다
  // (산 물건이 다시 안 산 것처럼 보이고 코인도 되살아난다). 구매·착용도 같은 순번을 올려
  // 그보다 먼저 시작된 조회 결과는 버린다.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!token) return;
    const mySeq = ++loadSeq.current;
    // 앱을 새로 켠 직후에는 메모리 캐시가 비어 있다 — 디스크에 남은 지난 값으로 먼저 그린다
    const cached = await loadCache<ShopState>('shop:shop');
    if (cached && mySeq === loadSeq.current) {
      setShop((prev) => prev ?? cached.data);
      setLoading(false);
    }
    try {
      const [s, w, p, q] = await Promise.all([
        getShop(token), getWallet(token), getProgress(token), getQuests(token),
      ]);
      if (mySeq !== loadSeq.current) return;  // 그사이 구매·착용으로 최신 상태가 됐다
      setShop(s);
      setWallet(w);
      setProgress(p);
      setQuests(q);
    } catch {
      toast('불러오기 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  // 최신 상태를 기기에 남긴다 — 구매·착용·뽑기 등 어떤 경로로 바뀌어도 다음 방문이 즉시 뜬다
  useEffect(() => { if (shop) void saveCache('shop:shop', shop); }, [shop]);
  useEffect(() => { if (wallet) void saveCache('shop:wallet', wallet); }, [wallet]);
  useEffect(() => { if (progress) void saveCache('shop:progress', progress); }, [progress]);
  useEffect(() => { if (quests) void saveCache('shop:quests', quests); }, [quests]);

  // 퀘스트 보상 수령 — 잔액이 바뀌므로 상점·지갑도 같이 갱신
  const handleClaimQuest = async (q: Quest) => {
    setClaiming(q.id);
    try {
      const next = await claimQuest(q.id, token);
      loadSeq.current += 1;
      setQuests(next);
      const [s, w] = await Promise.all([getShop(token), getWallet(token)]);
      setShop(s);
      setWallet(w);
      toast('보상 수령!', `'${q.title}' 달성 — ${q.reward}코인을 받았어요 🪙`);
    } catch (e) {
      toast('수령 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setClaiming(null);
    }
  };

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
          loadSeq.current += 1;   // 이보다 먼저 시작된 조회 결과는 버린다
          setShop(next);
          setJustBought((v) => (v.includes(item.id) ? v : [...v, item.id])); // 방금 산 건 착용까지 하고 갈 수 있게 남긴다
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
      const equipped = await equipItem(item.id, !item.equipped, token);
      loadSeq.current += 1;
      setShop(equipped);
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
      {/* 제목 오른쪽에 보관함 링크 — 산 것만 따로 모아 본다 */}
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <ScreenTitle title="상점" subtitle="할 일을 끝내면 코인이 쌓여요" />
        </View>
        <PressableScale style={styles.vaultBtn} onPress={() => setVaultOpen(true)}>
          <Ionicons name="albums-outline" size={14} color={colors.espressoBrown} />
          <Text style={styles.vaultBtnText}>보관함</Text>
        </PressableScale>
      </View>

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

      {/* ── 브루 캡슐 뽑기 — 코인 소모처 + 운 요소 ── */}
      <FadeInUp delay={30}>
        <Card style={styles.gachaCard}>
          <Text style={styles.gachaEgg}>🥚</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.gachaTitle}>브루 캡슐 뽑기</Text>
            <Text style={styles.gachaDesc}>꾸미기 아이템 또는 코인이 랜덤으로! 꽝은 없어요</Text>
          </View>
          <PressableScale
            style={[styles.gachaBtn, (shop?.balance ?? 0) < 300 && styles.gachaBtnOff]}
            onPress={(shop?.balance ?? 0) >= 300 ? handleGacha : undefined}
            disabled={(shop?.balance ?? 0) < 300}
          >
            <Text style={styles.gachaBtnText}>🪙 300 뽑기</Text>
          </PressableScale>
        </Card>
      </FadeInUp>

      {/* ── 브루 키우기 (레벨·EXP·스트릭·일일 도전) ── */}
      {progress && (
        <FadeInUp delay={40}>
          <GrowthCard progress={progress} />
        </FadeInUp>
      )}

      {/* ── 주간 퀘스트 — 홈 '오늘의 할 일' 완료가 그대로 진행도가 된다 ── */}
      {quests && quests.quests.length > 0 && (
        <FadeInUp delay={50}>
          <SectionTitle>주간 퀘스트</SectionTitle>
          <Card style={{ gap: 12 }}>
            <Text style={styles.questHint}>
              홈에서 할 일을 완료하면 자동으로 채워져요 · 월요일마다 리셋
            </Text>
            {quests.quests.map((q) => (
              <QuestRow key={q.id} quest={q} claiming={claiming === q.id} onClaim={() => handleClaimQuest(q)} />
            ))}
          </Card>
        </FadeInUp>
      )}

      {/* ── 부위별 아이템 — 아직 안 산 것만 (산 것은 보관함으로) ── */}
      {/* shop이 아직 없으면(첫 로드 실패 등) 축하 배너를 띄우지 않는다 —
          아무것도 못 불러온 상태를 '다 모았다'로 읽으면 안 된다 */}
      {!!shop && !shop.items.some(inShopList) && (
        <FadeInUp delay={60}>
          <SectionTitle>꾸미기 아이템</SectionTitle>
          <Card>
            <Text style={styles.emptyText}>
              살 수 있는 아이템을 다 모았어요! 보관함에서 갈아입혀 보세요 🎉
            </Text>
          </Card>
        </FadeInUp>
      )}
      {SLOT_ORDER.map((slot, si) => {
        const items = (shop?.items ?? []).filter((i) => i.slot === slot && inShopList(i));
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

      {/* ── 보관함 — 상점·게임 룸이 같은 시트를 쓴다 (components/shop/VaultSheet).
             닫을 때 상점 목록도 다시 읽어 '착용 중' 표시를 맞춘다 ── */}
      <VaultSheet
        visible={vaultOpen}
        onClose={() => {
          setVaultOpen(false);
          load();
        }}
      />

      {/* ── 캡슐 뽑기 결과 모달 — 결과 도착 전엔 캡슐이 흔들린다 ── */}
      <Modal visible={gachaOpen} animationType="fade" transparent onRequestClose={() => setGachaOpen(false)}>
        <View style={styles.gachaBackdrop}>
          <View style={styles.gachaModal}>
            {gachaError ? (
              <>
                <Text style={styles.gachaEggBig}>😢</Text>
                <Text style={styles.gachaWait}>{gachaError}</Text>
                <PressableScale style={styles.gachaClose} onPress={() => setGachaOpen(false)}>
                  <Text style={styles.gachaCloseText}>닫기</Text>
                </PressableScale>
              </>
            ) : !gachaResult ? (
              <>
                <CapsuleShake />
                <Text style={styles.gachaWait}>두근두근…</Text>
              </>
            ) : (
              <>
                <Badge
                  label={gachaResult.rarity === 'epic' ? '✨ 전설' : gachaResult.rarity === 'rare' ? '💠 희귀' : '일반'}
                  tone={gachaResult.rarity === 'epic' ? 'orange' : gachaResult.rarity === 'rare' ? 'green' : 'neutral'}
                />
                {gachaResult.kind === 'item' && gachaResult.item ? (
                  <>
                    <View style={styles.gachaPrize}>
                      <ItemArt
                        item={{ ...gachaResult.item, slot_label: gachaResult.item.slot_label, price: 0, desc: '', owned: true, equipped: false, affordable: true } as ShopItem}
                        size={84}
                      />
                    </View>
                    <Text style={styles.gachaPrizeName}>{gachaResult.item.name}</Text>
                    <Text style={styles.gachaPrizeSub}>{gachaResult.item.slot_label} · 보관함에 들어갔어요</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.gachaEggBig}>🪙</Text>
                    <Text style={styles.gachaPrizeName}>코인 +{gachaResult.coins}</Text>
                    <Text style={styles.gachaPrizeSub}>잔액 {gachaResult.balance.toLocaleString()}코인</Text>
                  </>
                )}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  {(shop?.balance ?? 0) >= 300 && (
                    <PressableScale style={[styles.gachaClose, styles.gachaAgain]} onPress={handleGacha}>
                      <Text style={[styles.gachaCloseText, { color: colors.white }]}>한 번 더 (300)</Text>
                    </PressableScale>
                  )}
                  <PressableScale style={styles.gachaClose} onPress={() => setGachaOpen(false)}>
                    <Text style={styles.gachaCloseText}>닫기</Text>
                  </PressableScale>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ── 적립·사용 내역 — 기본 5줄만, 나머지는 '더보기'로 펼친다 ── */}
      <FadeInUp delay={300}>
        <SectionTitle>코인 내역</SectionTitle>
        <Card>
          {!wallet?.history.length ? (
            <Text style={styles.emptyText}>
              아직 내역이 없어요. 대시보드에서 할 일을 완료하면 코인이 쌓여요!
            </Text>
          ) : (
            (() => {
              const total = wallet.history.length;
              const shownCount = historyExpanded ? total : Math.min(HISTORY_PREVIEW_COUNT, total);
              const shown = wallet.history.slice(0, shownCount);
              const hiddenCount = total - shownCount;
              return (
                <>
                  {shown.map((h, i) => (
                    <HistoryRow key={h.id} item={h} last={i === shownCount - 1} />
                  ))}
                  {total > HISTORY_PREVIEW_COUNT && (
                    <PressableScale
                      style={styles.moreBtn}
                      onPress={() => setHistoryExpanded((v) => !v)}
                    >
                      <Text style={styles.moreBtnText}>
                        {historyExpanded ? '접기' : `${hiddenCount}개 더보기`}
                      </Text>
                      <Ionicons
                        name={historyExpanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={colors.mochaBrown}
                      />
                    </PressableScale>
                  )}
                </>
              );
            })()
          )}
        </Card>
      </FadeInUp>
    </ScrollView>
  );
}

/** 뽑기 대기 중 흔들리는 캡슐 — 결과가 올 때까지 좌우로 파닥인다 */
function CapsuleShake() {
  const t = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    // Animated.loop을 쓰지 않는다 — useNativeDriver:true면 웹에서 한 번 파닥이고 멈춰
    // 뽑기 대기 중인지 알 수 없게 된다(lib/animLoop.ts에 이유).
    return startLoop(() =>
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 90, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(t, { toValue: -1, duration: 180, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 90, easing: Easing.linear, useNativeDriver: true }),
        Animated.delay(240),
      ]),
    ).stop;
  }, [t]);
  const rotate = t.interpolate({ inputRange: [-1, 1], outputRange: ['-16deg', '16deg'] });
  return (
    <Animated.Text style={[styles.gachaEggBig, { transform: [{ rotate }] }]}>🥚</Animated.Text>
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
  // 레벨 잠금 — 실루엣으로 보여서 'Lv.N에 열린다'는 목표가 되게 한다 (구매는 서버도 막는다)
  if (item.locked) {
    return (
      <Card style={[styles.itemCard, { opacity: 0.75 }]}>
        <View style={[styles.itemEmojiWrap, { opacity: 0.3 }]}>
          <ItemArt item={item} apronColor={apronColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.itemName}>{item.name}</Text>
          <Text style={styles.itemDesc}>{item.desc}</Text>
        </View>
        <View style={styles.levelLockBox}>
          <Ionicons name="lock-closed" size={13} color={colors.mochaBrown} />
          <Text style={styles.levelLockText}>Lv.{item.min_level}에 열려요</Text>
        </View>
      </Card>
    );
  }
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
          {!!item.min_level && !item.owned && <Badge label={`Lv.${item.min_level}+`} tone="orange" />}
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

/** 주간 퀘스트 한 줄 — 진행 바 + (달성 시) 보상 받기 버튼 */
function QuestRow({ quest, claiming, onClaim }: { quest: Quest; claiming: boolean; onClaim: () => void }) {
  const pct = Math.max(0, Math.min(1, quest.progress / Math.max(1, quest.goal)));
  return (
    <View style={styles.questRow}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.questTitle}>{quest.title}</Text>
          {quest.claimed && <Badge label="수령 완료" tone="green" />}
        </View>
        <Text style={styles.questDesc}>{quest.desc}</Text>
        <View style={styles.questTrack}>
          <View style={[styles.questFill, { width: `${pct * 100}%` }, quest.done && styles.questFillDone]} />
        </View>
        <Text style={styles.questProgress}>
          {quest.progress}/{quest.goal}
        </Text>
      </View>
      {claiming ? (
        <ActivityIndicator color={colors.mochaBrown} style={{ width: 64 }} />
      ) : quest.claimable ? (
        <PressableScale style={styles.questClaimBtn} onPress={onClaim}>
          <Text style={styles.questClaimText}>+{quest.reward} 받기</Text>
        </PressableScale>
      ) : (
        <Text style={styles.questReward}>🪙 {quest.reward}</Text>
      )}
    </View>
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
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  questHint: { ...typography.L5, color: colors.mochaBrown },
  questRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  questTitle: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown },
  questDesc: { ...typography.L5, color: colors.mochaBrown, marginTop: 1 },
  questTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.mutedSand,
    overflow: 'hidden',
    marginTop: 6,
  },
  questFill: { height: '100%', borderRadius: 3, backgroundColor: colors.pointOrange },
  questFillDone: { backgroundColor: '#3E9B4F' },
  questProgress: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  questReward: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown, width: 64, textAlign: 'right' },
  questClaimBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  questClaimText: { ...typography.L5, fontWeight: '800', color: colors.white },
  vaultBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 4, // 제목 첫 줄과 눈높이를 맞춘다
  },
  vaultBtnText: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  heroCard: { alignItems: 'center', paddingVertical: 22, marginBottom: 6 },
  // ── 브루 캡슐 뽑기 ──
  gachaCard: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  gachaEgg: { fontSize: 30 },
  gachaTitle: { ...typography.L4, fontSize: 13, fontWeight: '800', color: colors.espressoBrown },
  gachaDesc: { ...typography.L5, color: colors.mochaBrown, marginTop: 1 },
  gachaBtn: { backgroundColor: colors.pointOrange, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9 },
  gachaBtnOff: { backgroundColor: colors.mutedSand },
  gachaBtnText: { ...typography.L5, fontWeight: '800', color: colors.white },
  gachaBackdrop: { flex: 1, backgroundColor: 'rgba(30,22,18,0.55)', alignItems: 'center', justifyContent: 'center' },
  gachaModal: {
    backgroundColor: colors.creamSand,
    borderRadius: 22,
    paddingHorizontal: 26,
    paddingVertical: 24,
    alignItems: 'center',
    minWidth: 240,
    gap: 6,
  },
  gachaEggBig: { fontSize: 56, marginVertical: 6 },
  gachaWait: { ...typography.L4, fontWeight: '700', color: colors.mochaBrown, textAlign: 'center' },
  gachaPrize: { marginTop: 8, marginBottom: 2 },
  gachaPrizeName: { ...typography.L3, fontSize: 17, fontWeight: '800', color: colors.espressoBrown },
  gachaPrizeSub: { ...typography.L5, color: colors.mochaBrown },
  gachaClose: {
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  gachaAgain: { backgroundColor: colors.pointOrange },
  gachaCloseText: { ...typography.L5, fontWeight: '800', color: colors.espressoBrown },
  levelLockBox: { alignItems: 'center', gap: 2, width: 78 },
  levelLockText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },

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

  // 코인 내역 '더보기 / 접기' 버튼 — 마지막 줄 아래, 살짝 구분선을 두고 가운데 정렬
  moreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 12,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
  },
  moreBtnText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },

  emptyText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', paddingVertical: 18, lineHeight: 17 },
});
