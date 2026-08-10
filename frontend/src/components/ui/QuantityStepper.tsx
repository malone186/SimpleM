// 수량을 손끝으로 굴리는 입력칸 —  [−]  [ 숫자 ]  [＋]
//
// 왜 만들었나 — 재고를 만질 때 대부분은 "한 병 썼다", "두 팩 들어왔다" 같은 한두 개 단위다.
// 그런데 그때마다 숫자를 타이핑하게 하면 키보드가 화면 절반을 덮고, 0을 하나 더 찍는 오타도 난다.
// −/＋ 를 한 번 누르면 1씩, 꾹 누르고 있으면 알아서 빠르게 굴러간다.
// 많은 양을 한 번에 넣을 때를 위해 숫자를 직접 적는 길은 그대로 열어 둔다.
//
// 색·테두리는 Field.tsx와 같은 규칙을 쓴다 — OEM 다크 모드가 글자색을 삼키지 못하게 앱 색으로 못 박는다.
import { useEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, typography } from '../../theme';

const HOLD_DELAY = 380; // 이만큼 누르고 있으면 '꾹 누름'으로 보고 연속 증감 시작
const HOLD_TICK = 110; // 연속 증감 간격
const HOLD_TICK_FAST = 45; // 오래 누르고 있으면 더 빨리
const FAST_AFTER = 8; // 이 횟수를 넘기면 빠른 간격으로 전환

/** 0.1 + 0.2 = 0.30000000000000004 같은 부동소수 찌꺼기를 잘라낸다 (kg·L처럼 소수 단위가 있다) */
export const roundQty = (n: number) => Math.round(n * 100) / 100;

/** 입력칸 문자열을 수량으로 — 비었거나 숫자가 아니면 0 */
export const parseQty = (raw: string) => {
  const n = Number(raw.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * 입력칸이 비어 있으면 '지금 수량 그대로'로 본다.
 * 숫자를 고쳐 쓰려고 다 지운 순간에 0으로 튀어 "전부 차감"처럼 보이는 걸 막는다.
 */
export const parseQtyOr = (raw: string, fallback: number) => (raw.trim() === '' ? fallback : parseQty(raw));

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** 숫자 뒤에 붙는 단위 (병, kg …) */
  unit?: string;
  /** −/＋ 한 번에 움직이는 폭 */
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function QuantityStepper({
  value,
  onChange,
  unit,
  step = 1,
  min = 0,
  max,
  disabled,
  autoFocus,
  style,
}: Props) {
  // 꾹 누르는 동안에는 리렌더를 기다리지 않고 ref로 값을 굴린다 — 안 그러면 같은 값에서 계속 +1이 된다
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticks = useRef(0);
  const rolled = useRef(false); // 꾹 눌러 이미 굴러갔는지 — 손을 뗄 때 한 번 더 더해지는 걸 막는다

  const clamp = (n: number) => {
    let x = n;
    if (min !== undefined) x = Math.max(min, x);
    if (max !== undefined) x = Math.min(max, x);
    return roundQty(x);
  };

  const bump = (dir: 1 | -1) => {
    const next = String(clamp(parseQty(valueRef.current) + dir * step));
    valueRef.current = next;
    onChange(next);
  };

  const stopHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    ticks.current = 0;
  };

  const startHold = (dir: 1 | -1) => {
    stopHold();
    rolled.current = false;
    const schedule = (delay: number) => {
      timer.current = setTimeout(() => {
        bump(dir);
        rolled.current = true;
        ticks.current += 1;
        schedule(ticks.current >= FAST_AFTER ? HOLD_TICK_FAST : HOLD_TICK);
      }, delay);
    };
    schedule(HOLD_DELAY);
  };

  // 화면을 벗어날 때 타이머가 살아 있으면 없는 칸의 값을 계속 바꾼다
  useEffect(() => stopHold, []);

  const current = parseQty(value);
  const minusOff = disabled || current <= min;
  const plusOff = disabled || (max !== undefined && current >= max);

  const renderBtn = (dir: 1 | -1, off: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir > 0 ? '수량 1 늘리기' : '수량 1 줄이기'}
      disabled={off}
      onPressIn={() => startHold(dir)}
      onPressOut={stopHold}
      onPress={() => {
        // 꾹 눌러 이미 굴러간 뒤라면 손 떼는 순간의 한 번은 건너뛴다
        if (rolled.current) {
          rolled.current = false;
          return;
        }
        bump(dir);
      }}
      style={({ pressed }) => [
        styles.stepBtn,
        dir > 0 ? styles.plusBtn : styles.minusBtn,
        pressed && styles.stepBtnPressed,
        off && styles.stepBtnOff,
      ]}
      // 손가락이 살짝 벗어나도 눌리게 — 44px 버튼 밖 여유
      hitSlop={6}
    >
      <Ionicons
        name={dir > 0 ? 'add' : 'remove'}
        size={22}
        color={dir > 0 ? colors.white : colors.espressoBrown}
      />
    </Pressable>
  );

  return (
    <View style={[styles.wrap, disabled && styles.wrapOff, style]}>
      {renderBtn(-1, minusOff)}
      <View style={styles.center}>
        {/* 단위 글자만큼 왼쪽에도 자리를 비워 둬야 숫자가 진짜 가운데에 온다 */}
        {unit ? <View style={styles.unitSpacer} /> : null}
        <TextInput
          value={value}
          onChangeText={(t) => onChange(t.replace(/[^0-9.]/g, ''))}
          keyboardType="numeric"
          selectTextOnFocus
          editable={!disabled}
          autoFocus={autoFocus}
          placeholder="0"
          placeholderTextColor={colors.mochaBrown}
          underlineColorAndroid="transparent"
          textAlign="center"
          maxFontSizeMultiplier={1.3}
          style={styles.input}
        />
        {unit ? (
          <Text style={styles.unit} numberOfLines={1}>
            {unit}
          </Text>
        ) : null}
      </View>
      {renderBtn(1, plusOff)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.22)',
    borderRadius: 16,
    padding: 5,
  },
  wrapOff: { opacity: 0.55 },
  center: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minWidth: 0 },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    paddingVertical: 6,
    paddingHorizontal: 2,
    ...typography.L2,
    fontSize: 22,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  unitSpacer: { width: 30 },
  unit: {
    width: 30,
    ...typography.L5,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  stepBtn: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  minusBtn: { backgroundColor: colors.coffeeCream, borderWidth: 1, borderColor: colors.mutedSand },
  plusBtn: { backgroundColor: colors.espressoBrown },
  stepBtnPressed: { opacity: 0.7, transform: [{ scale: 0.94 }] },
  stepBtnOff: { opacity: 0.35 },
});

export default QuantityStepper;
