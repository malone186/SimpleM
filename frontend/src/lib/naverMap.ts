// [네이버 지도] Client ID + 웹용 SDK 로더.
//
// EXPO_PUBLIC_* 는 번들을 만드는 시점에 문자열로 치환된다. 즉 이 값은 APK에 박히는 게
// 아니라 "번들에" 박히므로, eas update로 새 번들을 올리면 OTA로도 교체된다.
// 반대로 기본값이 낡아 있으면 .env를 못 읽는 환경에서 조용히 폐기된 키가 나가므로
// (테스터 APK에서 폴백 지도가 뜬 원인), 기본값도 항상 최신 키로 맞춰 둔다.
//
// 키 교체 시 세 곳을 함께 갱신할 것:
//   1) 이 파일의 기본값   2) frontend/.env · .env.production · .env.example
//   3) frontend/eas.json (preview·production) — 신규 빌드용
export const NAVER_CLIENT_ID = process.env.EXPO_PUBLIC_NAVER_CLIENT_ID || 'gdszkjaod1';

// [지도 페이지 오리진] 네이티브(WebView)가 여는 지도 HTML(/map/, /map/picker.html)을
// 어느 서버에서 받아올지. **API 주소와 일부러 분리한다.**
//
// 네이버 지도는 페이지의 origin(Referer)으로 인증한다 — NCP 콘솔 Maps Application의
// 'Web 서비스 URL'에 등록된 도메인이 아니면 navermap_authFailure로 지도가 통째로 안 뜬다.
// 개발 중에는 .env의 EXPO_PUBLIC_API_BASE_URL이 http://<사내 IP>:8000 같은 LAN 주소라,
// 지도 페이지도 그 주소에서 열려 매번 인증 실패였다 (등록된 건 배포 도메인과 localhost뿐).
// iOS는 여기에 ATS까지 겹쳐 http 페이지 로드 자체가 막혀 빈 화면이 된다.
//
// 지도 HTML은 정적 파일이라 어느 서버에서 받아도 내용이 같다. 그래서 API 주소가
// https가 아니면(= 로컬 개발) 등록된 공개 도메인에서 지도만 따로 받아온다.
// 개발용으로 다른 배포본을 쓰고 싶으면 EXPO_PUBLIC_MAP_ORIGIN으로 덮어쓸 수 있다.
const PUBLIC_MAP_ORIGIN =
  process.env.EXPO_PUBLIC_MAP_ORIGIN ||
  'https://brewnote-api-915817944047.asia-northeast3.run.app';

export function mapPageOrigin(apiBaseUrl: string): string {
  return /^https:\/\//i.test(apiBaseUrl) ? apiBaseUrl : PUBLIC_MAP_ORIGIN;
}

// 문서당 하나만 쓰는 스크립트 태그 id.
// [중요] 예전에는 화면마다 다른 id로 각자 스크립트를 넣었다(-direct / -geocoder).
// 그러면 회원가입에서 한 번, 대시보드 매장 지도에서 또 한 번 — v3 SDK가 두 번 로드돼
// 지도가 아예 안 그려졌다. 이제 모든 화면이 이 로더 하나만 쓴다.
const SCRIPT_ID = 'naver-maps-sdk';

// geocoder 서브모듈까지 항상 붙여 로드한다. 주소 검색이 필요 없는 화면에서도
// 로드 URL이 같아야 캐시가 재사용되고, 두 번 로드되는 일이 없다.
const SDK_SRC =
  `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(NAVER_CLIENT_ID)}` +
  '&submodules=geocoder';

export const NAVER_MAP_ERROR =
  '네이버 지도를 불러오지 못했습니다.\n네트워크 상태를 확인한 뒤 다시 시도해 주세요.';

let sdkPromise: Promise<any> | null = null;

/** 네이버 지도 SDK를 문서당 딱 한 번만 로드한다 (웹 전용).
 *
 *  폴백 지도(Leaflet 등)는 쓰지 않는다 — 실패하면 reject 되고, 호출한 화면이
 *  사용자에게 실패를 그대로 알린다. 조용히 다른 지도로 바꿔치기하지 않는다.
 *  실패 시 캐시를 비워 다음 호출에서 다시 시도할 수 있게 한다. */
export function loadNaverMaps(): Promise<any> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('브라우저 환경이 아닙니다.'));
  }
  const w = window as any;
  if (w.naver?.maps) return Promise.resolve(w.naver);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const fail = (msg: string) => {
      sdkPromise = null; // 다음 진입에서 재시도 가능하게
      reject(new Error(msg));
    };

    // 키·도메인 문제로 인증이 거부되면 SDK가 이 전역 콜백을 부른다.
    w.navermap_authFailure = () =>
      fail('네이버 지도 인증에 실패했습니다. 지도 API 키와 등록된 도메인을 확인해 주세요.');

    const done = () => (w.naver?.maps ? resolve(w.naver) : fail(NAVER_MAP_ERROR));

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      // 다른 화면이 이미 넣어 뒀지만 아직 로딩 중일 수 있다
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', () => fail(NAVER_MAP_ERROR), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.type = 'text/javascript';
    script.src = SDK_SRC;
    script.onload = done;
    script.onerror = () => fail(NAVER_MAP_ERROR);
    document.head.appendChild(script);
  });

  return sdkPromise;
}
