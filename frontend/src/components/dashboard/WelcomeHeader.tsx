// [상단 웰컴 블록 - 미니멀 말풍선 카드 적용 (투데이스 브루 뱃지 제거 및 1줄 피트 정렬)]
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../../theme';
import Brew, { type BrewMood } from '../brew/Brew';
import MarqueeText from '../MarqueeText';
import { getAnnouncements } from '../../lib/api/announcements';

// [시간대별 인사말] "~사장님!" 아래 줄에 현재 시각에 맞춰 자동으로 바뀌는 문구.
// 각 구간에 여러 후보를 두고 10분 단위로 회전해 같은 시간대라도 조금씩 달라진다.
function timeGreeting(now: Date): string {
  const h = now.getHours();
  let pool: string[];
  if (h < 6) pool = ['늦은 시간까지 고생 많으세요. 잠깐의 휴식도 챙기세요.', '고요한 새벽이에요. 무리하지 마시고 천천히 준비해요.'];
  else if (h < 11) pool = ['상쾌한 아침이에요! 오늘의 첫 잔을 준비해 볼까요?', '좋은 아침입니다. 오늘도 활기차게 시작해요!', '아침 손님 맞이 준비 되셨나요? 파이팅이에요!'];
  else if (h < 14) pool = ['점심 피크타임이에요. 바쁜 만큼 힘내세요!', '든든하게 점심 챙기시고, 오후도 파이팅!'];
  else if (h < 17) pool = ['나른한 오후, 향긋한 커피 한 잔 어떠세요?', '오후의 여유를 손님과 함께 나눠 보세요.'];
  else if (h < 21) pool = ['저녁 손님 맞이 준비 되셨나요? 마무리까지 힘내요!', '하루의 끝을 향해 가요. 오늘도 수고 많으셨어요.'];
  else pool = ['오늘 하루도 정말 고생 많으셨어요. 편히 마무리하세요.', '늦은 밤이에요. 마감 정리 후 푹 쉬세요.'];
  const rot = Math.floor(now.getMinutes() / 10);
  return pool[rot % pool.length];
}

// 시간대 인사말을 상태로 들고 1분마다 현재 시각 기준으로 갱신
function useTimeGreeting() {
  const [line, setLine] = useState(() => timeGreeting(new Date()));
  useEffect(() => {
    const tick = () => setLine(timeGreeting(new Date()));
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);
  return line;
}

const DISMISSED_KEY = 'simplem:announce:dismissed';

// 관리자 공지를 폴링해 아직 닫지 않은 가장 최근 공지를 반환. 닫으면(dismiss) 다음부턴 숨긴다.
function useAdminAnnouncement() {
  const [announce, setAnnounce] = useState<{ id: number; title: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const list = await getAnnouncements();
        const raw = await AsyncStorage.getItem(DISMISSED_KEY);
        const seen: number[] = raw ? JSON.parse(raw) : [];
        const fresh = (list || [])
          .filter((n) => typeof n?.id === 'number' && !seen.includes(n.id))
          .sort((a, b) => b.id - a.id);
        if (alive) setAnnounce(fresh[0] ? { id: fresh[0].id, title: fresh[0].title } : null);
      } catch {
        // 서버 오프라인 — 다음 주기에 재시도, 말풍선은 시간대 인사말로 유지
      }
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const dismiss = async () => {
    if (!announce) return;
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_KEY);
      const seen: number[] = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...seen, announce.id])]));
    } catch {
      // 저장 실패해도 이번 세션에선 숨긴다
    }
    setAnnounce(null);
  };

  return { announce, dismiss };
}

export default function WelcomeHeader({
  storeName = '포자카페',
  mood = 'welcome',
  onOpenMap,
}: {
  storeName?: string;
  photo?: string;
  mood?: BrewMood;
  onOpenMap?: () => void;
}) {
  const greeting = useTimeGreeting();
  const { announce, dismiss } = useAdminAnnouncement();

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
        <TouchableOpacity style={styles.mapBtn} onPress={onOpenMap} hitSlop={10} activeOpacity={0.85}>
          <Ionicons name="map-outline" size={15} color={colors.creamSand} />
        </TouchableOpacity>
      </View>

      <Animated.View style={[styles.mainRow, { transform: [{ translateY }] }]}>
        {/* [한글 주석: 투데이스 브루 뱃지를 깔끔하게 제거하고 단어 꺾임 없이 한 줄로 배치한 말풍선] */}
        <View style={styles.bubble}>
          {/* 1행 인사말 — 상호명이 길어도 잘리지 않게 마퀴로 흘려 준다 */}
          <Text style={[styles.greetingLine, { marginBottom: 1 }]}>안녕하세요,</Text>
          <MarqueeText style={{ marginBottom: 5 }}>
            <Text style={styles.greetingLine}>
              <Text style={styles.nameHighlight}>{storeName}</Text> 사장님!
            </Text>
          </MarqueeText>

          {/* 2행 — 관리자 공지가 있으면 강아지가 전하는 공지, 없으면 시간대별 인사말 (둘 다 길면 흐른다) */}
          {announce ? (
            <TouchableOpacity activeOpacity={0.7} onPress={dismiss} style={styles.announceRow}>
              <Ionicons name="megaphone" size={11} color={colors.pointOrange} style={{ marginRight: 4 }} />
              <MarqueeText style={{ flex: 1 }}>
                <Text style={styles.announceLine}>{announce.title}</Text>
              </MarqueeText>
              <Ionicons name="close" size={12} color="#B4A89E" style={{ marginLeft: 4 }} />
            </TouchableOpacity>
          ) : (
            <MarqueeText>
              <Text style={styles.quoteLine}>{greeting}</Text>
            </MarqueeText>
          )}

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
  mapBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // [한글 주석: 뱃지 없는 컴팩트 둥근 아이보리 말풍선 카드 - 더 얇고 은은한 그림자 디자인으로 세련되게 개편]
  bubble: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)', // 테마의 mutedSand 계열 적용
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 12,
    position: 'relative',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 3,
  },
  // [한글 주석: 인사말 라인 (1줄 피트)]
  greetingLine: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2C1D17',
    marginBottom: 3,
  },
  // [한글 주석: 사장님 성함 하이라이트 - 붉은 주황색에서 차분하고 감성적인 로컬 모카 브라운 톤으로 변경]
  nameHighlight: {
    fontSize: 15.5,
    fontWeight: '900',
    color: colors.mochaBrown, // 로컬 모카 브라운 톤 (기존 빨강 #D9531E에서 변경)
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
  // 관리자 공지 라인 — 강아지가 전하는 공지 느낌으로 포인트 오렌지 톤
  announceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  announceLine: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#C05A24',
    lineHeight: 15,
    letterSpacing: -0.3,
  },
  bubbleTail: {
    position: 'absolute',
    right: -8,
    top: '50%',
    marginTop: -5,
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: colors.white,
  },
  bubbleTailBorder: {
    position: 'absolute',
    right: -10,
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
    borderLeftColor: 'rgba(140, 111, 86, 0.15)',
  },
  mascot: { marginRight: 2 },
});
