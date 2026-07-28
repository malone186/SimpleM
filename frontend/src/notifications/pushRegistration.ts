// FCM 푸시 등록 (백엔드 B) — 권한 → 채널 → 토큰 발급 → 서버 등록까지
//
// 백엔드가 FCM HTTP v1로 직접 쏘므로 Expo 푸시 서비스가 아니라 '원시 FCM 토큰'을 쓴다
// (getExpoPushTokenAsync가 아니라 getDevicePushTokenAsync).
//
// 토큰 만료 대응: FCM 등록 토큰은 앱 재설치·데이터 삭제·장기 미사용으로 언제든 무효화된다.
// 만료 시각을 우리가 추적할 방법은 없고 그럴 필요도 없다 —
//   ① addPushTokenListener가 토큰이 바뀌는 순간 알려주므로 그때 서버에 재등록하고,
//   ② 앱이 뜰 때마다 한 번 더 등록해 (upsert) 놓친 갱신을 따라잡고,
//   ③ 그래도 죽은 토큰이 남으면 발송 시 FCM이 UNREGISTERED로 알려주고 서버가 지운다.
// 이 세 겹이면 "키 만료 시 자동 재발급"이 별도 코드 없이 성립한다.
//
// 주의: SDK 53부터 안드로이드 Expo Go에서는 원격 푸시가 동작하지 않는다.
// 개발 빌드(expo-dev-client)에서만 토큰이 발급되므로, Expo Go에서는 조용히 건너뛴다.
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { registerPushToken, unregisterPushToken } from '../lib/api/push';
import { navigateToTarget, type PushTarget } from './navigationTarget';

// 백엔드 push_service.py의 CHANNEL_DEFAULT/CHANNEL_URGENT와 반드시 같아야 한다 —
// 서버가 보낸 channel_id에 해당하는 채널이 없으면 안드로이드가 기본 채널로 강등한다.
const CHANNEL_DEFAULT = 'brewnote-default';
const CHANNEL_URGENT = 'brewnote-urgent';

/** 원격 푸시를 쓸 수 있는 환경인지 — 웹과 Expo Go는 제외 */
function isPushSupported(): boolean {
  if (Platform.OS === 'web') return false;
  // storeClient = Expo Go. SDK 53+ 안드로이드에서 원격 푸시 미지원
  return Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

/** expo-notifications를 지연 로드한다 — 미설치·미지원 환경에서 import만으로 죽지 않게 */
function loadNotifications(): typeof import('expo-notifications') | null {
  try {
    return require('expo-notifications');
  } catch {
    return null;
  }
}

/** 마지막으로 서버에 등록한 FCM 토큰 — 로그아웃 시 해제하려면 값을 들고 있어야 한다 */
let currentFcmToken: string | null = null;

/**
 * 안드로이드 알림 채널 생성. Android 8+ 필수이고, Android 13의 권한 팝업은
 * 채널이 최소 하나 있어야 뜨므로 권한 요청·토큰 발급보다 먼저 불러야 한다.
 */
async function ensureChannels(N: typeof import('expo-notifications')): Promise<void> {
  if (Platform.OS !== 'android') return;

  await N.setNotificationChannelAsync(CHANNEL_DEFAULT, {
    name: '브루노트 알림',
    description: '경영 리포트·재고 소진·서류 갱신 안내',
    importance: N.AndroidImportance.DEFAULT,
    sound: 'default',
  });

  // 설비 이상(냉장고 온도 이탈)은 식자재 폐기로 직결돼 방해금지도 뚫어야 한다.
  // 안드로이드는 DND 우회를 채널 단위로 정하므로 채널이 분리돼 있어야 한다.
  await N.setNotificationChannelAsync(CHANNEL_URGENT, {
    name: '긴급 설비 알림',
    description: '냉장고 온도 이탈 등 즉시 조치가 필요한 알림',
    importance: N.AndroidImportance.MAX,
    sound: 'default',
    bypassDnd: true,
    enableVibrate: true,
  });
}

/** 알림 권한 확보 — 이미 허용됐으면 다시 묻지 않는다 */
async function ensurePermission(N: typeof import('expo-notifications')): Promise<boolean> {
  const current = await N.getPermissionsAsync();
  if (current.granted) return true;
  // 사용자가 명시적으로 거부한 뒤에는 다시 물어도 팝업이 뜨지 않는다 — 설정에서 켜야 한다
  if (!current.canAskAgain) return false;
  const asked = await N.requestPermissionsAsync();
  return asked.granted;
}

/**
 * 푸시 등록 전체 흐름. 성공하면 FCM 토큰을, 실패·미지원이면 null을 돌려준다.
 * 실패는 예외로 올리지 않는다 — 푸시가 안 된다고 앱이 멈추면 안 된다.
 */
export async function registerForPush(authToken: string): Promise<string | null> {
  if (!isPushSupported()) return null;

  const N = loadNotifications();
  if (!N) return null;

  try {
    // 순서 중요: 채널 → 권한 → 토큰
    await ensureChannels(N);
    if (!(await ensurePermission(N))) return null;

    const devicePushToken = await N.getDevicePushTokenAsync();
    const fcmToken = devicePushToken.data;
    if (!fcmToken) return null;

    await registerPushToken(
      authToken,
      fcmToken,
      Platform.OS === 'android' ? 'android' : 'ios',
      Constants.deviceName ?? undefined
    );
    currentFcmToken = fcmToken;
    return fcmToken;
  } catch (e) {
    // 개발 빌드가 아니거나 google-services.json이 없으면 여기로 온다 — 조용히 포기
    console.warn('[push] 등록 실패:', e);
    return null;
  }
}

/**
 * 로그아웃 시 호출 — 이 기기로 이전 사장님 알림이 계속 가지 않게 한다.
 *
 * currentFcmToken은 이번 앱 실행에서 등록을 거쳤을 때만 채워져 있다. 자동 로그인으로
 * 켜자마자 로그아웃하는 흐름에서는 비어 있으므로, 그때는 기기에서 토큰을 직접 물어본다.
 * (이 경로가 없으면 앱 재시작 후 로그아웃이 서버에 아무 영향을 주지 못한다)
 */
export async function unregisterFromPush(authToken: string): Promise<void> {
  let fcmToken = currentFcmToken;

  if (!fcmToken && isPushSupported()) {
    const N = loadNotifications();
    try {
      fcmToken = N ? ((await N.getDevicePushTokenAsync()).data as string) : null;
    } catch {
      fcmToken = null; // 권한 없음·개발빌드 아님 — 애초에 등록된 적이 없다
    }
  }
  if (!fcmToken) return;

  try {
    await unregisterPushToken(authToken, fcmToken);
  } catch {
    // 서버 오프라인 — 다음 로그인 때 토큰 소유자가 덮어써지므로 치명적이지 않다
  }
  currentFcmToken = null;
}

/**
 * 알림을 탭했을 때 열 화면. 서버가 data.screen으로 넣어 보낸다
 * (compliance→Document, report→Dashboard, stock→Order, sensor→Dashboard).
 *
 * 앱이 완전히 종료된 상태에서 알림으로 실행되면 네비게이터가 준비되기 전에 이벤트가
 * 지나가므로, 이동에 실패하면 여기 담아 두고 RootNavigator의 onReady에서 꺼내 쓴다.
 */
let pendingTarget: PushTarget | null = null;

export function takePendingTarget(): PushTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

/** 탭 이벤트 처리 — 지금 이동할 수 있으면 바로 가고, 아니면 보류함에 넣는다 */
function handleTap(data: Record<string, string> | undefined) {
  if (!data?.screen) return;
  const target: PushTarget = { screen: data.screen, params: data };
  if (!navigateToTarget(target)) pendingTarget = target;
}

/**
 * 앱 전역에 한 번만 붙이는 훅 — 로그인 상태가 되면 등록하고, 토큰이 바뀌면 재등록한다.
 * AlertsWatcher(헤드리스)에서 호출한다.
 */
export function usePushRegistration(authToken: string | null) {
  // 같은 토큰으로 중복 등록하지 않도록 마지막 처리한 인증 토큰을 기억
  const registeredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!authToken || !isPushSupported()) return;
    if (registeredFor.current === authToken) return;
    registeredFor.current = authToken;

    const N = loadNotifications();
    if (!N) return;

    // 앱이 켜져 있을 때 도착한 알림도 배너로 보여준다 (기본값은 표시 안 함)
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    void registerForPush(authToken);

    // ① 토큰 자동 재발급 — FCM이 토큰을 굴리면 즉시 서버에 새 토큰을 올린다
    const tokenSub = N.addPushTokenListener((token) => {
      currentFcmToken = token.data;
      registerPushToken(
        authToken,
        token.data,
        Platform.OS === 'android' ? 'android' : 'ios',
        Constants.deviceName ?? undefined
      ).catch(() => {
        // 실패해도 다음 앱 실행 때 registerForPush가 다시 올린다
      });
    });

    // ② 알림 탭 → 해당 화면으로 이동
    const tapSub = N.addNotificationResponseReceivedListener((response) => {
      handleTap(response.notification.request.content.data as Record<string, string> | undefined);
    });

    // ③ 앱이 종료된 상태에서 알림으로 실행된 경우 — 위 리스너가 붙기 전에 이벤트가 끝나
    // 있으므로 마지막 응답을 직접 꺼내 온다. 이게 없으면 콜드스타트 탭이 전부 무시된다.
    // 처리한 뒤 clear하지 않으면 로그아웃 후 재로그인 등으로 이 훅이 다시 돌 때마다
    // 같은 알림으로 또 이동한다.
    try {
      const last = N.getLastNotificationResponse();
      if (last) {
        handleTap(last.notification.request.content.data as Record<string, string> | undefined);
        N.clearLastNotificationResponse();
      }
    } catch {
      // 미지원 환경 — 포그라운드 탭은 위 리스너가 처리하므로 치명적이지 않다
    }

    return () => {
      tokenSub.remove();
      tapSub.remove();
    };
  }, [authToken]);
}
