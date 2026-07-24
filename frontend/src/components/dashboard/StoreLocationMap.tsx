// [매장 위치 네이버 지도 공용 컴포넌트]
// SalesCard의 지도 모달에 있던 다이렉트 DOM 렌더링 로직을 추출 — 프로필 화면 등 어디서든 재사용.
// 네이버 지도 인증 실패/로딩 실패 시 Leaflet.js 오픈맵으로 자동 폴백된다.
// 웹은 브라우저 DOM에 직접 렌더, 네이티브(Expo Go)는 동일 로직을 WebView HTML로 렌더.
import { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { API_BASE_URL } from '../../lib/api/client';
import type { NearbyEvent } from '../../lib/api/forecast';

// [한글 주석] 네이티브 WebView용 자립형 HTML — 웹 버전과 동일한 네이버 지도 + Leaflet 폴백 로직
function buildMobileMapHtml(
  lat: number,
  lon: number,
  regionName: string,
  shopLabel: string,
  nearbyEvents: NearbyEvent[],
  clientId: string,
) {
  // XSS/문법 깨짐 방지: 모든 동적 값은 JSON 직렬화로 주입
  const DATA = JSON.stringify({ lat, lon, regionName, shopLabel, events: nearbyEvents });
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%;background:#F8F6F2;}</style>
</head>
<body>
<div id="map"></div>
<script>
var D = ${DATA};

// [한글 주석] RN 쪽 Metro 콘솔에서 실제 사용 중인 지도 엔진을 확인할 수 있게 알린다
function reportEngine(name) {
  if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(name); }
}

function initNaver() {
  try {
    if (!window.naver || !window.naver.maps) { initLeaflet(); return; }
    var container = document.getElementById('map');
    container.innerHTML = '';
    reportEngine('naver');
    var map = new naver.maps.Map(container, {
      center: new naver.maps.LatLng(D.lat, D.lon),
      zoom: 14,
      zoomControl: false,
    });
    var shopMarker = new naver.maps.Marker({
      position: new naver.maps.LatLng(D.lat, D.lon),
      map: map,
      icon: {
        content: '<div style="width:16px;height:16px;background:#4E3629;border:3px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.3)"></div>',
        anchor: new naver.maps.Point(8, 8),
      },
    });
    var infoWindow = new naver.maps.InfoWindow({
      content: '<div style="padding:10px;min-width:140px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>\\uD83D\\uDCCD ' + D.shopLabel + '</b><br/>' + D.regionName + '</div>',
      borderWidth: 1,
      borderColor: '#8C6F56',
      borderRadius: 8,
      backgroundColor: '#FFFFFF',
      anchorSize: new naver.maps.Size(10, 10),
    });
    naver.maps.Event.addListener(shopMarker, 'click', function () {
      if (infoWindow.getMap()) { infoWindow.close(); } else { infoWindow.open(map, shopMarker); }
    });
    var eventWindows = [];
    D.events.forEach(function (e) {
      if (e.lat && e.lon) {
        var eventMarker = new naver.maps.Marker({
          position: new naver.maps.LatLng(e.lat, e.lon),
          map: map,
          icon: {
            content: '<div style="width:12px;height:12px;background:#E28257;border:2.5px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3)"></div>',
            anchor: new naver.maps.Point(6, 6),
          },
        });
        var eWindow = new naver.maps.InfoWindow({
          content: '<div style="padding:10px;min-width:160px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>\\uD83C\\uDF89 ' + e.name + '</b><br/>\\uC7A5\\uC18C: ' + e.place + '<br/>\\uAC70\\uB9AC: ' + e.distance_km + 'km<br/>\\uB0A0\\uC9DC: ' + e.date + '</div>',
          borderWidth: 1,
          borderColor: '#E28257',
          borderRadius: 8,
          backgroundColor: '#FFFFFF',
        });
        eventWindows.push(eWindow);
        naver.maps.Event.addListener(eventMarker, 'click', function () {
          if (eWindow.getMap()) { eWindow.close(); } else { eWindow.open(map, eventMarker); }
        });
      }
    });
    naver.maps.Event.addListener(map, 'click', function () {
      eventWindows.forEach(function (w) { if (w.getMap()) w.close(); });
    });
  } catch (err) { initLeaflet(); }
}

function initLeaflet() {
  reportEngine('leaflet');
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(link);
  var start = function () {
    if (!window.L) return;
    var container = document.getElementById('map');
    container.innerHTML = '';
    var map = L.map(container, { zoomControl: false }).setView([D.lat, D.lon], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    L.circleMarker([D.lat, D.lon], { color: '#4E3629', fillColor: '#8C6F56', fillOpacity: 1, radius: 8, weight: 3 })
      .addTo(map)
      .bindPopup("<div style='font-size:11px'><b>\\uD83D\\uDCCD " + D.shopLabel + '</b><br/>' + D.regionName + '</div>');
    D.events.forEach(function (e) {
      if (e.lat && e.lon) {
        L.circleMarker([e.lat, e.lon], { color: '#E28257', fillColor: '#FFFFFF', fillOpacity: 0.9, radius: 6, weight: 3.5 })
          .addTo(map)
          .bindPopup("<div style='font-size:11px'><b>\\uD83C\\uDF89 " + e.name + '</b><br/>\\uC7A5\\uC18C: ' + e.place + '<br/>\\uAC70\\uB9AC: ' + e.distance_km + 'km<br/>\\uB0A0\\uC9DC: ' + e.date + '</div>');
      }
    });
  };
  if (window.L) { start(); return; }
  var script = document.createElement('script');
  script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  script.onload = start;
  document.head.appendChild(script);
}

// 폴백 원인을 구분해 로그로 알린다 (인증 거부 vs 스크립트 로드 실패)
window.navermap_authFailure = function () {
  reportEngine('naver-AUTH-FAILED(키/도메인 미등록) referer=' + document.referrer + ' origin=' + location.origin);
  initLeaflet();
};
var s = document.createElement('script');
s.src = 'https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}';
s.onload = initNaver;
s.onerror = function () {
  reportEngine('naver-SCRIPT-ERROR(네트워크/차단) origin=' + location.origin);
  initLeaflet();
};
document.head.appendChild(s);
</script>
</body>
</html>`;
}

export default function StoreLocationMap({
  lat,
  lon,
  regionName,
  shopLabel,
  nearbyEvents = [],
  containerId = 'naver-map-container',
}: {
  lat: number;
  lon: number;
  regionName: string;
  shopLabel: string;
  nearbyEvents?: NearbyEvent[];
  // 같은 페이지에 지도가 2개 이상 뜰 수 있으므로 DOM id를 호출부마다 다르게 지정
  containerId?: string;
}) {
  const serializedEvents = JSON.stringify(nearbyEvents);

  // [네이버 지도 연동 설정 가이드]
  // NCP 콘솔 Maps > Web Dynamic Map의 Client ID. 비어있거나 인증 실패 시 Leaflet 폴백 가동.
  const NAVER_CLIENT_ID = process.env.EXPO_PUBLIC_NAVER_CLIENT_ID || '6amak4awt7';

  // 네이티브 WebView용 HTML (props가 바뀔 때만 재생성)
  const mobileHtml = useMemo(
    () => buildMobileMapHtml(lat, lon, regionName, shopLabel, nearbyEvents, NAVER_CLIENT_ID),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lat, lon, regionName, shopLabel, serializedEvents, NAVER_CLIENT_ID],
  );

  // 네이티브 WebView가 로드할 백엔드 지도 URL.
  // HTML 문자열을 직접 넣으면 iOS가 Referer를 안 보내 네이버 인증이 실패하므로,
  // 백엔드(/map/)가 서빙하는 실제 URL을 로드해 Referer가 전송되게 한다.
  const mapUri = useMemo(() => {
    const payload = encodeURIComponent(
      JSON.stringify({ lat, lon, regionName, shopLabel, events: nearbyEvents }),
    );
    return `${API_BASE_URL}/map/?key=${encodeURIComponent(NAVER_CLIENT_ID)}&d=${payload}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, regionName, shopLabel, serializedEvents, NAVER_CLIENT_ID]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    // 1. 네이버 지도 API 스크립트 로드
    const loadNaverScript = () => {
      const existing = document.getElementById('naver-map-script-direct');
      if (existing) {
        // 스크립트 태그는 있지만 아직 로딩 중일 수 있음 — 로드 완료를 기다린 뒤 초기화
        if ((window as any).naver?.maps) {
          initNaverMapDirectly();
        } else {
          existing.addEventListener('load', initNaverMapDirectly, { once: true });
        }
        return;
      }

      const script = document.createElement('script');
      script.id = 'naver-map-script-direct';
      script.type = 'text/javascript';
      // 신규 NCP Maps API는 oapi 도메인 + ncpKeyId 파라미터로만 인증됨
      script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NAVER_CLIENT_ID}`;
      script.onload = initNaverMapDirectly;
      script.onerror = () => {
        console.error('네이버 지도 로딩 실패: Leaflet으로 전환');
        initLeafletFallback();
      };
      document.head.appendChild(script);
    };

    // 2. 실제 DOM에 네이버 지도 생성 및 마킹
    const initNaverMapDirectly = () => {
      try {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        const naverObj = (window as any).naver;
        if (!naverObj || !naverObj.maps) {
          initLeafletFallback();
          return;
        }

        const map = new naverObj.maps.Map(container, {
          center: new naverObj.maps.LatLng(lat, lon),
          zoom: 14,
          zoomControl: false,
        });

        // 내 매장 마커 마킹
        const shopMarker = new naverObj.maps.Marker({
          position: new naverObj.maps.LatLng(lat, lon),
          map: map,
          icon: {
            content: '<div style="width:16px;height:16px;background:#4E3629;border:3px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.3)"></div>',
            anchor: new naverObj.maps.Point(8, 8),
          },
        });

        const infoWindow = new naverObj.maps.InfoWindow({
          content: '<div style="padding:10px;min-width:140px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>📍 ' + shopLabel + '</b><br/>' + regionName + '</div>',
          borderWidth: 1,
          borderColor: '#8C6F56',
          borderRadius: 8,
          backgroundColor: '#FFFFFF',
          anchorSize: new naverObj.maps.Size(10, 10),
        });

        // [한글 주석] 축소된 지도를 말풍선이 가리지 않게 자동 오픈 대신 마커 클릭 시 토글
        naverObj.maps.Event.addListener(shopMarker, 'click', () => {
          if (infoWindow.getMap()) {
            infoWindow.close();
          } else {
            infoWindow.open(map, shopMarker);
          }
        });

        // 인근 축제 마커들 생성 (열린 정보창을 모아두었다가 지도 빈 곳 클릭 시 일괄 닫기)
        const eventWindows: any[] = [];
        nearbyEvents.forEach((e: any) => {
          if (e.lat && e.lon) {
            const eventMarker = new naverObj.maps.Marker({
              position: new naverObj.maps.LatLng(e.lat, e.lon),
              map: map,
              icon: {
                content: '<div style="width:12px;height:12px;background:#E28257;border:2.5px solid #FFFFFF;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3)"></div>',
                anchor: new naverObj.maps.Point(6, 6),
              },
            });

            const eWindow = new naverObj.maps.InfoWindow({
              content: '<div style="padding:10px;min-width:160px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>🎉 ' + e.name + '</b><br/>장소: ' + e.place + '<br/>거리: ' + e.distance_km + 'km<br/>날짜: ' + e.date + '</div>',
              borderWidth: 1,
              borderColor: '#E28257',
              borderRadius: 8,
              backgroundColor: '#FFFFFF',
            });
            eventWindows.push(eWindow);

            naverObj.maps.Event.addListener(eventMarker, 'click', () => {
              if (eWindow.getMap()) {
                eWindow.close();
              } else {
                eWindow.open(map, eventMarker);
              }
            });
          }
        });

        // 지도 빈 곳을 클릭하면 열려 있는 행사 정보창을 모두 닫는다
        naverObj.maps.Event.addListener(map, 'click', () => {
          eventWindows.forEach((w) => {
            if (w.getMap()) w.close();
          });
        });
      } catch (err) {
        console.error('네이버 지도 직접 초기화 중 에러, 폴백 가동:', err);
        initLeafletFallback();
      }
    };

    // 3. Leaflet.js 폴백 복원 함수
    const initLeafletFallback = () => {
      try {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        let existingCss = document.getElementById('leaflet-css-direct');
        if (!existingCss) {
          const link = document.createElement('link');
          link.id = 'leaflet-css-direct';
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }

        const startLeaflet = () => {
          const L = (window as any).L;
          if (!L) return;
          const map = L.map(container, { zoomControl: false }).setView([lat, lon], 14);

          L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
          }).addTo(map);

          const shopMarker = L.circleMarker([lat, lon], {
            color: '#4E3629',
            fillColor: '#8C6F56',
            fillOpacity: 1,
            radius: 8,
            weight: 3,
          }).addTo(map);

          shopMarker.bindPopup("<div style='font-size:11px'><b>📍 " + shopLabel + '</b><br/>' + regionName + '</div>');

          nearbyEvents.forEach((e: any) => {
            if (e.lat && e.lon) {
              L.circleMarker([e.lat, e.lon], {
                color: '#E28257',
                fillColor: '#FFFFFF',
                fillOpacity: 0.9,
                radius: 6,
                weight: 3.5,
              }).addTo(map)
                .bindPopup("<div style='font-size:11px'><b>🎉 " + e.name + '</b><br/>장소: ' + e.place + '<br/>거리: ' + e.distance_km + 'km<br/>날짜: ' + e.date + '</div>');
            }
          });
        };

        const existingScript = document.getElementById('leaflet-js-direct');
        if (existingScript) {
          startLeaflet();
        } else {
          const script = document.createElement('script');
          script.id = 'leaflet-js-direct';
          script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
          script.onload = startLeaflet;
          document.head.appendChild(script);
        }
      } catch (err) {
        console.error('Leaflet 로딩 실패:', err);
      }
    };

    // 네이버 지도 인증 실패 전역 콜백 연결
    (window as any).navermap_authFailure = () => {
      console.warn('네이버 지도 인증 실패: 즉시 Leaflet 오픈 지도로 안전 전환합니다.');
      initLeafletFallback();
    };

    const timer = setTimeout(loadNaverScript, 50);
    return () => clearTimeout(timer);
  }, [lat, lon, regionName, shopLabel, serializedEvents, containerId, NAVER_CLIENT_ID]);

  if (Platform.OS !== 'web') {
    return (
      <View style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <WebView
          originWhitelist={['*']}
          // [중요] HTML 문자열 + baseUrl 방식(loadHTMLString)은 iOS가 하위 리소스에 Referer를
          // 붙이지 않아, Referer로 도메인을 검증하는 네이버 지도가 인증을 거부한다(Leaflet 폴백).
          // 그래서 지도 HTML을 백엔드가 실제 URL로 서빙하고 여기서는 그 URL을 로드한다.
          // NCP 콘솔 Maps Application의 "Web 서비스 URL"에 이 API 도메인을 등록해야 한다.
          source={{ uri: mapUri }}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          onMessage={(e) => console.log(`[StoreLocationMap] 모바일 지도 엔진: ${e.nativeEvent.data}`)}
          style={{ flex: 1, backgroundColor: '#F8F6F2' }}
        />
      </View>
    );
  }

  return <View id={containerId} style={{ width: '100%', height: '100%' }} />;
}
