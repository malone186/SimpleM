// 챗봇 (프론트 B) — PRD §5.3 통합 창구
// 리포트 조회 · 원두 비교 · 법령 검색 · 문서 생성 · 발주 초안 등 전용 화면 없는 모든 기능
// 대화 세션 관리: 새 채팅 열기 + 과거 채팅 복원/삭제
// (로그인 시 서버 DB에 계정별 보관 — 비로그인·서버 장애 시 기기 로컬 폴백)
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, type RouteProp } from '@react-navigation/native';

import type { RootTabParamList } from '../../navigation/RootNavigator';

import { useAuth } from '../../auth/AuthContext';
import Brew from '../../components/brew/Brew';
import DocumentCard from '../../components/chatbot/DocumentCard';
import { FadeInUp, PressableScale } from '../../components/motion';
import { sendChatMessage } from '../../lib/api/chatbot';
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
  const { token } = useAuth();
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
    try {
      // 인사말(g0)을 제외한 지금까지의 대화를 두뇌가 이해하는 형식으로 변환
      const history = afterUser
        .filter((m) => m.id !== 'g0' && m.id !== userMsg.id)
        .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('model' as const), text: m.text }));
      const res = await sendChatMessage(q, history, token);
      commit([
        ...messagesRef.current,
        { id: `b${Date.now()}`, role: 'bot', text: res.response, docs: res.documents },
      ]);
    } catch {
      commit([...messagesRef.current, {
        id: `e${Date.now()}`,
        role: 'bot',
        text: '앗, 답변을 가져오지 못했어요. 서버가 켜져 있는지 확인하고 잠시 후 다시 시도해 주세요.',
      }]);
    } finally {
      setSending(false);
      scrollDown();
    }
  };

  // 새 채팅 — 지금 대화는 이미 저장돼 있으므로 화면만 초기화한다
  const startNewChat = () => {
    if (sending) return;
    sessionIdRef.current = `s${Date.now()}`;
    createdAtRef.current = Date.now();
    messagesRef.current = [GREETING];
    setMessages([GREETING]);
    setInput('');
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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Brew mood="welcome" size={34} />
        <Text style={styles.headerTitle}>브루 챗봇</Text>
        <View style={styles.headerActions}>
          {/* 대화 중에도 언제든 새 채팅을 열 수 있다 — 기존 대화는 기록에 남는다 */}
          <PressableScale
            style={[styles.headerBtn, !hasConversation && styles.headerBtnDim]}
            onPress={startNewChat}
            disabled={sending || !hasConversation}
          >
            <Ionicons name="add" size={20} color={colors.espressoBrown} />
            <Text style={styles.headerBtnText}>새 채팅</Text>
          </PressableScale>
          <PressableScale style={styles.headerBtn} onPress={openHistory}>
            <Ionicons name="time-outline" size={18} color={colors.espressoBrown} />
            <Text style={styles.headerBtnText}>기록</Text>
          </PressableScale>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((m) => (
          <View key={m.id} style={styles.msgBlock}>
            <FadeInUp
              distance={10}
              style={[styles.bubbleRow, m.role === 'user' ? styles.rowRight : styles.rowLeft]}
            >
              <View style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.botBubble]}>
                <Text style={[styles.bubbleText, m.role === 'user' && { color: colors.white }]}>
                  {m.role === 'bot' ? plainText(m.text) : m.text}
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
        ))}

        {/* 두뇌가 도구를 호출하며 답을 준비하는 동안 표시 */}
        {sending && (
          <View style={[styles.bubbleRow, styles.rowLeft]}>
            <View style={[styles.bubble, styles.botBubble]}>
              <Text style={styles.bubbleText}>생각 중이에요… ☕</Text>
            </View>
          </View>
        )}

        {messages.length <= 1 && (
          <View style={styles.suggestWrap}>
            {SUGGESTIONS.map((s, i) => (
              <FadeInUp key={s} delay={200 + i * 70}>
                <PressableScale style={styles.chip} onPress={() => send(s)}>
                  <Text style={styles.chipText}>{s}</Text>
                </PressableScale>
              </FadeInUp>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={styles.inputBar}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={sending ? '답변을 기다리는 중…' : '브루에게 물어보세요'}
          placeholderTextColor={colors.mochaBrown}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => send(input)}
          returnKeyType="send"
          editable={!sending}
        />
        <PressableScale style={styles.sendBtn} onPress={() => send(input)} disabled={sending} to={0.88}>
          <Ionicons name="arrow-up" size={20} color={colors.white} />
        </PressableScale>
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
              <Text style={styles.sheetTitle}>채팅 기록</Text>
              {sessions.length > 0 && (
                <PressableScale style={styles.clearBtn} onPress={removeAllSessions}>
                  <Text style={styles.clearBtnText}>전체 삭제</Text>
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
  listContent: { padding: spacing.globalPadding, gap: 12 },
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
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  input: {
    flex: 1,
    backgroundColor: colors.creamSand,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 11,
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 과거 채팅 시트 — FormSheet와 같은 폰 프레임 규격
  modalRoot: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  modalDim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheet: {
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
