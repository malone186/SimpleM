/**
 * [한글 주석] 웹에서 확인 대화상자가 실제로 동작하는지 고정한다.
 *
 * react-native-web의 Alert.alert는 아무것도 하지 않는 빈 함수다.
 *
 *     class Alert { static alert() {} }
 *
 * 그래서 충전 전 확인 팝업을 넣었더니 웹에서 버튼을 눌러도 아무 일이 없었다.
 * 팝업이 뜨지도 않고 onPress도 불리지 않았다.
 * 앱(폰)에서는 정상 동작해서 더 알아채기 어려웠다 —
 * 타입도 맞고 에러도 없고, 그냥 조용히 아무 일도 안 일어났다.
 */
import { Platform } from 'react-native';

import { showAlert } from '../alert';

const originalOS = Platform.OS;

beforeEach(() => {
  // 테스트에서 플랫폼을 바꾼다
  Platform.OS = 'web';
  window.alert = jest.fn();
  window.confirm = jest.fn();
});

afterEach(() => {
  // 원복
  Platform.OS = originalOS;
});

test('버튼이 없으면 단순 알림을 띄운다', () => {
  showAlert('충전 완료', '잔액 60,000원');
  expect(window.alert).toHaveBeenCalledWith('충전 완료\n\n잔액 60,000원');
});

test('버튼 1개면 알림을 띄우고 onPress를 부른다', () => {
  const onPress = jest.fn();
  showAlert('확인했습니다', undefined, [{ text: '확인', onPress }]);
  expect(window.alert).toHaveBeenCalled();
  expect(onPress).toHaveBeenCalled();
});

test('확인을 누르면 취소가 아닌 버튼이 실행된다', () => {
  // [핵심] 이게 안 불려서 충전이 안 됐다
  (window.confirm as jest.Mock).mockReturnValue(true);
  const onCancel = jest.fn();
  const onConfirm = jest.fn();

  showAlert('충전 전 손님께 안내', '보너스 10,000원 포함', [
    { text: '취소', style: 'cancel', onPress: onCancel },
    { text: '안내함 · 충전', onPress: onConfirm },
  ]);

  expect(onConfirm).toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

test('취소를 누르면 확인 버튼이 실행되지 않는다', () => {
  (window.confirm as jest.Mock).mockReturnValue(false);
  const onCancel = jest.fn();
  const onConfirm = jest.fn();

  showAlert('잔액 환불', '되돌릴 수 없습니다', [
    { text: '취소', style: 'cancel', onPress: onCancel },
    { text: '환불', style: 'destructive', onPress: onConfirm },
  ]);

  expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalled();
});

test('취소 버튼이 없어도 마지막 버튼을 확인으로 본다', () => {
  (window.confirm as jest.Mock).mockReturnValue(true);
  const onPress = jest.fn();
  showAlert('제목', '내용', [{ text: '나중에' }, { text: '지금', onPress }]);
  expect(onPress).toHaveBeenCalled();
});

test('앱에서는 브라우저 대화상자를 쓰지 않는다', () => {
  // 네이티브로 전환
  Platform.OS = 'ios';
  showAlert('제목', '내용');
  expect(window.alert).not.toHaveBeenCalled();
});
