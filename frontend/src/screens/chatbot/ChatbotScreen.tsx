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

import Brew from '../../components/brew/Brew';
import { FadeInUp, PressableScale } from '../../components/motion';
import { colors, spacing, typography } from '../../theme';

type Msg = { id: string; role: 'bot' | 'user'; text: string };

const SUGGESTIONS = [
  '이번 주 경영 리포트 보여줘',
  '에티오피아 미디엄 원두 가격 비교해줘',
  '주휴수당 계산 기준 알려줘',
  '거래명세서 양식 만들어줘',
];

const GREETING: Msg = {
  id: 'g0',
  role: 'bot',
  text: '안녕하세요 사장님! 저는 브루예요 ☕\n리포트·원두 비교·법령·문서·발주까지 뭐든 물어보세요.',
};

// 데모용 간단 응답 (실제로는 백엔드 main_agent 호출)
function fakeReply(q: string): string {
  if (q.includes('리포트'))
    return '이번 주 매출은 지난주 대비 +8.2%예요. 다만 원가율이 3%p 올랐는데, 우유 단가 인상이 주 원인이에요. 라떼 계열 마진이 눌리고 있으니 가격 조정을 검토해 보세요. (근거: 우유 2,200→2,400원)';
  if (q.includes('원두') || q.includes('비교'))
    return '에티오피아 미디엄 로스팅 kg당 비교예요.\n· 커피리브레 28,000원 (플로럴)\n· 프릳츠 31,000원 (베리)\n· 앤트러사이트 29,500원 (시트러스)\n발주 초안을 만들어 드릴까요?';
  if (q.includes('주휴') || q.includes('수당') || q.includes('법령'))
    return '주휴수당은 주 15시간 이상 근무 시 1주 개근하면 발생해요. 1일 소정근로시간 × 시급으로 계산합니다. 알바님 스케줄 기준으로 자동 계산해 드릴까요?';
  if (q.includes('명세서') || q.includes('문서') || q.includes('양식'))
    return '거래명세서 초안을 만들었어요. 공급자/품목/수량/단가 칸이 포함됩니다. 운영 탭에서 확인·수정 후 확정하세요. (draft_)';
  return '무엇을 도와드릴까요? 아래 추천 질문을 눌러보셔도 좋아요.';
}

export default function ChatbotScreen() {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const send = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const userMsg: Msg = { id: `u${Date.now()}`, role: 'user', text: q };
    const botMsg: Msg = { id: `b${Date.now()}`, role: 'bot', text: fakeReply(q) };
    setMessages((prev) => [...prev, userMsg, botMsg]);
    setInput('');
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
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
          <FadeInUp
            key={m.id}
            distance={10}
            style={[styles.bubbleRow, m.role === 'user' ? styles.rowRight : styles.rowLeft]}
          >
            <View style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.botBubble]}>
              <Text style={[styles.bubbleText, m.role === 'user' && { color: colors.white }]}>
                {m.text}
              </Text>
            </View>
          </FadeInUp>
        ))}

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
          placeholder="브루에게 물어보세요"
          placeholderTextColor={colors.mochaBrown}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => send(input)}
          returnKeyType="send"
        />
        <PressableScale style={styles.sendBtn} onPress={() => send(input)} to={0.88}>
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
