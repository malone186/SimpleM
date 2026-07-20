// 자주 시키는 발주 모달 (Design Spec §4-③)
// 바텀 시트 + 딤드 배경(bg-black/40) — PRD §1.4: 발주는 초안-승인 원칙이나
// 본 모달은 '자주 시키는 항목 즉시 발주' UX 데모 (실제 확정은 발주 승인 화면)
import { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, spacing, typography } from '../../theme';
import { PressableScale } from '../motion';
import type { Todo } from './TodoList';

export default function QuickOrderModal({
  visible,
  todo,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  todo: Todo | null;
  onClose: () => void;
  onConfirm: (todo: Todo) => void;
}) {
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      // 스프링으로 살짝 오버슛하며 튀어오르는 토스식 바텀시트
      Animated.spring(slide, {
        toValue: 1,
        useNativeDriver: true,
        speed: 14,
        bounciness: 9,
      }).start();
    } else {
      Animated.timing(slide, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [420, 0] });
  const backdropOpacity = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* 딤 배경 페이드 */}
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        {/* 스프링으로 튀어오르는 바텀시트 */}
        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY }] }]}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.title}>자주 시키는 발주</Text>
            {todo && (
              <View style={styles.itemBox}>
                <Text style={styles.itemName}>{todo.title}</Text>
                <Text style={styles.itemSub}>{todo.subtitle}</Text>
                <View style={styles.qtyRow}>
                  <Text style={styles.qtyLabel}>추천 수량</Text>
                  <Text style={styles.qtyValue}>5 kg</Text>
                </View>
              </View>
            )}
            {/* [한글 주석: 앱 내 직접 발주 미지원 고지 및 닫기 버튼 배치] */}
            <Text style={styles.infoText}>
              * 앱 내 결제 및 직접 발주는 지원하지 않습니다. 외부 공급처를 통해 별도로 주문해주시기 바랍니다.
            </Text>
            <PressableScale style={styles.confirmBtn} onPress={onClose}>
              <Text style={styles.confirmText}>닫기</Text>
            </PressableScale>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.black40,
  },
  sheetWrap: { width: '100%' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: spacing.globalPadding,
    paddingBottom: 32,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.mutedSand,
    marginBottom: 16,
  },
  title: { ...typography.L1, color: colors.espressoBrown, marginBottom: 16 },
  itemBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 16,
    marginBottom: 20,
  },
  itemName: { ...typography.L3, color: colors.espressoBrown },
  itemSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  qtyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 12,
  },
  qtyLabel: { ...typography.L5, color: colors.mochaBrown },
  qtyValue: { ...typography.L3, color: colors.espressoBrown },
  infoText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 16,
    textAlign: 'center',
  },
  confirmBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  confirmText: { ...typography.L3, color: colors.white },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { ...typography.L4, color: colors.mochaBrown },
});
