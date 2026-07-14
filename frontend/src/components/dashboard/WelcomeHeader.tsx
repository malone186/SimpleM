// 상단 웰컴 블록 (Design Spec §4-①) — 브루 등장 지도 #1: 홈 인사 + AI 비서
// 인사말 + 오늘의 명언(자정마다 교체) + 오늘 상태에 따라 표정이 바뀌는 브루.
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography } from '../../theme';
import Brew, { type BrewMood } from '../brew/Brew';

// 오늘의 명언 — 날짜(로컬 자정 기준)로 하나씩 순환
const QUOTES = [
  '좋은 커피 한 잔이 누군가의 하루를 바꿉니다.',
  '서두르지 않아도 향은 깊어집니다.',
  '오늘의 정성이 내일의 단골을 만듭니다.',
  '작은 가게의 큰 진심, 손님은 압니다.',
  '완벽한 한 잔보다 따뜻한 한 마디.',
  '숫자는 어제를, 마음은 오늘을 채웁니다.',
  '천천히 내려도 커피는 맛있습니다.',
  '한 잔의 여유가 하루를 버티게 합니다.',
];

function dayIndex(d: Date) {
  // 로컬 자정 기준 일수 → 자정이 지나면 값이 바뀐다
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.floor(midnight / 86_400_000);
}

function useDailyQuote() {
  const [idx, setIdx] = useState(() => dayIndex(new Date()) % QUOTES.length);

  useEffect(() => {
    // 다음 자정에 맞춰 명언 갱신
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const timer = setTimeout(() => setIdx(dayIndex(new Date()) % QUOTES.length), nextMidnight - now.getTime() + 500);
    return () => clearTimeout(timer);
  }, [idx]);

  return QUOTES[idx];
}

export default function WelcomeHeader({
  storeName = '포자카페',
  photo,
  mood = 'welcome',
  onOpenProfile,
}: {
  storeName?: string;
  photo?: string;
  mood?: BrewMood;
  onOpenProfile?: () => void;
}) {
  const quote = useDailyQuote();
  const initial = (storeName || 'S').charAt(0).toUpperCase();

  return (
    <View style={styles.header}>
      {/* 상단바 — 왼쪽 프로필 */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.profileBtn} onPress={onOpenProfile} hitSlop={8} activeOpacity={0.8}>
          {photo ? (
            <Image source={{ uri: photo }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
          )}
          <Ionicons name="chevron-down" size={14} color={colors.mutedSand} />
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <View style={styles.textCol}>
          <Text style={styles.greeting}>안녕하세요 사장님 ☀️</Text>
          <Text style={styles.title}>{storeName}</Text>
          <Text style={styles.quote} numberOfLines={2}>
            {quote}
          </Text>
        </View>
        <Brew mood={mood} size={132} style={styles.mascot} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.espressoBrown,
    paddingTop: 48,
    paddingBottom: 22,
    paddingHorizontal: spacing.globalPadding,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
  },
  topBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  profileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 999,
    paddingLeft: 4,
    paddingRight: 8,
    paddingVertical: 4,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...typography.L4, color: colors.white, fontWeight: '900' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textCol: { flex: 1, paddingRight: 4 },
  greeting: { ...typography.L4, color: colors.mutedSand, marginBottom: 4 },
  title: { fontSize: 26, fontWeight: '900', color: colors.creamSand },
  quote: { ...typography.L5, color: colors.mutedSand, lineHeight: 16, marginTop: 12, paddingRight: 6, fontStyle: 'italic' },
  // 캐릭터를 키우고 로그아웃 버튼과 안 겹치게 왼쪽으로
  mascot: { marginRight: 8 },
});
