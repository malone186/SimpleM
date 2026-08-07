// [상단 웰컴 블록 - 미니멀 말풍선 카드 적용 (투데이스 브루 뱃지 제거 및 1줄 피트 정렬)]
import { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { colors, spacing, shadows } from '../../theme';
import { useTopInset } from '../../theme/responsive';
import { type BrewMood } from '../brew/Brew';
import MascotEasterEgg from './MascotEasterEgg';
import MarqueeText from '../MarqueeText';
import { useAuth } from '../../auth/AuthContext';
import { fetchNoticeFeed, type AdminNotice } from '../../lib/api/notice';
import { useTranslation } from '../../i18n/translations';
import { startLoop } from '../../lib/animLoop';

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

// 아직 닫지 않은 가장 최근 공지를 고른다. 닫으면(dismiss) 다음부턴 숨긴다.
// 같은 컴포넌트의 알림함(useNoticeInbox)이 이미 같은 피드를 폴링하고 있으므로
// 여기서 또 서버를 부르지 않고 그 목록을 받아 계산만 한다 — 예전엔 두 훅이 각각
// 20초마다 같은 엔드포인트를 때려 홈에 가만히 있어도 분당 6회 요청이 나갔다.
function useAdminAnnouncement(notices: AdminNotice[]) {
  const [seenSigs, setSeenSigs] = useState<string[]>([]);
  const [sessionDismissed, setSessionDismissed] = useState<string[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(DISMISSED_KEY)
      .then((raw) => setSeenSigs(raw ? JSON.parse(raw) : []))
      .catch(() => {});
  }, []);

  const dismissed = useMemo(() => new Set([...seenSigs, ...sessionDismissed]), [seenSigs, sessionDismissed]);
  const announce = useMemo(() => {
    const fresh = (notices || [])
      .filter((n) => typeof n?.id === 'number' && !dismissed.has(announceSig(n)))
      .sort((a, b) => b.id - a.id);
    return fresh[0] ? { id: fresh[0].id, sig: announceSig(fresh[0]), title: fresh[0].title } : null;
  }, [notices, dismissed]);

  const dismiss = async () => {
    if (!announce) return;
    setSessionDismissed((prev) => [...prev, announce.sig]); // 저장 실패해도 이번 세션에선 숨긴다
    try {
      const raw = await AsyncStorage.getItem(DISMISSED_KEY);
      const seen: string[] = raw ? JSON.parse(raw) : [];
      const next = [...new Set([...seen, announce.sig])];
      await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      setSeenSigs(next);
    } catch {
      // 세션 상태로 이미 숨겨졌다
    }
  };

  return { announce, dismiss };
}

const READ_MAX_KEY = 'simplem:notice:read-max-id';

// 공지 → 화면 연결 규칙. 관리자 공지에는 대상 화면 정보가 없어서
// 제목·본문의 키워드로 갈 곳을 추론한다. 위에 있는 규칙이 우선(구체적인 주제부터).
// 매칭되는 규칙이 없으면 카드는 눌러도 이동하지 않는 일반 카드로 남는다.
const NOTICE_ROUTE_RULES: { keywords: string[]; route: string; label: string }[] = [
  { keywords: ['급여', '알바', '아르바이트', '스케줄', '근무', '인건비', '주휴'], route: 'Operation', label: '스케줄 · 급여' },
  { keywords: ['세금', '세무', '부가세', '신고', '계약서', '서류', '문서', '명세서', '장부'], route: 'Document', label: '서류 자동화' },
  { keywords: ['원가', '마진', '손익'], route: 'Cost', label: '원가 분석' },
  { keywords: ['매출', '판매'], route: 'SalesInput', label: '매출 입력' },
  // 디저트는 메뉴 관리 안의 '디저트' 탭으로 합쳐졌다
  { keywords: ['디저트', '메뉴', '레시피'], route: 'Menu', label: '메뉴 관리' },
  // 발주 화면은 따로 없다 — 발주·입고 이야기는 재고 화면에서 이어진다
  { keywords: ['발주', '주문', '입고', '거래처', '재고', '재료', '유통기한', '실사', '원두'], route: 'Inventory', label: '재고' },
  { keywords: ['챗봇', '어시스턴트', 'ai'], route: 'Chatbot', label: '챗봇' },
  { keywords: ['설정', '환경설정'], route: 'Settings', label: '설정' },
];

/** 공지 내용에서 이동할 화면을 찾는다. 못 찾으면 null.
 *  제목이 공지의 주제이므로 제목에서 먼저 찾고, 없을 때만 본문까지 넓혀 본다.
 *  (예: 제목 "재고 부족" + 본문 "발주 필요" → 재고 화면) */
function resolveNoticeRoute(notice: { title?: string; body?: string }) {
  const match = (text: string) =>
    text.trim() ? NOTICE_ROUTE_RULES.find((rule) => rule.keywords.some((k) => text.includes(k))) : undefined;
  const title = (notice.title ?? '').toLowerCase();
  const body = (notice.body ?? '').toLowerCase();
  return match(title) ?? match(body) ?? null;
}

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
    // 공지는 분 단위로 급한 정보가 아니다 — 20초 폴링은 홈에 가만히 있어도
    // 배터리·Neon 왕복을 계속 태웠다 (이 훅이 헤더 말풍선의 공급원까지 겸한다).
    const timer = setInterval(load, 60_000);
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
  storeName,
  refreshTrigger,
  mood = 'top',
  onOpenMap,
  onOpenPushModal,
  onOpenShop,
  hasUnreadPush = true,
}: {
  storeName: string;
  refreshTrigger?: number;
  mood?: BrewMood;
  onOpenMap?: () => void;
  onOpenPushModal?: () => void;
  onOpenShop?: () => void;
  hasUnreadPush?: boolean;
}) {
  const navigation = useNavigation<any>();
  const greeting = useTimeGreeting();
  // [한글 주석] 상태바(노치·펀치홀·다이나믹 아일랜드) 실측 높이
  const topInset = useTopInset();
  // 알림함 (지도 아이콘 옆 벨) — 지난 공지를 스택형으로 모아 본다.
  // 헤더 말풍선(useAdminAnnouncement)도 이 목록을 그대로 쓴다 (폴링은 여기 한 곳만).
  const { notices, unreadCount, readMaxId, markAllRead } = useNoticeInbox(refreshTrigger);
  const { announce, dismiss } = useAdminAnnouncement(notices);
  const [inboxOpen, setInboxOpen] = useState(false);
  // 모달을 열 때의 읽음 기준선을 스냅샷 — 그 이후 id는 목록에서 'NEW'로 표시
  const [newBaseline, setNewBaseline] = useState(0);
  // 한 건만 골라 보는 상세 화면 — 알림이 여러 개 와도 하나씩 집중해서 읽을 수 있게 한다
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = notices.find((n) => n.id === selectedId) ?? null;
  // 상세로 연 공지에 이어지는 화면이 있으면 하단에 이동 버튼을 띄운다
  const selectedTarget = selected ? resolveNoticeRoute(selected) : null;

  const openInbox = () => {
    setNewBaseline(readMaxId);
    setSelectedId(null); // 항상 목록부터 — 지난번 상세가 남아 있지 않게
    setInboxOpen(true);
    markAllRead();
  };

  const closeInbox = () => {
    setInboxOpen(false);
    setSelectedId(null);
  };

  // 공지 상세의 이동 버튼 → 알림함을 닫고 관련 화면으로 이동.
  // 모달이 닫히는 프레임과 화면 전환이 겹치면 전환이 씹히므로 다음 프레임에 이동한다.
  const goToNoticeTarget = (route: string) => {
    closeInbox();
    requestAnimationFrame(() => navigation.navigate(route));
  };

  // 말풍선 공지를 탭하면: 말풍선에서 치우고(dismiss) 그 공지 하나의 상세로 바로 들어간다
  const openAnnounce = () => {
    const id = announce?.id ?? null;
    openInbox();
    setSelectedId(id);
    dismiss();
  };

  // [한글 주석: 다국어 번역 훅 호출 — 사장님 칭호 및 인사말 영어/한국어 처리]
  const { t, language } = useTranslation();

  // [한글 주석: 강아지와 말풍선을 묶어 위아래로 둥둥 띄우기 위한 애니메이션 상태변수 정의]
  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Animated.loop을 쓰지 않는다 — useNativeDriver:true면 웹에서 한 번 떴다 내려온 뒤
    // 영영 멈춘다(lib/animLoop.ts에 이유). 브루가 안 움직인다는 신고의 절반이 이거였다.
    return startLoop(() =>
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
      ]),
    ).stop;
  }, [floatAnim]);

  // [한글 주석: 위아래로 최대 7픽셀(px) 만큼 둥둥거리도록 애니메이션 수치 변환]
  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -7],
  });

  return (
    // [한글 주석] 예전 paddingTop: 38 고정값 → 기기 실측 노치 높이로 교체.
    // 다이나믹 아일랜드(59pt)에서는 아이콘 줄이 가렸고, 노치 없는 기기에서는 여백이 남았다.
    <View style={[styles.header, { paddingTop: topInset }]}>
      <View style={styles.topBar}>
        {/* [한글 주석: 왼쪽 기존 아이콘 3개 그룹 (지도, 알림, 말풍선)] */}
        <View style={styles.leftIconGroup}>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenMap} hitSlop={10} activeOpacity={0.85}>
            <Ionicons name="map-outline" size={19} color={colors.creamSand} />
          </TouchableOpacity>

          {/* 기존 공지 알림함 */}
          <TouchableOpacity style={styles.iconBtn} onPress={openInbox} hitSlop={10} activeOpacity={0.85}>
            <Ionicons name="notifications-outline" size={19} color={colors.creamSand} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* [한글 주석: 세련된 3번째 스마트 푸시 알림 버튼 💬] */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onOpenPushModal}
            hitSlop={10}
            activeOpacity={0.85}
          >
            <Ionicons name="chatbubbles-outline" size={19} color={colors.creamSand} />
            {hasUnreadPush && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>N</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* [한글 주석: 사장님 요청 — 상점 버튼 🛍️ (상단 맨 우측 독립 배치)] */}
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={onOpenShop || (() => navigation.navigate('BrewRoom'))}
          hitSlop={10}
          activeOpacity={0.85}
        >
          {/* 게임 허브(브루의 카페) 진입 — 상점이 아니라 게임 룸이므로 컨트롤러 아이콘 */}
          <Ionicons name="game-controller-outline" size={19} color={colors.creamSand} />
        </TouchableOpacity>
      </View>

      <Animated.View style={[styles.mainRow, { transform: [{ translateY }] }]}>
        {/* [한글 주석: 말풍선 카드 - 글씨가 커져도 마퀴(Marquee)가 한 줄로 예쁘게 흐르도록 maxFontSizeMultiplier=1.3 부여] */}
        <View style={styles.bubble}>
          {/* 1행 인사말 — 상호명이 길거나 글자 크기가 커져도 8글자까지 1줄로 단정하게 피트 */}
          <Text style={[styles.greetingLine, { marginBottom: 1 }]} maxFontSizeMultiplier={1.2}>
            {language === 'en' ? 'Hello,' : '안녕하세요,'}
          </Text>
          <MarqueeText style={{ marginBottom: 5 }}>
            <Text style={styles.greetingLine} maxFontSizeMultiplier={1.2}>
              {language === 'en' ? (
                <>
                  <Text style={styles.nameHighlight} maxFontSizeMultiplier={1.2}>{storeName}</Text> Manager!
                </>
              ) : (
                <>
                  <Text style={styles.nameHighlight} maxFontSizeMultiplier={1.2}>{storeName}</Text> 사장님!
                </>
              )}
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
                  <Text style={styles.announceLine} maxFontSizeMultiplier={1.2}>{announce.title}</Text>
                </MarqueeText>
              </TouchableOpacity>
              {/* X → 알림함을 열지 않고 말풍선에서 닫기만 */}
              <TouchableOpacity onPress={dismiss} hitSlop={8} style={{ marginLeft: 4 }}>
                <Ionicons name="close" size={12} color="#B4A89E" />
              </TouchableOpacity>
            </View>
          ) : (
            <MarqueeText>
              <Text style={styles.quoteLine} maxFontSizeMultiplier={1.2} numberOfLines={1}>
                {language === 'en' ? t('welcomeGreeting') : greeting}
              </Text>
            </MarqueeText>
          )}

          {/* [한글 주석: 말풍선 우측 삼각형 꼬리] */}
          <View style={styles.bubbleTailBorder} />
          <View style={styles.bubbleTail} />
        </View>

        {/* [한글 주석: 우측 마스코트 강아지 캐릭터] */}
        {/* 강아지 탭 이스터에그: 한 번 = 쓰다듬기+한마디/간식 랜덤, 빠른 두 번 = 시크릿 */}
        {/* motion: 여기 브루는 원래 눈만 깜빡이고 몸은 멈춰 있었다(도입 때부터 disableMotion 고정).
            홈에 늘 떠 있는 캐릭터가 굳어 있으니 그림처럼 보여서 잔동작을 켠다.
            autonomous: 가끔 끄덕·갸웃·두리번을 스스로 얹는다. 전신 모션(점프·댄스)은 여기선
            안 나온다 — 그건 무대가 넓은 게임 룸 몫이다(interactiveMotions가 꺼져 있어 자동으로 제외).
            Animated 기반이라 8/6에 잡았던 SalesCard식 '초당 60회 setState' 부류가 아니다. */}
        <MascotEasterEgg mood={mood} size={190} style={styles.mascot} motion autonomous />
      </Animated.View>

      {/* 알림함 모달 — 목록(스택 카드) ↔ 한 건 상세 두 단계로 동작한다 */}
      <Modal visible={inboxOpen} transparent animationType="fade" onRequestClose={selected ? () => setSelectedId(null) : closeInbox}>
        <Pressable style={styles.inboxBackdrop} onPress={closeInbox}>
          <Pressable style={styles.inboxPanel} onPress={(e) => e.stopPropagation()}>
            <View style={styles.inboxHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                {selected ? (
                  // 상세에서는 벨 대신 뒤로가기 — 누르면 목록으로 돌아간다
                  <TouchableOpacity onPress={() => setSelectedId(null)} hitSlop={10} style={styles.backBtn}>
                    <Ionicons name="chevron-back" size={18} color={colors.espressoBrown} />
                  </TouchableOpacity>
                ) : (
                  <Ionicons name="notifications" size={16} color={colors.espressoBrown} />
                )}
                <Text style={styles.inboxTitle} numberOfLines={1}>
                  {selected ? '알림 상세' : notices.length > 0 ? `알림 ${notices.length}건` : '알림'}
                </Text>
              </View>
              <TouchableOpacity onPress={closeInbox} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.mochaBrown} />
              </TouchableOpacity>
            </View>

            {selected ? (
              /* ── 상세: 고른 알림 한 건만 전문으로 ── */
              <View>
                <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                  <View style={styles.detailCard}>
                    <View style={styles.detailTop}>
                      <Ionicons name="megaphone" size={15} color={colors.pointOrange} style={{ marginRight: 6, marginTop: 2 }} />
                      <Text style={styles.detailTitle}>{selected.title}</Text>
                    </View>
                    <Text style={styles.detailMeta}>{selected.author} · {selected.date}</Text>
                    <View style={styles.detailDivider} />
                    <Text style={styles.detailBody}>{selected.body || '내용이 없는 공지예요.'}</Text>
                  </View>
                </ScrollView>
                {/* 공지 주제와 이어지는 화면이 있으면 여기서 바로 이동 */}
                {selectedTarget && (
                  <TouchableOpacity
                    style={styles.detailGoBtn}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={`${selectedTarget.label} 화면으로 이동`}
                    onPress={() => goToNoticeTarget(selectedTarget.route)}
                  >
                    <Text style={styles.detailGoText}>{selectedTarget.label} 화면으로 이동</Text>
                    <Ionicons name="chevron-forward" size={13} color={colors.white} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.detailBackBtn} onPress={() => setSelectedId(null)} activeOpacity={0.85}>
                  <Ionicons name="list-outline" size={14} color={colors.espressoBrown} />
                  <Text style={styles.detailBackText}>알림 목록으로</Text>
                </TouchableOpacity>
              </View>
            ) : notices.length === 0 ? (
              <View style={styles.inboxEmpty}>
                <Ionicons name="mail-open-outline" size={28} color="#C7BBB0" />
                <Text style={styles.inboxEmptyText}>받은 공지가 없어요.</Text>
              </View>
            ) : (
              /* 목록 — 관리자가 보낸 공지를 최신순으로. 누르면 그 한 건의 상세로 들어간다 */
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                {notices.map((n) => {
                  // 이어지는 화면이 있으면 칩으로 미리 알려주고, 실제 이동은 상세 안의 버튼에서 한다
                  const target = resolveNoticeRoute(n);
                  return (
                    <TouchableOpacity
                      key={n.id}
                      style={[styles.noticeCard, target && styles.noticeCardLinked]}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={`${n.title} 자세히 보기`}
                      onPress={() => setSelectedId(n.id)}
                    >
                      <View style={styles.noticeCardTop}>
                        <Ionicons name="megaphone" size={13} color={colors.pointOrange} style={{ marginRight: 5, marginTop: 1 }} />
                        <Text style={styles.noticeCardTitle} numberOfLines={1}>{n.title}</Text>
                        {n.id > newBaseline && (
                          <View style={styles.newDot}>
                            <Text style={styles.newDotText}>N</Text>
                          </View>
                        )}
                        <Ionicons name="chevron-forward" size={14} color="#C0B3A8" style={{ marginLeft: 4, marginTop: 2 }} />
                      </View>
                      {!!n.body && <Text style={styles.noticeCardBody} numberOfLines={2}>{n.body}</Text>}
                      <View style={styles.noticeCardFoot}>
                        <Text style={styles.noticeCardMeta}>{n.author} · {n.date}</Text>
                        {target && (
                          <View style={styles.noticeCardCta}>
                            <Text style={styles.noticeCardCtaText}>{target.label}</Text>
                            <Ionicons name="chevron-forward" size={11} color={colors.pointOrange} />
                          </View>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })}
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
    paddingBottom: 12,
    paddingHorizontal: spacing.globalPadding,
  },
  // marginTop으로 아이콘 줄을 아주 조금 아래로 내리고, 양쪽 끝 분리(space-between) 적용
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    marginBottom: 8,
  },
  leftIconGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
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
  // [한글 주석: 인사말 라인 - 8글자 상호명도 1줄 피트되도록 12px로 살짝 조율]
  greetingLine: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2C1D17',
    marginBottom: 2,
  },
  // [한글 주석: 사장님 상호명 하이라이트 - 8글자("스타벅스스타벅스")까지 1줄에 피트되도록 13.5px 및 자간 -0.6px로 조율]
  nameHighlight: {
    fontSize: 13.5,
    fontWeight: '900',
    color: colors.mochaBrown,
    letterSpacing: -0.6,
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

  // [한글 주석: 알림함 모달 배경 - 좌우 여백을 넓혀 모달 폭이 화면에 꽉 차지 않도록 조절]
  inboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  // [한글 주석: 알림 모달 패널 - 최대 폭을 320px로 컴팩트하게 축소하여 아기자기한 팝업 비율 형성]
  inboxPanel: {
    backgroundColor: colors.creamSand,
    borderRadius: 24,
    padding: 20,
    maxWidth: 320,
    width: '84%',
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
    marginBottom: 8,
  },
  inboxTitle: { flexShrink: 1, fontSize: 15, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.3 },
  // 상세 화면 헤더의 뒤로가기 버튼 — 벨 아이콘 자리를 그대로 이어받는다
  backBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(140,111,86,0.10)',
    marginLeft: -2,
  },
  // [한글 주석: 빈 알림 안내 영역 - 패널 크기 축소에 맞춰 상하 여백을 24px로 슬림하게 맞춤]
  inboxEmpty: { alignItems: 'center', gap: 6, paddingVertical: 24 },
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
  // 관련 화면으로 이동할 수 있는 카드 — 왼쪽 포인트 띠로 '누를 수 있음'을 알린다
  noticeCardLinked: {
    borderLeftWidth: 3,
    borderLeftColor: colors.pointOrange,
    paddingLeft: 11,
  },
  noticeCardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  noticeCardTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.espressoBrown, lineHeight: 18 },
  noticeCardBody: { fontSize: 11.5, color: '#6B5D53', lineHeight: 16, marginTop: 5 },
  noticeCardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 7,
  },
  noticeCardMeta: { flex: 1, fontSize: 10, color: '#A99C90', fontWeight: '600' },
  // 이동 힌트 — "재고 ›" 형태로 어디로 가는지 미리 알려 준다
  noticeCardCta: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  noticeCardCtaText: { fontSize: 10.5, fontWeight: '800', color: colors.pointOrange, letterSpacing: -0.2 },
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

  // 한 건만 펼쳐 보는 상세 카드 — 목록 카드보다 여백을 넉넉히 줘 읽기에 집중되게
  detailCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.14)',
    paddingHorizontal: 15,
    paddingVertical: 14,
    marginTop: 4,
  },
  detailTop: { flexDirection: 'row', alignItems: 'flex-start' },
  detailTitle: { flex: 1, fontSize: 14.5, fontWeight: '900', color: colors.espressoBrown, lineHeight: 20, letterSpacing: -0.3 },
  detailMeta: { fontSize: 10.5, color: '#A99C90', fontWeight: '600', marginTop: 6 },
  detailDivider: { height: 1, backgroundColor: 'rgba(140,111,86,0.12)', marginVertical: 11 },
  detailBody: { fontSize: 12.5, color: '#5C4F46', lineHeight: 19, letterSpacing: -0.2 },
  // 공지 주제와 이어지는 화면으로 보내는 주 버튼 — 상세에서 가장 눈에 띄어야 한다
  detailGoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 10,
    paddingVertical: 11,
    borderRadius: 13,
    backgroundColor: colors.pointOrange,
  },
  detailGoText: { fontSize: 12.5, fontWeight: '800', color: colors.white, letterSpacing: -0.2 },
  // 상세 하단 '목록으로' 버튼 — 뒤로가기를 못 찾아도 되돌아갈 길을 하나 더
  detailBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 13,
    backgroundColor: 'rgba(140,111,86,0.10)',
  },
  detailBackText: { fontSize: 12, fontWeight: '800', color: colors.espressoBrown, letterSpacing: -0.2 },
  inAppBackdrop: {
    position: 'absolute',
    top: 0,
    left: -16,
    right: -16,
    height: 700,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    zIndex: 99999,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  largePushModalPanel: {
    width: '96%',
    maxWidth: 380,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 14,
    maxHeight: 520,
    borderWidth: 1.5,
    borderColor: '#EFEAE2',
    ...shadows.medium,
  },
});
