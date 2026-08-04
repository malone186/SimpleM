// 반응형 브레이크포인트 회귀 테스트
//
// 실기기를 매번 돌려볼 수 없으니 "이 해상도에서는 이렇게 판정돼야 한다"를 여기에 못 박는다.
// 해상도는 실제 기기의 논리 픽셀(dp) 기준이다.
// (useResponsive 훅은 computeResponsive 를 useMemo 로 감싸기만 하므로 순수 함수만 검증하면 된다)
import { breakpointOf, computeResponsive, gridItemBasis } from '../responsive';

const DEVICES = {
  flipCover: { width: 277, height: 288 }, // 갤럭시 Z 플립 커버 화면
  iphoneSE1: { width: 320, height: 568 }, // 아이폰 SE 1세대 (가장 좁은 현역)
  foldFolded: { width: 344, height: 882 }, // 갤럭시 Z 폴드 접힘
  iphoneSE3: { width: 375, height: 667 },
  iphone14: { width: 390, height: 844 }, // 디자인 시안 기준
  galaxyS: { width: 412, height: 915 },
  iphoneProMax: { width: 430, height: 932 },
  foldOpen: { width: 673, height: 841 }, // 갤럭시 Z 폴드 펼침
  landscape: { width: 844, height: 390 }, // 아이폰 가로모드
};

const at = (d: { width: number; height: number }) => computeResponsive(d.width, d.height);

describe('breakpointOf', () => {
  it('기기별 구간을 정확히 가른다', () => {
    expect(breakpointOf(DEVICES.flipCover.width)).toBe('xs');
    expect(breakpointOf(DEVICES.iphoneSE1.width)).toBe('xs');
    expect(breakpointOf(DEVICES.foldFolded.width)).toBe('sm');
    expect(breakpointOf(DEVICES.iphoneSE3.width)).toBe('sm');
    expect(breakpointOf(DEVICES.iphone14.width)).toBe('md');
    expect(breakpointOf(DEVICES.galaxyS.width)).toBe('md');
    expect(breakpointOf(DEVICES.iphoneProMax.width)).toBe('lg');
    expect(breakpointOf(DEVICES.foldOpen.width)).toBe('xl');
  });
});

describe('computeResponsive', () => {
  it('플립 커버 화면은 초소형으로 판정하고 여백을 줄인다', () => {
    const r = at(DEVICES.flipCover);
    expect(r.isXS).toBe(true);
    expect(r.isCompact).toBe(true);
    expect(r.isWide).toBe(false);
    expect(r.gutter).toBe(12); // 20 그대로 쓰면 본문 폭이 크게 깎인다
    expect(r.isShortViewport).toBe(true);
  });

  it('폴드 접힘은 좁지만 초소형은 아니다', () => {
    const r = at(DEVICES.foldFolded);
    expect(r.isXS).toBe(false);
    expect(r.isCompact).toBe(true);
    expect(r.gutter).toBe(16);
  });

  it('시안 기준 기기는 기본 여백을 그대로 쓴다', () => {
    const r = at(DEVICES.iphone14);
    expect(r.bp).toBe('md');
    expect(r.isCompact).toBe(false);
    expect(r.isWide).toBe(false);
    expect(r.gutter).toBe(20);
    expect(r.contentMaxWidth).toBe(390); // 폭 제한 없음 = 화면 폭 그대로
  });

  it('폴드 펼침은 본문 폭을 제한한다 — 글줄이 673px로 늘어지면 못 읽는다', () => {
    const r = at(DEVICES.foldOpen);
    expect(r.isWide).toBe(true);
    expect(r.contentMaxWidth).toBe(560);
    expect(r.contentMaxWidth).toBeLessThan(r.width);
    expect(r.gutter).toBe(24);
  });

  it('가로모드는 세로가 짧은 화면으로 판정한다', () => {
    const r = at(DEVICES.landscape);
    expect(r.isLandscape).toBe(true);
    expect(r.isShortViewport).toBe(true); // 상하 여백을 줄여 본문을 확보해야 한다
  });

  it('세로가 긴 기기는 짧은 화면으로 오판하지 않는다', () => {
    expect(at(DEVICES.iphone14).isShortViewport).toBe(false);
    expect(at(DEVICES.foldFolded).isShortViewport).toBe(false);
  });

  it('스케일은 상하한에 묶여 폴드 펼침에서도 폭주하지 않는다', () => {
    // 673/390 = 1.72배지만 1.15배로 묶인다
    expect(at(DEVICES.foldOpen).rs(100)).toBeLessThanOrEqual(115);
    // 277/390 = 0.71배지만 0.85배 밑으로는 안 내려간다 (더 줄면 못 읽는다)
    expect(at(DEVICES.flipCover).rs(100)).toBeGreaterThanOrEqual(85);
  });

  it('열 개수는 화면 폭에 따라 늘어난다', () => {
    // 최소 항목 폭 150dp 기준
    expect(at(DEVICES.flipCover).columns(150)).toBe(1); // 좁으면 한 줄에 하나
    expect(at(DEVICES.iphone14).columns(150)).toBe(2);
    expect(at(DEVICES.foldOpen).columns(150)).toBe(3); // 폭 제한(560) 안에서 3열
  });

  it('열 개수에는 상한을 줄 수 있다', () => {
    expect(at(DEVICES.foldOpen).columns(150, 2)).toBe(2);
  });

  it('vw·vh 는 현재 화면 기준으로 계산한다', () => {
    const r = at(DEVICES.iphone14);
    expect(r.vw(50)).toBe(195);
    expect(r.vh(50)).toBe(422);
  });
});

describe('gridItemBasis', () => {
  it('1열이면 꽉 채운다', () => {
    expect(gridItemBasis(1)).toBe('100%');
  });

  it('여러 열이면 간격을 뺀 폭을 균등 분배한다', () => {
    expect(gridItemBasis(2)).toBe('49%'); // (100 - 2) / 2
    expect(gridItemBasis(3)).toBe('32%'); // (100 - 4) / 3
  });
});
