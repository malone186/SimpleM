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
  where: string;         // 설치 위치 한 줄
  benefit: string;       // 연결하면 좋아지는 점
  steps: string[];       // 설치 가이드 3단계
  paired: boolean;
  paired_at: string | null;
  serial: string | null; // 페어링 완료 시 발급된 기기 시리얼
}

export interface SensorDevicesResponse extends SensorPairing {
  devices: SensorDevice[];
}

export const getSensorDevices = (token: string) =>
  apiFetch<SensorDevicesResponse>('/api/v1/sensor/devices', { headers: auth(token) });

export const pairSensorDevice = (token: string, deviceId: string) =>
  apiFetch<{ ok: boolean; device_id: string; name: string; serial: string }>(
    `/api/v1/sensor/devices/${deviceId}/pair`,
    { method: 'POST', headers: auth(token) },
  );

export const unpairSensorDevice = (token: string, deviceId: string) =>
  apiFetch<{ ok: boolean; device_id: string }>(
    `/api/v1/sensor/devices/${deviceId}/unpair`,
    { method: 'POST', headers: auth(token) },
  );

// 센서 기능 매장별 ON/OFF — 센서 없는 카페는 끄면 라이브·배너·코치 알림 전부 사라짐
export const setSensorFeature = (token: string, enabled: boolean) =>
  apiFetch<{ ok: boolean; enabled: boolean }>('/api/v1/sensor/feature', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
    headers: auth(token),
  });
