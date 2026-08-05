// 브루의 카페 (게임 룸) — 홈 우상단 버튼으로 들어오는 게임 허브 화면.
// 카페 배경 한가운데에 '내가 꾸민 브루'가 살아 움직이고, 그 아래로 레벨·주간 퀘스트가
// 붙는다. 상점·보관함은 여기서 갈라져 들어간다 — 꾸미기 경제의 관문 역할.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageBackground, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useAuth } from '../../auth/AuthContext';
import MascotEasterEgg from '../../components/dashboard/MascotEasterEgg';
import { FadeInUp, PressableScale } from '../../components/motion';
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
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { colors, typography } from '../../theme';
import { s, useBottomInset, useTopInset } from '../../theme/responsive';

const ROOM_BG = require('../../../assets/game/room_bg.jpg');

export default function BrewRoomScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { token } = useAuth();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [quests, setQuests] = useState<QuestBoard | null>(null);
  const [coins, setCoins] = useState<number | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [p, q, w] = await Promise.all([getProgress(token), getQuests(token), getWallet(token)]);
      setProgress(p);
      setQuests(q);
      setCoins(w.balance);
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

  return (
    <View style={{ flex: 1, backgroundColor: '#241A14' }}>
      {/* 배경을 자르지 않고 통째로 보여준다(contain). 화면 비율과 안 맞아 생기는
          여백은 같은 그림을 크게 흐려 깐 것으로 채워 빈 띠처럼 안 보이게 한다. */}
      <ImageBackground source={ROOM_BG} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={18} />
      <Image source={ROOM_BG} style={styles.fullBg} resizeMode="contain" />
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
            그대로 쓰되, 여기서는 정지 포즈여도 잔동작을 켜서 살아 있게 한다. ── */}
        <View style={styles.stage}>
          <MascotEasterEgg size={s(270)} motion />
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
              onPress={() => navigation.navigate('Shop', { openVault: true })}
            >
              <Ionicons name="albums" size={18} color={colors.espressoBrown} />
              <Text style={[styles.bigBtnText, { color: colors.espressoBrown }]}>보관함</Text>
            </PressableScale>
          </View>
        </FadeInUp>
      </ScrollView>
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
    justifyContent: 'flex-end',
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
