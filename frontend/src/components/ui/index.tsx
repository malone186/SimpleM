// 공용 UI 킷 — 디자인 스펙 색상/타이포/간격 기반. 모든 화면에서 재사용.
import { Children, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';

import { colors, spacing, typography } from '../../theme';
import { FadeInUp, PressableScale } from '../motion';

// 화면 상단 타이틀 헤더
export function ScreenTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.screenTitleWrap}>
      <Text style={styles.screenTitle}>{title}</Text>
      {subtitle ? <Text style={styles.screenSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

// 스크롤 가능한 화면 컨테이너 — 진입 시 자식들이 순차로 떠오르고(토스식 stagger),
// 탭 포커스될 때마다 다시 재생된다.
export function Screen({ children }: { children: ReactNode }) {
  const isFocused = useIsFocused();
  const [runId, setRunId] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (isFocused) setRunId((x) => x + 1);
  }, [isFocused]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setRunId((x) => x + 1); // 새로고침하면 콘텐츠가 다시 순차 등장
      setRefreshing(false);
    }, 650);
  }, []);

  const items = Children.toArray(children);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.screenContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.mochaBrown}
            colors={[colors.pointOrange]}
          />
        }
      >
        {items.map((child, i) => (
          <FadeInUp key={`${runId}-${i}`} delay={i * 70}>
            {child}
          </FadeInUp>
        ))}
      </ScrollView>
    </View>
  );
}

// 카드 컨테이너
export function Card({
  children,
  style,
  tone = 'white',
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: 'white' | 'cream';
}) {
  return (
    <View style={[styles.card, tone === 'cream' ? styles.cardCream : styles.cardWhite, style]}>
      {children}
    </View>
  );
}

// 섹션 제목 (카드 위 라벨)
export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

type BadgeTone = 'green' | 'orange' | 'neutral' | 'danger';

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  const toneStyle = {
    green: { bg: colors.trendGreenBg, fg: colors.trendGreenText },
    orange: { bg: '#F7E4D6', fg: colors.pointOrange },
    neutral: { bg: colors.coffeeCream, fg: colors.mochaBrown },
    danger: { bg: '#F6DED8', fg: '#B23B2E' },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: toneStyle.bg }]}>
      <Text style={[styles.badgeText, { color: toneStyle.fg }]}>{label}</Text>
    </View>
  );
}

// 기본 버튼 (primary=오렌지 액션 / secondary=외곽선)
// [한글 주석] textStyle 프로퍼티를 추가하여 버튼 내부 텍스트 폰트 크기 등을 호출부에서 커스텀할 수 있게 합니다.
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
  textStyle,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.btn,
        variant === 'primary' && styles.btnPrimary,
        variant === 'secondary' && styles.btnSecondary,
        variant === 'ghost' && styles.btnGhost,
        disabled && styles.btnDisabled,
        style,
      ]}
    >
      <Text
        style={[
          styles.btnText,
          variant === 'primary' && { color: colors.white },
          variant === 'secondary' && { color: colors.espressoBrown },
          variant === 'ghost' && { color: colors.mochaBrown },
          textStyle, // [한글 주석] 외부에서 넘겨받은 커스텀 폰트 스타일을 덮어씌웁니다.
        ]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

// 진행 바 (재고 수준 등)
export function ProgressBar({ ratio, tone = 'mocha' }: { ratio: number; tone?: 'mocha' | 'green' | 'danger' }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const barColor = { mocha: colors.mochaBrown, green: colors.trendGreenText, danger: '#B23B2E' }[tone];
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${clamped * 100}%`, backgroundColor: barColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.creamSand },
  screenContent: {
    padding: spacing.globalPadding,
    paddingTop: 45, // [중요] 노치바 및 상태바 시스템 글자 겹침을 방지하기 위한 안전 높이 적용
    paddingBottom: 32,
    gap: spacing.verticalGap,
  },
  screenTitleWrap: { marginBottom: 4 },
  screenTitle: { ...typography.L1, color: colors.espressoBrown },
  screenSubtitle: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  card: { borderRadius: 20, padding: spacing.globalPadding, borderWidth: 1 },
  cardWhite: { backgroundColor: colors.white, borderColor: 'rgba(140,111,86,0.18)' },
  cardCream: { backgroundColor: colors.coffeeCream, borderColor: colors.mutedSand },
  sectionTitle: {
    ...typography.L3,
    fontSize: 15, // 본문 텍스트보다 명확히 돋보이는 가독성 크기
    fontWeight: '800', // 타이틀 강조를 위한 볼드 처리
    color: colors.espressoBrown,
    marginBottom: 6, // 하단 정보와의 여유로운 조형적 여백
  },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { ...typography.L5, fontWeight: '700' },
  btn: { borderRadius: 14, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.pointOrange },
  btnSecondary: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.mutedSand },
  btnGhost: { backgroundColor: 'transparent' },
  btnDisabled: { opacity: 0.4 },
  btnText: { ...typography.L3 },
  divider: { height: 1, backgroundColor: colors.mutedSand },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: colors.mutedSand, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
});

export * from './IosTimePicker';
// [한글 주석] 신규 복원된 요일 버튼 그룹 컴포넌트를 공용 UI 킷에서 내보냅니다.
export * from './WeekdayButtonGroup';
