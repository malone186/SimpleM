// 인앱 토스트 + 확인 다이얼로그 — 브라우저 alert 대신 앱 내부 UI로 알림.
// 훅이 아닌 곳에서도 부를 수 있게 imperative API(toast/confirmDialog) 제공.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../theme';

type ToastItem = { id: number; title: string; message?: string };
type ConfirmItem = { message: string; confirmLabel: string; destructive: boolean; onConfirm: () => void };

let _show: ((t: { title: string; message?: string }) => void) | null = null;
let _confirm: ((c: ConfirmItem) => void) | null = null;
let seq = 0;

export function toast(title: string, message?: string) {
  _show?.({ title, message });
}

export function confirmDialog(
  message: string,
  opts: { onConfirm: () => void; confirmLabel?: string; destructive?: boolean }
) {
  _confirm?.({
    message,
    confirmLabel: opts.confirmLabel ?? '확인',
    destructive: !!opts.destructive,
    onConfirm: opts.onConfirm,
  });
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [confirm, setConfirm] = useState<ConfirmItem | null>(null);

  useEffect(() => {
    _show = ({ title, message }) => {
      const id = ++seq;
      setItems((p) => [...p, { id, title, message }]);
      setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), 2600);
    };
    _confirm = (c) => setConfirm(c);
    return () => {
      _show = null;
      _confirm = null;
    };
  }, []);

  return (
    <>
      <View style={styles.toastWrap} pointerEvents="box-none">
        {items.map((t) => (
          <ToastRow key={t.id} item={t} />
        ))}
      </View>
      {confirm && <ConfirmView item={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

function ToastRow({ item }: { item: ToastItem }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 8 }).start();
  }, [v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] });
  return (
    <Animated.View style={[styles.toast, { opacity: v, transform: [{ translateY }] }]}>
      <Text style={styles.toastTitle}>{item.title}</Text>
      {item.message ? <Text style={styles.toastMsg}>{item.message}</Text> : null}
    </Animated.View>
  );
}

function ConfirmView({ item, onClose }: { item: ConfirmItem; onClose: () => void }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [v]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] });

  return (
    <View style={styles.confirmRoot}>
      <Animated.View style={[styles.confirmBackdrop, { opacity: v }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.dialog, { opacity: v, transform: [{ scale }] }]}>
        <Text style={styles.dialogMsg}>{item.message}</Text>
        <View style={styles.dialogActions}>
          <Pressable style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>취소</Text>
          </Pressable>
          <Pressable
            style={[styles.okBtn, item.destructive && styles.okDanger]}
            onPress={() => {
              onClose();
              item.onConfirm();
            }}
          >
            <Text style={styles.okText}>{item.confirmLabel}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', top: 54, left: 0, right: 0, alignItems: 'center', gap: 8, zIndex: 1000 },
  toast: {
    maxWidth: '88%',
    backgroundColor: 'rgba(43,35,32,0.96)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center', // [한글 주석] 토스트 팝업 텍스트 및 요소를 정가운데로 정렬
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  // [한글 주석] 알림 제목 — 또렷한 하얀색 볼드 서체 및 중앙 배치
  toastTitle: { ...typography.L4, color: colors.white, fontWeight: '800', textAlign: 'center' },
  // [한글 주석] 알림 상세 메시지 — 어두운 배경과 대비되는 선명한 하얀색 텍스트 적용
  toastMsg: { ...typography.L5, color: 'rgba(255, 255, 255, 0.92)', marginTop: 4, lineHeight: 18, textAlign: 'center' },
  // 확인 다이얼로그
  confirmRoot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
  confirmBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  dialog: {
    width: '82%',
    maxWidth: 340,
    backgroundColor: colors.white,
    borderRadius: 22,
    padding: 22,
  },
  dialogMsg: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 21, textAlign: 'center' },
  dialogActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, paddingVertical: 13, borderRadius: 14, backgroundColor: colors.coffeeCream, alignItems: 'center' },
  cancelText: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  okBtn: { flex: 1, paddingVertical: 13, borderRadius: 14, backgroundColor: colors.pointOrange, alignItems: 'center' },
  okDanger: { backgroundColor: '#B23B2E' },
  okText: { ...typography.L4, color: colors.white, fontWeight: '700' },
});
