// 전면 광고(Interstitial) — "작업이 도는 동안 광고를 보여주고, 광고가 닫히면 결과를 내놓는다".
//
// OCR처럼 서버 응답을 기다려야 하는 흐름에 쓴다. 광고와 작업을 순차로 실행하지 않고
// 병렬로 굴리기 때문에, 광고 시간이 대기 시간을 잡아먹어 체감 지연이 늘지 않는다.
import type { InterstitialAd } from 'react-native-google-mobile-ads';

import { adUnitId } from './ids';
import { initAds } from './init';
// SDK는 반드시 안전 로더를 거친다 — 직접 import하면 Expo Go에서 앱이 시작조차 못 한다.
import { sdk } from './sdk';

// 명세서를 여러 장 연속으로 올리는 게 흔한 사용 패턴이라, 매번 광고가 뜨면 앱을 못 쓴다.
const MIN_INTERVAL_MS = 3 * 60 * 1000;

// 광고가 닫힘 이벤트를 끝내 보내주지 않는 경우(SDK 버그·프로세스 이상)에도
// 결과가 영원히 안 나오는 일은 없어야 한다.
const SHOW_TIMEOUT_MS = 90 * 1000;

let ready: InterstitialAd | null = null;
let loading = false;
let lastShownAt = 0;

/**
 * 광고를 미리 받아둔다. 로드에 1~3초가 걸리므로 필요한 순간에 부르면 이미 늦다 —
 * 화면 진입 시점에 호출해 둘 것. 실패해도 조용히 넘어간다(광고는 부가 기능).
 */
export function preloadInterstitial(): void {
  if (!sdk) return; // Expo Go 등 — 광고 없이 동작
  if (ready || loading) return;
  loading = true;
  const { AdEventType, InterstitialAd } = sdk;

  initAds()
    .then((allowed) => {
      if (!allowed) {
        loading = false;
        return;
      }
      const ad = InterstitialAd.createForAdRequest(adUnitId('interstitial'));
      const unsubscribe: Array<() => void> = [];
      const cleanup = () => unsubscribe.forEach((off) => off());

      unsubscribe.push(
        ad.addAdEventListener(AdEventType.LOADED, () => {
          ready = ad;
          loading = false;
          cleanup();
        }),
      );
      unsubscribe.push(
        ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
          // 노필(no-fill)은 정상적인 상황이다 — 재고가 없으면 그냥 광고를 건너뛴다.
          if (__DEV__) console.warn('[ads] 전면 광고 로드 실패:', error?.message);
          loading = false;
          cleanup();
          ad.removeAllListeners();
        }),
      );

      ad.load();
    })
    .catch(() => {
      loading = false;
    });
}

/**
 * `task`를 실행하면서 준비된 전면 광고를 띄우고, **광고가 닫힌 뒤** task의 결과를 돌려준다.
 *
 * - 광고가 없거나(미로드·노필·웹·Expo Go) 노출 간격에 걸리면 task 결과를 그대로 즉시 반환한다.
 *   즉 광고 사정으로 기능이 막히는 일은 없다.
 * - task가 광고보다 먼저 끝나면 결과를 들고 있다가 광고가 닫힐 때 넘긴다.
 * - task가 광고보다 늦게 끝나면 광고가 닫힌 뒤 남은 시간만 기다린다(기존 로딩 표시 유지).
 * - task가 실패하면 광고가 닫힌 뒤 그 예외를 그대로 던진다.
 */
export async function showAdWhile<T>(task: Promise<T>): Promise<T> {
  // 광고를 보는 동안 task가 먼저 실패해도 unhandled rejection이 되지 않도록 즉시 결과를 감싼다.
  const settled = task.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const ad = ready;
  const throttled = Date.now() - lastShownAt < MIN_INTERVAL_MS;

  if (ad && ad.loaded && !throttled) {
    ready = null;
    lastShownAt = Date.now();
    await showAndWaitForClose(ad);
    preloadInterstitial(); // 다음 회차용
  }

  const result = await settled;
  if (result.ok) return result.value;
  throw result.error;
}

function showAndWaitForClose(ad: InterstitialAd): Promise<void> {
  // ad가 존재한다는 것 자체가 sdk가 로드됐다는 뜻이다 (preload에서만 생성됨)
  const { AdEventType } = sdk!;
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ad.removeAllListeners();
      resolve();
    };

    timer = setTimeout(finish, SHOW_TIMEOUT_MS);
    ad.addAdEventListener(AdEventType.CLOSED, finish);
    ad.addAdEventListener(AdEventType.ERROR, finish);
    ad.show().catch(finish);
  });
}
