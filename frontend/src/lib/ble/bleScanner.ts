// 네이티브(안드로이드/iOS)용 실제 BLE 스캔 — react-native-ble-plx
// 주의: 네이티브 모듈이라 Expo Go에서는 동작하지 않는다.
//   npx expo prebuild && npx expo run:android  (개발 빌드)로 실행해야 실기기 스캔 가능.
// Expo Go/모듈 미설치 환경에서는 getBleAvailability()가 안내 문구와 함께 false를 준다.
import { PermissionsAndroid, Platform } from 'react-native';
import { BleAvailability, FoundBleDevice, ScanOptions, matchesHint } from './bleTypes';

let _manager: any = null;
let _initError: string | null = null;

function getManager(): any {
  if (_manager) return _manager;
  if (_initError) throw new Error(_initError);
  try {
    // 동적 require: 모듈이 없거나 Expo Go(네이티브 미링크)여도 앱이 죽지 않게
    const { BleManager } = require('react-native-ble-plx');
    _manager = new BleManager();
    return _manager;
  } catch {
    _initError =
      'Expo Go에서는 블루투스 스캔을 쓸 수 없어요. 개발 빌드(npx expo run:android)로 실행하거나, 웹(Chrome)에서 열어주세요.';
    throw new Error(_initError);
  }
}

export function getBleAvailability(): BleAvailability {
  try {
    getManager();
    return { available: true, reason: null };
  } catch (e: any) {
    return { available: false, reason: e?.message ?? '블루투스를 사용할 수 없어요.' };
  }
}

// 라이브 리더(bleLiveReader)가 페어링된 기기에 GATT 연결할 때 재사용
export function getNativeBleManager(): any {
  return getManager();
}

// 안드로이드 12+: BLUETOOTH_SCAN/CONNECT, 11 이하: 위치 권한이 BLE 스캔 조건
async function ensureAndroidPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const api = Number(Platform.Version);
  const wanted =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted as any);
  const denied = Object.values(result).some((v) => v !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied) throw new Error('블루투스 스캔 권한이 거부됐어요. 설정에서 권한을 허용해 주세요.');
}

export async function scanForBleDevices(opts: ScanOptions): Promise<FoundBleDevice[]> {
  const manager = getManager();
  await ensureAndroidPermissions();

  const state = await manager.state();
  if (state !== 'PoweredOn') {
    throw new Error('휴대폰 블루투스가 꺼져 있어요. 블루투스를 켜고 다시 스캔해 주세요.');
  }

  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise<FoundBleDevice[]>((resolve, reject) => {
    const seen = new Map<string, FoundBleDevice>();
    const finish = (err?: Error) => {
      manager.stopDeviceScan();
      if (err) reject(err);
      else {
        // 권장 기기 우선 → 신호 센 순
        const list = [...seen.values()].sort(
          (a, b) =>
            Number(b.hintMatch) - Number(a.hintMatch) || (b.rssi ?? -999) - (a.rssi ?? -999),
        );
        resolve(list);
      }
    };
    const timer = setTimeout(() => finish(), timeoutMs);

    manager.startDeviceScan(null, { allowDuplicates: false }, (error: any, device: any) => {
      if (error) {
        clearTimeout(timer);
        finish(new Error(error?.message ?? '스캔 중 오류가 발생했어요.'));
        return;
      }
      const name = device?.name || device?.localName;
      if (!name || seen.has(device.id)) return; // 이름 없는 광고 패킷은 제외
      const found: FoundBleDevice = {
        id: device.id,
        name,
        rssi: typeof device.rssi === 'number' ? device.rssi : null,
        hintMatch: matchesHint(name, opts.hints),
      };
      seen.set(device.id, found);
      opts.onDevice?.(found);
    });
  });
}
