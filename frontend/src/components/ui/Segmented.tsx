// 슬라이딩 세그먼트 컨트롤 — 선택 시 흰 알약이 스프링으로 스르륵 이동
import { useEffect, useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography, shadows } from '../../theme';

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
      speed: 26, // [스프링 튜닝] 더 기민하고 신속한 이동
      bounciness: 4, // 쫀득한 안착을 위해 오버슛을 감소시킴
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
    backgroundColor: 'rgba(140, 111, 86, 0.08)', // [글라스모피즘 트랙] 부드러운 반투명 베이지
    borderRadius: 12,
    padding: 4,
    borderWidth: 0.8,
    borderColor: 'rgba(140, 111, 86, 0.05)',
    position: 'relative',
  },
  pill: {
    position: 'absolute',
    top: 4,
    left: 4,
    bottom: 4,
    backgroundColor: colors.pointOrange, // [iOS 스타일] 사장님이 선택하신 딥 토프 브라운 (#6B5E55) 탑재
    borderRadius: 9,
    // [한글 주석: 안심 그림자 기입] 웹 런타임 스타일 붕괴를 예방하기 위한 직접 기입그림자
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  item: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  text: { fontSize: 12, fontWeight: '700', color: '#9C8875', letterSpacing: -0.2 }, // 비선택 텍스트
  textActive: { color: colors.white, fontWeight: '800' }, // 선택 텍스트 (딥 브라운 캡슐 위에 하얗게 선명히 안착)
});
