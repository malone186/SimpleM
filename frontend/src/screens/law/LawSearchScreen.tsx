// 법령 검색 (ERP-11) — 법령 RAG 검색 (챗봇과 동일 백엔드)
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '../../components/motion';
import { Card, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

const SUGGESTIONS = ['주휴수당 지급 기준', '5인 미만 사업장 연차', '식품위생법 원산지 표시', '아르바이트 근로계약서'];

type Result = { title: string; law: string; snippet: string };

const RESULTS: Record<string, Result[]> = {
  주휴수당: [
    {
      title: '주휴수당 지급 요건',
      law: '근로기준법 제55조',
      snippet: '1주 소정근로시간이 15시간 이상이고 1주 개근한 근로자에게 1일 이상의 유급휴일을 보장해야 합니다.',
    },
    {
      title: '주휴수당 계산',
      law: '근로기준법 시행령',
      snippet: '1일 소정근로시간 × 시급으로 산정하며, 단시간 근로자는 비례하여 계산합니다.',
    },
  ],
};

export default function LawSearchScreen() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);

  const search = (text: string) => {
    const query = text.trim();
    setQ(query);
    if (!query) {
      setResults(null);
      return;
    }
    const key = Object.keys(RESULTS).find((k) => query.includes(k));
    setResults(
      key
        ? RESULTS[key]
        : [
            {
              title: '검색 결과',
              law: '관련 법령',
              snippet: `"${query}"에 대한 법령을 요약했어요. 자세한 판단은 브루 챗봇에서 이어서 물어보실 수 있어요.`,
            },
          ]
    );
  };

  return (
    <Screen>
      <ScreenTitle title="법령 검색" subtitle="카페 운영에 필요한 법령을 빠르게" />

      {/* 검색창 */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.mochaBrown} />
        <TextInput
          style={styles.input}
          placeholder="궁금한 법령을 검색하세요"
          placeholderTextColor={colors.mochaBrown}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => search(q)}
          returnKeyType="search"
        />
      </View>

      {/* 추천 검색어 */}
      {!results && (
        <View style={styles.chips}>
          {SUGGESTIONS.map((s) => (
            <PressableScale key={s} style={styles.chip} onPress={() => search(s)}>
              <Text style={styles.chipText}>{s}</Text>
            </PressableScale>
          ))}
        </View>
      )}

      {/* 결과 */}
      {results?.map((r, i) => (
        <Card key={i}>
          <View style={styles.resHead}>
            <Text style={styles.resTitle}>{r.title}</Text>
            <View style={styles.lawTag}>
              <Text style={styles.lawTagText}>{r.law}</Text>
            </View>
          </View>
          <Text style={styles.snippet}>{r.snippet}</Text>
        </Card>
      ))}

      {results && (
        <Text style={styles.note}>
          더 자세한 상담은 챗봇 탭에서 브루에게 물어보세요.
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
  resHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  resTitle: { ...typography.L3, color: colors.espressoBrown, flex: 1 },
  lawTag: { backgroundColor: colors.coffeeCream, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  lawTagText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  snippet: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 20 },
  note: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center' },
});
