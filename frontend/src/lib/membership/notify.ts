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
  /** 복사가 실패했을 때 사장님이 직접 복사하도록 보여줄 문구 */
  text?: string;
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

/**
 * 웹에서는 문자앱이 없다 — 문구를 클립보드에 복사해 준다.
 *
 * [한글 주석] 복사가 실패하는 경우가 실제로 있다.
 *
 *   navigator.clipboard는 '문서에 포커스가 있을 때'만 동작한다.
 *   확인 대화상자(window.confirm)가 포커스를 가져갔다 막 닫힌 직후에 부르면
 *   "Document is not focused" 오류가 난다.
 *
 *   그래서 세 단계로 시도한다.
 *     1) 포커스를 되돌리고 clipboard API
 *     2) 실패하면 textarea + execCommand (구식이지만 포커스를 직접 잡는다)
 *     3) 그래도 안 되면 실패로 알리고, 부르는 쪽이 문구를 보여준다
 *
 *   복사가 안 됐는데 "복사했습니다"라고 하면 사장님이 빈 클립보드를
 *   붙여넣게 되므로, 실패를 감추지 않는 게 중요하다.
 */
async function copyToClipboard(text: string): Promise<NotifyResult> {
  // 1) 표준 API — 포커스를 먼저 되돌린다
  try {
    if (typeof window !== 'undefined') window.focus();
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch {
    // 포커스 문제 등 — 아래 폴백으로 넘어간다
  }

  // 2) 구식 폴백 — textarea에 넣고 직접 선택해 복사한다
  try {
    if (typeof document === 'undefined') {
      return { ok: false, reason: '클립보드를 사용할 수 없습니다.' };
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    // 화면에 보이지 않게 하되 focus는 가능해야 하므로 display:none은 쓸 수 없다
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return { ok: true };
  } catch {
    // 마지막 폴백으로 넘어간다
  }

  return { ok: false, reason: '복사에 실패했습니다. 아래 문구를 직접 복사해 주세요.' };
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
    // 실패하면 문구를 함께 돌려준다 — 복사가 안 됐는데 안내만 하면
    // 사장님이 빈 클립보드를 붙여넣게 된다
    return r.ok
      ? { ok: true, reason: '문구를 복사했습니다. 문자앱에 붙여넣어 보내세요.' }
      : { ...r, text };
  }
  return sendViaDeviceSms(phone, text);
}
