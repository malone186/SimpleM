/**
 * 브루 표정 자동 선택 — 여기서 지키려는 건 "근거 없이 감정을 보이지 않는다"이다.
 *
 * 표정은 사장님이 홈을 여는 순간 처음 보는 정보다. 판매 기록이 없는 신규 매장에
 * 슬픈 브루가 떠 있으면 그건 예측이 아니라 그냥 불안을 심는 것이고, 반대로 비 오는
 * 날 폴짝 뛰고 있으면 다음부터 표정을 아무도 안 믿는다.
 */
import { isNotable, moodFromForecast } from '../forecastMood';
import type { SalesForecast } from '../../../lib/api/forecast';

/** 필요한 필드만 채운 예측 — 표정 판정은 baseline·tomorrow·nearby_events만 본다 */
const forecast = (
  tomorrow: Partial<SalesForecast['tomorrow']>,
  nearby: Partial<SalesForecast['nearby_events'][number]>[] = [],
  baseline?: { days: number; avg_cups: number },
  trend?: { change_pct: number },
) =>
  ({
    baseline,
    trend,
    tomorrow: {
      date: '2026-08-08',
      weekday: '토',
      base_cups: 100,
      cups: 100,
      revenue: 500_000,
      weather: null,
      temp_max: null,
      precip_prob: null,
      adjustments: [],
      holiday: null,
      ...tomorrow,
    },
    nearby_events: nearby,
  } as unknown as SalesForecast);

describe('평소 대비로 판단한다', () => {
  it('기준선보다 많이 팔릴 것 같으면 폴짝 뛴다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 130 }));
    expect(r.outlook).toBe('good');
    expect(r.mood).toBe('jump');
    expect(r.deltaPct).toBe(30);
  });

  it('기준선보다 많이 줄 것 같으면 시무룩해진다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 70 }));
    expect(r.outlook).toBe('bad');
    expect(r.mood).toBe('upset');
    expect(r.deltaPct).toBe(-30);
  });

  it('평소와 비슷하면 표정을 바꾸지 않고 말도 얹지 않는다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 105 }));
    expect(r.outlook).toBe('normal');
    expect(r.mood).toBe('top');
    expect(r.reason).toBeNull();
  });

  it('절대 잔 수가 아니라 비율로 본다 — 작은 매장이 늘 슬프면 안 된다', () => {
    const small = moodFromForecast(forecast({ base_cups: 10, cups: 13 }));
    const big = moodFromForecast(forecast({ base_cups: 1000, cups: 1300 }));
    expect(small.outlook).toBe('good');
    expect(big.outlook).toBe('good');
  });
});

describe('내리막 매출을 잡아낸다 — baseline이 있으면 그것이 기준', () => {
  // 이 묶음이 이 기능의 핵심이다. 예전 방식(base_cups 대비)은 매출이 몇 주째 줄어도
  // 예측이 추세를 따라가 비율이 1에 머물렀고, 브루는 태연히 웃고 있었다.
  it('요즘 평균보다 예측이 낮으면 날씨가 멀쩡해도 시무룩해진다', () => {
    const r = moodFromForecast(
      // 모델 기준선 대비로는 변화 없음(70/70=1.0) — 예전 방식이면 'normal'로 새어 나간다
      forecast({ base_cups: 70, cups: 70 }, [], { days: 14, avg_cups: 100 }),
    );
    expect(r.outlook).toBe('bad');
    expect(r.mood).toBe('upset');
    expect(r.deltaPct).toBe(-30);
    expect(r.reason).toContain('매출이 계속 줄고 있진 않은지');
  });

  it('매출이 살아나는 중이면 기뻐한다', () => {
    const r = moodFromForecast(
      forecast({ base_cups: 130, cups: 130 }, [], { days: 14, avg_cups: 100 }),
    );
    expect(r.outlook).toBe('good');
    expect(r.mood).toBe('jump');
  });

  it('요즘 평균이 있으면 모델 기준선보다 그쪽을 쓴다', () => {
    const r = moodFromForecast(
      // base_cups로 보면 +30%(좋음), 요즘 평균으로 보면 -35%(나쁨) → 요즘 평균이 이긴다
      forecast({ base_cups: 100, cups: 130 }, [], { days: 14, avg_cups: 200 }),
    );
    expect(r.outlook).toBe('bad');
  });

  it('평균이 0이면(기록 없음) 판단하지 않고 모델 기준선으로 물러난다', () => {
    const r = moodFromForecast(
      forecast({ base_cups: 100, cups: 130 }, [], { days: 0, avg_cups: 0 }),
    );
    expect(r.outlook).toBe('good'); // base_cups 대비 +30%
  });
});

describe('이미 무너진 매출이 예측에 가려지지 않는다', () => {
  // 실제로 부딪힌 문제다. 더미 데이터로 매출을 반 토막(-54%) 냈는데 브루가 계속 춤을 췄다.
  // 예측 모델이 며칠짜리 급락을 곧바로 '새 수준'으로 받아들이지 않아(그게 맞다) 내일 예측은
  // 예전 수준 근처(-9%)에 머물렀고, 예측만 보던 로직은 '평소와 비슷'으로 판정했다.
  it('예측은 멀쩡해 보여도 지난주 대비 매출이 꺾였으면 시무룩해진다', () => {
    const r = moodFromForecast(
      forecast({ cups: 83 }, [], { days: 14, avg_cups: 91 }, { change_pct: -54 }),
    );
    expect(r.outlook).toBe('bad');
    expect(r.mood).toBe('upset');
    expect(r.deltaPct).toBe(-54);
    expect(r.reason).toContain('지난 일주일');
    expect(r.reason).toContain('54%');
  });

  it('둘 중 더 나쁜 쪽을 따른다 — 내일이 더 나쁘면 내일 사정을 말한다', () => {
    const r = moodFromForecast(
      // 추세 -15%, 내일 예측 -45% → 내일 쪽이 더 나쁘다
      forecast({ cups: 50, precip_prob: 90 }, [], { days: 14, avg_cups: 91 }, { change_pct: -15 }),
    );
    expect(r.outlook).toBe('bad');
    expect(r.reason).toContain('비 소식');
  });

  it('추세가 멀쩡하면 예측 판정을 그대로 쓴다', () => {
    const r = moodFromForecast(
      forecast({ cups: 95 }, [], { days: 14, avg_cups: 91 }, { change_pct: 3 }),
    );
    expect(r.outlook).toBe('normal');
    expect(r.mood).toBe('top');
  });

  it('추세가 좋아도 내일이 나쁘면 나쁜 쪽을 말한다', () => {
    const r = moodFromForecast(
      forecast({ cups: 40, precip_prob: 95 }, [], { days: 14, avg_cups: 91 }, { change_pct: 20 }),
    );
    expect(r.outlook).toBe('bad');
  });

  it('구버전 서버(추세 없음)에서도 예측만으로 동작한다', () => {
    const r = moodFromForecast(forecast({ cups: 60 }, [], { days: 14, avg_cups: 91 }));
    expect(r.outlook).toBe('bad');
  });
});

describe('근거가 없으면 판단하지 않는다', () => {
  it.each([
    ['예측 자체가 없을 때', null],
    ['예측을 못 받았을 때(판매 기록 14일 미만 → 서버 409)', undefined],
  ])('%s 평소 포즈를 유지한다', (_label, value) => {
    const r = moodFromForecast(value as null | undefined);
    expect(r.mood).toBe('top');
    expect(r.outlook).toBe('unknown');
    expect(r.reason).toBeNull();
  });

  it('기준선이 0이면 비교가 성립하지 않으므로 표정을 바꾸지 않는다', () => {
    const r = moodFromForecast(forecast({ base_cups: 0, cups: 50 }));
    expect(r.mood).toBe('top');
    expect(r.outlook).toBe('unknown');
    expect(r.deltaPct).toBeNull();
  });
});

describe('산 포즈를 언제 밀어내는가', () => {
  // 매출이 꺾였는데 상점에서 산 '스웩 댑' 포즈로 춤추고 있으면 표정이 정보가 아니라 장식이다.
  // 반대로 평소에도 밀어내면 코인 주고 산 포즈를 볼 일이 없다.
  it('할 말이 있는 날(좋음·나쁨)에는 산 포즈보다 표정이 앞선다', () => {
    expect(isNotable('bad')).toBe(true);
    expect(isNotable('good')).toBe(true);
  });

  it('평소와 다를 게 없으면 산 포즈를 그대로 둔다', () => {
    expect(isNotable('normal')).toBe(false);
    expect(isNotable('unknown')).toBe(false);
  });

  it('매출이 꺾인 날은 실제로 밀어내기가 켜진다', () => {
    const r = moodFromForecast(forecast({ base_cups: 60, cups: 60 }, [], { days: 14, avg_cups: 91 }));
    expect(r.mood).toBe('upset');
    expect(isNotable(r.outlook)).toBe(true);
  });
});

describe('말풍선은 이유를 아는 날만 구체적으로 말한다', () => {
  it('주변 행사가 있으면 행사 이름을 그대로 전한다', () => {
    const r = moodFromForecast(
      forecast({ base_cups: 100, cups: 140 }, [{ name: '한강 불꽃축제', date: '2026-08-08' }]),
    );
    expect(r.reason).toContain('한강 불꽃축제');
    expect(r.reason).toContain('넉넉히');
  });

  it('날짜가 다른 행사는 내일 근거로 쓰지 않는다', () => {
    const r = moodFromForecast(
      forecast({ base_cups: 100, cups: 140 }, [{ name: '지난주 축제', date: '2026-08-01' }]),
    );
    expect(r.reason).not.toContain('지난주 축제');
  });

  it('공휴일이면 그 이름을 전한다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 140, holiday: '광복절' }));
    expect(r.reason).toContain('광복절');
  });

  it('비 예보로 한산할 것 같으면 강수확률과 함께 재료를 줄이라고 말한다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 70, precip_prob: 80 }));
    expect(r.reason).toContain('80%');
    expect(r.reason).toContain('조금만');
  });

  it('나쁜 날의 문구에는 음수 부호가 새어 나오지 않는다', () => {
    const r = moodFromForecast(forecast({ base_cups: 100, cups: 70 }));
    expect(r.reason).toContain('30%');
    expect(r.reason).not.toContain('-30');
  });
});
