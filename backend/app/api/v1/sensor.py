"""매장 IoT 센서 라이브 API (백엔드 B)

발주 화면 '현재 사용 중인 원두' 카드의 실시간 연동 전용 엔드포인트.
- GET  /sensor/live             : 폴링용 전체 센서 스냅샷 (5초 주기 호출 가정)
- GET  /sensor/recommendations  : AI 발주 코치 추천 (규칙 기반, LLM 쿼터 소모 없음)
- POST /sensor/beans            : RFID 태그 원두명 재지정 (수정 모달 저장 시)
- GET  /sensor/devices          : 센서 스테이션 마법사 — 기기 카탈로그 + 페어링 상태
- POST /sensor/devices/{id}/pair   : 기기 페어링 (BLE 스캔 결과 실기기 등록 / 데모 등록)
- POST /sensor/devices/{id}/unpair : 기기 연결 해제
- POST /sensor/ingest           : ESP32 허브·브라우저 BLE 리더의 측정값 업링크 (JWT 없음)
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.models.user import User
from app.services.ai import sensor_service

router = APIRouter(prefix="/sensor", tags=["Sensor"])


class BeanTagUpdate(BaseModel):
    caffeine: Optional[str] = None   # 카페인 호퍼 RFID에 기록할 원두명
    decaf: Optional[str] = None      # 디카페인 호퍼 RFID에 기록할 원두명


class FeatureToggle(BaseModel):
    enabled: bool                    # 센서 기능 사용 여부 (센서 없는 매장은 False)


class PairRequest(BaseModel):
    """앱이 실제 BLE 스캔으로 찾은 기기 정보 — 비우면 데모 페어링"""
    ble_id: Optional[str] = None     # BLE MAC(안드로이드) 또는 브라우저 발급 기기 ID(웹)
    ble_name: Optional[str] = None   # BLE 광고 이름 (예: SM-TEMP-3F2A, LYWSD03MMC)
    rssi: Optional[int] = None       # 스캔 당시 신호 세기 (dBm)


@router.get("/live")
def get_live(current_user: User = Depends(get_current_user)):
    """[한글 주석] 실시간 센서 스냅샷 — store_id는 로그인 계정 이메일 기준"""
    return sensor_service.get_live_snapshot(current_user.email)


@router.get("/recommendations")
def get_recommendations(current_user: User = Depends(get_current_user)):
    """[한글 주석] 센서+판매 데이터 기반 AI 발주 코치 추천 목록"""
    return sensor_service.get_recommendations(current_user.email)


@router.post("/beans")
def set_beans(payload: BeanTagUpdate, current_user: User = Depends(get_current_user)):
    """[한글 주석] 수정 모달에서 저장한 원두명을 호퍼 RFID 태그에 반영"""
    tags = sensor_service.set_bean_tags(current_user.email, payload.caffeine, payload.decaf)
    return {"ok": True, "tags": tags}


@router.get("/devices")
def get_devices(current_user: User = Depends(get_current_user)):
    """[한글 주석] 센서 스테이션 마법사 — 기기 카탈로그·설치 가이드·페어링 상태"""
    return sensor_service.get_devices(current_user.email)


@router.post("/devices/{device_id}/pair")
def pair_device(
    device_id: str,
    payload: Optional[PairRequest] = None,
    current_user: User = Depends(get_current_user),
):
    """[한글 주석] 기기 페어링 — BLE 스캔 결과(payload)가 있으면 실기기, 없으면 데모 등록"""
    try:
        ble = payload.model_dump() if payload else None
        return sensor_service.pair_device(current_user.email, device_id, ble)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/devices/{device_id}/unpair")
def unpair_device(device_id: str, current_user: User = Depends(get_current_user)):
    """[한글 주석] 기기 연결 해제"""
    return sensor_service.unpair_device(current_user.email, device_id)


class IngestPayload(BaseModel):
    """센서 하드웨어 업링크 — 예:
    {"store": "s@gmail.com", "readings": {
        "bean_scale": {"caffeine_g": 923.4, "decaf_g": 1210.0},
        "fridge_temp": {"temp_c": 3.2},
        "water_level": {"low": false},
        "smart_plug": {"power_w": 1240.5},
        "milk_scale": {"remaining_ml": 2400},
        "rfid_reader": {"caffeine_tag": "브라질 산토스", "decaf_tag": "디카페인 콜롬비아"}}}"""
    store: str
    readings: Dict[str, Dict[str, Any]]


@router.post("/ingest")
def ingest(payload: IngestPayload):
    """[한글 주석] ESP32 허브/브라우저 BLE 리더 측정값 수신 — 페어링된 기기의 값만 반영.
    임베디드 기기가 JWT를 못 쓰므로 인증 대신 '해당 매장에 페어링 존재' 검증으로 제한한다."""
    try:
        return sensor_service.ingest_readings(payload.store, payload.readings)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/feature")
def get_feature(current_user: User = Depends(get_current_user)):
    """[한글 주석] 센서 기능 ON/OFF 현재 상태 — 설정 화면 스위치 초기값용 경량 조회"""
    return {"enabled": sensor_service.is_feature_enabled(current_user.email)}


@router.post("/feature")
def set_feature(payload: FeatureToggle, current_user: User = Depends(get_current_user)):
    """[한글 주석] 센서 기능 매장별 ON/OFF — 끄면 라이브·데모 배너·발주 코치 알림 전부 중단"""
    return sensor_service.set_feature_enabled(current_user.email, payload.enabled)
