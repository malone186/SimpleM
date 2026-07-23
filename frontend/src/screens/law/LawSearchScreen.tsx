// 법령 검색 (ERP-11) — 법령 RAG 검색 (챗봇과 동일 백엔드, 하드코딩 결과 없음)
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import { PressableScale } from '../../components/motion';
import { Card, Screen, ScreenTitle } from '../../components/ui';
import { sendChatMessage } from '../../lib/api/chatbot';
import { colors, typography } from '../../theme';

const SUGGESTIONS = ['주휴수당 지급 기준', '5인 미만 사업장 연차', '식품위생법 원산지 표시', '아르바이트 근로계약서'];

export default function LawSearchScreen() {
  // [한글 주석: 전역 다국어 번역 훅 연동]
  const { t, language } = useTranslation();
  const { token } = useAuth();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (text: string) => {
    const query = text.trim();
    setQ(query);
    if (!query || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setAsked(query);
    try {
      // 챗봇 RAG 백엔드에 법령 질의 — 매장 데이터 없이도 법령 문서 기반으로 답한다
      const reply = await sendChatMessage(
        `카페 운영 관련 법령 질문이야. 관련 법령 조항과 함께 간결하게 알려줘: ${query}`,
        [],
        token,
      );
      setAnswer(reply.response);
    } catch (e) {
      console.error('법령 검색 실패:', e);
      setError('법령 검색에 실패했어요. 서버 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title={t('lawSearchTitle')} subtitle={t('lawSearchSub')} />

      {/* 검색창 */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.mochaBrown} />
        <TextInput
          style={styles.input}
          placeholder={language === 'en' ? 'Search cafe regulations & labor laws...' : '궁금한 법령을 검색하세요'}
          placeholderTextColor={colors.mochaBrown}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => search(q)}
          returnKeyType="search"
        />
      </View>

      {/* 추천 검색어 */}
      {!answer && !loading && (
        <View style={styles.chips}>
          {SUGGESTIONS.map((s) => (
            <PressableScale key={s} style={styles.chip} onPress={() => search(s)}>
              <Text style={styles.chipText}>{s}</Text>
            </PressableScale>
          ))}
        </View>
      )}

      {/* 로딩 */}
      {loading && (
        <Card>
          <View style={styles.stateWrap}>
            <ActivityIndicator color={colors.mochaBrown} />
            <Text style={styles.stateText}>"{asked}" 관련 법령을 찾는 중…</Text>
          </View>
        </Card>
      )}

      {/* 오류 */}
      {error && !loading && (
        <Card>
          <Text style={styles.stateText}>{error}</Text>
        </Card>
      )}

      {/* 결과 — 백엔드 RAG 답변 */}
      {answer && !loading && (
        <Card>
          <View style={styles.resHead}>
            <Text style={styles.resTitle}>{asked}</Text>
            <View style={styles.lawTag}>
              <Text style={styles.lawTagText}>법령 RAG</Text>
            </View>
          </View>
          <Text style={styles.snippet}>{answer}</Text>
        </Card>
      )}

      {answer && !loading && (
        <Text style={styles.note}>
          더 자세한 상담은 챗봇 탭에서 브루에게 이어서 물어보세요.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  input: { flex: 1, paddingVertical: 13, ...typography.L4, fontWeight: '500', color: colors.espressoBrown },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  chipText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 },
  resHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  resTitle: { ...typography.L3, color: colors.espressoBrown, flex: 1 },
  lawTag: { backgroundColor: colors.coffeeCream, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  lawTagText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  snippet: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 20 },
  note: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center' },
});
