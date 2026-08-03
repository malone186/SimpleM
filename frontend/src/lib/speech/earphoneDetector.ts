// 이어폰(외부 오디오 출력 장치) 감지 — 네이티브(Android/iOS) 구현
// (Metro가 웹에서는 earphoneDetector.web.ts를 자동 선택한다)
//
// ═══════════════════════════════════════════════════
// [한글 주석] 왜 다시 만들었나 — "이어폰을 꽂아도 알림을 안 읽어주던" 원인
//
// react-native-device-info의 안드로이드 구현은 이렇게 생겼다:
//   isHeadphonesConnected() = audioManager.isWiredHeadsetOn() || audioManager.isBluetoothA2dpOn()
//
// 둘 다 오래된(deprecated) API라서 실제로 이어폰이 꽂혀 있어도 false가 나오는 경우가 많다:
//   · isWiredHeadsetOn()   — USB-C 이어폰/젠더는 잡지 못하는 기기가 많다
//   · isBluetoothA2dpOn()  — "지금 A2DP로 소리가 흐르는 중인가"에 가까워서, 연결만 되어 있고
//                            재생 중이 아니면 false. 안드로이드 13+ LE Audio 이어폰은 A2DP가
//                            아니라 아예 잡히지 않는다.
// 예전 코드는 이 값이 false면 곧장 "재생 금지"로 판단해서, 사장님 입장에선 이어폰을 꼈는데도
// 아무 소리가 안 나는 상태가 됐다.
//
// 그래서 세 겹으로 다시 짰다:
//   ① 세 가지 조회(통합/유선/블루투스)를 각각 따로 try/catch로 돌려 하나라도 true면 연결로 본다
//      (예전엔 Promise.all이라 하나가 던지면 나머지 결과까지 통째로 버려졌다)
//   ② 네이티브 브로드캐스트 이벤트(RNDeviceInfo_headphone*ConnectionDidChange)를 구독해
//      "꽂힘/뽑힘" 순간을 따로 기록한다 — 조회가 false를 줘도 최근에 꽂힘 신호가 있었고
//      뽑힘 신호가 없었다면 연결 상태로 유지한다(A2DP 라우팅이 잠깐 끊겨 false로 튀는 것 방지)
//   ③ 그래도 모르면 supported=false로 정직하게 보고한다 → 정책(audioPolicy)이 침묵 대신 재생을 택한다
// ═══════════════════════════════════════════════════
import { DeviceEventEmitter } from 'react-native';

import type { EarphoneStatus } from './speechTypes';

// 네이티브 모듈이 없으면 import가 아니라 "호출 시점"에 터지므로 require와 호출 양쪽을 감싼다
let DeviceInfo: any = null;
try {
  const mod = require('react-native-device-info');
  DeviceInfo = mod?.default ?? mod;
} catch {
  DeviceInfo = null;
}

/** 조회가 false로 튀어도 이 시간 안에 '꽂힘'을 본 적이 있으면 연결로 간주한다 */
const GRACE_MS = 10 * 60_000;
/** 같은 값을 짧은 간격에 반복 조회하지 않도록 하는 캐시 수명 (큐가 연속 재생할 때 브리지 부하 방지) */
const CACHE_TTL_MS = 1_500;

let _lastConnectedAt = 0; // 마지막으로 '연결됨'을 확인한 시각
let _lastConnectedVia: 'wired' | 'bluetooth' | null = null;
let _lastDisconnectedAt = 0; // 네이티브가 '뽑힘'을 알려준 시각
let _cache: { at: number; value: EarphoneStatus } | null = null;
let _subscribed = false;

/** 네이티브 브로드캐스트(꽂힘/뽑힘) 구독 — 앱 수명 동안 한 번만 */
function subscribeOnce(): void {
  if (_subscribed) return;
  _subscribed = true;
  const bind = (event: string, via: 'wired' | 'bluetooth' | null) => {
    try {
      DeviceEventEmitter.addListener(event, (connected: boolean) => {
        if (connected) {
          _lastConnectedAt = Date.now();
          if (via) _lastConnectedVia = via;
        } else {
          _lastDisconnectedAt = Date.now();
        }
        _cache = null; // 상태가 바뀌었으니 다음 조회는 새로 한다
      });
    } catch {
      // 이벤트 이미터가 없는 환경 — 조회 기반 감지만 쓴다
    }
  };
  bind('RNDeviceInfo_headphoneConnectionDidChange', null);
  bind('RNDeviceInfo_headphoneWiredConnectionDidChange', 'wired');
  bind('RNDeviceInfo_headphoneBluetoothConnectionDidChange', 'bluetooth');
}

/** 조회 하나를 안전하게 실행 — 못 쓰거나 던지면 null(=모름), 성공하면 boolean */
async function probe(fn: unknown): Promise<boolean | null> {
  if (typeof fn !== 'function') return null;
  try {
    return !!(await (fn as () => Promise<boolean> | boolean)());
  } catch {
    return null;
  }
}

/** 지금 이어폰이 연결되어 있는지 — 캐시 없이 실제로 조회한다 */
async function detectFresh(): Promise<EarphoneStatus> {
  subscribeOnce();

  if (!DeviceInfo) {
    return {
      connected: false,
      supported: false,
      via: null,
      reason: '이 빌드에는 오디오 장치 감지 모듈이 없어요. (Expo Go — 개발 빌드에서 감지됩니다)',
    };
  }

  // ① 세 가지 조회를 각각 독립적으로 — 하나가 실패해도 나머지 결과는 살린다
  const [wired, bluetooth, any] = await Promise.all([
    probe(DeviceInfo.isWiredHeadphonesConnected),
    probe(DeviceInfo.isBluetoothHeadphonesConnected),
    probe(DeviceInfo.isHeadphonesConnected),
  ]);

  const supported = wired !== null || bluetooth !== null || any !== null;
  if (!supported) {
    return {
      connected: false,
      supported: false,
      via: null,
      reason: '이 기기에서는 오디오 출력 장치를 확인할 수 없어요.',
    };
  }

  const now = Date.now();
  if (wired || bluetooth || any) {
    _lastConnectedAt = now;
    _lastConnectedVia = bluetooth ? 'bluetooth' : wired ? 'wired' : _lastConnectedVia;
    return {
      connected: true,
      supported: true,
      via: bluetooth ? 'bluetooth' : wired ? 'wired' : null,
      reason: null,
    };
  }

  // ② 조회는 false지만, 최근에 '꽂힘'을 봤고 그 뒤로 '뽑힘'이 없었다면 연결로 본다.
  //    (블루투스 A2DP 라우팅이 잠깐 끊기거나 LE Audio라 조회가 못 잡는 경우 대비)
  if (
    _lastConnectedAt > 0 &&
    now - _lastConnectedAt < GRACE_MS &&
    _lastDisconnectedAt < _lastConnectedAt
  ) {
    return {
      connected: true,
      supported: true,
      via: _lastConnectedVia ?? 'recent',
      reason: null,
    };
  }

  return {
    connected: false,
    supported: true,
    via: null,
    reason: '이어폰(블루투스 포함)이 연결되어 있지 않아요.',
  };
}

/** 이어폰 연결 여부 (짧은 캐시 사용 — 큐가 연속으로 물어봐도 브리지를 두들기지 않는다) */
export async function detectEarphone(): Promise<EarphoneStatus> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.value;
  const value = await detectFresh();
  _cache = { at: Date.now(), value };
  return value;
}

/** 캐시를 버리고 다음 조회를 강제한다 — 설정 화면의 '다시 확인' 버튼용 */
export function resetEarphoneCache(): void {
  _cache = null;
}

export default detectEarphone;
