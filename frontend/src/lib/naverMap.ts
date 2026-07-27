// [네이버 지도 Client ID] NCP 콘솔 Maps > Web Dynamic Map의 Client ID.
//
// EXPO_PUBLIC_* 는 번들을 만드는 시점에 문자열로 치환된다. 즉 이 값은 APK에 박히는 게
// 아니라 "번들에" 박히므로, eas update로 새 번들을 올리면 OTA로도 교체된다.
// 반대로 기본값이 낡아 있으면 .env를 못 읽는 환경에서 조용히 폐기된 키가 나가므로
// (테스터 APK에서 Leaflet 폴백이 뜬 원인), 기본값도 항상 최신 키로 맞춰 둔다.
//
// 키 교체 시 세 곳을 함께 갱신할 것:
//   1) 이 파일의 기본값   2) frontend/.env · .env.production · .env.example
//   3) frontend/eas.json (preview·production) — 신규 빌드용
export const NAVER_CLIENT_ID = process.env.EXPO_PUBLIC_NAVER_CLIENT_ID || 'gdszkjaod1';
