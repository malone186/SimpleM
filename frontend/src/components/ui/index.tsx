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
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing, typography } from '../../theme';
import { fs, s, useResponsive } from '../../theme/responsive';
import { FadeInUp, PressableScale } from '../motion';

// 진입 애니메이션에서 순차 지연을 줄 최대 개수 — 그 뒤 항목은 함께 나타난다.
const STAGGER_MAX_ITEMS = 7;

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
//
// [반응형] 기기별로 달라지는 세 가지를 여기서 한 번에 처리한다.
//  • safeTop: 헤더가 없는 탭 화면은 노치/펀치홀 아래에서 시작해야 한다 (기본값은 헤더가 있다고 가정)
//  • 하단 여백: 갤럭시 제스처 바·아이폰 홈 인디케이터 높이를 실측해서 더한다
//  • 최대 폭: 폴드를 펼치면 673dp 라 한 줄 글이 지나치게 길어진다 → 가운데 정렬 + 폭 제한
export function Screen({
  children,
  safeTop = false,
  withTabBar = false,
}: {
  children: ReactNode;
  /** 상단 헤더가 없는 화면(탭 직속)에서 true — 상태바 높이만큼 띄운다 */
  safeTop?: boolean;
  /** 하단 탭 바가 있는 화면에서 true — 마지막 카드가 탭 바에 가리지 않게 여백을 더 준다 */
  withTabBar?: boolean;
}) {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { gutter, contentMaxWidth, isWide, isShortViewport } = useResponsive();
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

  // [한글 주석] 세로가 짧은 화면(가로모드·플립 커버)에서는 상하 여백을 줄여 본문을 확보한다.
  const verticalPad = isShortViewport ? s(12) : s(20);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.screenContent,
          {
            paddingHorizontal: gutter,
            paddingTop: verticalPad + (safeTop ? insets.top : 0),
            // 하단 제스처 바 + 탭 바(있을 때) 높이를 실측해서 마지막 카드가 잘리지 않게 한다
            paddingBottom: verticalPad + insets.bottom + (withTabBar ? s(72) : s(28)),
            gap: isShortViewport ? s(14) : spacing.verticalGap,
          },
          // 폴드 펼침·태블릿에서만 폭을 묶고 가운데로 모은다
          isWide && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
        ]}
        showsVerticalScrollIndicator={false}
        // 기본값('never')이면 키보드가 떠 있을 때의 첫 탭이 키보드를 내리는 데 쓰이고 버려진다.
        // 금액을 입력한 뒤 바로 옆 선택지를 누르면 "눌러도 선택이 안 된다"고 느끼던 원인.
        keyboardShouldPersistTaps="handled"
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
          // 등장 지연은 앞쪽 몇 개까지만 준다. 예전엔 i * 70ms를 무제한으로 걸어서,
          // 메뉴가 40개인 매장은 마지막 카드가 2.8초 뒤에야 나타났다 — 사장님 눈에는
          // 화면이 멈춘 것(렉)처럼 보였다. 목록이 길수록 첫 화면이 바로 서야 한다.
          <FadeInUp key={`${runId}-${i}`} delay={Math.min(i, STAGGER_MAX_ITEMS) * 60}>
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
  onLayout,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: 'white' | 'cream';
  /** 목록에서 이 카드의 위치를 알아야 할 때 (예: 알림에서 넘어와 해당 항목으로 스크롤) */
  onLayout?: ViewProps['onLayout'];
}) {
  return (
    <View onLayout={onLayout} style={[styles.card, tone === 'cream' ? styles.cardCream : styles.cardWhite, style]}>
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
  // [한글 주석] 여백은 전부 Screen 안에서 기기별로 계산해 인라인으로 덮어쓴다.
  // 예전에는 paddingTop: 45 / paddingBottom: 48 처럼 숫자를 박아 뒀는데,
  // 다이나믹 아일랜드(59pt)에서는 제목이 가리고 갤럭시 제스처 바에서는 마지막 카드가 잘렸다.
  screenContent: {
    flexGrow: 1,
  },
  screenTitleWrap: { marginBottom: 4 },
  screenTitle: { ...typography.L1, color: colors.espressoBrown },
  screenSubtitle: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  card: { borderRadius: s(20), padding: spacing.globalPadding, borderWidth: 1 },
  cardWhite: { backgroundColor: colors.white, borderColor: 'rgba(140,111,86,0.18)' },
  cardCream: { backgroundColor: colors.coffeeCream, borderColor: colors.mutedSand },
  sectionTitle: {
    ...typography.L3,
    fontSize: fs(15), // 본문 텍스트보다 명확히 돋보이는 가독성 크기
    fontWeight: '800', // 타이틀 강조를 위한 볼드 처리
    color: colors.espressoBrown,
    marginBottom: 6, // 하단 정보와의 여유로운 조형적 여백
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: s(9),
    paddingVertical: s(3),
    alignSelf: 'flex-start',
    flexShrink: 1, // [한글 주석] 좁은 화면에서 배지가 옆 요소를 밀어내지 않게 줄어들 수 있게 한다
  },
  badgeText: { ...typography.L5, fontWeight: '700' },
  btn: {
    borderRadius: s(14),
    paddingVertical: s(13),
    paddingHorizontal: s(18),
    // [한글 주석] 손가락 터치 최소 영역(44dp) 보장 — 작은 화면에서 패딩이 줄어도 누르기 어려워지지 않게
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
