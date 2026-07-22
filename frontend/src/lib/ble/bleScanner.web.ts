// 웹(react-native-web)용 실제 BLE 스캔 — Web Bluetooth API
// 크롬/엣지에서 브라우저 기기 선택창이 뜨고, 사용자가 실제 주변 BLE 기기를 고른다.
// (localhost 또는 HTTPS에서만 동작. 파이어폭스/사파리는 미지원)
import {
  BleAvailability,
  FoundBleDevice,
  ScanOptions,
  SM_HUB_SERVICE,
  XIAOMI_TEMP_SERVICE,
  matchesHint,
} from './bleTypes';

// 선택창에서 고른 실기기 핸들 보관 — 페어링 후 라이브 리더(bleLiveReader)가 GATT 연결에 재사용
const _handles = new Map<string, any>();
export const getWebBleDevice = (id: string): any => _handles.get(id);

export function getBleAvailability(): BleAvailability {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav?.bluetooth) {
    return {
      available: false,
      reason: '이 브라우저는 블루투스 스캔(Web Bluetooth)을 지원하지 않아요. Chrome 또는 Edge에서 열어주세요.',
    };
  }
  return { available: true, reason: null };
}

// 브라우저 선택창은 그 자체가 실기기 스캔 목록이라, 사용자가 고른 1대를 반환한다.
// 취소하면 빈 배열 (에러 아님).
export async function scanForBleDevices(opts: ScanOptions): Promise<FoundBleDevice[]> {
  const bluetooth = (navigator as any).bluetooth;
  try {
    const device = await bluetooth.requestDevice({
      acceptAllDevices: true,
      // 페어링 후 실측값을 직접 읽을 GATT 서비스 접근 권한 (선택 시점에 미리 선언해야 함)
      optionalServices: [SM_HUB_SERVICE, XIAOMI_TEMP_SERVICE, 'battery_service'],
    });
    _handles.set(device.id, device);
    const found: FoundBleDevice = {
      id: device.id,
      name: device.name || '(이름 없는 기기)',
      rssi: null, // Web Bluetooth는 선택창 밖에서 RSSI를 주지 않음
      hintMatch: matchesHint(device.name, opts.hints),
    };
    opts.onDevice?.(found);
    return [found];
  } catch (e: any) {
    if (e?.name === 'NotFoundError') return []; // 사용자가 선택창을 취소함
    throw e;
  }
}
