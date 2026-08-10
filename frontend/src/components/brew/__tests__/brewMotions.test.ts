// 절차적 동작 표가 '런타임에 터지지 않는지' 확인한다.
//
// Animated.interpolate는 inputRange가 반드시 오름차순이어야 하고, 아니면 화면을 그리는
// 순간에 던진다. 표에 동작을 한 줄 더 얹는 게 곧 새 동작인 구조라(brewMotions.ts) 손으로
// 적다가 구간을 뒤집어 놓기 쉬운데, 그 실수는 타입 검사에 안 걸리고 그 포즈를 실제로
// 띄워 봐야만 드러난다 — 그래서 표 전체를 여기서 한 번에 훑는다.
import { Animated } from 'react-native';

import { buildMotion, IDLE_MOTIONS, MOTIONS, type MotionName } from '../brewMotions';

const NAMES = Object.keys(MOTIONS) as MotionName[];

describe('brewMotions 표', () => {
  it.each(NAMES)('%s: interpolate 구간이 오름차순이다', (name) => {
    const value = new Animated.Value(0);
    const original = value.interpolate.bind(value);
    const ranges: number[][] = [];
    // 테스트에서만 가로채 설정값을 들여다본다 (interpolate는 읽기 전용이 아니다)
    value.interpolate = (config) => {
      ranges.push(config.inputRange);
      return original(config);
    };

    MOTIONS[name].tf(value, 240);

    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      for (let i = 1; i < range.length; i += 1) {
        expect(range[i]).toBeGreaterThan(range[i - 1]);
      }
    }
  });

  it.each(NAMES)('%s: 동작이 도달하는 값이 interpolate 구간 안에 있다', (name) => {
    // steps가 -1까지 가는데 tf는 0~1만 받는 식으로 어긋나면, 화면에서 동작이 잘려 보인다.
    // (에러는 안 나고 조용히 끝값에 붙어 버려서 눈으로도 놓치기 쉽다)
    const value = new Animated.Value(0);
    const original = value.interpolate.bind(value);
    const ranges: number[][] = [];
    // 위와 같은 이유
    value.interpolate = (config) => {
      ranges.push(config.inputRange);
      return original(config);
    };
    MOTIONS[name].tf(value, 240);

    const reached = MOTIONS[name].steps.map(([to]) => to).concat(0);
    const lo = Math.min(...reached);
    const hi = Math.max(...reached);
    for (const range of ranges) {
      expect(range[0]).toBeLessThanOrEqual(lo);
      expect(range[range.length - 1]).toBeGreaterThanOrEqual(hi);
    }
  });

  it.each(NAMES)('%s: buildMotion이 애니메이션을 만든다', (name) => {
    const anim = buildMotion(name, new Animated.Value(0));
    expect(typeof anim.start).toBe('function');
    expect(typeof anim.stop).toBe('function');
  });

  it('잔동작 목록은 전부 실재하는 동작을 가리킨다', () => {
    for (const name of IDLE_MOTIONS) {
      expect(MOTIONS[name]).toBeDefined();
    }
  });
});
