// 푸시 알림 API (백엔드 B의 /api/v1/chatbot/push·notifications 연동, 인증 필요)
//
// 토큰 등록과 수신 설정 동기화 두 가지를 다룬다. 설정을 서버에도 보내는 이유는
// 푸시를 서버가 보내기 때문이다 — 방해금지 구간과 종류별 on/off를 서버가 모르면
// 사장님이 꺼둔 알림이 그대로 날아간다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export type NotificationSettings = {
  push_enabled: boolean;
  compliance_alert: boolean;
  report_alert: boolean;
  stock_alert: boolean;
  sensor_alert: boolean;
  /** 주변 소식 — 곧 열리는 행사(AI 준비 제안 포함)·경쟁 카페 개업/폐업 */
  nearby_alert: boolean;
  /**
   * 아침 브리핑 + 선제 인사이트(정산 미입력·뜸해진 단골·POS 연동 끊김·메뉴 원가…).
   * 설정의 '놓친 일 먼저 알려주기' 스위치가 이 값을 움직인다. 구버전 서버는 안 받는다.
   */
  insight_alert?: boolean;
  report_frequency: 'daily' | 'weekly';
  dnd_enabled: boolean;
  dnd_start: string; // 'HH:MM'
  dnd_end: string;
};

export type NotificationSettingsResponse = NotificationSettings & {
  store_id: string;
  /** 서버에 FCM 자격증명이 있어 실제 발송이 가능한지 — false면 설정 화면에 안내를 띄운다 */
  push_configured: boolean;
  device_count: number;
};

/** 기기 푸시 토큰 등록/갱신 (upsert) — 로그인 직후와 토큰 갱신 때마다 호출 */
export async function registerPushToken(
  token: string,
  fcmToken: string,
  platform: 'android' | 'ios' | 'web' = 'android',
  deviceName?: string
): Promise<void> {
  await apiFetch<void>('/api/v1/chatbot/push/tokens', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ token: fcmToken, platform, device_name: deviceName }),
  });
}

/** 로그아웃 시 해제 — 이 기기로 더는 알림이 가지 않게 한다 */
export async function unregisterPushToken(token: string, fcmToken: string): Promise<void> {
  await apiFetch<void>(`/api/v1/chatbot/push/tokens?token=${encodeURIComponent(fcmToken)}`, {
    method: 'DELETE',
    headers: auth(token),
  });
}

export async function getNotificationSettings(token: string): Promise<NotificationSettingsResponse> {
  return apiFetch<NotificationSettingsResponse>('/api/v1/chatbot/notifications/settings', {
    headers: auth(token),
  });
}

export async function updateNotificationSettings(
  token: string,
  settings: NotificationSettings
): Promise<NotificationSettingsResponse> {
  return apiFetch<NotificationSettingsResponse>('/api/v1/chatbot/notifications/settings', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(settings),
  });
}

/** 설정 화면의 '테스트 알림' 버튼 — 지금 이 기기로 시험 발송 */
export async function sendTestPush(token: string): Promise<{ sent: number }> {
  return apiFetch<{ sent: number }>('/api/v1/chatbot/notifications/test', {
    method: 'POST',
    headers: auth(token),
  });
}
