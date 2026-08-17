// 브루의 표정을 매출 예측으로 정한다 — "표정 = 가게 상태"라는 마스코트 원칙의 연장.
//
// 왜 이렇게 정하나:
//   내일 몇 잔 팔릴지 숫자로 보여 줘도 그게 좋은 건지 나쁜 건지는 사장님이 직접 비교해야
//   안다. 브루가 먼저 표정으로 알려 주면 홈을 여는 순간 0.5초 만에 감이 온다.
//
// 무엇과 비교하나:
//   내일 예측(cups)을 '요즘 실적 평균'(baseline.avg_cups, 최근 2주 실제 판매)과 견준다.
//   절대 잔 수로 판단하면 원래 작은 매장은 늘 슬퍼하고 큰 매장은 늘 기뻐하므로 비율로 본다.
//
//   처음엔 base_cups(모델 예측)와 cups(보정 후)의 비율을 썼는데 그건 틀렸다. 그 둘의 비율은
//   날씨·행사 보정만 담는다 — 예측이 매출 추세를 이미 따라가므로, 장사가 몇 주째 내리막이어도
//   비율은 1에 가깝고 브루는 태연히 웃는다. 정작 표정이 필요한 상황을 놓치는 것이다.
//   그래서 서버가 최근 실적 평균을 따로 실어 보내고(forecast_service.BASELINE_WINDOW_DAYS),
//   여기서는 그것과 비교한다. 이러면 내리막도, 내일 비 예보도 같은 잣대로 잡힌다.
//   구버전 서버 응답에는 baseline이 없어 그때만 예전 방식으로 물러난다.
//
// 표정 그림:
//   나쁠 때는 'upset'(장부 보며 시무룩한 브루). 처음엔 'resting'을 썼는데 그건 틀렸다 —
//   이름만 보고 골랐고 실제 그림은 커피잔 들고 활짝 웃는 모습이라, 매출이 34% 꺾인 날에도
//   웃고 있었다. 표정으로 상태를 말하는 기능인데 정작 표정이 반대였던 셈이다.
//   기쁠 때는 'redred'가 플립북 애니메이션으로 재생된다 (신나게 춤추는 브루).
//   'jump'(폴짝)에서 바꿨다 — 한 바퀴가 길어(192프레임/24fps ≈ 8초) 잘 나가는 날의
//   들뜬 느낌이 더 오래 남는다.
import type { BrewMood } from './Brew';
import type { SalesForecast } from '../../lib/api/forecast';

export type BrewOutlook = 'good' | 'normal' | 'bad' | 'unknown';

export type ForecastMood = {
  mood: BrewMood;
  outlook: BrewOutlook;
  /** 평소 대비 몇 % (좋으면 양수). 판단 근거가 없으면 null */
  deltaPct: number | null;
  /** 말풍선에 띄울 한 줄. 평소와 다를 게 없으면 null (기본 인사말을 그대로 둔다) */
  reason: string | null;
};

// 평소와 이만큼은 차이 나야 표정을 바꾼다. 좁게 잡으면 매일 표정이 널뛰어
// '브루가 또 슬프네'가 배경음이 되고, 정작 진짜 나쁜 날에 눈에 안 들어온다.
const GOOD_AT = 1.12;
const BAD_AT = 0.88;

const NEUTRAL: ForecastMood = { mood: 'top', outlook: 'unknown', deltaPct: null, reason: null };

/**
 * 지금 표정으로 말해야 하는 상황인가.
 *
 * 이때만 상점에서 산 포즈를 잠시 밀어낸다. 평소에도 밀어내면 코인 주고 산 포즈를
 * 볼 일이 없고, 반대로 한 번도 안 밀어내면 매출이 꺾인 날 스웩 댑 포즈로 춤을 춘다.
 */
export function isNotable(outlook: BrewOutlook): boolean {
  return outlook === 'good' || outlook === 'bad';
}

/**
 * 내일 예측으로 브루의 표정을 고른다.
 *
 * 예측이 없거나(판매 기록 14일 미만이면 서버가 409) 기준선이 0이면 판단하지 않고
 * 평소 포즈를 그대로 쓴다 — 근거 없이 슬픈 표정을 띄우면 사장님만 불안해진다.
 */
export function moodFromForecast(forecast: SalesForecast | null | undefined): ForecastMood {
  const tomorrow = forecast?.tomorrow;
  if (!tomorrow) return NEUTRAL;

  const expected = Number(tomorrow.cups) || 0;
  // 요즘 실적 평균이 기준. 없는 응답(구버전 서버)에서만 모델 기준선으로 물러난다.
  const base = Number(forecast?.baseline?.avg_cups) || Number(tomorrow.base_cups) || 0;
  // 기준선이 없으면(신규 매장·판매 기록 부족) 비교 자체가 성립하지 않는다
  if (base <= 0) return NEUTRAL;

  const forecastRatio = expected / base;
  const forecastDelta = Math.round((forecastRatio - 1) * 100);

  // 이미 무너지고 있는 매출이 예측 하나에 가려지지 않게 한다.
  // 예측은 며칠짜리 급락을 곧바로 반영하지 않아서, 실적이 반 토막 나도 '평소와 비슷'으로
  // 나온다. 그래서 추세가 더 나쁘면 그쪽을 따른다 — 둘 중 나쁜 쪽이 사장님이 알아야 할 사실이다.
  const trendPct = forecast?.trend ? Number(forecast.trend.change_pct) : null;
  const trendRatio = trendPct == null ? null : 1 + trendPct / 100;

  if (trendRatio != null && trendRatio <= BAD_AT && trendRatio < forecastRatio) {
    return {
      mood: 'upset',
      outlook: 'bad',
      deltaPct: Math.round(trendPct as number),
      reason: trendReason(Math.round(trendPct as number)),
    };
  }

  if (forecastRatio >= GOOD_AT) {
    return { mood: 'redred', outlook: 'good', deltaPct: forecastDelta, reason: goodReason(forecast, forecastDelta) };
  }
  if (forecastRatio <= BAD_AT) {
    return { mood: 'upset', outlook: 'bad', deltaPct: forecastDelta, reason: badReason(forecast, forecastDelta) };
  }
  return { mood: 'top', outlook: 'normal', deltaPct: forecastDelta, reason: null };
}

/** 내일 열리는 주변 행사 — 예측이 부스팅에 쓴 것과 같은 목록에서 찾는다 */
function eventTomorrow(forecast: SalesForecast) {
  const date = forecast.tomorrow?.date;
  return (forecast.nearby_events ?? []).find((e) => e.date === date) ?? null;
}

// 말풍선 문구는 숫자보다 '그래서 뭘 하면 되는지'를 담는다.
// 이유를 아는 날만 구체적으로 말하고, 모르면 굳이 지어내지 않는다.
function goodReason(forecast: SalesForecast, deltaPct: number): string {
  const event = eventTomorrow(forecast);
  if (event) {
    return `내일 근처에서 '${event.name}'이 열려요. 요즘보다 ${deltaPct}% 바쁠 것 같으니 재료를 넉넉히 준비하세요!`;
  }
  if (forecast.tomorrow.holiday) {
    return `내일은 ${forecast.tomorrow.holiday}예요. 요즘보다 ${deltaPct}% 붐빌 것 같아요!`;
  }
  return `내일은 요즘보다 ${deltaPct}% 잘될 것 같아요. 재료가 넉넉한지 한 번 봐 주세요!`;
}

/** 매출 자체가 꺾인 경우 — 내일 얘기가 아니라 '지난 일주일'을 말해야 한다 */
function trendReason(deltaPct: number): string {
  return `지난 일주일 매출이 그 전주보다 ${Math.abs(deltaPct)}% 줄었어요. 무슨 일이 있었는지 살펴보세요.`;
}

function badReason(forecast: SalesForecast, deltaPct: number): string {
  const drop = Math.abs(deltaPct);
  const rain = Number(forecast.tomorrow.precip_prob) || 0;
  if (rain >= 60) {
    return `내일은 비 소식이 있어요(강수확률 ${rain}%). 요즘보다 ${drop}% 한산할 수 있으니 재료는 조금만 준비하세요.`;
  }
  // 날씨 탓이 아니면 매출 자체가 내려앉고 있다는 뜻이라, 재료 얘기보다 원인을 보게 한다
  return `내일은 요즘보다 ${drop}% 조용할 것 같아요. 매출이 계속 줄고 있진 않은지 살펴보세요.`;
}
