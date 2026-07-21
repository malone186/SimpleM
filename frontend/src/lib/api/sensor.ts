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

export interface SensorLive {
  updated_at: string;
  store_id: string;
  simulated: boolean;   // true면 DB 폴백(시뮬레이션) 모드
  in_business: boolean;
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
