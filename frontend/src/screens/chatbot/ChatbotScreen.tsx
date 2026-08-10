// 챗봇 (프론트 B) — PRD §5.3 통합 창구
// 리포트 조회 · 원두 비교 · 문서 생성 · 발주 초안 등 전용 화면 없는 모든 기능
// 대화 세션 관리: 새 채팅 열기 + 과거 채팅 복원/삭제
// (로그인 시 서버 DB에 계정별 보관 — 비로그인·서버 장애 시 기기 로컬 폴백)
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, type RouteProp } from '@react-navigation/native';

import type { RootTabParamList } from '../../navigation/RootNavigator';

import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import Brew from '../../components/brew/Brew';
import DocumentCard from '../../components/chatbot/DocumentCard';
import { FadeInUp, PressableScale } from '../../components/motion';
import {
  ChatQuotaExhaustedError,
  grantChatQuotaFromAd,
  isChatQuotaExhausted,
  sendChatMessage,
  waitForAdQuota,
  type ChatHistoryItem,
} from '../../lib/api/chatbot';
import { isRewardedReady, preloadRewarded, showRewarded } from '../../lib/ads';
import { confirmDialog, toast } from '../../components/toast';
import {
  clearSessions,
  deleteSession,
  loadSessions,
  makeTitle,
  saveSession,
  timeLabel,
  type ChatMsg as Msg,
  type ChatSession,
} from '../../lib/chatSessions';
import { colors, spacing, typography } from '../../theme';
import { fs, s, useBottomInset, useResponsive, useTopInset } from '../../theme/responsive';
import RoomBackdrop, { ROOM_TEXT_SHADOW, useSheetTop } from '../../components/brew/RoomBackdrop';
import { getRoomTint } from '../../components/brew/roomBackgrounds';
import { useEquipped } from '../../rewards/EquippedContext';

// [한글 주석] 상태바 여백은 useTopInset() 훅이 기기 실측값으로 계산한다 (고정값은 기기마다 어긋났다).

const SUGGESTIONS = [
  '이번 주 경영 리포트 만들어줘',
  '이번 달 매입·매출 장부 만들어줘',
  '갱신 만료 임박한 서류 있어?',
  '에티오피아 원두 가격 비교해줘',
];

const GREETING: Msg = {
  id: 'g0',
  role: 'bot',
  text: '안녕하세요 사장님! 저는 브루예요 ☕\n경영 리포트·서류 생성·영수증 문서·매출 예측·원두 비교·세금까지 뭐든 물어보세요.',
};

// 두뇌가 간혹 붙이는 마크다운 기호를 걷어낸다 — 말풍선은 일반 텍스트라 **가 그대로 보인다.
// (프롬프트로도 금지하지만, 과거 저장된 채팅과 모델의 실수까지 커버하는 안전망)
function plainText(t: string): string {
  return t
    .replace(/\*\*(.+?)\*\*/g, '$1') // **굵게** → 굵게
    .replace(/^[ \t]*[*•-]\s+/gm, '· ') // "* 항목" → "· 항목"
    .replace(/^#{1,4}\s+/gm, ''); // "## 제목" → "제목"
}

// 웹은 Alert.alert 버튼이 동작하지 않으므로 window.confirm으로 분기한다
function confirmAsk(title: string, message: string, okLabel: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(message)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: '취소', style: 'cancel' },
    { text: okLabel, style: 'destructive', onPress: onOk },
  ]);
}

export default function ChatbotScreen() {
  // 착용한 카페 배경의 분위기 색으로 상단 오로라를 물들인다 (홈과 통일 — roomBackgrounds.ts)
  const { roomBgId } = useEquipped();
  const tint = getRoomTint(roomBgId);
  // 착용 배경 사진이 헤더를 꽉 채우도록, 크림 시트가 시작하는 y를 실측해 넘긴다 (네 탭 공통)
  const { sheetTop, onSheetLayout } = useSheetTop();
  // [한글 주석: 전역 다국어 번역 훅 연동]
  const { t, language } = useTranslation();
  const { token, user } = useAuth();
  // [한글 주석] 노치 실측 여백 + 하단 제스처 바 + 화면 급수 (좁은 화면에서 헤더를 접는다)
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { isCompact, isXS, isShortViewport, isWide } = useResponsive();
  const route = useRoute<RouteProp<RootTabParamList, 'Chatbot'>>();
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 과거 채팅 패널
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  // 현재 세션 식별자 — 메시지가 쌓일 때마다 이 id로 로컬에 저장된다
  const sessionIdRef = useRef(`s${Date.now()}`);
  const createdAtRef = useRef(Date.now());
  // send가 비동기라 최신 메시지 배열을 ref로도 들고 있는다
  const messagesRef = useRef<Msg[]>([GREETING]);

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

  // 화면 상태 갱신 + 사용자 발화가 있는 세션만 보관소에 저장 (로그인 시 서버, 아니면 로컬)
  const commit = (next: Msg[]) => {
    messagesRef.current = next;
    setMessages(next);
    const firstUser = next.find((m) => m.role === 'user');
    if (!firstUser) return;
    saveSession(
      {
        id: sessionIdRef.current,
        title: makeTitle(firstUser.text),
        messages: next,
        createdAt: createdAtRef.current,
        updatedAt: Date.now(),
      },
      token,
    ).catch(() => {});
  };

  // 브루의 말풍선을 한 줄 붙인다 (안내·오류 문구 공용)
  const botSay = (text: string) => {
    commit([...messagesRef.current, { id: `e${Date.now()}`, role: 'bot', text }]);
    scrollDown();
  };

  // 실제 호출 + 답변 말풍선. 광고 시청 후 재시도할 때도 같은 경로를 탄다.
  const askBrew = async (q: string, history: ChatHistoryItem[]) => {
    const res = await sendChatMessage(q, history, token);
    commit([
      ...messagesRef.current,
      { id: `b${Date.now()}`, role: 'bot', text: res.response, docs: res.documents },
    ]);
  };

  // 무료 턴 소진 → 보상형 광고로 충전을 제안한다.
  // AdMob 정책상 보상형은 사용자가 명시적으로 동의한 뒤에만 띄울 수 있어서, 기존 확인
  // 다이얼로그를 그대로 쓴다 (새 UI를 만들지 않는다).
  const offerAdForMoreTurns = (err: ChatQuotaExhaustedError, q: string, history: ChatHistoryItem[]) => {
    // 하루 광고 상한에 걸렸거나(can_watch_ad) 띄울 광고가 없으면 권하지 않는다 —
    // "광고 보기"를 눌렀는데 아무 일도 안 일어나는 게 최악이다.
    const adReady = isRewardedReady();
    if (__DEV__) {
      console.log('[quota] 할당량 소진 — can_watch_ad:', err.quota?.can_watch_ad, '| 광고 준비됨:', adReady);
    }
    if (err.quota?.can_watch_ad === false || !adReady) {
      botSay('오늘 무료 대화 횟수를 다 썼어요. 내일 다시 이야기해요.');
      return;
    }

    const bonus = err.quota?.turns_per_ad ?? 5;
    confirmDialog(`오늘 무료 대화를 다 썼어요. 광고를 보면 ${bonus}번 더 이야기할 수 있어요.`, {
      confirmLabel: '광고 보기',
      onConfirm: async () => {
        setSending(true);
        try {
          const earned = await showRewarded();
          if (!earned) {
            // 중간에 닫은 경우. 정책상 닫을 수 있어야 하고, 그때는 보상을 주지 않는다.
            botSay('광고를 끝까지 보지 않아서 충전되지 않았어요.');
            return;
          }
          // 서버가 SSV 강제 모드면 이 호출로 바로 충전되지 않는다 — 구글 검증 콜백이
          // 도착할 때까지 몇 초 기다린 뒤 재질문한다 (안 기다리면 또 소진 오류가 난다).
          const quota = await waitForAdQuota(await grantChatQuotaFromAd(token), token);
          if (quota.remaining <= 0) {
            botSay('충전 확인이 조금 늦어지고 있어요. 잠시 후 다시 물어봐 주세요.');
            return;
          }
          await askBrew(q, history);
        } catch {
          botSay('앗, 충전에 실패했어요. 잠시 후 다시 시도해 주세요.');
        } finally {
          setSending(false);
          scrollDown();
        }
      },
    });
  };

  // 백엔드 멀티에이전트 두뇌(/chatbot/chat) 호출 — 이전 대화도 함께 보내 맥락을 유지한다
  const send = async (text: string) => {
    const q = text.trim();
    if (!q || sending) return;
    const userMsg: Msg = { id: `u${Date.now()}`, role: 'user', text: q };
    const afterUser = [...messagesRef.current, userMsg];
    commit(afterUser);
    setInput('');
    setSending(true);
    scrollDown();
    // 인사말(g0)을 제외한 지금까지의 대화를 두뇌가 이해하는 형식으로 변환
    const history = afterUser
      .filter((m) => m.id !== 'g0' && m.id !== userMsg.id)
      .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('model' as const), text: m.text }));
    try {
      await askBrew(q, history);
    } catch (e) {
      if (isChatQuotaExhausted(e)) {
        // 광고 흐름은 사용자 응답을 기다리므로 finally에서 sending을 풀고 별도로 진행한다
        setSending(false);
        offerAdForMoreTurns(e, q, history);
        return;
      }
      botSay('앗, 답변을 가져오지 못했어요. 서버가 켜져 있는지 확인하고 잠시 후 다시 시도해 주세요.');
    } finally {
      setSending(false);
      scrollDown();
    }
  };

  // [한글 주석: 새 채팅 클릭 시 이전 대화 세션을 보관하고 화면 대화를 즉시 초기화합니다]
  const startNewChat = () => {
    if (sending) return;
    sessionIdRef.current = `s${Date.now()}`;
    createdAtRef.current = Date.now();
    messagesRef.current = [GREETING];
    setMessages([GREETING]);
    setInput('');
    toast('새 채팅 시작', '브루와 새로운 대화를 시작합니다.');
  };

  const hasConversation = messages.some((m) => m.role === 'user');

  // 과거 채팅 패널 열기 — 열 때마다 보관소에서 최신 목록을 읽는다
  const openHistory = async () => {
    setSessions(await loadSessions(token));
    setHistoryOpen(true);
  };

  // 과거 채팅 복원 — 그 시점의 대화·문서 카드가 그대로 살아난다
  const openSession = (s: ChatSession) => {
    if (sending) return;
    sessionIdRef.current = s.id;
    createdAtRef.current = s.createdAt;
    messagesRef.current = s.messages;
    setMessages(s.messages);
    setHistoryOpen(false);
    scrollDown();
  };

  const removeSession = (s: ChatSession) => {
    confirmAsk('채팅 삭제', `'${s.title}' 채팅을 삭제할까요?`, '삭제', async () => {
      await deleteSession(s.id, token);
      setSessions(await loadSessions(token));
      // 지금 보고 있던 채팅을 지웠다면 새 채팅으로 초기화
      if (s.id === sessionIdRef.current) startNewChat();
    });
  };

  const removeAllSessions = () => {
    confirmAsk('전체 삭제', '과거 채팅을 모두 삭제할까요? 되돌릴 수 없어요.', '전체 삭제', async () => {
      await clearSessions(token);
      setSessions([]);
      startNewChat();
    });
  };

  // 무료 턴이 소진되는 순간 광고가 준비돼 있어야 한다 (로드에 1~3초).
  // 실패하면 광고 없이 "내일 다시" 안내로 떨어진다.
  //
  // 로그인 이메일을 함께 넘기는 이유: 서버 사이드 검증(SSV) 식별자는 광고를 요청할 때만
  // 심을 수 있다. 이 값이 있어야 구글이 "이 계정이 광고를 끝까지 봤다"를 서명해 우리
  // 서버로 직접 알려주고, 서버가 앱 보고 대신 그 통보를 근거로 충전할 수 있다.
  useEffect(() => {
    preloadRewarded(user?.email);
  }, [user?.email]);

  // 경영 리포트 등에서 버튼으로 넘어오면 그 질문을 자동으로 전송한다 (입력만 채우지 않고 바로 물어봄).
  // ts가 함께 바뀌므로 같은 질문 버튼을 다시 눌러도 매번 새로 전송된다.
  useEffect(() => {
    const prefill = route.params?.prefill;
    if (prefill) send(prefill);
    // send는 매 렌더 새로 생성되므로 의존성에서 제외 — 넘어온 질문(prefill/ts)이 바뀔 때만 전송한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.prefill, route.params?.ts]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
      // [한글 주석: 안드로이드/iOS 키보드 호출 시 입력창 아래 들뜸 여백 제거 — 키보드 위 착 밀착]
      keyboardVerticalOffset={Platform.select({
        ios: 56 + bottomInset,
        android: 0,
        default: 0,
      })}
    >
      {/* [딥브라운 오로라 배경] 재고/관리 탭과 동일 — 상단 딥브라운에서 하단 크림으로 */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="chatAurora" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor={tint.top[0]} />
              <Stop offset="35%" stopColor={tint.top[1]} />
              <Stop offset="70%" stopColor="#6E5544" stopOpacity="0.35" />
              <Stop offset="100%" stopColor={colors.creamSand} />
            </LinearGradient>
            <Filter id="chatGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="70" />
            </Filter>
          </Defs>
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#chatAurora)" />
          <Circle cx="85%" cy="12%" r="140" fill={tint.glow[0]} filter="url(#chatGlow)" opacity="0.25" />
          <Circle cx="15%" cy="22%" r="130" fill={tint.glow[1]} filter="url(#chatGlow)" opacity="0.2" />
          <Circle cx="60%" cy="4%" r="120" fill={tint.glow[2]} filter="url(#chatGlow)" opacity="0.16" />
        </Svg>
      </View>

      {/* 착용한 카페 배경 '사진' — 브루룸과 같은 그림을 그대로 깐다.
          미착용이면 null이라 위 오로라가 그대로 보인다 (RoomBackdrop.tsx) */}
      <RoomBackdrop roomBgId={roomBgId} sheetTop={sheetTop} fadeAt={0.32} />

      {/* 브라운 헤더 — 관리 탭과 동일 (제목/부제 + 마스코트만). 새 채팅/기록은 헤더 밖 시트 상단으로 이동 */}
      <View style={[styles.brownHeader, { paddingTop: topInset }]}>
        <View style={styles.brownHeaderLeft}>
          <FadeInUp>
            <Text style={styles.brownHeaderTitle}>{language === 'en' ? 'Brew AI Assistant' : '브루 챗봇'}</Text>
            <Text style={styles.brownHeaderSub}>{language === 'en' ? 'Your cafe AI assistant' : '카페 운영을 돕는 AI 비서'}</Text>
          </FadeInUp>
        </View>
        <View style={styles.brownHeaderRight}>
          {/* greet 일러스트는 clipboard(317)보다 프레임 여백이 커(380) 작아 보인다 —
              캐릭터 크기를 관리 탭과 맞추려고 프레임 비율(380/317)만큼 키운다 */}
          {/* [한글 주석] 좁은/낮은 화면에서는 마스코트를 줄여 대화 영역을 확보한다 */}
          <Brew mood="happy" size={isXS ? 80 : isCompact ? 108 : s(144)} />
        </View>
      </View>

      {/* onLayout은 배경 사진이 어디까지 보일지 정하는 기준선이다 (RoomBackdrop) */}
      <View style={styles.brownSheet} onLayout={onSheetLayout}>
      {/* 새 채팅/기록 — 브라운 헤더 아래 별도 섹션 (크림 시트 상단) */}
      <View style={styles.chatActionsRow}>
        <PressableScale style={styles.sheetChip} onPress={startNewChat} disabled={sending}>
          <Ionicons name="add" size={16} color={colors.creamSand} />
          <Text style={styles.sheetChipText}>{language === 'en' ? 'New' : '새 채팅'}</Text>
        </PressableScale>
        <PressableScale style={styles.sheetChip} onPress={openHistory}>
          <Ionicons name="time-outline" size={14} color={colors.creamSand} />
          <Text style={styles.sheetChipText}>{language === 'en' ? 'History' : '기록'}</Text>
        </PressableScale>
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        // [한글 주석] 폴드 펼침(≈673dp)에서는 말풍선이 지나치게 길어져 읽기 힘들다 → 폭 제한 + 가운데 정렬
        contentContainerStyle={[
          styles.listContent,
          isWide && { maxWidth: 560, width: '100%', alignSelf: 'center' },
        ]}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={scrollDown}
      >
        {/* 말풍선 목록은 messages·언어가 바뀔 때만 다시 만든다 — 입력창 키 한 번마다
            화면 전체가 재렌더되면서 모든 봇 말풍선의 plainText(정규식 3회)가 다시 돌아
            대화가 길어질수록 타이핑이 무거워졌다 */}
        {useMemo(() => messages.map((m) => (
          <View key={m.id} style={styles.msgBlock}>
            <FadeInUp
              distance={10}
              style={[styles.bubbleRow, m.role === 'user' ? styles.rowRight : styles.rowLeft]}
            >
              <View style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.botBubble]}>
                <Text style={[styles.bubbleText, m.role === 'user' && { color: colors.white }]}>
                  {m.role === 'bot'
                    ? (m.id === 'g0'
                        ? (language === 'en'
                            ? "Hello Manager! I'm Brew. ☕\nAsk me anything about executive reports, receipts, revenue forecasts, bean comparison, or taxes."
                            : plainText(m.text))
                        : plainText(m.text))
                    : m.text}
                </Text>
              </View>
            </FadeInUp>
            {/* 챗봇이 만든 문서 초안은 화면 이동 없이 여기서 바로 확인 */}
            {m.docs?.map((d) => (
              <FadeInUp key={d.id} distance={10}>
                <DocumentCard doc={d} />
              </FadeInUp>
            ))}
          </View>
        )), [messages, language])}

        {/* 두뇌가 도구를 호출하며 답을 준비하는 동안 표시 */}
        {sending && (
          <View style={[styles.bubbleRow, styles.rowLeft]}>
            <View style={[styles.bubble, styles.botBubble]}>
              <Text style={styles.bubbleText}>{language === 'en' ? 'Thinking... ☕' : '생각 중이에요… ☕'}</Text>
            </View>
          </View>
        )}

        {messages.length <= 1 && (
          <View style={styles.suggestWrap}>
            {(language === 'en'
              ? [
                  'Generate this week executive report',
                  'Create this month income ledger',
                  'Any documents near expiration?',
                  'Compare Ethiopia bean prices',
                ]
              : SUGGESTIONS
            ).map((s, i) => (
              <FadeInUp key={s} delay={200 + i * 70}>
                <PressableScale style={styles.chip} onPress={() => send(s)}>
                  <Text style={styles.chipText}>{s}</Text>
                </PressableScale>
              </FadeInUp>
            ))}
          </View>
        )}
      </ScrollView>

      {/* [한글 주석] 하단 탭 바 위에 바로 밀착되도록 중복 bottomInset 여백 제거 및 시안 맞춤 입력바 */}
      <View style={styles.inputBar}>
        <View style={styles.inputWrapper}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={sending ? (language === 'en' ? 'Waiting for response...' : '답변을 기다리는 중…') : (language === 'en' ? 'Ask Brew anything about your cafe...' : '브루에게 물어보세요')}
            placeholderTextColor={colors.mochaBrown}
            value={input}
            onChangeText={setInput}
            onFocus={scrollDown}
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
            editable={!sending}
          />
        </View>
        <PressableScale style={styles.sendBtn} onPress={() => send(input)} disabled={sending} to={0.88}>
          <Ionicons name="arrow-up" size={18} color={colors.white} />
        </PressableScale>
      </View>
      </View>

      {/* 과거 채팅 목록 — 탭하면 복원, 휴지통으로 개별 삭제 */}
      <Modal
        visible={historyOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryOpen(false)}
      >
        {/* FormSheet 패턴 — 웹에서도 폰 프레임(maxWidth 420) 안에 시트를 가둔다 */}
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalDim} onPress={() => setHistoryOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{language === 'en' ? 'Chat History' : '채팅 기록'}</Text>
              {sessions.length > 0 && (
                <PressableScale style={styles.clearBtn} onPress={removeAllSessions}>
                  <Text style={styles.clearBtnText}>{language === 'en' ? 'Clear All' : '전체 삭제'}</Text>
                </PressableScale>
              )}
              <PressableScale style={styles.closeBtn} onPress={() => setHistoryOpen(false)}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </PressableScale>
            </View>

            <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
              {sessions.length === 0 && (
                <Text style={styles.emptyText}>
                  아직 저장된 채팅이 없어요.{'\n'}브루와 대화하면 자동으로 기록됩니다.
                </Text>
              )}
              {sessions.map((s) => {
                const isCurrent = s.id === sessionIdRef.current;
                const turns = s.messages.filter((m) => m.role === 'user').length;
                return (
                  <View key={s.id} style={[styles.sessionRow, isCurrent && styles.sessionRowActive]}>
                    <Pressable style={styles.sessionMain} onPress={() => openSession(s)}>
                      <Text style={styles.sessionTitle} numberOfLines={1}>
                        {s.title}
                      </Text>
                      <Text style={styles.sessionMeta}>
                        {timeLabel(s.updatedAt)} · 질문 {turns}개{isCurrent ? ' · 지금 보는 중' : ''}
                      </Text>
                    </Pressable>
                    <PressableScale style={styles.trashBtn} onPress={() => removeSession(s)}>
                      <Ionicons name="trash-outline" size={18} color={colors.mochaBrown} />
                    </PressableScale>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // [재고/관리 탭과 동일] 딥브라운 오로라 + 고정 브라운 헤더 + 둥근 크림 시트
  // [세 탭 헤더 통일] 좌측 세로열(제목 위·버튼 아래) + 우측 마스코트, 마스코트 높이가 헤더 높이를 정한다
  brownHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingHorizontal: 18,
    gap: 10,
  },
  brownHeaderLeft: { flex: 1, justifyContent: 'center' },
  // 관리 탭 헤더 높이(설정칩+마스코트 ~153)에 맞춰 마스코트를 하단 정렬 — 챗봇 헤더엔 버튼이 없어 minHeight로 확보
  // [한글 주석] minHeight 고정 154는 세로가 짧은 화면에서 대화 영역을 통째로 잡아먹었다 → 스케일 적용
  brownHeaderRight: { alignItems: 'flex-end', justifyContent: 'flex-end', minHeight: s(154) },
  // 배경 사진 위에 얹히므로 글자 그림자를 준다 (RoomBackdrop.ROOM_TEXT_SHADOW)
  brownHeaderTitle: { fontSize: fs(24), fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5, ...ROOM_TEXT_SHADOW },
  brownHeaderSub: { fontSize: fs(11.5), color: '#D4C9C1', marginTop: 4, fontWeight: '500', letterSpacing: -0.2, ...ROOM_TEXT_SHADOW },
  // 새 채팅/기록 — 브라운 헤더 아래 크림 시트 상단 섹션의 칩 (크림 배경이라 어두운 글씨)
  chatActionsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: 14,
    paddingBottom: 2,
  },
  sheetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.mochaBrown, // 헤더(진한 브라운)·예시 질문 칩(밝은 크림) 둘 다와 구분되는 중간 톤
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  sheetChipText: { color: colors.creamSand, fontSize: 12, fontWeight: '700' },
  brownSheet: {
    flex: 1,
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
  },
  root: { flex: 1, backgroundColor: colors.creamSand },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: 56,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  headerTitle: { ...typography.L3, color: colors.espressoBrown },
  headerActions: { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  headerBtnDim: { opacity: 0.4 },
  headerBtnText: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown },
  list: { flex: 1 },
  listContent: {
    padding: spacing.globalPadding,
    paddingBottom: 24, // [한글 주석: 입력바에 채팅 메시지 하단이 가려지지 않게 여유로운 패딩 확보]
    gap: 12,
  },
  msgBlock: { gap: 10 },
  bubbleRow: { flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  botBubble: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderTopLeftRadius: 4,
  },
  userBubble: { backgroundColor: colors.espressoBrown, borderTopRightRadius: 4 },
  bubbleText: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 19 },
  suggestWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: {
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  chipText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    // [한글 주석] 탭 바 바로 위에 밀착되도록 상/하단 얇은 구분선 추가
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    borderBottomWidth: 1,
    borderBottomColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  inputWrapper: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.espressoBrown,
    borderRadius: 999,
    backgroundColor: colors.white,
    justifyContent: 'center',
  },
  input: {
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 10 : 7,
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.espressoBrown, // [시안 반영] 어두운 딥브라운 원형 전송 버튼
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 과거 채팅 시트 — FormSheet와 같은 폰 프레임 규격
  modalRoot: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  modalDim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheet: {
    // [한글 주석] 세로가 짧은 기기(가로모드·플립)에서도 핸들과 목록이 함께 보이도록 비율 유지
    maxHeight: '70%',
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 24,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.mutedSand,
    marginTop: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: 14,
    paddingBottom: 12,
  },
  sheetTitle: { ...typography.L3, color: colors.espressoBrown, flex: 1 },
  clearBtn: {
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.white,
  },
  clearBtnText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },
  closeBtn: { padding: 4 },
  sheetList: { paddingHorizontal: spacing.globalPadding },
  emptyText: {
    ...typography.L4,
    fontWeight: '500',
    color: colors.mochaBrown,
    textAlign: 'center',
    lineHeight: 20,
    paddingVertical: 32,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    marginBottom: 8,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 11,
  },
  sessionRowActive: { borderColor: colors.mochaBrown, backgroundColor: colors.coffeeCream },
  sessionMain: { flex: 1, gap: 3 },
  sessionTitle: { ...typography.L4, color: colors.espressoBrown },
  sessionMeta: { ...typography.L5, color: colors.mochaBrown },
  trashBtn: { padding: 8 },
});
