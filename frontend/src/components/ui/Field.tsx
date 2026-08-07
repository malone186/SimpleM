// 어느 폰에서나 똑같이 읽히는 입력칸 (재고·메뉴 등 폼 공통)
//
// 왜 따로 만들었나 — 기존 폼은 안내 문구를 placeholder에만 담고 placeholderTextColor를
// 지정하지 않았다. 안드로이드는 placeholder 색을 시스템 테마의 textColorHint에서 가져오는데,
// 삼성·샤오미처럼 앱에 다크 모드를 강제로 씌우는 스킨에서는 이 값이 흰색에 가까워진다.
// 입력칸 배경도 흰색이라 안내 문구가 통째로 사라져 '빈 네모 4개'만 남았다.
// (같은 코드인데 폰마다 다르게 보이던 이유)
//
// 그래서 여기서는
//   1) 라벨을 입력칸 위에 항상 그린다 — placeholder가 안 보여도 무슨 칸인지 알 수 있다
//   2) placeholderTextColor·color를 앱 색으로 못 박는다 — 시스템 테마가 못 건드린다
//   3) 높이를 고정하지 않고 minHeight로 준다 — 글씨 크게 보기(접근성)에서 글자가 안 잘린다
//   4) FieldRow가 좁은 화면에서 알아서 한 줄에 하나씩 접힌다 — 폴드 커버·SE에서도 안 찌그러진다
import { ReactNode } from 'react';
import { StyleProp, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';

import { colors, typography } from '../../theme';

type FieldProps = TextInputProps & {
  label: string;
  /** 라벨 옆에 '필수' 표시 */
  required?: boolean;
  /** 입력칸 아래 회색 보조 설명 */
  hint?: string;
  /** 단위처럼 값 뒤에 붙는 고정 글자 (예: 원, 개) */
  suffix?: string;
  /** 한 줄에 여러 칸을 놓을 때의 최소 폭 — 이보다 좁아지면 다음 줄로 접힌다 */
  minWidth?: number;
  /** 세로 여백을 줄인 촘촘한 형태 (초안 편집처럼 줄이 많은 곳) */
  compact?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  right?: ReactNode;
};

export function Field({
  label,
  required,
  hint,
  suffix,
  minWidth = 130,
  compact,
  containerStyle,
  right,
  style,
  ...inputProps
}: FieldProps) {
  return (
    <View style={[styles.field, { minWidth, flexGrow: 1, flexBasis: minWidth }, containerStyle]}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, compact && styles.labelCompact]} numberOfLines={1}>
          {label}
        </Text>
        {required && <Text style={styles.required}>필수</Text>}
        {right}
      </View>
      <View style={styles.inputWrap}>
        <TextInput
          {...inputProps}
          style={[styles.input, compact && styles.inputCompact, suffix ? styles.inputWithSuffix : null, style]}
          // 시스템 테마가 안내 문구 색을 가져가지 못하게 앱 색으로 못 박는다
          placeholderTextColor={colors.mochaBrown}
          underlineColorAndroid="transparent"
          // 안드로이드는 minHeight를 쓰면 글자가 위로 붙는다 — 가운데로 내린다
          textAlignVertical="center"
          // 글씨 크게 보기에서 라벨·버튼까지 밀려 레이아웃이 깨지는 폰이 있어 상한을 둔다
          maxFontSizeMultiplier={1.4}
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/** 입력칸 여러 개를 가로로 놓되, 좁은 화면에서는 자동으로 줄바꿈되는 행 */
export function FieldRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  field: { gap: 5 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: {
    ...typography.L5,
    fontSize: 12.5,
    fontWeight: '800',
    color: colors.espressoBrown,
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  labelCompact: { fontSize: 11.5 },
  required: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.white,
    backgroundColor: colors.mochaBrown,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  inputWrap: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 46, // 손가락으로 누르기 편한 최소 높이 (고정 height는 큰 글씨 설정에서 글자를 자른다)
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.22)',
    borderRadius: 12,
    backgroundColor: colors.white,
    ...typography.L4,
    fontSize: 15, // 15 미만이면 iOS 사파리(웹)에서 입력 시 화면이 확대된다
    color: colors.espressoBrown,
  },
  inputCompact: { minHeight: 40, paddingVertical: 8, fontSize: 14 },
  // 단위 글자가 입력값을 덮지 않도록 오른쪽 여백을 미리 비워 두고 그 자리에 얹는다
  inputWithSuffix: { paddingRight: 40 },
  suffix: {
    position: 'absolute',
    right: 12,
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  hint: { ...typography.L5, fontSize: 11, color: colors.mochaBrown },
});

export default Field;
