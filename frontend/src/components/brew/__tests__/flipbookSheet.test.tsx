// 시트 재생 모드가 '격자에서 올바른 칸을 오려내는지' 검사한다.
//
// 프레임을 낱장 파일로 실으면 에셋이 수천 개가 되어 OTA(EAS Update)의 업데이트당
// 1000개 제한에 걸린다 — 그래서 (모션×색)당 시트 1장을 클리핑해 재생한다. 오프셋
// 계산이 한 칸이라도 어긋나면 재생 중 엉뚱한 자세가 끼어드는데, 눈으로는 한 프레임
// (1/24초)이라 알아채기 어렵다. 그 좌표를 여기서 숫자로 못 박는다.
import Flipbook, { type FlipSheet } from '../Flipbook';

// react-test-renderer는 타입 선언 패키지가 따로 없다 — 테스트 전용이라 필요한 모양만 잡는다.
// (@testing-library/react-native는 이 프로젝트 조합에서 'test-renderer' 모듈 누락으로 못 쓴다)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { act, create } = require('react-test-renderer') as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
  create: (el: React.ReactElement) => { toJSON(): any };
};

const SIZE = 100;
const sheet: FlipSheet = { src: 1, frame: [360, 360], cols: 11, rows: 2, count: 20 };

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
  return collectImages(tree!.toJSON());
}

test('시트 모드: 프레임 수 + 루프 이음매만큼 클리핑 셀이 깔린다', async () => {
  const images = await renderImages(<Flipbook sheet={sheet} size={SIZE} />);
  // 20칸 + 이음매(첫 칸 복제) = 21
  expect(images).toHaveLength(sheet.count + 1);
});

test('시트 모드: i번째 셀은 격자의 (i%cols, i//cols) 칸을 보여준다', async () => {
  const images = await renderImages(<Flipbook sheet={sheet} size={SIZE} />);
  for (const i of [0, 5, 10, 11, 19]) {
    const style = images[i].props.style;
    expect(style.width).toBe(SIZE * sheet.cols);
    expect(style.height).toBe(SIZE * sheet.rows);
    expect(style.left).toBe(-SIZE * (i % sheet.cols));
    expect(style.top).toBe(-SIZE * Math.floor(i / sheet.cols));
  }
  // 이음매 레이어(마지막)는 첫 칸과 같은 위치를 보여줘야 되감기는 순간 티가 안 난다
  const seam = images[sheet.count].props.style;
  expect(seam.left).toBe(-0);
  expect(seam.top).toBe(-0);
});

test('한 번 재생(loop=false)에는 이음매를 깔지 않는다 — 마무리 자세가 유지되게', async () => {
  const images = await renderImages(<Flipbook sheet={sheet} size={SIZE} loop={false} />);
  expect(images).toHaveLength(sheet.count);
});

test('한 칸짜리 시트는 정지 그림으로 렌더된다 (interpolate 구간 뒤집힘 방지)', async () => {
  const single: FlipSheet = { ...sheet, count: 1 };
  const images = await renderImages(<Flipbook sheet={single} size={SIZE} />);
  expect(images).toHaveLength(1);
});
