// 부가세 토글이 붙은 금액 입력 — 영수증 숫자를 그대로 치면 나머지는 앱이 계산한다.
//
// 왜 필요한가(사장님 피드백): 우유 1L 2,180원을 적을 때 그게 부가세 포함인지 아닌지에 따라
// 원가가 10% 달라진다. 지금까지는 사장님이 직접 나눠서 계산해 넣어야 했는데, 그건 아무도
// 안 한다. 칩 하나 눌러 "포함 / 별도 / 면세"만 고르면 공급가액을 앱이 뽑는다.
//
// 원가에는 공급가액(부가세 뺀 금액)을 쓴다 — 일반과세자는 매입세액을 공제받으므로
// 실제로 부담한 재료비는 부가세를 뺀 금액이기 때문이다. 우유·생수 같은 면세 품목은
// 부가세가 원래 없으므로 적은 금액이 곧 공급가액이다.
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { colors, typography } from '../theme';

export type VatMode = 'included' | 'excluded' | 'exempt';

const VAT_RATE = 0.1;

const MODES: { code: VatMode; label: string; hint: string }[] = [
  { code: 'included', label: '부가세 포함', hint: '영수증 결제금액 그대로' },
  { code: 'excluded', label: '부가세 별도', hint: '공급가액만 적힌 명세서' },
  { code: 'exempt', label: '면세', hint: '우유·생수·농축산물 등' },
];

/** 입력값과 모드로 공급가액(원가에 쓸 금액)을 구한다. */
export function supplyPriceOf(amount: number, mode: VatMode): number {
  if (amount <= 0) return 0;
  if (mode === 'included') return Math.round(amount / (1 + VAT_RATE));
  return Math.round(amount); // 별도·면세는 적은 금액이 곧 공급가액
}

export default function PriceInput({
  label,
  hint,
  initialAmount = '',
  initialMode = 'included',
  onChange,
}: {
  label: string;
  hint?: string;
  initialAmount?: string;
  initialMode?: VatMode;
  /** 공급가액(원가 반영 금액)과 사용자가 실제로 친 금액을 함께 알려 준다. */
  onChange: (supply: number, raw: number, mode: VatMode) => void;
}) {
  const [text, setText] = useState(initialAmount);
  const [mode, setMode] = useState<VatMode>(initialMode);

  const raw = Number(text.replace(/[^0-9]/g, '')) || 0;
  const supply = supplyPriceOf(raw, mode);
  const vat = mode === 'exempt' ? 0 : mode === 'included' ? raw - supply : Math.round(raw * VAT_RATE);
  const paid = mode === 'excluded' ? raw + vat : raw; // 실제 결제한 총액

  useEffect(() => {
    onChange(supply, raw, mode);
    // onChange는 호출부에서 매 렌더 새로 만들어지는 경우가 많아 의존성에 넣으면 무한 루프가 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supply, raw, mode]);

  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>

      <View style={styles.inputBox}>
        <TextInput
          style={styles.input}
          value={text ? Number(text.replace(/[^0-9]/g, '')).toLocaleString() : ''}
          onChangeText={(v) => setText(v.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="0"
          placeholderTextColor="#C7C7CC"
        />
        <Text style={styles.suffix}>원</Text>
      </View>

      <View style={styles.chipRow}>
        {MODES.map((m) => {
          const active = mode === m.code;
          return (
            <TouchableOpacity
              key={m.code}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setMode(m.code)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{m.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.modeHint}>{MODES.find((m) => m.code === mode)?.hint}</Text>

      {raw > 0 && (
        <View style={styles.breakdown}>
          <View style={styles.breakRow}>
            <Text style={styles.breakLabel}>공급가액 (원가 반영)</Text>
            <Text style={styles.breakValueStrong}>₩{supply.toLocaleString()}</Text>
          </View>
          {mode !== 'exempt' && (
            <>
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>부가세 10%</Text>
                <Text style={styles.breakValue}>₩{vat.toLocaleString()}</Text>
              </View>
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>실제 결제액</Text>
                <Text style={styles.breakValue}>₩{paid.toLocaleString()}</Text>
              </View>
            </>
          )}
          <Text style={styles.breakNote}>
            {mode === 'exempt'
              ? '면세 품목은 부가세가 붙지 않아 적으신 금액이 그대로 원가예요.'
              : '원가에는 부가세를 뺀 공급가액을 씁니다 — 매입세액은 부가세 신고 때 공제받으니까요.'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 6 },
  label: { ...typography.L4, color: colors.espressoBrown },
  hint: { ...typography.L5, color: colors.mochaBrown },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: 'rgba(60, 60, 67,0.22)',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 50,
  },
  input: {
    flex: 1,
    fontSize: 20,
    fontWeight: '900',
    color: colors.espressoBrown,
    textAlign: 'right',
    padding: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  suffix: { ...typography.L3, color: colors.mochaBrown, marginLeft: 6 },
  chipRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  chip: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  chipText: { fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown },
  chipTextActive: { color: colors.white },
  modeHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 6 },
  breakdown: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    gap: 5,
  },
  breakRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  breakLabel: { ...typography.L5, color: colors.mochaBrown },
  breakValue: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  breakValueStrong: { ...typography.L3, color: colors.espressoBrown },
  breakNote: { fontSize: 9.5, color: colors.mochaBrown, lineHeight: 14, marginTop: 3 },
});
