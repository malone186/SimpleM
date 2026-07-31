// 보상형 광고(Rewarded) — 끝까지 보면 보상을 주는 형식.
//
// 전면 광고(interstitial.ts)와 역할이 다르다. 전면 광고는 대기 시간을 메우는 용도라
// 사용자에게 묻지 않고 띄우지만, 보상형은 AdMob 정책상 반드시 사용자가 명시적으로
// 동의한 뒤에만 띄울 수 있고 중간에 닫을 수 있어야 한다. 그래서 이 모듈은 광고만
// 담당하고, "볼래요?" 확인은 호출부(기존 confirmDialog)가 맡는다.
import { AdEventType, RewardedAd, RewardedAdEventType } from 'react-native-google-mobile-ads';

import { adUnitId } from './ids';
import { initAds } from './init';

const SHOW_TIMEOUT_MS = 5 * 60 * 1000;

let ready: RewardedAd | null = null;
let loading = false;

/** 광고를 미리 받아둔다 (로드 1~3초). 보상형은 사용자를 기다리게 하면 안 되므로 선로딩이 중요하다. */
export function preloadRewarded(): void {
  if (ready || loading) return;
  loading = true;

  initAds()
    .then((allowed) => {
      if (!allowed) {
        loading = false;
        return;
      }
      const ad = RewardedAd.createForAdRequest(adUnitId('rewarded'));
      const offs: Array<() => void> = [];
      const cleanup = () => offs.forEach((off) => off());

      offs.push(
        ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
          ready = ad;
          loading = false;
          cleanup();
        }),
      );
      offs.push(
        ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
          if (__DEV__) console.warn('[ads] 보상형 광고 로드 실패:', error?.message);
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

/** 지금 당장 띄울 수 있는 광고가 준비되어 있는지. 없으면 사용자에게 광고를 권하지 말 것. */
export function isRewardedReady(): boolean {
  return ready != null && ready.loaded;
}

/**
 * 보상형 광고를 띄우고 **보상을 획득했는지** 돌려준다.
 *
 * 중간에 닫으면 false다 — 정책상 닫을 수 있어야 하고, 그때는 보상을 주지 않는 게 맞다.
 * 광고가 준비되지 않았으면 띄우지 않고 false를 돌려준다(호출부가 안내하도록).
 */
export async function showRewarded(): Promise<boolean> {
  const ad = ready;
  if (!ad || !ad.loaded) {
    preloadRewarded(); // 다음 기회를 위해 받아둔다
    return false;
  }
  ready = null;

  const earned = await new Promise<boolean>((resolve) => {
    let settled = false;
    let gotReward = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ad.removeAllListeners();
      resolve(gotReward);
    };

    timer = setTimeout(finish, SHOW_TIMEOUT_MS);

    // 보상 획득은 닫힘보다 먼저 온다 — 플래그로 받아두고 닫힐 때 확정한다.
    ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
      gotReward = true;
    });
    ad.addAdEventListener(AdEventType.CLOSED, finish);
    ad.addAdEventListener(AdEventType.ERROR, finish);
    ad.show().catch(finish);
  });

  preloadRewarded(); // 다음 회차용
  return earned;
}
