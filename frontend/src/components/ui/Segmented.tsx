// 슬라이딩 세그먼트 컨트롤 — 선택 시 흰 알약이 스프링으로 스르륵 이동
import { useEffect, useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../../theme';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const [width, setWidth] = useState(0);
  const pos = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const pad = 4;
  const pillWidth = width > 0 ? (width - pad * 2) / options.length : 0;

  useEffect(() => {
    Animated.spring(pos, {
      toValue: index * pillWidth,
      useNativeDriver: true,
      speed: 16,
      bounciness: 8,
    }).start();
  }, [index, pillWidth, pos]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.track} onLayout={onLayout}>
      {pillWidth > 0 && (
        <Animated.View
          style={[
            styles.pill,
            { width: pillWidth, transform: [{ translateX: pos }] },
          ]}
        />
      )}
      {options.map((o) => (
        <Pressable key={o.value} style={styles.item} onPress={() => onChange(o.value)}>
          <Text style={[styles.text, value === o.value && styles.textActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    position: 'relative',
  },
  pill: {
    position: 'absolute',
    top: 4,
    left: 4,
    bottom: 4,
    backgroundColor: colors.white,
    borderRadius: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  item: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  text: { ...typography.L4, color: colors.mochaBrown },
  textActive: { color: colors.espressoBrown },
});
