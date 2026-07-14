// 상단 웰컴 블록 (Design Spec §4-①) — 브루 등장 지도 #1: 홈 인사 + AI 비서
// 오늘 상태에 따라 브루 표정이 바뀐다.
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, typography } from '../../theme';
import Brew, { type BrewMood } from '../brew/Brew';

export default function WelcomeHeader({
  storeName = '포자카페',
  mood = 'welcome',
  brewLine,
  onLogout,
}: {
  storeName?: string;
  mood?: BrewMood; // 오늘 상태에 따른 표정
  brewLine?: string; // 브루의 한마디 (AI가 → 브루가)
  onLogout?: () => void;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.row}>
        <View style={styles.textCol}>
          <Text style={styles.greeting}>안녕하세요 사장님 ☀️</Text>
          <Text style={styles.title}>{storeName}</Text>
          <Text style={styles.subtitle}>오늘도 향기로운 하루 되세요</Text>
        </View>
        <Brew mood={mood} size={104} />
      </View>

      {/* 브루의 한마디 — "AI가"가 아니라 "브루가" */}
      {brewLine ? (
        <View style={styles.brewBubble}>
          <Text style={styles.brewBubbleText}>{brewLine}</Text>
          <Text style={styles.brewSign}>— 브루</Text>
        </View>
      ) : null}

      {onLogout && (
        <TouchableOpacity style={styles.logoutBtn} onPress={onLogout} hitSlop={8}>
          <Ionicons name="log-out-outline" size={18} color={colors.mutedSand} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.espressoBrown,
    paddingTop: 56,
    paddingBottom: 24,
    paddingHorizontal: spacing.globalPadding,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
  },
  logoutBtn: { position: 'absolute', top: 52, right: 16, padding: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textCol: { flex: 1 },
  greeting: { ...typography.L5, color: colors.mutedSand, marginBottom: 4 },
  title: { ...typography.L1, color: colors.creamSand },
  subtitle: { ...typography.L5, color: colors.mochaBrown, marginTop: 6 },
  // 브루 말풍선
  brewBubble: {
    marginTop: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    borderTopLeftRadius: 4,
    padding: 14,
  },
  brewBubbleText: { ...typography.L4, fontWeight: '500', color: colors.creamSand, lineHeight: 19 },
  brewSign: { ...typography.L5, color: colors.mutedSand, marginTop: 6, textAlign: 'right' },
});
