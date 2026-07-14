// 브루 등장 지도 #2: 빈 화면 — 턱 괸 브루 + 안내 (이탈 방지)
import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../../theme';
import { Button } from '../ui';
import Brew, { type BrewMood } from './Brew';

export default function EmptyState({
  mood = 'resting',
  title,
  description,
  actionLabel,
  onAction,
}: {
  mood?: BrewMood;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <Brew mood={mood} size={150} />
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.desc}>{description}</Text> : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} style={styles.btn} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  title: { ...typography.L3, color: colors.espressoBrown, marginTop: 8, textAlign: 'center' },
  desc: { ...typography.L4, color: colors.mochaBrown, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  btn: { marginTop: 20, paddingHorizontal: 28 },
});
