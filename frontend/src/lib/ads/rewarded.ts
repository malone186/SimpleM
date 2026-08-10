// 보상형 광고(Rewarded) — 끝까지 보면 보상을 주는 형식.
//
// 전면 광고(interstitial.ts)와 역할이 다르다. 전면 광고는 대기 시간을 메우는 용도라
// 사용자에게 묻지 않고 띄우지만, 보상형은 AdMob 정책상 반드시 사용자가 명시적으로
// 동의한 뒤에만 띄울 수 있고 중간에 닫을 수 있어야 한다. 그래서 이 모듈은 광고만
// 담당하고, "볼래요?" 확인은 호출부(기존 confirmDialog)가 맡는다.
import { AdEventType, RewardedAd, RewardedAdEventType } from 'react-native-google-mobile-ads';

import { adUnitId } from './ids';
import { initAds } from './init';
import { mockAvailable, showMockRewarded } from './mockRewarded';

const SHOW_TIMEOUT_MS = 5 * 60 * 1000;

let ready: RewardedAd | null = null;
let loading = false;

// 지금 받아둔 광고가 어느 계정 앞으로 요청된 것인지. 서버 사이드 검증(SSV) 식별자는
// 광고를 '요청할 때'만 심을 수 있어서, 계정이 바뀌면 받아둔 광고를 버리고 다시 받아야 한다.
let loadedForUser: string | undefined;

// SDK를 아예 쓸 수 없는 환경(Expo Go 등)인지. preload 시점에 확정된다.
// '아직 로드 안 됨'과 구분해야 한다 — 개발 빌드에서는 진짜 테스트 광고를 띄워야 하므로,
// 단순히 로드가 안 끝난 상태에 모의 광고가 끼어들면 안 된다.
let sdkUnavailable = false;

/**
 * 광고를 미리 받아둔다 (로드 1~3초). 보상형은 사용자를 기다리게 하면 안 되므로 선로딩이 중요하다.
 *
 * ssvUserId(로그인 이메일)를 주면 서버 사이드 검증 식별자로 광고 요청에 심는다. 사용자가
 * 광고를 끝까지 보면 구글이 이 값을 담아 우리 서버로 직접 알려주고(SSV 콜백), 서버는
 * 그 서명된 통보를 근거로 턴을 충전한다 — 앱의 '다 봤어요' 보고보다 위조가 불가능하다.
 * 이 값은 광고를 **요청할 때만** 심을 수 있어서 show 시점에 붙일 수 없다.
 */
export function preloadRewarded(ssvUserId?: string): void {
  // 다른 계정 앞으로 받아둔(또는 받는 중인) 광고는 충전이 그 계정으로 가버린다 — 버리고 다시 받는다.
  if ((ready || loading) && loadedForUser !== ssvUserId) {
    ready = null;
    loading = false;
  }
  if (ready || loading) return;
  loading = true;
  loadedForUser = ssvUserId;

  initAds()
    .then((allowed) => {
      if (!allowed) {
        // SDK 초기화 실패 = Expo Go처럼 네이티브 모듈이 없는 환경
        sdkUnavailable = true;
        loading = false;
        return;
      }
      const ad = RewardedAd.createForAdRequest(
        adUnitId('rewarded'),
        ssvUserId ? { serverSideVerificationOptions: { userId: ssvUserId } } : undefined,
      );
      const offs: Array<() => void> = [];
      const cleanup = () => offs.forEach((off) => off());
      // 이 로드가 끝나기 전에 계정이 바뀌면 결과를 버려야 한다 — 안 그러면 로그아웃 직후
      // 도착한 광고가 이전 계정 식별자를 단 채 ready에 앉는다.
      const stale = () => loadedForUser !== ssvUserId;

      offs.push(
        ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
          cleanup();
          if (stale()) {
            ad.removeAllListeners();
            return;
          }
          ready = ad;
          loading = false;
          if (__DEV__) console.log('[ads] 보상형 광고 로드 완료 — 띄울 준비됨');
        }),
      );
      offs.push(
        ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
          if (__DEV__) console.warn('[ads] 보상형 광고 로드 실패:', error?.message);
          cleanup();
          ad.removeAllListeners();
          if (stale()) return;
          loading = false;
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
  if (ready != null && ready.loaded) return true;
  return sdkUnavailable && mockAvailable();
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
    // SDK가 없는 개발 환경에서는 모의 광고로 흐름만 확인한다 (릴리즈에서는 도달하지 않음)
    if (sdkUnavailable && mockAvailable()) return showMockRewarded();
    preloadRewarded(loadedForUser); // 다음 기회를 위해 받아둔다 (같은 계정 앞으로)
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

  preloadRewarded(loadedForUser); // 다음 회차용 (같은 계정 앞으로)
  return earned;
}
