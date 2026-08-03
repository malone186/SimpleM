// 손님 알림 발송 — 발송 수단을 갈아끼울 수 있게 여기 한 곳에 모은다.
//
// [한글 주석] 왜 서버에서 안 보내고 사장님 폰으로 보내는가:
//
//   문자는 인터넷이 아니라 이동통신망으로 간다. 서버가 직접 못 보낸다.
//   중계 서비스(솔라피·알리고 등)를 쓰려면 사업자등록증과 발신번호 사전등록이
//   필요하고 심사에 3~5일이 걸린다. 카카오 알림톡은 템플릿 승인까지 더 걸린다.
//
//   그래서 지금은 사장님 폰의 기본 문자앱을 여는 방식으로 간다.
//     · 외부 서비스 불필요, 사업자등록증 불필요
//     · 발신번호가 사장님 본인 번호라 사전등록도 필요 없다
//     · 비용 0원 (대개 문자 무제한 요금제)
//     · 손님 입장에서도 가게 번호로 오니 신뢰도가 높다
//
//   한계는 자동 발송이 안 된다는 것이다. 충전은 어차피 사장님이 그 자리에서
//   처리하므로 버튼 한 번 더 누르는 것뿐이고, 초기 물량에서는 문제가 안 된다.
//
//   나중에 사업자등록이 되면 sendViaApi 쪽만 구현하고 sendNotification의
//   분기를 바꾸면 된다. 호출하는 화면 코드는 손대지 않는다.
import { Linking, Platform } from 'react-native';

export type NotifyResult = {
  ok: boolean;
  reason?: string;
};

/** 사장님 폰의 문자앱을 열고 수신번호·본문을 미리 채운다. */
async function sendViaDeviceSms(phone: string, text: string): Promise<NotifyResult> {
  const to = phone.replace(/\D/g, '');

  // [한글 주석] 본문 구분자가 OS마다 다르다.
  // iOS는 '&', 안드로이드는 '?' 를 쓴다. 반대로 넣으면 본문이 안 채워진다.
  const separator = Platform.OS === 'ios' ? '&' : '?';
  const url = `sms:${to}${separator}body=${encodeURIComponent(text)}`;

  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      return { ok: false, reason: '이 기기에서 문자앱을 열 수 없습니다.' };
    }
    await Linking.openURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 웹에서는 문자앱이 없다 — 문구를 클립보드에 복사해 준다. */
async function copyToClipboard(text: string): Promise<NotifyResult> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
    return { ok: false, reason: '클립보드를 사용할 수 없습니다.' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 손님에게 알림을 보냅니다.
 *
 * 앱: 문자앱을 열어 사장님이 전송 버튼만 누르면 됩니다.
 * 웹: 문자앱이 없으므로 문구를 복사해 드립니다.
 */
export async function sendNotification(phone: string, text: string): Promise<NotifyResult> {
  if (Platform.OS === 'web') {
    const r = await copyToClipboard(text);
    return r.ok
      ? { ok: true, reason: '문구를 복사했습니다. 문자앱에 붙여넣어 보내세요.' }
      : r;
  }
  return sendViaDeviceSms(phone, text);
}
