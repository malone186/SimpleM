// 시트 재생(2겹 계단)이 '올바른 칸을, 새는 순간 없이' 보여주는지 검사한다.
//
// 프레임을 낱장 파일로 실으면 에셋이 수천 개가 되어 OTA(EAS Update)의 업데이트당
// 1000개 제한에 걸린다 — 그래서 (모션×색)당 시트 1장을 클리핑해 재생한다.
//
// 예전엔 프레임 수만큼 레이어를 쌓았지만(bad 모션은 96겹 → 아이폰 기기 재시작 사고),
// 지금은 base·overlay 2겹이 계단식 interpolate로 칸을 옮겨 다닌다. 이 구조의 생명줄은
// '칸 이동(점프)이 새어 보이지 않는 것'이다: base의 점프는 overlay가 완전 불투명일 때,
// overlay의 점프는 자신이 완전 투명일 때만 일어나야 한다. 그 타이밍을 여기서 못 박는다.
import Flipbook, {
  type FlipSheet,
  type Stair,
  baseCellStairs,
  cellOffset,
  overlayCellStairs,
  overlayOpacityStair,
} from '../Flipbook';

// react-test-renderer는 타입 선언 패키지가 따로 없다 — 테스트 전용이라 필요한 모양만 잡는다.
// (@testing-library/react-native는 이 프로젝트 조합에서 'test-renderer' 모듈 누락으로 못 쓴다)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { act, create } = require('react-test-renderer') as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
  create: (el: React.ReactElement) => { toJSON(): any; unmount(): void };
};

const SIZE = 100;
const sheet: FlipSheet = { src: 1, frame: [360, 360], cols: 11, rows: 2, count: 20 };
const n = sheet.count;

/** RN의 interpolate(extrapolate: 'clamp')와 같은 구간별 선형 보간 */
function evaluate({ inputRange, outputRange }: Stair, t: number): number {
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

/** (x, y)가 정확히 어느 칸 위에 있으면 그 인덱스, 칸 사이를 지나는 중이면 null */
function cellAt(x: number, y: number): number | null {
  for (let i = 0; i < n; i += 1) {
    const c = cellOffset(i, sheet, SIZE);
    if (Math.abs(c.x - x) < 1e-6 && Math.abs(c.y - y) < 1e-6) return i;
  }
  return null;
}

/** 렌더 트리에서 호스트 Image 노드를 문서 순서대로 모은다 */
function collectImages(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collectImages(child, out));
    return out;
  }
  if (node.type === 'Image') out.push(node);
  collectImages(node.children, out);
  return out;
}

async function renderImages(el: React.ReactElement) {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(el);
  });
  const images = collectImages(tree!.toJSON());
  // 반복 재생 타이머가 테스트 종료 후까지 살아남지 않게 바로 내린다
  await act(async () => tree!.unmount());
  return images;
}

test('시트 모드: 프레임 수와 무관하게 레이어는 base·overlay 2겹뿐이다', async () => {
  expect(await renderImages(<Flipbook sheet={sheet} size={SIZE} />)).toHaveLength(2);
  expect(await renderImages(<Flipbook sheet={sheet} size={SIZE} loop={false} />)).toHaveLength(2);
});

test('한 칸짜리 시트는 정지 그림 한 겹으로 렌더된다 (interpolate 구간 뒤집힘 방지)', async () => {
  const single: FlipSheet = { ...sheet, count: 1 };
  expect(await renderImages(<Flipbook sheet={single} size={SIZE} />)).toHaveLength(1);
});

describe('base 계단', () => {
  const base = baseCellStairs(n, sheet, SIZE);

  it('프레임 구간 한가운데(t=i+0.5)에는 정확히 i번째 칸을 보여준다', () => {
    for (const i of [0, 5, 10, 11, 19]) {
      expect(cellAt(evaluate(base.x, i + 0.5), evaluate(base.y, i + 0.5))).toBe(i);
    }
  });

  it('칸 사이를 지나는 순간엔 반드시 overlay가 완전 불투명으로 덮고 있다', () => {
    const op = overlayOpacityStair(n, true);
    for (let step = 0; step <= n * 500; step += 1) {
      const t = step / 500;
      if (cellAt(evaluate(base.x, t), evaluate(base.y, t)) === null) {
        expect(evaluate(op, t)).toBeGreaterThan(0.999);
      }
    }
  });
});

describe('overlay 계단', () => {
  const over = overlayCellStairs(n, sheet, SIZE, true);
  const op = overlayOpacityStair(n, true);

  it('덮어 오는 동안(t∈[i-0.5, i])에는 i번째 칸을 물고 있다', () => {
    for (const i of [1, 5, 11, 19]) {
      expect(cellAt(evaluate(over.x, i - 0.25), evaluate(over.y, i - 0.25))).toBe(i);
    }
    // 이음매 — 마지막 전환은 첫 칸이 덮어 온다
    expect(cellAt(evaluate(over.x, n - 0.25), evaluate(over.y, n - 0.25))).toBe(0);
  });

  it('칸 사이를 지나는 순간엔 자신이 완전 투명하다', () => {
    for (let step = 0; step <= n * 500; step += 1) {
      const t = step / 500;
      if (cellAt(evaluate(over.x, t), evaluate(over.y, t)) === null) {
        expect(evaluate(op, t)).toBeLessThan(0.001);
      }
    }
  });

  it('크로스페이드 곡선은 예전과 같다 — [i-0.5, i]에서 0→1로 올라온다', () => {
    for (const i of [1, 10, 19]) {
      expect(evaluate(op, i - 0.5)).toBeCloseTo(0);
      expect(evaluate(op, i - 0.25)).toBeCloseTo(0.5);
      expect(evaluate(op, i)).toBeCloseTo(1);
    }
  });
});

describe('되감기 이음매 (loop)', () => {
  it('t=n과 t=0의 그림이 같다 — overlay가 첫 칸을 1로 덮고 있다', () => {
    const over = overlayCellStairs(n, sheet, SIZE, true);
    const op = overlayOpacityStair(n, true);
    for (const t of [0, n]) {
      expect(evaluate(op, t)).toBeCloseTo(1);
      expect(cellAt(evaluate(over.x, t), evaluate(over.y, t))).toBe(0);
    }
  });
});

describe('한 번 재생 (loop=false)', () => {
  it('이음매가 없다 — 끝나면 overlay는 꺼진 채 base가 마지막 칸(마무리 자세)을 유지한다', () => {
    const op = overlayOpacityStair(n, false);
    const base = baseCellStairs(n, sheet, SIZE);
    expect(evaluate(op, n - 0.25)).toBeCloseTo(0); // 첫 칸이 덮어 오지 않는다
    expect(evaluate(op, n)).toBeCloseTo(0);
    expect(cellAt(evaluate(base.x, n), evaluate(base.y, n))).toBe(n - 1);
  });

  it('시작(t=0)은 base의 첫 칸만 보인다', () => {
    const op = overlayOpacityStair(n, false);
    const base = baseCellStairs(n, sheet, SIZE);
    expect(evaluate(op, 0)).toBeCloseTo(0);
    expect(cellAt(evaluate(base.x, 0), evaluate(base.y, 0))).toBe(0);
  });
});

describe('interpolate 구간 검증', () => {
  it.each([2, 3, 20, 95])('프레임 %i장: 모든 계단의 구간이 오름차순이다', (count) => {
    const s: FlipSheet = { ...sheet, count, rows: Math.ceil(count / sheet.cols) };
    for (const loop of [true, false]) {
      const stairs = [
        baseCellStairs(count, s, SIZE).x,
        baseCellStairs(count, s, SIZE).y,
        overlayCellStairs(count, s, SIZE, loop).x,
        overlayCellStairs(count, s, SIZE, loop).y,
        overlayOpacityStair(count, loop),
      ];
      for (const { inputRange, outputRange } of stairs) {
        expect(inputRange.length).toBe(outputRange.length);
        expect(inputRange.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < inputRange.length; i += 1) {
          expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1]);
        }
      }
    }
  });
});
