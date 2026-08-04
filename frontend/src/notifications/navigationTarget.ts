// 푸시 알림 탭 → 화면 이동 (백엔드 B)
//
// AlertsWatcher는 NavigationContainer '바깥'에 붙어 있어서(App.tsx) useNavigation을 쓸 수 없다.
// 그래서 컨테이너 ref를 여기 두고, RootNavigator가 ref와 onReady를 연결한다.
//
// 앱이 완전히 종료된 상태에서 알림으로 실행되면 네비게이터가 준비되기 전에 탭 이벤트가
// 지나가므로, pushRegistration이 pendingTarget에 담아 두고 onReady에서 꺼내 쓴다.
import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

/** 하단 탭에 속한 화면들 — 스택이 아니라 'Tabs' 안에 중첩돼 있어 따로 넘겨야 한다 */
const TAB_SCREENS = new Set(['Dashboard', 'Inventory', 'Chatbot', 'Management']);

/**
 * 서버가 보낸 screen 값을 실제 라우트 이름으로 교정한다.
 *
 * 서버는 한동안 'Documents'(복수)를 보냈는데 실제 라우트는 'Document'(단수)라
 * 이동이 조용히 실패했다. 서버는 고쳤지만 이미 발송된 알림과 기기에 남아 있는
 * 알림에는 옛 값이 그대로 있으므로 여기서도 흡수한다.
 */
// 'Order'(발주)는 탭에서 빠진 화면이라 라우트가 없다. 서버·기기에 남아 있는 알림이
// 아직 Order를 보내므로, 같은 내용을 다루는 재고 화면으로 흡수한다.
const ALIASES: Record<string, string> = {
  Documents: 'Document',
  Report: 'Dashboard',
  Order: 'Inventory',
  Stock: 'Inventory',
};

export type PushTarget = { screen: string; params?: Record<string, string> };

/**
 * 알림에 담긴 목적지로 이동한다. 네비게이터가 아직 준비되지 않았으면 false를 돌려주고,
 * 호출자가 pendingTarget에 담아 두었다가 onReady에서 다시 시도한다.
 */
export function navigateToTarget(target: PushTarget): boolean {
  if (!navigationRef.isReady()) return false;

  const screen = ALIASES[target.screen] ?? target.screen;

  // screen·category는 라우팅용 메타라 화면에 넘길 이유가 없다 — 나머지(item_id 등)만 전달
  const { screen: _s, category: _c, ...params } = target.params ?? {};
  const hasParams = Object.keys(params).length > 0;

  try {
    if (TAB_SCREENS.has(screen)) {
      // @ts-expect-error — 런타임 문자열 라우트라 ParamList로 좁혀지지 않는다
      navigationRef.navigate('Tabs', { screen, params: hasParams ? params : undefined });
    } else {
      // @ts-expect-error — 위와 동일
      navigationRef.navigate(screen, hasParams ? params : undefined);
    }
    return true;
  } catch (e) {
    // 알 수 없는 화면 이름 — 알림은 이미 열렸으니 홈에 머무는 것으로 충분하다
    console.warn('[push] 알 수 없는 이동 대상:', target.screen, e);
    return false;
  }
}
