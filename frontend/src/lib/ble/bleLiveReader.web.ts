// 웹용 BLE 라이브 리더 — 페어링한 실기기에 GATT로 붙어 측정값을 구독하고
// 서버 /sensor/ingest 로 올린다. 이 값이 라이브 스냅샷에서 실측으로 표시된다.
// 지원 프로토콜:
//   1) 자체 ESP32 허브(SM-HUB-*): ffe1 캐릭터리스틱이 JSON 측정값을 notify
//   2) 샤오미 온습도계 LYWSD03MMC: 표준 온습도 notify (냉장고 온도 슬롯 전용)
// 주의: 브라우저 탭이 살아있는 동안만 유지된다 (새로고침하면 재스캔 필요 — Web Bluetooth 제약).
import { postSensorReadings } from '../api/sensor';
import { getWebBleDevice } from './bleScanner.web';
import {
  SM_HUB_CHAR,
  SM_HUB_SERVICE,
  XIAOMI_TEMP_CHAR,
  XIAOMI_TEMP_SERVICE,
  parseXiaomiPacket,
} from './bleTypes';

export interface LiveReaderTarget {
  store: string;      // 업링크에 쓸 매장 식별자 (get_devices 응답의 store_id)
  catalogId: string;  // 센서 카탈로그 슬롯 (bean_scale, fridge_temp, …)
  bleId: string;      // 스캔 때 브라우저가 발급한 기기 ID
  bleName: string;
}

const MIN_POST_INTERVAL_MS = 5000; // 업링크 최소 간격 (notify가 더 잦아도 서버엔 5초에 한 번)
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECTS = 5;

interface ActiveReader {
  stop: () => void;
}

const _active = new Map<string, ActiveReader>(); // catalogId → reader

export function stopBleLiveReader(catalogId: string): void {
  _active.get(catalogId)?.stop();
  _active.delete(catalogId);
}

export function stopAllBleLiveReaders(): void {
  for (const id of [..._active.keys()]) stopBleLiveReader(id);
}

// 페어링 직후 호출 — 실패해도 조용히 끝난다 (업링크는 best-effort, 페어링 상태엔 영향 없음)
export function startBleLiveReader(target: LiveReaderTarget): void {
  stopBleLiveReader(target.catalogId);
  const device = getWebBleDevice(target.bleId);
  if (!device?.gatt) return; // 이 세션에서 스캔한 기기가 아니면 핸들이 없음

  let stopped = false;
  let reconnects = 0;
  let lastPostAt = 0;

  const post = (readings: Record<string, Record<string, unknown>>) => {
    const now = Date.now();
    if (now - lastPostAt < MIN_POST_INTERVAL_MS) return;
    lastPostAt = now;
    postSensorReadings(target.store, readings).catch(() => { });
  };

  const subscribe = async (): Promise<void> => {
    const server = await device.gatt.connect();

    // 1) 자체 ESP32 허브 — JSON 전체 측정값
    try {
      const svc = await server.getPrimaryService(SM_HUB_SERVICE);
      const ch = await svc.getCharacteristic(SM_HUB_CHAR);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (ev: any) => {
        const view: DataView = ev.target.value;
        try {
          const text = new TextDecoder().decode(view.buffer);
          const readings = JSON.parse(text);
          if (readings && typeof readings === 'object') post(readings);
        } catch { /* 조각난 패킷은 버림 */ }
      });
      return;
    } catch { /* SM 허브 서비스 없음 → 다음 프로토콜 시도 */ }

    // 2) 샤오미 LYWSD03MMC — 냉장고 온도 슬롯일 때만 의미가 있음
    if (target.catalogId === 'fridge_temp') {
      const svc = await server.getPrimaryService(XIAOMI_TEMP_SERVICE);
      const ch = await svc.getCharacteristic(XIAOMI_TEMP_CHAR);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (ev: any) => {
        const view: DataView = ev.target.value;
        const parsed = parseXiaomiPacket(new Uint8Array(view.buffer));
        if (parsed) post({ fridge_temp: { temp_c: parsed.temp_c, humidity: parsed.humidity } });
      });
      return;
    }

    throw new Error('지원하는 측정 서비스 없음');
  };

  const onDisconnected = () => {
    if (stopped || reconnects >= MAX_RECONNECTS) return;
    reconnects += 1;
    setTimeout(() => {
      if (!stopped) subscribe().catch(() => { });
    }, RECONNECT_DELAY_MS);
  };
  device.addEventListener('gattserverdisconnected', onDisconnected);

  subscribe().catch(() => { });

  _active.set(target.catalogId, {
    stop: () => {
      stopped = true;
      device.removeEventListener('gattserverdisconnected', onDisconnected);
      try { device.gatt.disconnect(); } catch { }
    },
  });
}
