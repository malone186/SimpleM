import { computeFrameMetrics } from '../DeviceFrame';

describe('computeFrameMetrics', () => {
  it('낮은 데스크톱 창에서는 축소된 프레임 자리가 가용 높이 안에 정확히 들어간다', () => {
    const metrics = computeFrameMetrics(1280, 720);

    expect(metrics.fillsScreen).toBe(false);
    expect(metrics.scale).toBeCloseTo(672 / 850, 5);
    expect(metrics.slotHeight).toBeCloseTo(672, 5);
    expect(metrics.slotWidth).toBeLessThan(420);
  });

  it('휴대폰 폭의 웹 화면에서는 목업 없이 실제 화면을 가득 쓴다', () => {
    expect(computeFrameMetrics(320, 568)).toEqual({
      fillsScreen: true,
      scale: 1,
      slotWidth: 320,
      slotHeight: 568,
    });
  });

  it('가로로 넓고 세로로 짧은 창에서도 프레임 높이가 화면을 넘지 않는다', () => {
    const metrics = computeFrameMetrics(844, 390);
    expect(metrics.fillsScreen).toBe(false);
    expect(metrics.slotHeight).toBeLessThanOrEqual(390 - 48);
  });
});
