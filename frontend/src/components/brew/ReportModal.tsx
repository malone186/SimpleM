// 브루 등장 지도 #3(로딩: 드립 내리는 브루) + #4(리포트 서명: "— 브루 드림")
// AI 리포트를 "브루가 나에게 쓴 편지"로 만든다.
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../../theme';
import { PressableScale } from '../motion';
import Brew from './Brew';

export default function ReportModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<'brewing' | 'done'>('brewing');
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setPhase('brewing');
      Animated.spring(slide, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }).start();
      // 브루가 리포트를 "내리는" 로딩 연출
      const t = setTimeout(() => setPhase('done'), 1600);
      return () => clearTimeout(t);
    }
    Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start();
  }, [visible, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [500, 0] });
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

            {phase === 'brewing' ? (
              <View style={styles.brewing}>
                <Brew mood="pouring" size={180} framed />
                <Text style={styles.brewingText}>브루가 이번 주 리포트를 내리는 중…</Text>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.reportHead}>
                  <Brew mood="clipboard" size={72} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reportTitle}>이번 주 경영 리포트</Text>
                    <Text style={styles.reportDate}>7월 2주차 · 사장님께</Text>
                  </View>
                </View>

                <Text style={styles.letter}>
                  이번 주 매출은 지난주보다 <Text style={styles.hl}>8.2% 올랐어요</Text> 🎉{'\n\n'}
                  다만 원가율이 <Text style={styles.hl}>3%p 높아졌는데</Text>, 우유 단가가
                  2,200원에서 2,400원으로 오른 게 가장 큰 원인이에요. 특히 라떼 계열 마진이
                  눌리고 있어서, 라떼 가격을 조금 조정하거나 우유 거래처를 비교해보시길
                  추천드려요.{'\n\n'}
                  원두는 예가체프 소진이 빨라요. 발주 탭에 초안을 올려두었으니 확인만
                  해주시면 돼요.
                </Text>

                {/* 근거 숫자 (검증 가능하게) */}
                <View style={styles.evidence}>
                  <Ev label="주간 매출" value="₩2,984,000" delta="+8.2%" up />
                  <Ev label="원가율" value="32.4%" delta="+3.0%p" />
                  <Ev label="우유 단가" value="₩2,400" delta="+9.1%" />
                </View>

                <Text style={styles.sign}>— 브루 드림 ☕</Text>

                <PressableScale style={styles.closeBtn} onPress={onClose}>
                  <Text style={styles.closeText}>고마워요 브루</Text>
                </PressableScale>
              </ScrollView>
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function Ev({ label, value, delta, up }: { label: string; value: string; delta: string; up?: boolean }) {
  return (
    <View style={styles.ev}>
      <Text style={styles.evLabel}>{label}</Text>
      <Text style={styles.evValue}>{value}</Text>
      <Text style={[styles.evDelta, up && { color: colors.trendGreenText }]}>{delta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
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
  brewing: { alignItems: 'center', paddingVertical: 30 },
  brewingText: { ...typography.L4, color: colors.mochaBrown, marginTop: 8 },
  reportHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  reportTitle: { ...typography.L1, color: colors.espressoBrown },
  reportDate: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  letter: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 22 },
  hl: { color: colors.pointOrange, fontWeight: '700' },
  evidence: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 20,
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 14,
  },
  ev: { flex: 1, alignItems: 'center' },
  evLabel: { ...typography.L5, color: colors.mochaBrown },
  evValue: { ...typography.L3, color: colors.espressoBrown, marginTop: 4 },
  evDelta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  sign: { ...typography.L3, color: colors.espressoBrown, textAlign: 'right', marginTop: 20, fontStyle: 'italic' },
  closeBtn: { backgroundColor: colors.pointOrange, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  closeText: { ...typography.L3, color: colors.white },
});
