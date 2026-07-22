// 네이티브(개발 빌드)용 BLE 라이브 리더 — ble-plx로 페어링 기기에 연결해
// 측정값 notify를 구독하고 서버 /sensor/ingest 로 올린다. (웹 버전과 동일한 API)
// 지원 프로토콜: 자체 ESP32 허브(ffe1 JSON notify), 샤오미 LYWSD03MMC(냉장고 온도 슬롯).
import { postSensorReadings } from '../api/sensor';
import { getNativeBleManager } from './bleScanner';
import {
  SM_HUB_CHAR,
  SM_HUB_SERVICE,
  XIAOMI_TEMP_CHAR,
  XIAOMI_TEMP_SERVICE,
  base64ToBytes,
  bytesToText,
  parseXiaomiPacket,
} from './bleTypes';

export interface LiveReaderTarget {
  store: string;
  catalogId: string;
  bleId: string;   // BLE MAC(안드로이드) / 기기 UUID(iOS)
  bleName: string;
}

const MIN_POST_INTERVAL_MS = 5000;

interface ActiveReader {
  stop: () => void;
}

const _active = new Map<string, ActiveReader>();

export function stopBleLiveReader(catalogId: string): void {
  _active.get(catalogId)?.stop();
  _active.delete(catalogId);
}

export function stopAllBleLiveReaders(): void {
  for (const id of [..._active.keys()]) stopBleLiveReader(id);
}

export function startBleLiveReader(target: LiveReaderTarget): void {
  stopBleLiveReader(target.catalogId);

  let manager: any;
  try {
    manager = getNativeBleManager();
  } catch {
    return; // Expo Go 등 BLE 미지원 환경 — 조용히 무시 (페어링 상태엔 영향 없음)
  }

  let stopped = false;
  let subscription: any = null;
  let lastPostAt = 0;

  const post = (readings: Record<string, Record<string, unknown>>) => {
    const now = Date.now();
    if (now - lastPostAt < MIN_POST_INTERVAL_MS) return;
    lastPostAt = now;
    postSensorReadings(target.store, readings).catch(() => { });
  };

  const run = async () => {
    const device = await manager.connectToDevice(target.bleId, { timeout: 10000 });
    if (stopped) return;
    await device.discoverAllServicesAndCharacteristics();
    if (stopped) return;

    const services: any[] = await device.services();
    const has = (uuid: string) =>
      services.some((s) => String(s.uuid).toLowerCase() === uuid.toLowerCase());

    if (has(SM_HUB_SERVICE)) {
      // 자체 ESP32 허브 — JSON 전체 측정값
      subscription = device.monitorCharacteristicForService(
        SM_HUB_SERVICE, SM_HUB_CHAR,
        (error: any, ch: any) => {
          if (error || !ch?.value) return;
          try {
            const readings = JSON.parse(bytesToText(base64ToBytes(ch.value)));
            if (readings && typeof readings === 'object') post(readings);
          } catch { /* 조각난 패킷은 버림 */ }
        },
      );
    } else if (has(XIAOMI_TEMP_SERVICE) && target.catalogId === 'fridge_temp') {
      subscription = device.monitorCharacteristicForService(
        XIAOMI_TEMP_SERVICE, XIAOMI_TEMP_CHAR,
        (error: any, ch: any) => {
          if (error || !ch?.value) return;
          const parsed = parseXiaomiPacket(base64ToBytes(ch.value));
          if (parsed) post({ fridge_temp: { temp_c: parsed.temp_c, humidity: parsed.humidity } });
        },
      );
    }
  };

  run().catch(() => { });

  _active.set(target.catalogId, {
    stop: () => {
      stopped = true;
      try { subscription?.remove?.(); } catch { }
      try { manager.cancelDeviceConnection(target.bleId); } catch { }
    },
  });
}
