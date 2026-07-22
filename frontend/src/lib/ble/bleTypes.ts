// 실제 블루투스(BLE) 스캔 공용 타입 — 플랫폼별 구현은 bleScanner.ts / bleScanner.web.ts
// (Metro가 웹에서는 .web.ts, 네이티브에서는 .ts를 자동 선택한다)

export interface FoundBleDevice {
  id: string;            // BLE MAC(안드로이드) 또는 브라우저 발급 기기 ID(웹)
  name: string;          // 광고 이름 (예: SM-TEMP-3F2A, LYWSD03MMC, ACAIA PEARL)
  rssi: number | null;   // 신호 세기 dBm (웹 Web Bluetooth는 제공 안 함 → null)
  hintMatch: boolean;    // 이 센서 슬롯의 권장 기기 이름 규칙과 일치하는지
}

export interface BleAvailability {
  available: boolean;
  reason: string | null; // 사용 불가 사유 (사용자 안내 문구)
}

export interface ScanOptions {
  hints: string[];                          // 권장 기기 광고 이름 접두어 (대소문자 무시)
  timeoutMs?: number;                       // 네이티브 스캔 시간 (기본 8초)
  onDevice?: (d: FoundBleDevice) => void;   // 발견 즉시 콜백 (목록 실시간 갱신용)
}

export const matchesHint = (name: string | null | undefined, hints: string[]): boolean => {
  if (!name) return false;
  const upper = name.toUpperCase();
  return hints.some((h) => upper.includes(h.toUpperCase()));
};

// ─── 실측 GATT 프로토콜 상수 ───────────────────────────────────────────────
// 자체 ESP32 허브(hardware/esp32_hub 펌웨어): HM-10 스타일 서비스로 JSON 측정값을 notify
export const SM_HUB_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const SM_HUB_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';
// 샤오미 온습도계 LYWSD03MMC: 표준 알려진 서비스 — 5바이트 notify (온도 int16LE×0.01℃, 습도 uint8)
export const XIAOMI_TEMP_SERVICE = 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6';
export const XIAOMI_TEMP_CHAR = 'ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6';

export interface XiaomiReading {
  temp_c: number;
  humidity: number;
}

export const parseXiaomiPacket = (bytes: Uint8Array): XiaomiReading | null => {
  if (bytes.length < 3) return null;
  const raw = bytes[0] | (bytes[1] << 8);
  const temp = ((raw << 16) >> 16) / 100; // int16 LE, 0.01℃ 단위
  return { temp_c: Math.round(temp * 10) / 10, humidity: bytes[2] };
};

// 네이티브(ble-plx)의 characteristic.value는 base64 — Hermes에 atob/Buffer가 없어 직접 디코드
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const base64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 63) << 6) |
      (B64.indexOf(clean[i + 3]) & 63);
    out.push((n >> 16) & 255);
    if (clean[i + 2] !== undefined) out.push((n >> 8) & 255);
    if (clean[i + 3] !== undefined) out.push(n & 255);
  }
  return Uint8Array.from(out);
};

export const bytesToText = (bytes: Uint8Array): string => {
  // UTF-8 디코드 (측정값 JSON은 ASCII 범위지만 태그명 한글 대비)
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  try { return decodeURIComponent(escape(s)); } catch { return s; }
};
