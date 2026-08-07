// 플립북 재생이 '깜빡이지 않는지' 검사한다.
//
// 처음 짠 크로스페이드는 두 프레임을 각각 반투명으로 겹쳤는데, 그러면 프레임이 넘어가는
// 동안 합성 알파가 0.66까지 떨어져 캐릭터가 배경이 비칠 만큼 옅어졌다. 초당 11번이라
// 눈에는 깜빡임으로 보였다. 화면을 띄워 봐야만 드러나는 종류의 버그라, 그 조건을 여기서
// 숫자로 못 박는다: 재생 내내 어느 순간에도 불투명한 한 장이 깔려 있어야 한다.
import { frameOpacityRange, seamOpacityRange } from '../Flipbook';

type Range = { inputRange: number[]; outputRange: number[] };

/** RN의 interpolate(extrapolate: 'clamp')와 같은 구간별 선형 보간 */
function evaluate({ inputRange, outputRange }: Range, t: number): number {
  if (t <= inputRange[0]) return outputRange[0];
  const last = inputRange.length - 1;
  if (t >= inputRange[last]) return outputRange[last];
  for (let i = 1; i <= last; i += 1) {
    if (t <= inputRange[i]) {
      const span = inputRange[i] - inputRange[i - 1];
      const ratio = span === 0 ? 1 : (t - inputRange[i - 1]) / span;
      return outputRange[i - 1] + (outputRange[i] - outputRange[i - 1]) * ratio;
    }
  }
  return outputRange[last];
}

/** 아래에서 위로 겹쳐 그렸을 때 최종 불투명도 (source-over 합성) */
function composite(opacities: number[]): number {
  return opacities.reduce((acc, a) => acc + a * (1 - acc), 0);
}

const SIZES = [2, 3, 8, 20];

describe('Flipbook 프레임 겹침', () => {
  it.each(SIZES)('프레임 %i장: 재생 내내 합성 불투명도가 1이다', (n) => {
    const layers = [...Array(n).keys()].map((i) => frameOpacityRange(i, n));
    const seam = seamOpacityRange(n);

    let worst = { t: 0, alpha: 1 };
    for (let step = 0; step <= n * 200; step += 1) {
      const t = (step / 200);
      const alpha = composite([...layers.map((r) => evaluate(r, t)), evaluate(seam, t)]);
      if (alpha < worst.alpha) worst = { t, alpha };
    }
    // 0.999 — 부동소수 오차만 허용한다. 옛 방식이면 0.66까지 떨어져 여기서 걸린다.
    expect(worst.alpha).toBeGreaterThan(0.999);
  });

  it.each(SIZES)('프레임 %i장: interpolate 구간이 오름차순이다', (n) => {
    const ranges = [...[...Array(n).keys()].map((i) => frameOpacityRange(i, n)), seamOpacityRange(n)];
    for (const { inputRange } of ranges) {
      for (let i = 1; i < inputRange.length; i += 1) {
        expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1]);
      }
    }
  });

  it('루프 이음매에서 되감겨도 보이는 그림이 같다', () => {
    // t가 끝(n)에 닿는 순간과 0으로 되감긴 직후가 같은 그림이어야 튀지 않는다.
    // 끝에서는 이음매 레이어(첫 프레임 복제)가 1, 처음에는 첫 프레임이 1 — 둘 다 같은 그림이다.
    const n = 20;
    expect(evaluate(seamOpacityRange(n), n)).toBeCloseTo(1);
    expect(evaluate(frameOpacityRange(0, n), 0)).toBeCloseTo(1);
  });

  it('한 시점에 실제로 보이는 프레임은 최대 두 장이다', () => {
    // 세 장 이상이 동시에 비치면 잔상이 겹쳐 보인다
    const n = 20;
    const layers = [...Array(n).keys()].map((i) => frameOpacityRange(i, n));
    for (let step = 0; step <= n * 100; step += 1) {
      const t = step / 100;
      const visible = layers.map((r) => evaluate(r, t)).filter((a) => a > 0.001).length;
      expect(visible).toBeLessThanOrEqual(2);
    }
  });
});
