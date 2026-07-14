// 재사용 입력 바텀시트 — 폼을 스프링으로 띄우고 하단에 제출 버튼
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { colors, spacing, typography } from '../theme';
import { PressableScale } from './motion';

export default function FormSheet({
  visible,
  title,
  onClose,
  onSubmit,
  submitLabel = '추가',
  submitDisabled,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  children: ReactNode;
}) {
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(slide, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }).start();
    } else {
      Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [560, 0] });
  const backdrop = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY }] }]}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.title}>{title}</Text>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            <PressableScale
              style={[styles.submitBtn, submitDisabled && styles.submitDisabled]}
              onPress={onSubmit}
              disabled={submitDisabled}
            >
              <Text style={styles.submitText}>{submitLabel}</Text>
            </PressableScale>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

// 라벨 붙은 입력 필드
export function LabeledInput({ label, ...props }: { label: string } & TextInputProps) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.mochaBrown}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheetWrap: { width: '100%' },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: spacing.globalPadding,
    paddingBottom: 32,
    maxHeight: 620,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.mutedSand, marginBottom: 16 },
  title: { ...typography.L1, color: colors.espressoBrown, marginBottom: 16 },
  submitBtn: { backgroundColor: colors.pointOrange, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  submitDisabled: { opacity: 0.4 },
  submitText: { ...typography.L3, color: colors.white },
  fieldWrap: { marginBottom: 14 },
  label: { ...typography.L5, color: colors.mochaBrown, marginBottom: 6 },
  input: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
  },
});
