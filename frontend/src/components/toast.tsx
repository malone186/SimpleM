// 인앱 토스트 + 확인 다이얼로그 — 브라우저 alert 대신 앱 내부 UI로 알림.
// 훅이 아닌 곳에서도 부를 수 있게 imperative API(toast/confirmDialog) 제공.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, typography } from '../theme';

/** 토스트를 눌렀을 때 이어질 행동 (예: "재고 보기" → 그 재료 화면으로) */
export type ToastAction = { label: string; onPress: () => void };

type ToastItem = { id: number; title: string; message?: string; action?: ToastAction };
type ConfirmItem = { message: string; confirmLabel: string; destructive: boolean; onConfirm: () => void };

let _show: ((t: { title: string; message?: string; action?: ToastAction }) => void) | null = null;
let _confirm: ((c: ConfirmItem) => void) | null = null;
let seq = 0;

// 그냥 알리기만 하는 토스트는 짧게 사라져야 방해가 안 된다.
// 반면 누를 게 있는 토스트가 2.6초 만에 사라지면 손이 닿기 전에 없어진다.
const PLAIN_MS = 2600;
const ACTION_MS = 6000;

/**
 * 인앱 토스트.
 * @param action 주면 토스트 전체가 눌리는 버튼이 되고, 표시 시간도 길어진다.
 */
export function toast(title: string, message?: string, action?: ToastAction) {
  _show?.({ title, message, action });
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
    _show = ({ title, message, action }) => {
      const id = ++seq;
      setItems((p) => [...p, { id, title, message, action }]);
      setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), action ? ACTION_MS : PLAIN_MS);
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
          <ToastRow
            key={t.id}
            item={t}
            onDismiss={() => setItems((p) => p.filter((x) => x.id !== t.id))}
          />
        ))}
      </View>
      {confirm && <ConfirmView item={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 8 }).start();
  }, [v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] });

  const body = (
    <>
      <Text style={styles.toastTitle}>{item.title}</Text>
      {item.message ? <Text style={styles.toastMsg}>{item.message}</Text> : null}
      {item.action ? (
        <View style={styles.toastAction}>
          <Text style={styles.toastActionText}>{item.action.label}</Text>
          <Ionicons name="chevron-forward" size={13} color={colors.pointOrange} />
        </View>
      ) : null}
    </>
  );

  return (
    <Animated.View style={[styles.toast, { opacity: v, transform: [{ translateY }] }]}>
      {item.action ? (
        // 작은 버튼을 조준하게 만들지 않고 토스트 전체를 누를 수 있게 한다.
        // 누르면 바로 치운다 — 화면이 바뀐 뒤에도 떠 있으면 남은 알림처럼 보인다.
        <Pressable
          onPress={() => {
            onDismiss();
            item.action?.onPress();
          }}
          accessibilityRole="button"
          accessibilityLabel={`${item.title} — ${item.action.label}`}
          style={({ pressed }) => [styles.toastPress, pressed && styles.toastPressed]}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
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
  // 누를 수 있는 토스트 — 전체가 버튼이라 안쪽 여백은 Pressable이 갖는다
  toastPress: { alignItems: 'center' },
  toastPressed: { opacity: 0.72 },
  // "재고 보기 ›" — 누를 수 있다는 걸 알려주는 표시
  toastAction: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8 },
  toastActionText: { ...typography.L5, color: colors.pointOrange, fontWeight: '800' },
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
