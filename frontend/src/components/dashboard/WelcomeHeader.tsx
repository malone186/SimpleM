// [상단 웰컴 블록 - 미니멀 말풍선 카드 적용 (투데이스 브루 뱃지 제거 및 1줄 피트 정렬)]
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../../theme';
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

  // [한글 주석: 강아지와 말풍선을 묶어 위아래로 둥둥 띄우기 위한 애니메이션 상태변수 정의]
  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 1250,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1250,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [floatAnim]);

  // [한글 주석: 위아래로 최대 7픽셀(px) 만큼 둥둥거리도록 애니메이션 수치 변환]
  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -7],
  });

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

      <Animated.View style={[styles.mainRow, { transform: [{ translateY }] }]}>
        {/* [한글 주석: 투데이스 브루 뱃지를 깔끔하게 제거하고 단어 꺾임 없이 한 줄로 배치한 말풍선] */}
        <View style={styles.bubble}>
          {/* [한글 주석: 1행 사장님 인사말] */}
          <Text style={styles.greetingLine} numberOfLines={1}>
            안녕하세요, <Text style={styles.nameHighlight}>{storeName}</Text> 사장님!
          </Text>

          {/* [한글 주석: 2행 명언 - 단어 가름 없이 폰트를 10.5px로 조절하여 1문장 1줄 정렬] */}
          <Text style={styles.quoteLine} numberOfLines={1}>
            {quote}
          </Text>

          {/* [한글 주석: 말풍선 우측 삼각형 꼬리] */}
          <View style={styles.bubbleTailBorder} />
          <View style={styles.bubbleTail} />
        </View>

        {/* [한글 주석: 우측 마스코트 강아지 캐릭터] */}
        <Brew mood={mood} size={150} style={styles.mascot} disableMotion={true} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: 'transparent',
    paddingTop: 38,
    paddingBottom: 12,
    paddingHorizontal: spacing.globalPadding,
  },
  topBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
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
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 9.5, color: colors.white, fontWeight: '900' },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // [한글 주석: 뱃지 없는 컴팩트 둥근 아이보리 말풍선 카드]
  bubble: {
    flex: 1,
    backgroundColor: '#FFFCFA',
    borderRadius: 18,
    borderWidth: 1.2,
    borderColor: '#F2E6DD',
    paddingHorizontal: 15,
    paddingVertical: 11,
    marginRight: 12,
    position: 'relative',
    shadowColor: '#3A2012',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  // [한글 주석: 인사말 라인 (1줄 피트)]
  greetingLine: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2C1D17',
    marginBottom: 3,
  },
  // [한글 주석: 사장님 성함 하이라이트]
  nameHighlight: {
    fontSize: 15.5,
    fontWeight: '900',
    color: '#D9531E',
    letterSpacing: -0.4,
  },
  // [한글 주석: 명언 라인 (어색한 단어 꺾임 방지 10.5px 및 1줄 피트)]
  quoteLine: {
    fontSize: 10.5,
    fontWeight: '500',
    color: '#7A6C63',
    lineHeight: 15,
    letterSpacing: -0.3,
  },
  bubbleTail: {
    position: 'absolute',
    right: -9,
    top: '50%',
    marginTop: -6,
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderLeftWidth: 9,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#FFFCFA',
  },
  bubbleTailBorder: {
    position: 'absolute',
    right: -11,
    top: '50%',
    marginTop: -7,
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 10,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#F2E6DD',
  },
  mascot: { marginRight: 2 },
});
