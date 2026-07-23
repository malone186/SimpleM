// 브리핑 버튼 — 오늘의 음성 브리핑을 불러와 읽어준다 (2단계 요구사항 1번의 진입점).
//
// [한글 주석] 이어폰 미착용이면 음성은 나가지 않으므로, speech_text를 화면에 그대로 띄웁니다.
// "지금 왜 소리가 안 나는지"를 사용자가 알 수 있도록 안내 문구도 함께 보여줍니다.
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import { usePreferences } from '../../preferences/PreferencesContext';
import { useBriefing } from '../../lib/speech/useBriefing';
import { colors, shadows, typography } from '../../theme';
import { toast } from '../toast';

export default function BriefingButton() {
  const { token } = useAuth();
  const prefs = usePreferences();
  const briefing = useBriefing({
    onError: (message) => {
      if (message.includes('404') || message.includes('Not Found')) return;
      toast('📋 브리핑', message);
    },
  });

  if (!token || !prefs.ready || !prefs.voiceAssistantEnabled) return null;

  const { data, loading, spoken, permission } = briefing;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {!!data && (
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>오늘의 브리핑</Text>
            <Pressable onPress={briefing.dismiss} hitSlop={8} accessibilityLabel="브리핑 닫기">
              <Ionicons name="close" size={16} color={colors.mochaBrown} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={styles.speech}>{data.speech_text}</Text>

            <Text style={styles.section}>
              완료 {data.completed.length}건 · 남은 일 {data.pending.length}건
            </Text>
            {data.pending.slice(0, 5).map((t) => (
              <Text key={t.id} style={styles.item} numberOfLines={1}>
                • {t.title}
              </Text>
            ))}
          </ScrollView>

          {!spoken && (
            <Text style={styles.notice}>
              🔇 {permission?.reason ?? '이어폰이 연결되어 있지 않아 음성은 재생하지 않았습니다.'}
            </Text>
          )}
        </View>
      )}

      <Pressable
        style={styles.fab}
        disabled={loading}
        onPress={() => briefing.play()}
        accessibilityLabel="오늘의 브리핑 듣기"
      >
        {loading ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : (
          <Ionicons name="document-text" size={20} color={colors.white} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 16,
    bottom: 78, // [한글 주석: 마이크 버튼(bottom: 20) 바로 위 제자리 배치]
    alignItems: 'flex-end',
    gap: 10,
  },
  card: {
    width: 280,
    maxHeight: 320,
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
    ...shadows.medium,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.L3,
    color: colors.espressoBrown,
  },
  close: {
    ...typography.L4,
    color: colors.mochaBrown,
    paddingHorizontal: 4,
  },
  body: {
    maxHeight: 220,
  },
  bodyContent: {
    gap: 6,
  },
  speech: {
    ...typography.L4,
    color: colors.espressoBrown,
    lineHeight: 19,
  },
  section: {
    ...typography.L5,
    color: colors.mochaBrown,
    marginTop: 6,
  },
  item: {
    ...typography.L5,
    color: colors.espressoBrown,
  },
  notice: {
    ...typography.L5,
    color: colors.mochaBrown,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 8,
    lineHeight: 14,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#6E5544', // [한글 주석: 세련된 모카 브라운 원형 뱃지]
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    ...shadows.medium,
  },
});
