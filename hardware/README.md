# SimpleM 매장 센서 하드웨어

앱의 '센서 스테이션'과 실제로 연동되는 하드웨어 구성. 모두 시판 중인 실제 부품/기기다.

## 구성 개요

```
[로드셀×3, DS18B20, 플로트, SCT-013, RC522]
        │ (유선)
      ESP32 허브  ──(BLE "SM-HUB-xxxx" 광고·JSON notify)──▶ 앱/브라우저 → 서버
        └────────(WiFi HTTP POST /api/v1/sensor/ingest)──▶ 서버 (앱 없이도 업링크)
```

앱 '기기 스캔'은 진짜 BLE 스캔이며, `SM-HUB-*`(이 펌웨어) 또는 아래 시판 BLE 기기를
찾아 페어링한다. 페어링 후 GATT notify(자체 허브 JSON / 샤오미 온도 프로토콜)를 구독해
측정값을 서버로 올리고, 발주 화면 수치가 판매 환산 → **실측**으로 바뀐다.

## 부품 목록 (자작 허브 경로 — 전부 실재하는 부품, 국내 구매 가능)

| 부품 | 모델 | 용도 | 대략 가격 |
|---|---|---|---|
| MCU | ESP32-WROOM-32 DevKit | BLE+WiFi 허브 | ~8,000원 |
| 무게 | 로드셀 5kg + HX711 앰프 ×3 | 원두 호퍼×2, 우유 | 개당 ~4,000원 |
| 온도 | DS18B20 방수 프로브 | 냉장고 | ~3,000원 |
| 수위 | 플로트 스위치 | 정수 탱크 | ~2,000원 |
| 전류 | SCT-013-030 클램프 CT | 머신 추출 감지 | ~9,000원 |
| RFID | RC522 리더 + 13.56MHz NTAG 스티커 | 원두통 인식 | ~4,000원 |

## 시판 BLE 완제품 경로 (납땜 없이)

| 슬롯 | 실제 제품 | 비고 |
|---|---|---|
| 냉장고 온도 | **샤오미 미지아 LYWSD03MMC** (~5천원), SwitchBot 온도계, Govee H5075, Inkbird IBS-TH2 | BLE 표준 notify — 앱이 페어링 즉시 실측 수신 (구현 완료) |
| 원두/우유 무게 | **Acaia Pearl/Lunar/Pyxis**, 타임모어 Black Mirror, Bookoo Themis | BLE 저울 — 프로토콜 공개/역공학 문서 존재 (프로토콜 어댑터는 추후) |
| 머신 전원 | SwitchBot 플러그 미니, Shelly Plus Plug S | 전력측정 플러그는 대부분 WiFi 중심 — 확실한 건 SCT-013 자작 |

## 펌웨어 굽기

1. Arduino IDE → 보드 매니저에서 `esp32 by Espressif` 설치, 보드 "ESP32 Dev Module"
2. 라이브러리: `HX711`(bogde), `OneWire`, `DallasTemperature`, `EmonLib`, `MFRC522`, `ArduinoJson`
3. `esp32_hub.ino` 상단에서 없는 센서는 `ENABLE_* 0`, WiFi/서버 주소/`STORE_ID`(로그인 이메일) 설정
4. 업로드 → 시리얼 모니터(115200)에서 `[BLE] SM-HUB-xxxx 광고 시작` 확인
5. 앱 발주 화면 → 센서 연결 → 기기 스캔 → `SM-HUB-xxxx` 선택

## 캘리브레이션

- 로드셀: `set_scale()` 값은 기지 무게(예: 물 500g)를 올려 `get_units()`가 500이 되도록 조정
- SCT-013: 머신 대기/추출 전력을 시리얼로 확인해 서버 판정 임계(800W)와 맞는지 확인
- RFID: 태그 스티커의 UID를 시리얼 로그로 확인해 `TAGS[]` 매핑에 원두명 등록
