// 절차적 동작 사전 — 그림을 굽지 않고 만드는 움직임.
//
// 왜 이게 필요한가: 전신 모션 5종(손인사·점프·댄스·dab·팔벌려뛰기)은 원화를 리깅해
// 모션캡처를 입혀 20프레임으로 구운 것인데, 리깅 원본이 남아 있지 않아 같은 방식으로
// 새 동작을 만들 수 없다(scripts/bake_mascot.py 머리말 참고). 그래서 동작을 늘리는
// 길을 '프레임을 더 굽는다'에서 '한 장에 transform을 건다'로 옮겼다.
//
// 원래도 bounce·wave·pour는 이 방식이었다(그림 한 장에 translateY·rotate). 그게 컴포넌트
// 안에 if로 박혀 있어서 늘릴 때마다 분기가 늘었는데, 여기 표로 빼면 한 줄 추가가 곧 새 동작이다.
//
// 제약: 브루는 포즈마다 완성된 그림 한 장이라 팔다리를 따로 못 움직인다. 여기 있는 건
// 전부 '몸 전체'를 어떻게 흔드느냐다. 부위를 따로 움직이려면 clipboard처럼 레이어를
// 분리한 그림이 따로 필요하다(Brew.tsx의 PART_ANIM).
import { Animated, Easing } from 'react-native';

import { startLoop } from '../../lib/animLoop';

/** 한 구간: [도달값, 걸리는 시간(ms)] — 값은 0~1 사이의 '진행도'다. */
type Step = [number, number];

export type MotionSpec = {
  /** 재생 순서. 마지막 구간이 끝나면 loop면 처음부터 다시. */
  steps: Step[];
  /** 구간 사이에 쉬는 시간(ms). 잔동작을 '가끔' 하는 것처럼 보이게 한다. */
  rest?: number;
  /** 진행도 → transform. dim은 캐릭터 한 변 크기(px) — 크기에 비례해 움직이게. */
  tf: (p: Animated.Value, dim: number) => any[];
  /** 안 적으면 반복 재생 */
  once?: boolean;
};

const ease = Easing.inOut(Easing.sin);

/** -1~1을 오가는 왕복 (좌우 흔들기용) */
const swing = (dur: number): Step[] => [[1, dur], [-1, dur * 2], [0, dur]];

export const MOTIONS = {
  // ── 기존에 있던 셋 (동작은 그대로, 자리만 옮겼다) ────────────────────────
  bounce: {
    steps: [[1, 1250], [0, 1250]],
    tf: (p, dim) => [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, -dim * 0.083] }) }],
  },
  wave: {
    steps: swing(620),
    tf: (p) => [{ rotate: p.interpolate({ inputRange: [-1, 1], outputRange: ['-5deg', '5deg'] }) }],
  },
  pour: {
    steps: [[1, 1400], [0, 1400]],
    tf: (p) => [{ rotate: p.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '3deg'] }) }],
  },

  // ── 새로 는 것들 ──────────────────────────────────────────────────────────
  /** 숨쉬기 — 가만히 있어도 죽어 보이지 않게. 가장 약한 기본 잔동작. */
  breathe: {
    steps: [[1, 1900], [0, 1900]],
    tf: (p) => [
      { scaleY: p.interpolate({ inputRange: [0, 1], outputRange: [1, 1.018] }) },
      { scaleX: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.994] }) },
    ],
  },
  /** 고개 끄덕 — 알아들었다는 반응. 두 번 끄덕이고 쉰다. */
  nod: {
    steps: [[1, 220], [0, 240], [1, 220], [0, 260]],
    rest: 2600,
    tf: (p, dim) => [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, dim * 0.035] }) }],
  },
  /** 갸웃 — 궁금할 때. 천천히 기울였다 되돌아온다. */
  tilt: {
    steps: [[1, 780], [1, 420], [0, 700]],
    rest: 2400,
    tf: (p) => [{ rotate: p.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-9deg'] }) }],
  },
  /** 폴짝 — 뛰어오르며 늘어났다가 착지에서 눌린다(스쿼시·스트레치).
   *  진행도를 0→1로 한 번 흘리고 그 안에서 위치·찌그러짐을 같이 뽑는다. */
  hop: {
    steps: [[1, 620]],
    rest: 1500,
    tf: (p, dim) => [
      {
        translateY: p.interpolate({
          inputRange: [0, 0.15, 0.5, 0.85, 1],
          outputRange: [0, dim * 0.02, -dim * 0.16, 0, 0], // 살짝 앉았다 → 뜀 → 착지
        }),
      },
      {
        scaleY: p.interpolate({
          inputRange: [0, 0.15, 0.35, 0.85, 0.95, 1],
          outputRange: [1, 0.93, 1.06, 1, 0.94, 1], // 눌림 → 늘어남 → 착지에 다시 눌림
        }),
      },
      {
        scaleX: p.interpolate({
          inputRange: [0, 0.15, 0.35, 0.85, 0.95, 1],
          outputRange: [1, 1.06, 0.96, 1, 1.05, 1],
        }),
      },
    ],
  },
  /** 이동용 폴짝 — hop과 같은데 쉬는 구간이 없다.
   *  무대를 가로질러 갈 때 쓴다. hop(쉼 1.5초)을 그대로 쓰면 대부분의 시간을 안 뛰고
   *  미끄러지기만 해서 '걷는다'가 아니라 '떠서 이동한다'로 보인다. */
  walk: {
    steps: [[1, 520]],
    tf: (p, dim) => [
      { translateY: p.interpolate({ inputRange: [0, 0.12, 0.5, 0.88, 1], outputRange: [0, dim * 0.015, -dim * 0.1, 0, 0] }) },
      { scaleY: p.interpolate({ inputRange: [0, 0.12, 0.3, 0.88, 0.96, 1], outputRange: [1, 0.95, 1.04, 1, 0.96, 1] }) },
      { scaleX: p.interpolate({ inputRange: [0, 0.12, 0.3, 0.88, 0.96, 1], outputRange: [1, 1.04, 0.97, 1, 1.03, 1] }) },
    ],
  },
  /** 부르르 — 추울 때·놀랐을 때. 빠르고 작게 떤다. */
  shiver: {
    steps: [[1, 55], [-1, 55], [1, 55], [-1, 55], [1, 55], [0, 55]],
    rest: 3200,
    tf: (p, dim) => [{ translateX: p.interpolate({ inputRange: [-1, 1], outputRange: [-dim * 0.012, dim * 0.012] }) }],
  },
  /** 기지개 — 심심할 때. 위로 쭉 늘어났다 돌아온다. */
  stretch: {
    steps: [[1, 900], [1, 500], [0, 700]],
    rest: 5200,
    tf: (p, dim) => [
      { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, -dim * 0.045] }) },
      { scaleY: p.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }) },
      { scaleX: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) },
    ],
  },
  /** 두리번 — 주변을 살핀다. 좌우로 천천히 몸을 튼다. */
  lookAround: {
    steps: [[1, 700], [1, 500], [-1, 900], [-1, 500], [0, 700]],
    rest: 3400,
    tf: (p, dim) => [
      { translateX: p.interpolate({ inputRange: [-1, 1], outputRange: [-dim * 0.03, dim * 0.03] }) },
      { rotate: p.interpolate({ inputRange: [-1, 1], outputRange: ['3deg', '-3deg'] }) },
    ],
  },
  /** 신남 — 좋은 소식. 짧게 두 번 통통 튄다. */
  excited: {
    steps: [[1, 200], [0, 220], [1, 200], [0, 240]],
    rest: 1800,
    tf: (p, dim) => [
      { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, -dim * 0.1] }) },
      { scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) },
    ],
  },
  /** 축 처짐 — 안 좋은 소식. 아래로 가라앉아 한동안 머문다. */
  droop: {
    steps: [[1, 900], [1, 2200], [0, 1100]],
    rest: 2000,
    tf: (p, dim) => [
      { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, dim * 0.03] }) },
      { rotate: p.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '4deg'] }) },
      { scaleY: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) },
    ],
  },
} satisfies Record<string, MotionSpec>;

export type MotionName = keyof typeof MOTIONS;

/** 잔동작으로 끼워 넣어도 어색하지 않은 것들 — BrewBrain이 여기서 고른다. */
export const IDLE_MOTIONS: MotionName[] = ['breathe', 'nod', 'tilt', 'lookAround', 'stretch', 'hop'];

/** 표의 steps를 한 바퀴짜리 애니메이션으로 만든다. */
export function buildMotion(name: MotionName, value: Animated.Value): Animated.CompositeAnimation {
  const spec: MotionSpec = MOTIONS[name];
  const seq: Animated.CompositeAnimation[] = [];
  let prev = 0;
  for (const [to, dur] of spec.steps) {
    // 같은 값이 연달아 오면 '그 자세로 버티기' — timing 대신 delay가 맞다
    seq.push(
      to === prev
        ? Animated.delay(dur)
        : Animated.timing(value, { toValue: to, duration: dur, easing: ease, useNativeDriver: true }),
    );
    prev = to;
  }
  if (spec.rest) seq.push(Animated.delay(spec.rest));
  // 마지막이 0으로 안 끝나면 다음 사이클 시작 위치가 튄다 — 조용히 되돌린다
  if (prev !== 0 && !spec.once) {
    seq.push(Animated.timing(value, { toValue: 0, duration: 1, useNativeDriver: true }));
  }
  return Animated.sequence(seq);
}

/**
 * 동작을 시작한다. 반복 동작은 끝날 때마다 다시 시작한다 — Animated.loop을 쓰지 않는 이유는
 * animLoop.ts 참고(웹에서 한 바퀴만 돌고 멈춘다).
 * 돌려주는 함수를 호출하면 멈춘다.
 */
export function startMotion(name: MotionName, value: Animated.Value): () => void {
  const spec: MotionSpec = MOTIONS[name];
  if (spec.once) {
    const run = buildMotion(name, value);
    run.start();
    return () => run.stop();
  }
  return startLoop(() => buildMotion(name, value)).stop;
}
