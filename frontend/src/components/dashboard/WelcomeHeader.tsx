// [상단 웰컴 블록 - 미니멀 말풍선 카드 및 말풍선 하단 반투명 블러 공지 바 적용]
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../../theme';
import { AdminNotification, getAdminNotifications } from '../../lib/api/notifications';
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
  refreshTrigger = 0,
}: {
  storeName?: string;
  photo?: string;
  mood?: BrewMood;
  onOpenMap?: () => void;
  refreshTrigger?: number;
}) {
  const greeting = useTimeGreeting();
  const { announce, dismiss } = useAdminAnnouncement();

  // [한글 주석: 백엔드에서 불러온 최신 관리자 공지사항 데이터 상태]
  const [latestNotice, setLatestNotice] = useState<AdminNotification | null>(null);
  // [한글 주석: 공지사항 클릭 시 상세 내역을 팝업으로 띄우는 모달 상태]
  const [modalNotice, setModalNotice] = useState<AdminNotification | null>(null);
  // [한글 주석: 사장님이 마지막으로 클릭하여 읽은 공지사항 ID 상태 및 읽지 않은 신규 공지 여부]
  const [readNoticeId, setReadNoticeId] = useState<number | null>(null);

  // [한글 주석: 로컬 저장소(AsyncStorage)에서 이전에 확인했던 공지 ID 로드]
  useEffect(() => {
    AsyncStorage.getItem('read_admin_notice_id')
      .then((val) => {
        if (val) setReadNoticeId(Number(val));
      })
      .catch(() => {});
  }, []);

  // [한글 주석: 최신 공지사항과 비교하여 읽지 않은 새 공지가 존재하면 true]
  const hasUnreadNotice = latestNotice != null && readNoticeId !== latestNotice.id;

  // [한글 주석: 공지사항 바 클릭 시 열람 모달 팝업 및 읽음 처리(빨간 점 제거)]
  const handleOpenNotice = (notice: AdminNotification) => {
    setModalNotice(notice);
    setReadNoticeId(notice.id);
    AsyncStorage.setItem('read_admin_notice_id', String(notice.id)).catch(() => {});
  };

  // [한글 주석: 강아지와 말풍선을 묶어 위아래로 둥둥 띄우기 위한 애니메이션 상태변수 정의]
  const floatAnim = useRef(new Animated.Value(0)).current;

  // [한글 주석: 최신 공지사항 조회 함수 - 백엔드에서 공지 목록 수신]
  useEffect(() => {
    let active = true;
    const fetchNotices = async () => {
      const list = await getAdminNotifications();
      if (active && list && list.length > 0) {
        setLatestNotice(list[0]); // 가장 최신 공지 1건 표출
      }
    };
    fetchNotices();
    return () => {
      active = false;
    };
  }, [refreshTrigger]);

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
        {/* [한글 주석: 좌측 수직 컬럼 - 말풍선과 공지 바를 세로로 묶어 강아지와 좌우 배치] */}
        <View style={styles.leftColumn}>
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

          {/* [한글 주석: 말풍선 밑에 들어가는 가로로 긴 반투명 블러 공지사항 바 UI] */}
          {latestNotice ? (
            <TouchableOpacity
              style={styles.glassNoticeBar}
              activeOpacity={0.78}
              onPress={() => handleOpenNotice(latestNotice)}
            >
              <View style={styles.noticeIconBadge}>
                {/* [한글 주석: 새로운 공지사항이 있을 경우 확성기 아이콘 좌측 상단에 빨간 점 표시] */}
                {hasUnreadNotice && <View style={styles.redBadgeDot} />}
                <Ionicons name="megaphone-sharp" size={10} color="#FFFFFF" />
              </View>
              <Text style={styles.noticeText} numberOfLines={1}>
                {latestNotice.title}
              </Text>
              <Ionicons name="chevron-forward" size={13} color="rgba(255, 255, 255, 0.7)" />
            </TouchableOpacity>
          ) : (
            <View style={styles.glassNoticeBarPlaceholder}>
              <View style={[styles.noticeIconBadge, { backgroundColor: 'rgba(255, 255, 255, 0.25)' }]}>
                <Ionicons name="notifications-outline" size={10} color="#FFFFFF" />
              </View>
              <Text style={styles.noticeTextPlaceholder} numberOfLines={1}>
                등록된 새로운 관리자 공지사항이 없습니다
              </Text>
            </View>
          )}
        </View>

        {/* [한글 주석: 우측 마스코트 강아지 캐릭터] */}
        <Brew mood={mood} size={150} style={styles.mascot} disableMotion={true} />
      </Animated.View>

      {/* [한글 주석: 공지사항 클릭 시 뜨는 상세 내역 팝업 모달] */}
      <Modal
        visible={!!modalNotice}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setModalNotice(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTag}>
                <Ionicons name="notifications" size={12} color="#E28257" style={{ marginRight: 4 }} />
                <Text style={styles.modalTagText}>관리자 공지사항</Text>
              </View>
              <TouchableOpacity onPress={() => setModalNotice(null)} hitSlop={12}>
                <Ionicons name="close" size={20} color="#7A6C63" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalTitle}>{modalNotice?.title}</Text>
            <Text style={styles.modalMeta}>
              발송일: {modalNotice?.date} · {modalNotice?.author || '최고 관리자'}
            </Text>

            <View style={styles.modalDivider} />

            <ScrollView style={styles.modalBodyScroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.modalBodyText}>
                {modalNotice?.body || '공지사항 본문 내용이 없습니다.'}
              </Text>
            </ScrollView>

            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setModalNotice(null)}>
              <Text style={styles.modalCloseBtnText}>확인</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: 'transparent',
    paddingTop: 44, // [한글 주석: 아이폰 상단 노치 영역과 겹치지 않도록 상단 여백을 44px로 시원하게 확보]
    paddingBottom: 14,
    paddingHorizontal: spacing.globalPadding,
  },
  // [한글 주석: 지도 아이콘 버튼 바 - 하단 말풍선 카드와 겹치지 않게 하단 여백을 16px로 넉넉히 띄움]
  topBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  mapBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 32, // [한글 주석: 터치 면적 및 시각적 안정감을 위해 버튼 크기 32px로 정돈]
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 16,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginTop: 4, // [한글 주석: 지도 아이콘 바로 아래 말풍선 카드와 강아지가 바짝 붙지 않고 전체적으로 쾌적하게 내려오도록 margin 부여]
  },
  // [한글 주석: 좌측 수직 컬럼 - 말풍선과 공지 바를 묶어 강아지와 좌우 배치]
  leftColumn: {
    flex: 1,
    marginRight: 8,
    gap: 8, // 말풍선과 공지 바 사이 8px 정교한 간격
  },
  // [한글 주석: 뱃지 없는 컴팩트 둥근 아이보리 말풍선 카드]
  bubble: {
    backgroundColor: colors.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 10,
    position: 'relative',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 3,
  },
  // [한글 주석: 인사말 라인]
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
    color: colors.mochaBrown,
    letterSpacing: -0.4,
  },
  // [한글 주석: 명언 라인]
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
    top: '38%',
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
    top: '38%',
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
  // [한글 주석: 말풍선 하단에 배치되는 가로로 긴 반투명 블러 공지사항 바 UI]
  glassNoticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.18)', // 살짝 블러처리된 듯한 반투명 투명 박스
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)', // 비치는 고급스러운 실버 테두리
    paddingHorizontal: 12,
    paddingVertical: 7.5,
    marginRight: 10, // 말풍선 너비와 나란히 일치되도록 마진 맞춤
  },
  glassNoticeBarPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 7.5,
    marginRight: 10,
  },
  noticeIconBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#E28257', // 포인트 서몬 오렌지 틴트
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
    position: 'relative', // [한글 주석: 좌측 상단 빨간 점 절대 위치 지정을 위한 기준 레이어]
  },
  // [한글 주석: 안 읽은 새 공지사항 존재 시 확성기 아이콘 좌측 상단에 띄우는 미니멀 알림 레드 닷]
  redBadgeDot: {
    position: 'absolute',
    top: -3.5,
    left: -3.5,
    width: 5.5,
    height: 5.5,
    borderRadius: 2.75,
    backgroundColor: '#FF3B30', // 깔끔한 알림 레드 컬러 (하얀 외곽선 제거)
    zIndex: 10,
  },
  noticeText: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '600',
    color: '#FFFBF7', // 오로라 배경 상단에서 선명하게 비치는 오프화이트 컬러
    letterSpacing: -0.2,
  },
  noticeTextPlaceholder: {
    flex: 1,
    fontSize: 11,
    fontWeight: '400',
    color: 'rgba(255, 255, 255, 0.55)',
  },
  mascot: { marginRight: 2 },

  // [한글 주석: 공지사항 상세보기 팝업 모달 스타일 - 웹 환경에서도 스마트폰 폭(maxWidth: 380px) 안으로 쏙 들어가게 정돈]
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380, // [한글 주석: 아이폰 모바일 프레임 크기에 맞춰 모달 최대 너비 380px 제한]
    maxHeight: '75%',
    backgroundColor: '#FAF8F5',
    borderRadius: 24,
    padding: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(226, 130, 87, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  modalTagText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#E28257',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#2C1D17',
    lineHeight: 22,
    marginBottom: 6,
  },
  modalMeta: {
    fontSize: 11,
    color: '#8A7A70',
    marginBottom: 12,
  },
  modalDivider: {
    height: 1,
    backgroundColor: 'rgba(140, 111, 86, 0.12)',
    marginBottom: 14,
  },
  modalBodyScroll: {
    maxHeight: 220,
    marginBottom: 18,
  },
  modalBodyText: {
    fontSize: 13.5,
    color: '#4A3B32',
    lineHeight: 21,
  },
  modalCloseBtn: {
    backgroundColor: colors.mochaBrown,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});

