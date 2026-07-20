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
          {/* [한글 주석: 기존 텍스트형 인사를 제거하고 타이틀을 더 돋보이게 배치합니다] */}
          <Text style={styles.title}>{storeName}</Text>
          <Text style={styles.quote} numberOfLines={2}>
            {quote}
          </Text>
        </View>
        {/* [한글 주석: 마스코트 캐릭터와 말풍선을 한곳에 담는 컨테이너로 감쌉니다] */}
        <View style={styles.mascotContainer}>
          {/* [한글 주석: 강아지가 직접 말하는 듯한 흰색 입체 말풍선 상자입니다] */}
          <View style={styles.bubble}>
            <Text style={styles.bubbleText}>안녕하세요 사장님 ☀️</Text>
            {/* [한글 주석: 말풍선 하단에 강아지 방향을 향하는 뾰족한 꼬리를 얹어줍니다] */}
            <View style={styles.bubbleTail} />
          </View>
          <Brew mood={mood} size={168} style={styles.mascot} />
        </View>
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
  title: { fontSize: 28, fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5 },
  quote: { fontSize: 11, fontWeight: '400', color: '#D4C9C1', lineHeight: 17, marginTop: 6, paddingRight: 8, letterSpacing: -0.2 }, // 상호와의 간격 좁힘
  mascotContainer: {
    position: 'relative',
    alignItems: 'center',
  },
  // [한글 주석: 강아지 캐릭터 머리맡에 뜨는 둥근 흰색 말풍선 상자 스타일]
  bubble: {
    position: 'absolute',
    top: 30,              // 강아지 얼굴/입 높이에 맞추어 기존 5에서 30으로 내림
    left: -115,           // 얼굴을 가리지 않도록 왼쪽으로 조금 더 (-85에서 -115로) 밀어냄
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    zIndex: 10,           // 강아지 그래픽 위에 렌더링되도록 우선순위 지정
    // [한글 주석: 그림자로 말풍선이 붕 떠 있는 듯한 세련된 오버레이 연출]
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 5,         // 안드로이드 환경을 위한 그림자 대체
  },
  // [한글 주석: 말풍선 안에 들어갈 텍스트 스타일]
  bubbleText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#3B2920',     // 테마에 알맞는 진한 모카 브라운 톤의 글자색
    letterSpacing: -0.2,
  },
  // [한글 주석: 말풍선 우측면에 붙어 강아지 얼굴 방향(오른쪽)으로 뻗어나가는 가로형 꼬리]
  bubbleTail: {
    position: 'absolute',
    right: -8,            // 말풍선 오른쪽 벽면 바깥쪽에 접착
    top: 10,              // 말풍선 세로 중앙 부근에 배치
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderTopWidth: 6,    // 위쪽 빗면 두께
    borderBottomWidth: 6, // 아래쪽 빗면 두께
    borderLeftWidth: 10,  // 왼쪽에서 오른쪽으로 향하는 삼각형의 길이 (꼬리의 뾰족한 길이)
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#FFFFFF', // 말풍선 본체 색상과 동일하게 채움
  },
  mascot: { marginRight: 4 },
});
