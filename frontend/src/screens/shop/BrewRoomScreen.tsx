// 브루의 카페 (게임 룸) — 홈 우상단 버튼으로 들어오는 게임 허브 화면.
// 카페 배경 한가운데에 '내가 꾸민 브루'가 살아 움직이고, 그 아래로 레벨·주간 퀘스트가
// 붙는다. 상점·보관함은 여기서 갈라져 들어간다 — 꾸미기 경제의 관문 역할.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ImageBackground, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useAuth } from '../../auth/AuthContext';
import BrewStage from '../../components/brew/BrewStage';
import type { BrewContext } from '../../components/brew/useBrewBrain';
import { FadeInUp, PressableScale } from '../../components/motion';
import VaultSheet from '../../components/shop/VaultSheet';
import { toast } from '../../components/toast';
import { Badge } from '../../components/ui';
import {
  claimQuest,
  getProgress,
  getQuests,
  getWallet,
  type Progress,
  type Quest,
  type QuestBoard,
} from '../../lib/api/rewards';
import { getRoomBg } from '../../components/brew/roomBackgrounds';
import { loadCache, peekCache, saveCache } from '../../lib/cache';
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { useEquipped } from '../../rewards/EquippedContext';
import { colors, typography } from '../../theme';
import { s, useBottomInset, useTopInset } from '../../theme/responsive';

export default function BrewRoomScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { token } = useAuth();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  // 지난 방문 값으로 먼저 그린다 — 매번 빈 카드에서 시작하지 않게 (서버 응답이 오면 조용히 갱신)
  const [progress, setProgress] = useState<Progress | null>(() => peekCache<Progress>('shop:progress')?.data ?? null);
  const [quests, setQuests] = useState<QuestBoard | null>(() => peekCache<QuestBoard>('shop:quests')?.data ?? null);
  const [coins, setCoins] = useState<number | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  // 보관함은 이 화면 위에 시트로 뜬다 — 꾸민 브루를 보면서 갈아입히는 게 목적이라
  // 상점으로 화면을 넘겨 버리면 정작 브루가 안 보인다
  const [vaultOpen, setVaultOpen] = useState(false);
  // 무대 폭은 재 봐야 안다 (기기·폴드 상태마다 다르다) — 브루가 화면 밖으로 걸어 나가지 않게
  const [stageWidth, setStageWidth] = useState(0);
  // 상점에서 산 '카페 배경'을 착용했으면 그 사진으로 방이 바뀐다 (미착용 시 기본 카운터)
  const { roomBgId } = useEquipped();
  const ROOM_BG = getRoomBg(roomBgId);

  const load = useCallback(async () => {
    if (!token) return;
    // 앱을 새로 켠 직후에는 메모리 캐시가 비어 있다 — 디스크의 지난 값으로 먼저 그린다
    const cached = await loadCache<Progress>('shop:progress');
    if (cached) setProgress((prev) => prev ?? cached.data);
    try {
      const [p, q, w] = await Promise.all([getProgress(token), getQuests(token), getWallet(token)]);
      setProgress(p);
      setQuests(q);
      setCoins(w.balance);
      // 상점 화면과 같은 칸에 남긴다 — 두 화면 어느 쪽을 먼저 열어도 즉시 뜨게
      void saveCache('shop:progress', p);
      void saveCache('shop:quests', q);
    } catch {
      toast('불러오기 실패', '잠시 후 다시 시도해 주세요.');
    }
  }, [token]);

  useEffect(() => {
    load();
    // 상점에서 사고 돌아왔을 때도 최신으로
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [load, navigation]);

  const handleClaim = async (q: Quest) => {
    setClaiming(q.id);
    try {
      const next = await claimQuest(q.id, token);
      setQuests(next);
      if (typeof next.balance === 'number') setCoins(next.balance);
      toast('보상 수령!', `'${q.title}' 달성 — ${q.reward}코인을 받았어요 🪙`);
    } catch (e) {
      toast('수령 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setClaiming(null);
    }
  };

  const expPct = progress
    ? Math.max(0, Math.min(1, progress.exp_in_level / Math.max(1, progress.exp_to_next)))
    : 0;

  // 브루가 몸으로 표현할 거리 — 이 화면이 아는 것만 넘긴다(나머지는 시간대로 판단한다)
  const brewContext = useMemo<BrewContext>(
    () => ({
      streakDone: progress?.streak_active_today,
      todosLeft: quests?.quests.filter((q) => !q.done).length,
    }),
    [progress?.streak_active_today, quests],
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#241A14' }}>
      {/* 배경은 화면을 꽉 채운다(cover). 예전엔 자르지 않으려고 contain을 썼는데,
          화면 비율과 안 맞는 만큼 위아래·좌우에 흐린 띠가 남아 '덜 채워진' 것처럼 보였다.
          이 화면의 주인공인 브루는 아래 ScrollView에 따로 얹히므로, 배경이 조금 잘려도
          잃는 게 없다. 아래 블러 레이어는 세로로 아주 긴 화면에서의 안전망으로 남긴다. */}
      <ImageBackground source={ROOM_BG} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={18} />
      <Image source={ROOM_BG} style={styles.fullBg} resizeMode="cover" />
      {/* 글자가 얹히는 부분만 살짝 어둡게 — 배경 그림은 최대한 살린다 */}
      <View style={styles.dim} />

      {/* 상단 바: 닫기 · 코인 */}
      <View style={[styles.topBar, { paddingTop: topInset + s(8) }]}>
        <PressableScale style={styles.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={colors.espressoBrown} />
        </PressableScale>
        <View style={styles.coinPill}>
          <Text style={styles.coinEmoji}>🪙</Text>
          <Text style={styles.coinText}>{coins === null ? '—' : coins.toLocaleString()}</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bottomInset + s(24), paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 카페 한가운데의 브루 — 내가 꾸민 모습 그대로, 이 화면의 주인공이라 크게.
            홈과 같은 이스터에그(탭=쓰다듬기/간식, 더블탭=시크릿, 롱프레스=풍선 펑)를
            그대로 쓰되, 여기서는 무대에 올려 스스로 돌아다니게 한다. ── */}
        <View style={styles.stage} onLayout={(e) => setStageWidth(e.nativeEvent.layout.width)}>
          {/* 폭을 잰 뒤에야 어디까지 걸어갈지 정할 수 있다 — 첫 프레임엔 무대를 비운다 */}
          {stageWidth > 0 && (
            <BrewStage size={s(240)} width={stageWidth} context={brewContext} />
          )}
        </View>

        {/* ── 레벨 카드 ── */}
        {progress && (
          <FadeInUp>
            <View style={styles.card}>
              <View style={styles.levelRow}>
                <View style={styles.levelBadge}>
                  <Text style={styles.levelBadgeText}>Lv.{progress.level}</Text>
                </View>
                <Text style={styles.levelTitle}>{progress.level_title}</Text>
                <View style={[styles.streakPill, !progress.streak_active_today && { opacity: 0.55 }]}>
                  <Text style={styles.streakText}>🔥 {progress.streak}일</Text>
                </View>
              </View>
              <View style={styles.expTrack}>
                <View style={[styles.expFill, { width: `${expPct * 100}%` }]} />
              </View>
              <Text style={styles.expHint}>
                다음 레벨까지 {Math.max(0, progress.exp_to_next - progress.exp_in_level)} EXP
              </Text>
            </View>
          </FadeInUp>
        )}

        {/* ── 주간 퀘스트 ── */}
        {quests && quests.quests.length > 0 && (
          <FadeInUp delay={60}>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>주간 퀘스트</Text>
              <Text style={styles.sectionHint}>홈에서 할 일을 완료하면 자동으로 채워져요 · 월요일 리셋</Text>
              {quests.quests.map((q) => {
                const pct = Math.max(0, Math.min(1, q.progress / Math.max(1, q.goal)));
                return (
                  <View key={q.id} style={styles.questRow}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.questTitle}>{q.title}</Text>
                        {q.claimed && <Badge label="수령 완료" tone="green" />}
                      </View>
                      <Text style={styles.questDesc}>{q.desc}</Text>
                      <View style={styles.questTrack}>
                        <View style={[styles.questFill, { width: `${pct * 100}%` }, q.done && { backgroundColor: '#3E9B4F' }]} />
                      </View>
                      <Text style={styles.questProgress}>{q.progress}/{q.goal}</Text>
                    </View>
                    {claiming === q.id ? (
                      <ActivityIndicator color={colors.mochaBrown} style={{ width: 64 }} />
                    ) : q.claimable ? (
                      <PressableScale style={styles.claimBtn} onPress={() => handleClaim(q)}>
                        <Text style={styles.claimText}>+{q.reward} 받기</Text>
                      </PressableScale>
                    ) : (
                      <Text style={styles.questReward}>🪙 {q.reward}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          </FadeInUp>
        )}

        {/* ── 상점 · 보관함 ── */}
        <FadeInUp delay={120}>
          <View style={styles.btnRow}>
            <PressableScale style={[styles.bigBtn, styles.bigBtnAlt]} onPress={() => navigation.navigate('Shop')}>
              <Ionicons name="cart" size={18} color={colors.espressoBrown} />
              <Text style={[styles.bigBtnText, { color: colors.espressoBrown }]}>상점</Text>
            </PressableScale>
            <PressableScale
              style={[styles.bigBtn, styles.bigBtnAlt]}
              onPress={() => setVaultOpen(true)}
            >
              <Ionicons name="albums" size={18} color={colors.espressoBrown} />
              <Text style={[styles.bigBtnText, { color: colors.espressoBrown }]}>보관함</Text>
            </PressableScale>
          </View>
        </FadeInUp>
      </ScrollView>

      {/* 보관함 — 이 화면 위에 올라온다. 배경을 갈아입으면 뒤의 방도 즉시 바뀐다
          (EquippedContext를 통해 roomBgId가 갱신되므로) */}
      <VaultSheet
        visible={vaultOpen}
        onClose={() => setVaultOpen(false)}
        onGoShop={() => {
          setVaultOpen(false);
          navigation.navigate('Shop');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(30, 22, 18, 0.18)',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  coinEmoji: { fontSize: 13 },
  coinText: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown },
  fullBg: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  stage: {
    alignItems: 'center',
    // 가로·세로 모두 한가운데. 예전엔 flex-end라 남는 세로 여백이 전부 브루 위에 쌓여,
    // 브루가 무대 바닥에 붙고 발끝이 레벨 카드에 닿았다.
    justifyContent: 'center',
    minHeight: s(300),
    marginTop: s(4),
    marginBottom: 12,
  },
  card: {
    backgroundColor: 'rgba(255, 252, 247, 0.94)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
  },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  levelBadge: {
    backgroundColor: colors.espressoBrown,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  levelBadgeText: { ...typography.L5, fontWeight: '800', color: colors.white },
  levelTitle: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown, flex: 1 },
  streakPill: {
    backgroundColor: colors.creamSand,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  streakText: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown },
  expTrack: {
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.mutedSand,
    overflow: 'hidden',
    marginTop: 10,
  },
  expFill: { height: '100%', borderRadius: 4, backgroundColor: colors.pointOrange },
  expHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 5 },
  sectionTitle: { ...typography.L4, fontSize: 14, fontWeight: '800', color: colors.espressoBrown },
  sectionHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 2, marginBottom: 4 },
  questRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
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
  questProgress: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  questReward: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown, width: 64, textAlign: 'right' },
  claimBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  claimText: { ...typography.L5, fontWeight: '800', color: colors.white },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  bigBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.espressoBrown,
    borderRadius: 16,
    paddingVertical: 14,
  },
  bigBtnAlt: { backgroundColor: 'rgba(255, 252, 247, 0.94)' },
  bigBtnText: { ...typography.L4, fontWeight: '800', color: colors.white },
});
