// [상단 웰컴 블록 - 미니멀 말풍선 카드 적용 (투데이스 브루 뱃지 제거 및 1줄 피트 정렬)]
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../../theme';
import Brew, { type BrewMood } from '../brew/Brew';
import MarqueeText from '../MarqueeText';
import { useAuth } from '../../auth/AuthContext';
import { fetchNoticeFeed, type AdminNotice } from '../../lib/api/notice';

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

// 닫힘 식별용 서명 — 백엔드가 서버 재시작 시 id를 재사용하므로 id만으로 닫으면
// 같은 번호의 새 공지가 잘못 숨겨진다. id+제목+날짜 조합으로 고유하게 식별한다.
const announceSig = (n: { id: number; title?: string; date?: string }) =>
  `${n.id}|${n.title ?? ''}|${n.date ?? ''}`;

// 관리자 공지를 폴링해 아직 닫지 않은 가장 최근 공지를 반환. 닫으면(dismiss) 다음부턴 숨긴다.
// 소스는 로그인 매장 몫만 골라 주는 타겟 피드(/admin/notifications/feed) — 다른 매장 공지는 안 온다.
function useAdminAnnouncement(refreshTrigger = 0) {
  const { token } = useAuth();
  const [announce, setAnnounce] = useState<{ sig: string; title: string } | null>(null);

  useEffect(() => {
    if (!token) {
      setAnnounce(null);
      return;
    }
    let alive = true;
    const check = async () => {
      try {
        // after_id=0 → 내 매장에 온 공지 전체를 받아 아직 안 닫은 최신 것을 고른다
        const list = await fetchNoticeFeed(token, 0);
        const raw = await AsyncStorage.getItem(DISMISSED_KEY);
        const seen: string[] = raw ? JSON.parse(raw) : [];
        const fresh = (list || [])
          .filter((n) => typeof n?.id === 'number' && !seen.includes(announceSig(n)))
          .sort((a, b) => b.id - a.id);
        if (alive) setAnnounce(fresh[0] ? { sig: announceSig(fresh[0]), title: fresh[0].title } : null);
      } catch {
        // 서버 오프라인/미로그인 — 다음 주기에 재시도, 말풍선은 시간대 인사말로 유지
      }
    };
    check();
    const timer = setInterval(check, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // refreshTrigger: 홈 당겨서 새로고침 시 공지도 즉시 재확인
  }, [token, refreshTrigger]);

  const dismiss = async () => {
    if (!announce) return;
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_KEY);
      const seen: string[] = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...seen, announce.sig])]));
    } catch {
      // 저장 실패해도 이번 세션에선 숨긴다
    }
    setAnnounce(null);
  };

  return { announce, dismiss };
}

const READ_MAX_KEY = 'simplem:notice:read-max-id';

// 알림함 — 내 매장에 온 관리자 공지 전체를 최신순으로 들고, 안 읽은 개수(배지)를 계산한다.
// 열면 현재 최신 id까지 '읽음' 처리한다.
function useNoticeInbox(refreshTrigger = 0) {
  const { token } = useAuth();
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const [readMaxId, setReadMaxId] = useState(0);

  useEffect(() => {
    AsyncStorage.getItem(READ_MAX_KEY)
      .then((v) => setReadMaxId(v ? Number(v) : 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!token) {
      setNotices([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const list = await fetchNoticeFeed(token, 0);
        if (alive) setNotices((list || []).slice().sort((a, b) => b.id - a.id));
      } catch {
        // 서버 오프라인/미로그인 — 다음 주기에 재시도
      }
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [token, refreshTrigger]);

  const unreadCount = notices.filter((n) => n.id > readMaxId).length;

  // 열람 시 호출 — 현재 최신 id까지 읽음 처리 (배지 사라짐)
  const markAllRead = async () => {
    const maxId = notices.reduce((m, n) => Math.max(m, n.id), readMaxId);
    setReadMaxId(maxId);
    try {
      await AsyncStorage.setItem(READ_MAX_KEY, String(maxId));
    } catch {
      // 저장 실패해도 이번 세션 동안은 읽음 처리 유지
    }
  };

  return { notices, unreadCount, readMaxId, markAllRead };
}

export default function WelcomeHeader({
  storeName = '포자카페',
  mood = 'welcome',
  onOpenMap,
  refreshTrigger = 0,
}: {
  storeName?: string;
  photo?: string;
  refreshTrigger?: number;
  mood?: BrewMood;
  onOpenMap?: () => void;
}) {
  const greeting = useTimeGreeting();
  const { announce, dismiss } = useAdminAnnouncement(refreshTrigger);

  // 알림함 (지도 아이콘 옆 벨) — 지난 공지를 스택형으로 모아 본다
  const { notices, unreadCount, readMaxId, markAllRead } = useNoticeInbox(refreshTrigger);
  const [inboxOpen, setInboxOpen] = useState(false);
  // 모달을 열 때의 읽음 기준선을 스냅샷 — 그 이후 id는 목록에서 'NEW'로 표시
  const [newBaseline, setNewBaseline] = useState(0);

  const openInbox = () => {
    setNewBaseline(readMaxId);
    setInboxOpen(true);
    markAllRead();
  };

  // 말풍선 공지를 탭하면: 말풍선에서 치우고(dismiss) 알림함을 열어 전체 내용을 보여준다
  const openAnnounce = () => {
    openInbox();
    dismiss();
  };

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
        <TouchableOpacity style={styles.iconBtn} onPress={onOpenMap} hitSlop={10} activeOpacity={0.85}>
          <Ionicons name="map-outline" size={19} color={colors.creamSand} />
        </TouchableOpacity>

        {/* 알림함 — 지난 관리자 공지를 스택형으로 모아 본다 */}
        <TouchableOpacity style={styles.iconBtn} onPress={openInbox} hitSlop={10} activeOpacity={0.85}>
          <Ionicons name="notifications-outline" size={19} color={colors.creamSand} />
          {unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
            </View>
          )}
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
            <View style={styles.announceRow}>
              {/* 본문 탭 → 알림함이 열려 전체 내용 확인 (동시에 말풍선에서 사라짐) */}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={openAnnounce}
                style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
              >
                <Ionicons name="megaphone" size={11} color={colors.pointOrange} style={{ marginRight: 4 }} />
                <MarqueeText style={{ flex: 1 }}>
                  <Text style={styles.announceLine}>{announce.title}</Text>
                </MarqueeText>
              </TouchableOpacity>
              {/* X → 알림함을 열지 않고 말풍선에서 닫기만 */}
              <TouchableOpacity onPress={dismiss} hitSlop={8} style={{ marginLeft: 4 }}>
                <Ionicons name="close" size={12} color="#B4A89E" />
              </TouchableOpacity>
            </View>
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

      {/* 알림함 모달 — 지난 공지를 스택 카드로 쌓아 보여준다 */}
      <Modal visible={inboxOpen} transparent animationType="fade" onRequestClose={() => setInboxOpen(false)}>
        <Pressable style={styles.inboxBackdrop} onPress={() => setInboxOpen(false)}>
          <Pressable style={styles.inboxPanel} onPress={(e) => e.stopPropagation()}>
            <View style={styles.inboxHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="notifications" size={16} color={colors.espressoBrown} />
                <Text style={styles.inboxTitle}>알림</Text>
              </View>
              <TouchableOpacity onPress={() => setInboxOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.mochaBrown} />
              </TouchableOpacity>
            </View>

            {notices.length === 0 ? (
              <View style={styles.inboxEmpty}>
                <Ionicons name="mail-open-outline" size={28} color="#C7BBB0" />
                <Text style={styles.inboxEmptyText}>받은 알림이 없어요.</Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {notices.map((n) => (
                  <View key={n.id} style={styles.noticeCard}>
                    <View style={styles.noticeCardTop}>
                      <Ionicons name="megaphone" size={13} color={colors.pointOrange} style={{ marginRight: 5, marginTop: 1 }} />
                      <Text style={styles.noticeCardTitle}>{n.title}</Text>
                      {n.id > newBaseline && (
                        <View style={styles.newDot}>
                          <Text style={styles.newDotText}>N</Text>
                        </View>
                      )}
                    </View>
                    {!!n.body && <Text style={styles.noticeCardBody}>{n.body}</Text>}
                    <Text style={styles.noticeCardMeta}>{n.author} · {n.date}</Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
  // marginTop으로 아이콘 줄을 아주 조금 아래로 내린다
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8 },
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 18,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  // 안 읽은 알림 개수 배지
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.2,
    borderColor: '#1E1612',
  },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: '900' },
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

  // 알림함 모달
  inboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  inboxPanel: {
    backgroundColor: colors.creamSand,
    borderRadius: 22,
    padding: 16,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  inboxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  inboxTitle: { fontSize: 16, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.3 },
  inboxEmpty: { alignItems: 'center', gap: 8, paddingVertical: 34 },
  inboxEmptyText: { fontSize: 12, color: '#9C8E82', fontWeight: '600' },
  // 스택형 공지 카드
  noticeCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.14)',
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  noticeCardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  noticeCardTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.espressoBrown, lineHeight: 18 },
  noticeCardBody: { fontSize: 11.5, color: '#6B5D53', lineHeight: 16, marginTop: 5 },
  noticeCardMeta: { fontSize: 10, color: '#A99C90', fontWeight: '600', marginTop: 7 },
  // 새 공지 'N' 뱃지
  newDot: {
    minWidth: 15,
    height: 15,
    borderRadius: 7.5,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
    marginTop: 1,
  },
  newDotText: { color: colors.white, fontSize: 8.5, fontWeight: '900' },
});
