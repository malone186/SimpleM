/*
 * SimpleM 매장 센서 허브 — ESP32 펌웨어
 *
 * 하나의 ESP32가 매장 센서 전체를 묶어 두 경로로 내보낸다:
 *   1) BLE: "SM-HUB-xxxx"로 광고 → 앱 '기기 스캔'에 잡힘.
 *      연결하면 ffe1 캐릭터리스틱으로 측정값 JSON을 5초마다 notify
 *      (브라우저/앱의 BLE 라이브 리더가 이걸 받아 서버로 중계).
 *   2) WiFi: 서버 /api/v1/sensor/ingest 로 직접 HTTP POST (앱이 꺼져 있어도 업링크 유지).
 *      WiFi 설정이 없으면 BLE만으로도 동작한다.
 *
 * 센서 배선 (없는 센서는 아래 ENABLE_* 를 0으로):
 *   - 원두 호퍼 로드셀 ×2 : HX711 보드 2개 (DT/SCK)     → 카페인 GPIO 32/33, 디카페인 GPIO 25/26
 *   - 우유 로드셀        : HX711 보드 1개               → GPIO 27/14
 *   - 냉장고 온도        : DS18B20 방수 프로브 (1-Wire)  → GPIO 4 (4.7kΩ 풀업)
 *   - 정수 플로트 스위치  : 스위치 → GPIO 16 (내부 풀업, 물 부족 시 open)
 *   - 머신 전류          : SCT-013-030 클램프 + 부담 저항 → GPIO 34 (ADC)
 *   - 원두 RFID          : RC522 (SPI)                  → SS GPIO 5, RST GPIO 17
 *
 * 필요 라이브러리 (Arduino IDE 라이브러리 매니저):
 *   HX711 (bogde), OneWire, DallasTemperature, EmonLib, MFRC522, ArduinoJson
 *   보드: "ESP32 Dev Module" (esp32 by Espressif)
 */

#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <HTTPClient.h>
#include <WiFi.h>

// ─── 설정 ────────────────────────────────────────────────────────────────
#define ENABLE_BEAN_SCALE 1
#define ENABLE_MILK_SCALE 1
#define ENABLE_FRIDGE_TEMP 1
#define ENABLE_WATER_LEVEL 1
#define ENABLE_SMART_PLUG 1
#define ENABLE_RFID 1

const char* WIFI_SSID = "";                        // 비우면 WiFi 업링크 생략 (BLE만)
const char* WIFI_PASS = "";
const char* SERVER_URL = "http://192.168.0.10:8000/api/v1/sensor/ingest"; // 백엔드 PC 주소
const char* STORE_ID = "s@gmail.com";              // 앱 로그인 계정 이메일과 동일해야 함

const uint32_t REPORT_INTERVAL_MS = 5000;

// 앱과 약속된 GATT UUID (frontend/src/lib/ble/bleTypes.ts 와 동일해야 함)
#define SERVICE_UUID "0000ffe0-0000-1000-8000-00805f9b34fb"
#define CHAR_UUID    "0000ffe1-0000-1000-8000-00805f9b34fb"

// ─── 센서 드라이버 ────────────────────────────────────────────────────────
#if ENABLE_BEAN_SCALE || ENABLE_MILK_SCALE
#include "HX711.h"
#endif
#if ENABLE_BEAN_SCALE
HX711 scaleCaf, scaleDecaf;
const float SCALE_CAL_CAF = 420.0f;   // 캘리브레이션: 기지 무게로 보정 후 수정
const float SCALE_CAL_DECAF = 420.0f;
#endif
#if ENABLE_MILK_SCALE
HX711 scaleMilk;
const float SCALE_CAL_MILK = 420.0f;
const float MILK_DENSITY = 1.03f;     // g/mL
#endif
#if ENABLE_FRIDGE_TEMP
#include <DallasTemperature.h>
#include <OneWire.h>
OneWire oneWire(4);
DallasTemperature fridgeTemp(&oneWire);
#endif
#if ENABLE_WATER_LEVEL
const int WATER_PIN = 16; // 플로트 스위치 (풀업, 물 부족 시 HIGH)
#endif
#if ENABLE_SMART_PLUG
#include "EmonLib.h"
EnergyMonitor emon;
const float MAINS_VOLTAGE = 220.0f;
#endif
#if ENABLE_RFID
#include <MFRC522.h>
#include <SPI.h>
MFRC522 rfid(5, 17);
String lastCafTag = "";   // 실제 운영: 태그 UID → 원두명 매핑을 서버/앱에서 관리해도 됨
String lastDecafTag = "";
// 데모용 UID→원두명 매핑 (태그 스티커 UID를 여기 등록)
struct TagMap { const char* uid; const char* bean; bool decaf; };
const TagMap TAGS[] = {
    {"04A1B2C3", "브라질 산토스", false},
    {"04D4E5F6", "에티오피아 예가체프", false},
    {"04112233", "디카페인 콜롬비아", true},
};
#endif

// ─── BLE ─────────────────────────────────────────────────────────────────
BLECharacteristic* bleChar = nullptr;
bool bleConnected = false;

class HubServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected = true; }
  void onDisconnect(BLEServer* server) override {
    bleConnected = false;
    server->getAdvertising()->start(); // 끊기면 다시 스캔에 잡히도록 재광고
  }
};

void setupBle() {
  uint64_t mac = ESP.getEfuseMac();
  char name[20];
  snprintf(name, sizeof(name), "SM-HUB-%04X", (uint16_t)(mac >> 32));
  BLEDevice::init(name);
  BLEDevice::setMTU(517); // 측정값 JSON이 기본 MTU(23)에 잘리지 않도록
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new HubServerCallbacks());
  BLEService* service = server->createService(SERVICE_UUID);
  bleChar = service->createCharacteristic(
      CHAR_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  bleChar->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising* adv = server->getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->start();
  Serial.printf("[BLE] %s 광고 시작\n", name);
}

// ─── 측정 ────────────────────────────────────────────────────────────────
// 서버 ingest 포맷 그대로 JSON을 만든다 (backend/app/api/v1/sensor.py 참고)
String buildReadingsJson(bool wrapForHttp) {
  JsonDocument doc;
  JsonObject readings = wrapForHttp ? doc["readings"].to<JsonObject>() : doc.to<JsonObject>();
  if (wrapForHttp) doc["store"] = STORE_ID;

#if ENABLE_BEAN_SCALE
  {
    JsonObject o = readings["bean_scale"].to<JsonObject>();
    o["caffeine_g"] = scaleCaf.is_ready() ? scaleCaf.get_units(3) : 0.0f;
    o["decaf_g"] = scaleDecaf.is_ready() ? scaleDecaf.get_units(3) : 0.0f;
  }
#endif
#if ENABLE_MILK_SCALE
  if (scaleMilk.is_ready()) {
    readings["milk_scale"]["remaining_ml"] = scaleMilk.get_units(3) / MILK_DENSITY;
  }
#endif
#if ENABLE_FRIDGE_TEMP
  {
    fridgeTemp.requestTemperatures();
    float t = fridgeTemp.getTempCByIndex(0);
    if (t > -100) readings["fridge_temp"]["temp_c"] = t; // -127 = 프로브 미연결
  }
#endif
#if ENABLE_WATER_LEVEL
  readings["water_level"]["low"] = digitalRead(WATER_PIN) == HIGH;
#endif
#if ENABLE_SMART_PLUG
  {
    double irms = emon.calcIrms(1480); // 전류 실효값 샘플링
    readings["smart_plug"]["power_w"] = irms * MAINS_VOLTAGE;
  }
#endif
#if ENABLE_RFID
  if (lastCafTag.length()) readings["rfid_reader"]["caffeine_tag"] = lastCafTag;
  if (lastDecafTag.length()) readings["rfid_reader"]["decaf_tag"] = lastDecafTag;
#endif

  String out;
  serializeJson(doc, out);
  return out;
}

#if ENABLE_RFID
void pollRfid() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  char uid[21] = {0};
  for (byte i = 0; i < rfid.uid.size && i < 10; i++)
    snprintf(uid + i * 2, 3, "%02X", rfid.uid.uidByte[i]);
  for (const TagMap& t : TAGS) {
    if (strcasecmp(uid, t.uid) == 0) {
      if (t.decaf) lastDecafTag = t.bean;
      else lastCafTag = t.bean;
      Serial.printf("[RFID] %s → %s\n", uid, t.bean);
    }
  }
  rfid.PICC_HaltA();
}
#endif

// ─── 업링크 ──────────────────────────────────────────────────────────────
void postToServer(const String& json) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  if (code != 200) Serial.printf("[HTTP] 업링크 실패 %d\n", code);
  http.end();
}

// ─── 메인 ────────────────────────────────────────────────────────────────
uint32_t lastReport = 0;

void setup() {
  Serial.begin(115200);

#if ENABLE_BEAN_SCALE
  scaleCaf.begin(32, 33);  scaleCaf.set_scale(SCALE_CAL_CAF);   scaleCaf.tare();
  scaleDecaf.begin(25, 26); scaleDecaf.set_scale(SCALE_CAL_DECAF); scaleDecaf.tare();
#endif
#if ENABLE_MILK_SCALE
  scaleMilk.begin(27, 14); scaleMilk.set_scale(SCALE_CAL_MILK); scaleMilk.tare();
#endif
#if ENABLE_FRIDGE_TEMP
  fridgeTemp.begin();
#endif
#if ENABLE_WATER_LEVEL
  pinMode(WATER_PIN, INPUT_PULLUP);
#endif
#if ENABLE_SMART_PLUG
  emon.current(34, 30.0); // SCT-013-030: 30A/1V 캘리브레이션
#endif
#if ENABLE_RFID
  SPI.begin();
  rfid.PCD_Init();
#endif

  setupBle();

  if (strlen(WIFI_SSID)) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WiFi] 연결 중");
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) {
      delay(500);
      Serial.print(".");
    }
    Serial.println(WiFi.status() == WL_CONNECTED
                       ? "\n[WiFi] 연결됨 — 서버 직접 업링크 사용"
                       : "\n[WiFi] 실패 — BLE 중계만 사용");
  }
}

void loop() {
#if ENABLE_RFID
  pollRfid();
#endif

  if (millis() - lastReport < REPORT_INTERVAL_MS) return;
  lastReport = millis();

  // 1) BLE notify (연결된 앱/브라우저가 서버로 중계)
  if (bleConnected && bleChar) {
    String bleJson = buildReadingsJson(false);
    bleChar->setValue((uint8_t*)bleJson.c_str(), bleJson.length());
    bleChar->notify();
  }
  // 2) WiFi 직접 업링크 (설정 시)
  postToServer(buildReadingsJson(true));
}
