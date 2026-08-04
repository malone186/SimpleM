// 반응형 스케일 · 브레이크포인트 시스템
//
// [왜 필요한가]
// 디자인 시안은 390×844(최신 표준 폰) 기준으로 그려졌다. 그대로 픽셀을 박아 두면
//  • 갤럭시 Z 플립 커버 화면(≈260dp)·아이폰 SE(320dp) 에서는 카드가 화면 밖으로 나가고
//  • 갤럭시 Z 폴드 펼침(≈673dp)·태블릿에서는 한 줄짜리 레이아웃이 허옇게 늘어난다.
//
// [두 축으로 나눠 푼다]
//  1) 정적 스케일 s()/vs()/ms() — StyleSheet.create 시점에 한 번 계산. 여백·반경·아이콘용.
//  2) 동적 훅 useResponsive() — useWindowDimensions 기반이라 '접었다 펴는' 순간에도 다시 계산된다.
//     열 개수·최대 폭·지도 높이처럼 레이아웃을 좌우하는 값은 반드시 이쪽을 쓴다.
//     (size-matters 의 스케일 값은 모듈 로드 시점에 고정되므로 폴더블에서는 신뢰할 수 없다)
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { PixelRatio, Platform, useWindowDimensions } from 'react-native';
import { scale as smScale, verticalScale as smVerticalScale } from 'react-native-size-matters';
import {
  heightPercentageToDP as hp,
  widthPercentageToDP as wp,
} from 'react-native-responsive-screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// 디자인 시안 기준 해상도 (dp)
export const BASE_WIDTH = 390;
export const BASE_HEIGHT = 844;

// react-native-size-matters 의 내장 기준값 (350×680) — 우리 시안 기준으로 되돌리기 위해 필요
const SM_BASE_WIDTH = 350;
const SM_BASE_HEIGHT = 680;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// [한글 주석] 스케일 상·하한을 두는 이유
// 폴드 펼침(673dp)은 시안 대비 1.72배다. 이 비율을 그대로 곱하면 글자가 우스꽝스럽게 커지고
// 한 화면에 들어가던 정보가 오히려 줄어든다. 작은 화면도 마찬가지로 무한정 줄이면 못 읽는다.
// 크기는 살짝만 따라가게 묶고(0.85~1.15), 남는 공간은 '열을 늘리는' 쪽으로 쓴다.
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.15;

// size-matters 가 계산한 원본 비율(shortDimension / 350)을 되받아 우리 기준으로 환산한다.
const RAW_WIDTH_RATIO = (smScale(100) / 100) * (SM_BASE_WIDTH / BASE_WIDTH); // = shortSide / 390
const RAW_HEIGHT_RATIO = (smVerticalScale(100) / 100) * (SM_BASE_HEIGHT / BASE_HEIGHT); // = longSide / 844

const WIDTH_RATIO = clamp(RAW_WIDTH_RATIO, MIN_SCALE, MAX_SCALE);
const HEIGHT_RATIO = clamp(RAW_HEIGHT_RATIO, MIN_SCALE, MAX_SCALE);

/** 가로 기준 스케일 — 여백·폭·아이콘 크기 */
export const s = (size: number) => Math.round(size * WIDTH_RATIO);

/** 세로 기준 스케일 — 세로 여백·행 높이 */
export const vs = (size: number) => Math.round(size * HEIGHT_RATIO);

/** 완만한 스케일 — 글자처럼 과하게 변하면 안 되는 값 (factor 0=고정, 1=완전 비례) */
export const ms = (size: number, factor = 0.5) =>
  Math.round(size + (size * WIDTH_RATIO - size) * factor);

/**
 * 글자 크기 전용 스케일.
 * OS 접근성 '글자 크게'가 1.3배를 넘어가면 버튼 라벨이 두 줄로 터지고 카드가 무너진다.
 * RN 이 fontSize 에 OS 배율을 자동으로 곱하므로, 초과분을 미리 나눠서 상한을 만든다.
 */
export const MAX_FONT_MULTIPLIER = 1.3;
export const fs = (size: number) => {
  const osScale = PixelRatio.getFontScale();
  const correction = osScale > MAX_FONT_MULTIPLIER ? MAX_FONT_MULTIPLIER / osScale : 1;
  return Math.round(ms(size, 0.4) * correction * 100) / 100;
};

/**
 * react-native-responsive-screen 의 퍼센트 → dp 변환.
 *
 * ⚠️ StyleSheet.create 안(모듈 최상단)에서는 쓰지 말 것.
 * 이 함수들은 호출 시점의 Dimensions 를 읽는데, StyleSheet 는 모듈 로드 때 딱 한 번 평가된다.
 * 그래서 앱이 아직 화면 크기를 모르는 순간에 0이 박히거나(로고가 0×0으로 사라졌던 실제 사례),
 * 폴더블을 펼쳐도 접힌 상태의 값이 그대로 남는다.
 * 컴포넌트 안에서 써야 하는 값은 useResponsive() 의 vw()/vh() 를 쓴다.
 */
export { hp, wp };

// ── 브레이크포인트 ────────────────────────────────────────────────────────────
// 기준은 '창의 가로 폭'(dp). 회전·폴더블 펼침에 즉시 반응해야 하므로 훅에서만 판정한다.
export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const BREAKPOINTS = {
  /** 갤럭시 Z 플립 커버 화면, 아이폰 SE 1세대 */
  xs: 0,
  /** 아이폰 SE2/3(375), 갤럭시 Z 폴드 접힘(344) */
  sm: 340,
  /** 아이폰 14/15(390·393), 갤럭시 S(412) — 시안 기준 구간 */
  md: 384,
  /** Pro Max / Ultra (430·440) */
  lg: 430,
  /** 갤럭시 Z 폴드 펼침(≈673), 태블릿 */
  xl: 600,
} as const;

export function breakpointOf(width: number): Breakpoint {
  if (width >= BREAKPOINTS.xl) return 'xl';
  if (width >= BREAKPOINTS.lg) return 'lg';
  if (width >= BREAKPOINTS.md) return 'md';
  if (width >= BREAKPOINTS.sm) return 'sm';
  return 'xs';
}

export type ResponsiveInfo = {
  width: number;
  height: number;
  /** 짧은 변 — 회전과 무관한 '기기 급수' 판정용 */
  shortSide: number;
  bp: Breakpoint;
  isLandscape: boolean;
  /** 플립 커버 화면급 초소형 — 장식 요소를 접고 필수 정보만 남긴다 */
  isXS: boolean;
  /** SE·폴드 접힘급 — 2열 그리드를 1열로 내린다 */
  isCompact: boolean;
  /** 폴드 펼침·태블릿 — 열을 늘리고 본문 폭을 제한한다 */
  isWide: boolean;
  /** 세로로 짧은 화면(가로모드·플립 커버) — 세로 여백을 줄인다 */
  isShortViewport: boolean;
  /** 본문 최대 폭 — 폴드 펼침에서 글줄이 지나치게 길어지는 것을 막는다 */
  contentMaxWidth: number;
  /** 화면 좌우 기본 여백 */
  gutter: number;
  /** 폭에 따라 살아 움직이는 스케일 (폴더블 전개 대응) */
  rs: (size: number) => number;
  /** 최소 항목 폭을 주면 들어갈 수 있는 열 개수를 돌려준다 */
  columns: (minItemWidth: number, max?: number) => number;
  /** 현재 화면 가로 폭의 n% (모듈 로드 시점에 고정되는 wp() 와 달리 회전·전개에 즉시 반응) */
  vw: (percent: number) => number;
  /** 현재 화면 세로 높이의 n% */
  vh: (percent: number) => number;
};

const CONTENT_MAX_WIDTH = 560; // 폴드 펼침에서도 한 손에 읽히는 글줄 길이 상한

// [한글 주석] 뷰포트 override
// 웹 미리보기는 앱을 420×850 목업 폰 안에 그린다. 이때 브라우저 창은 1280이라도
// 앱이 실제로 쓰는 폭은 404다. override 가 없으면 "폴드 펼침"으로 잘못 판정해
// 데모 화면이 실기기와 다르게 보인다. DeviceFrame 이 프레임 내부 크기를 여기에 넣어 준다.
const ViewportContext = createContext<{ width: number; height: number } | null>(null);

export function ViewportProvider({
  value,
  children,
}: {
  value: { width: number; height: number } | null;
  children: ReactNode;
}) {
  return createElement(ViewportContext.Provider, { value }, children);
}

/**
 * 순수 계산부 — 훅 바깥에 두어 렌더러 없이 테스트할 수 있게 한다.
 * (기종별 판정은 실기기를 매번 못 돌려보므로 responsive.test.ts 로 회귀를 막는다)
 */
export function computeResponsive(width: number, height: number): ResponsiveInfo {
  {
    const shortSide = Math.min(width, height);
    const bp = breakpointOf(width);
    const isLandscape = width > height;
    const isXS = bp === 'xs';
    const isCompact = bp === 'xs' || bp === 'sm';
    const isWide = bp === 'xl';
    const isShortViewport = height < 620;

    const ratio = clamp(width / BASE_WIDTH, MIN_SCALE, MAX_SCALE);
    const rs = (size: number) => Math.round(size * ratio);

    const gutter = isXS ? 12 : isCompact ? 16 : isWide ? 24 : 20;
    const contentMaxWidth = isWide ? CONTENT_MAX_WIDTH : width;

    const columns = (minItemWidth: number, max = 4) => {
      const usable = Math.min(width, contentMaxWidth) - gutter * 2;
      const fit = Math.floor((usable + 10) / (minItemWidth + 10));
      return clamp(fit, 1, max);
    };

    return {
      width,
      height,
      shortSide,
      bp,
      isLandscape,
      isXS,
      isCompact,
      isWide,
      isShortViewport,
      contentMaxWidth,
      gutter,
      rs,
      columns,
      vw: (percent: number) => Math.round((width * percent) / 100),
      vh: (percent: number) => Math.round((height * percent) / 100),
    };
  }
}

export function useResponsive(): ResponsiveInfo {
  const win = useWindowDimensions();
  const override = useContext(ViewportContext);
  const width = override?.width ?? win.width;
  const height = override?.height ?? win.height;

  return useMemo(() => computeResponsive(width, height), [width, height]);
}

/**
 * 상단 헤더가 없는 화면(탭 직속)에서 쓸 상태바 여백.
 *
 * 예전에는 Platform.select({ android: StatusBar.currentHeight+4, ios: 56 }) 처럼 계산했는데
 * iOS 56은 노치 없는 SE(20pt)에서는 과하고 다이나믹 아일랜드(59pt)에서는 모자랐다.
 * SafeArea inset 이 기기가 실제로 보고하는 값이므로 그걸 우선하고, 웹 미리보기처럼
 * inset 이 0으로 오는 환경에서만 최소값으로 받쳐 준다.
 */
export function useTopInset(minimum?: number) {
  const insets = useSafeAreaInsets();
  // 웹 미리보기는 DeviceFrame 의 목업 노치(26px)가 있어 inset 0으로도 글자가 가린다 → 44 로 받쳐 준다.
  const floor = minimum ?? (Platform.OS === 'web' ? 44 : 8);
  return Math.max(insets.top, floor);
}

/**
 * 하단 여백 — 아이폰 홈 인디케이터·갤럭시 제스처 바에 콘텐츠가 물리지 않게.
 * 탭 바가 있는 화면은 extra 로 탭 바 높이를 더 얹는다.
 */
export function useBottomInset(minimum = 12) {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, minimum);
}

/**
 * 가로모드/노치 있는 기기를 옆으로 눕혔을 때 좌우 카메라 컷아웃 영역.
 * 세로 모드에서는 0이라 그냥 더해도 안전하다.
 */
export function useHorizontalInsets() {
  const insets = useSafeAreaInsets();
  return { left: insets.left, right: insets.right };
}

/**
 * 그리드 항목 폭을 '퍼센트'로 돌려준다.
 * flexBasis 에 넣으면 열 개수가 바뀌어도 gap 이 어긋나지 않는다.
 */
export function gridItemBasis(columns: number, gapPercent = 2) {
  if (columns <= 1) return '100%' as const;
  const totalGap = gapPercent * (columns - 1);
  return `${(100 - totalGap) / columns}%` as `${number}%`;
}

/** 웹(반응형 미리보기)에서만 참인 조건 — 기기 프레임 계산 등에 사용 */
export const isWeb = Platform.OS === 'web';
