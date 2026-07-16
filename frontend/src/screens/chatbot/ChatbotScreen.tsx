// 챗봇 (프론트 B) — PRD §5.3 통합 창구
// 리포트 조회 · 원두 비교 · 법령 검색 · 문서 생성 · 발주 초안 등 전용 화면 없는 모든 기능
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import Brew from '../../components/brew/Brew';
import DocumentCard from '../../components/chatbot/DocumentCard';
import { FadeInUp, PressableScale } from '../../components/motion';
import { sendChatMessage, type ChatDocument } from '../../lib/api/chatbot';
import { colors, spacing, typography } from '../../theme';

// docs: 이번 답변에서 챗봇이 만든 문서 초안 — 말풍선 아래 카드로 바로 보여준다
type Msg = { id: string; role: 'bot' | 'user'; text: string; docs?: ChatDocument[] };

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

export default function ChatbotScreen() {
  const { token } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

  // 백엔드 멀티에이전트 두뇌(/chatbot/chat) 호출 — 이전 대화도 함께 보내 맥락을 유지한다
  const send = async (text: string) => {
    const q = text.trim();
    if (!q || sending) return;
    const userMsg: Msg = { id: `u${Date.now()}`, role: 'user', text: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);
    scrollDown();
    try {
      // 인사말(g0)을 제외한 지금까지의 대화를 두뇌가 이해하는 형식으로 변환
      const history = messages
        .filter((m) => m.id !== 'g0')
        .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('model' as const), text: m.text }));
      const res = await sendChatMessage(q, history, token);
      setMessages((prev) => [
        ...prev,
        { id: `b${Date.now()}`, role: 'bot', text: res.response, docs: res.documents },
      ]);
    } catch {
      setMessages((prev) => [...prev, {
        id: `e${Date.now()}`,
        role: 'bot',
        text: '앗, 답변을 가져오지 못했어요. 서버가 켜져 있는지 확인하고 잠시 후 다시 시도해 주세요.',
      }]);
    } finally {
      setSending(false);
      scrollDown();
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Brew mood="welcome" size={34} />
        <Text style={styles.headerTitle}>브루 챗봇</Text>
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
                  {m.text}
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
});
