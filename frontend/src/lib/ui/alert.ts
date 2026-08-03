// 확인 대화상자 — 웹에서도 동작하는 Alert 대체
//
// [한글 주석] 왜 필요한가:
//
//   react-native-web의 Alert.alert는 아무것도 하지 않는 빈 함수다.
//
//       class Alert { static alert() {} }
//
//   그래서 웹에서 "충전하시겠습니까?" 확인 팝업을 넣었더니
//   팝업이 뜨지도 않고 onPress도 불리지 않아, 버튼을 눌러도 아무 일이 없었다.
//   앱(폰)에서는 정상 동작해서 더 알아채기 어려웠다.
//
//   웹에서는 브라우저 기본 대화상자로 대체한다. 예쁘지는 않지만
//   '눌렀는데 아무 일도 안 일어나는' 것보다는 훨씬 낫다.
import { Alert, Platform } from 'react-native';

export type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

/**
 * 알림/확인 대화상자를 띄웁니다.
 *
 * 버튼 0~1개 → 단순 알림
 * 버튼 2개  → 확인/취소 (웹은 window.confirm)
 *
 * [한글 주석] 버튼 3개 이상은 웹에서 표현할 방법이 없어 지원하지 않는다.
 * 필요해지면 그때는 Modal로 직접 만들어야 한다.
 */
export function showAlert(title: string, message?: string, buttons?: AlertButton[]) {
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, buttons);
    return;
  }

  const text = message ? `${title}\n\n${message}` : title;

  if (!buttons || buttons.length === 0) {
    window.alert(text);
    return;
  }

  if (buttons.length === 1) {
    window.alert(text);
    buttons[0].onPress?.();
    return;
  }

  // 2개 — 취소가 아닌 것 중 '마지막'을 확인으로 본다.
  //
  // [한글 주석] find로 첫 번째를 고르면 안 된다.
  //   [{text:'나중에'}, {text:'지금', onPress}] 처럼 취소 스타일이 없는 경우
  //   '나중에'가 확인으로 잡혀 정작 실행할 동작이 안 불린다.
  //   RN에서도 마지막 버튼이 주 동작이라 그 관례를 따른다.
  const cancel = buttons.find((b) => b.style === 'cancel');
  const nonCancel = buttons.filter((b) => b.style !== 'cancel');
  const confirm = nonCancel[nonCancel.length - 1] ?? buttons[buttons.length - 1];

  if (window.confirm(text)) {
    confirm.onPress?.();
  } else {
    cancel?.onPress?.();
  }
}
