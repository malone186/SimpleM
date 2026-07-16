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
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.profileBtn} onPress={onOpenProfile} hitSlop={8} activeOpacity={0.85}>
          {photo ? (
            <Image source={{ uri: photo }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
          )}
          <Ionicons name="chevron-down" size={10} color="#D2C8C2" />
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
        <Brew mood={mood} size={124} style={styles.mascot} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: 'transparent', 
    paddingTop: 44, // [한글 주석: 레이아웃 리프팅] 위쪽 여백 축소
    paddingBottom: 14, // [한글 주석: 레이아웃 리프팅] 아래쪽 여백 축소
    paddingHorizontal: spacing.globalPadding,
  },
  topBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 }, // 본문과의 간격 밀착
  profileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingLeft: 3,
    paddingRight: 7,
    paddingVertical: 3,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  avatar: {
    width: 20, // [한글 주석: 계정 탭 축소] 너비를 20px로 미니멀화
    height: 20, // [한글 주석: 계정 탭 축소] 높이를 20px로 미니멀화
    borderRadius: 10,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 9.5, color: colors.white, fontWeight: '900' }, // 아바타 축소에 따른 텍스트 비례 축소
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textCol: { flex: 1, paddingRight: 8 },
  greeting: { fontSize: 13, fontWeight: '600', color: '#BCAFA5', marginBottom: 4, letterSpacing: -0.2 },
  title: { fontSize: 28, fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5 },
  quote: { fontSize: 11, fontWeight: '400', color: '#D4C9C1', lineHeight: 17, marginTop: 6, paddingRight: 8, letterSpacing: -0.2 }, // 상호와의 간격 좁힘
  mascot: { marginRight: 4 },
});
