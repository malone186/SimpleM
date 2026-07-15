// [상단 웰컴 블록 - 애플 스타일 오로라 가우시안 블러 필터 적용]
// 칼같이 보이던 원의 경계선을 feGaussianBlur 필터로 완벽히 뭉개고, 파스텔 톤의 모카 샌드 그라데이션으로 화사하게 튜닝했습니다.
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Filter, FeGaussianBlur } from 'react-native-svg';

import { colors, spacing, typography } from '../../theme';
import Brew, { type BrewMood } from '../brew/Brew';

// 오늘의 명언
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
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.floor(midnight / 86_400_000);
}

function useDailyQuote() {
  const [idx, setIdx] = useState(() => dayIndex(new Date()) % QUOTES.length);

  useEffect(() => {
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
      {/* 
        [한글 주석: 초고화질 가우시안 블러 필터 레이어]
        원의 경계를 완전히 파괴하여 사방으로 흐릿하게 번지는 몽환적인 글로우를 묘사합니다.
        레퍼런스의 플레시 핑크/모카 샌드 색상 비율을 매칭하여 고급화했습니다.
      */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="auroraGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor="#2B170F" />
              <Stop offset="50%" stopColor="#452A1E" />
              <Stop offset="100%" stopColor="#1E0F0A" />
            </LinearGradient>
            
            <Filter id="auroraGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="60" />
            </Filter>
          </Defs>
          {/* 백그라운드 밀키 모카 샌드 그라데이션 */}
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#auroraGrad)" />
          
          {/* [우측 상단 몽환적인 주황 오렌지 글로우] 표준편차 60px의 가우시안 블러 통과 */}
          <Circle cx="85%" cy="30%" r="160" fill="#E67E4F" filter="url(#auroraGlow)" opacity="0.3" />
          
          {/* [좌측 하단 은은한 샌드 브라운 글로우] */}
          <Circle cx="15%" cy="80%" r="140" fill="#B58E6F" filter="url(#auroraGlow)" opacity="0.25" />

          {/* [중앙 상단 화사한 샌드 베이지 글로우] */}
          <Circle cx="50%" cy="10%" r="120" fill="#F2CEB6" filter="url(#auroraGlow)" opacity="0.2" />
        </Svg>
      </View>

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

      {/* 웰컴 문구 및 브루 마스코트 배치 */}
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
    backgroundColor: 'transparent', 
    paddingTop: 48,
    paddingBottom: 22,
    paddingHorizontal: spacing.globalPadding,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
    overflow: 'hidden',
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
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
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
  mascot: { marginRight: 8 },
});
