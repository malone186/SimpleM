// 약관/개인정보처리방침 표시 화면 — 외부 의존성 없이 네이티브로 렌더링.
// route.params.doc 로 문서 선택 ('privacy' | 'terms'). 기본값은 'privacy'.
// 공개 원문(Play Console 등록용)은 백엔드 /legal/*.html 에 게시되어 있으며 '웹에서 열기'로 연결.
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';

import { API_BASE_URL } from '../../lib/api/client';
import { colors } from '../../theme';
import { PRIVACY_POLICY, TERMS_OF_SERVICE, type LegalBlock, type LegalDoc } from './legalContent';

type LegalDocKey = 'privacy' | 'terms';

function docFor(key: LegalDocKey | undefined): { doc: LegalDoc; path: string } {
  return key === 'terms'
    ? { doc: TERMS_OF_SERVICE, path: 'terms.html' }
    : { doc: PRIVACY_POLICY, path: 'privacy.html' };
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.t) {
    case 'h2':
      return <Text style={styles.h2}>{block.text}</Text>;
    case 'h3':
      return <Text style={styles.h3}>{block.text}</Text>;
    case 'p':
      return <Text style={styles.p}>{block.text}</Text>;
    case 'note':
      return (
        <View style={styles.noteBox}>
          <Text style={styles.noteText}>{block.text}</Text>
        </View>
      );
    case 'ul':
      return (
        <View style={styles.list}>
          {block.items.map((it, i) => (
            <View key={i} style={styles.li}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.liText}>{it}</Text>
            </View>
          ))}
        </View>
      );
    case 'ol':
      return (
        <View style={styles.list}>
          {block.items.map((it, i) => (
            <View key={i} style={styles.li}>
              <Text style={styles.olNum}>{i + 1}.</Text>
              <Text style={styles.liText}>{it}</Text>
            </View>
          ))}
        </View>
      );
    case 'table':
      return (
        <View style={styles.table}>
          <View style={[styles.tr, styles.trHead]}>
            {block.head.map((h, i) => (
              <Text key={i} style={[styles.th, i === 0 && styles.tFirst]}>
                {h}
              </Text>
            ))}
          </View>
          {block.rows.map((row, ri) => (
            <View key={ri} style={[styles.tr, ri === block.rows.length - 1 && styles.trLast]}>
              {row.map((c, ci) => (
                <Text key={ci} style={[styles.td, ci === 0 && styles.tFirst]}>
                  {c}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

export default function LegalScreen() {
  const route = useRoute<RouteProp<Record<string, { doc?: LegalDocKey }>, string>>();
  const { doc, path } = docFor(route.params?.doc);

  const openWeb = () => {
    Linking.openURL(`${API_BASE_URL}/legal/${path}`).catch(() => {});
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{doc.title}</Text>
      <Text style={styles.eff}>시행일: {doc.effectiveDate}</Text>
      {doc.intro ? <Text style={styles.intro}>{doc.intro}</Text> : null}

      {doc.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}

      <Text style={styles.webLink} onPress={openWeb}>
        웹에서 원문 보기 ↗
      </Text>
      <Text style={styles.footer}>© 브루노트 (SimpleM) · 시행일 {doc.effectiveDate}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.creamSand },
  content: { padding: 20, paddingBottom: 56 },

  title: { fontSize: 24, fontWeight: '900', color: colors.espressoBrown },
  eff: { fontSize: 13, color: colors.mochaBrown, marginTop: 4 },
  intro: { fontSize: 14.5, lineHeight: 23, color: colors.espressoBrown, marginTop: 16 },

  h2: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.espressoBrown,
    marginTop: 26,
    marginBottom: 6,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
  },
  h3: { fontSize: 15, fontWeight: '700', color: colors.espressoBrown, marginTop: 16, marginBottom: 4 },
  p: { fontSize: 14.5, lineHeight: 23, color: colors.espressoBrown, marginTop: 8 },

  list: { marginTop: 8 },
  li: { flexDirection: 'row', marginTop: 5, paddingRight: 4 },
  bullet: { fontSize: 14.5, lineHeight: 22, color: colors.mochaBrown, width: 16 },
  olNum: { fontSize: 14.5, lineHeight: 22, color: colors.mochaBrown, width: 22, fontWeight: '700' },
  liText: { flex: 1, fontSize: 14.5, lineHeight: 22, color: colors.espressoBrown },

  table: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    overflow: 'hidden',
  },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.mutedSand },
  trLast: { borderBottomWidth: 0 },
  trHead: { backgroundColor: colors.coffeeCream },
  th: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
    color: colors.espressoBrown,
    padding: 10,
    borderLeftWidth: 1,
    borderLeftColor: colors.mutedSand,
  },
  td: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: colors.espressoBrown,
    padding: 10,
    borderLeftWidth: 1,
    borderLeftColor: colors.mutedSand,
  },
  tFirst: { borderLeftWidth: 0 },

  noteBox: {
    marginTop: 20,
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    padding: 14,
  },
  noteText: { fontSize: 13.5, lineHeight: 21, color: colors.mochaBrown },

  webLink: {
    marginTop: 28,
    fontSize: 14,
    fontWeight: '700',
    color: colors.trendGreenText,
  },
  footer: { marginTop: 20, fontSize: 12, color: colors.mochaBrown },
});
