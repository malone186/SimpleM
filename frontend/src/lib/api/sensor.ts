// 매장 IoT 센서 라이브 API (백엔드 B /sensor/*)
// 발주 화면 '현재 사용 중인 원두' 카드의 실시간 연동 전용 모듈입니다.
import { apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface HopperState {
  kind: 'caffeine' | 'decaf';
  remaining_g: number;
  capacity_g: number;
  percent: number;
  shots_today: number;
  grams_per_shot: number;
  refills_today: number;
  depletion_at: string | null; // 오늘 안에 소진 예상 시 "HH:MM"
}

// 센서 연동(페어링) 진행 상태
export interface SensorPairing {
  paired: Record<string, boolean>;   // device_id -> 페어링 여부
  paired_count: number;
  total: number;
  demo_mode: boolean;                // 하나도 연결 안 됨 = 전체 데모 모드
}

// 지표별 실측 여부 (해당 센서가 페어링됐는지)
export interface LiveMetrics {
  hoppers: boolean;
  rfid: boolean;
  milk: boolean;
  fridge: boolean;
  water: boolean;
  machine: boolean;
}

export interface SensorLive {
  updated_at: string;
  store_id: string;
  feature_enabled?: boolean; // false면 매장이 센서 기능을 껐음 (다른 필드 없음)
  simulated: boolean;   // true면 DB 폴백(시뮬레이션) 모드
  in_business: boolean;
  pairing: SensorPairing;
  live_metrics: LiveMetrics;
  measured_metrics?: LiveMetrics; // 지표별 진짜 하드웨어 값 수신 여부 (TTL 이내 업링크 기준)
  hoppers: { caffeine: HopperState; decaf: HopperState };
  machine: { status: 'extracting' | 'idle' | 'off'; current_menu: string | null; last_menu: string | null };
  milk: { remaining_ml: number; capacity_ml: number; percent: number; drinks_today: number };
  fridge: { temp_c: number; ok: boolean };
  water: { percent: number; ok: boolean };
  rfid: {
    caffeine_bean: string | null;
    decaf_bean: string | null;
    caffeine_tag: string;
    decaf_tag: string;
  };
  events: string[];     // 전광판 틱커 메시지
}

export interface SensorRecommendation {
  priority: 'urgent' | 'warn' | 'info';
  title: string;
  reason: string;   // 근거 수치
  action: string;   // 사장님이 바로 실행할 액션
  source: string;   // 근거 출처 (센서/판매 데이터)
}

export interface SensorRecommendations {
  generated_at: string;
  feature_enabled?: boolean; // false면 매장이 센서 기능을 꺼서 추천도 비어 있음
  simulated: boolean;
  items: SensorRecommendation[];
}

// 5초 주기 폴링용 실시간 스냅샷
export const getSensorLive = (token: string) =>
  apiFetch<SensorLive>('/api/v1/sensor/live', { headers: auth(token) });

// AI 발주 코치 추천 (규칙 기반 — 60초 주기면 충분)
export const getSensorRecommendations = (token: string) =>
  apiFetch<SensorRecommendations>('/api/v1/sensor/recommendations', { headers: auth(token) });

// 수정 모달 저장 시 호퍼 RFID 태그에 원두명 재기록
export const setSensorBeans = (token: string, payload: { caffeine?: string; decaf?: string }) =>
  apiFetch<{ ok: boolean }>('/api/v1/sensor/beans', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: auth(token),
  });

// ─── 센서 스테이션 (기기 페어링 마법사) ───────────────────────────────────

export interface SensorDevice {
  id: string;
  metric: keyof LiveMetrics;
  icon: string;          // Ionicons 이름
  name: string;
  model: string;
  ble_names: string[];   // 실제 BLE 스캔 시 이 기기로 인정할 광고 이름 접두어
  where: string;         // 설치 위치 한 줄
  benefit: string;       // 연결하면 좋아지는 점
  steps: string[];       // 설치 가이드 3단계
  paired: boolean;
  paired_at: string | null;
  serial: string | null;          // 페어링 완료 시 발급된 기기 시리얼
  source: 'ble' | 'demo' | null;  // 실기기(BLE) 페어링인지 데모 등록인지
  ble_name: string | null;        // 실기기 페어링 시 BLE 광고 이름
}

export interface SensorDevicesResponse extends SensorPairing {
  store_id: string;      // 브라우저 BLE 리더가 측정값 업링크에 쓰는 매장 식별자
  devices: SensorDevice[];
}

// 센서 측정값 업링크 (ESP32 허브와 같은 엔드포인트 — 브라우저 BLE 리더도 사용)
// readings 예: { fridge_temp: { temp_c: 3.2 }, bean_scale: { caffeine_g: 923 } }
export const postSensorReadings = (store: string, readings: Record<string, Record<string, unknown>>) =>
  apiFetch<{ ok: boolean; accepted: string[]; ignored: string[] }>('/api/v1/sensor/ingest', {
    method: 'POST',
    body: JSON.stringify({ store, readings }),
  });

export const getSensorDevices = (token: string) =>
  apiFetch<SensorDevicesResponse>('/api/v1/sensor/devices', { headers: auth(token) });

// BLE 스캔으로 찾은 실기기 정보 — 생략하면 데모 페어링(센서 미보유 매장용)
export interface PairBlePayload {
  ble_id: string;
  ble_name: string;
  rssi?: number;
}

export const pairSensorDevice = (token: string, deviceId: string, ble?: PairBlePayload) =>
  apiFetch<{ ok: boolean; device_id: string; name: string; serial: string; source: 'ble' | 'demo' }>(
    `/api/v1/sensor/devices/${deviceId}/pair`,
    {
      method: 'POST',
      headers: auth(token),
      ...(ble ? { body: JSON.stringify(ble) } : {}),
    },
  );

export const unpairSensorDevice = (token: string, deviceId: string) =>
  apiFetch<{ ok: boolean; device_id: string }>(
    `/api/v1/sensor/devices/${deviceId}/unpair`,
    { method: 'POST', headers: auth(token) },
  );

// 센서 기능 ON/OFF 현재 상태 조회 — 설정 화면 스위치 초기값용
export const getSensorFeature = (token: string) =>
  apiFetch<{ enabled: boolean }>('/api/v1/sensor/feature', { headers: auth(token) });

// 센서 기능 매장별 ON/OFF — 센서 없는 카페는 끄면 라이브·배너·코치 알림 전부 사라짐
export const setSensorFeature = (token: string, enabled: boolean) =>
  apiFetch<{ ok: boolean; enabled: boolean }>('/api/v1/sensor/feature', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
    headers: auth(token),
  });
