// [매장 위치 네이버 지도 공용 컴포넌트]
// 프로필 화면·매장 지도 화면 등 어디서든 재사용한다.
// 네이버 지도 전용 — 인증/로딩이 실패하면 다른 지도로 바꿔치기하지 않고 실패를 그대로 알린다.
// 웹은 브라우저 DOM에 직접 렌더, 네이티브는 백엔드가 서빙하는 지도 페이지를 WebView로 띄운다.
//
// [중요] 이 지도는 '기기 현위치'를 그리지 않는다. 중심은 계정에 등록된 매장 고정 좌표다.
// 예전엔 GPS 파란 점을 함께 찍었는데, 사장님이 집에서 앱을 켜면 매장이 아닌 곳이 강조돼
// 매장 위치가 흔들리는 것처럼 보였다. 매장은 등록된 그 자리에 고정된다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';

import { API_BASE_URL } from '../../lib/api/client';
import type { NearbyEvent } from '../../lib/api/forecast';
import type { NearbyCafe } from '../../lib/api/nearbyCafes';
import { NAVER_CLIENT_ID, NAVER_MAP_ERROR, loadNaverMaps } from '../../lib/naverMap';
import { colors } from '../../theme';

export default function StoreLocationMap({
  lat,
  lon,
  regionName,
  shopLabel,
  nearbyEvents = [],
  nearbyCafes = [],
  onCafePress,
  containerId = 'naver-map-container',
  radius = 1000,
}: {
  lat: number;
  lon: number;
  regionName: string;
  shopLabel: string;
  nearbyEvents?: NearbyEvent[];
  // 주변 경쟁 카페 (네이버 지역정보 수집분) — 초록 마커로 표시하고 탭하면 상세 분석으로 연결
  nearbyCafes?: NearbyCafe[];
  onCafePress?: (cafe: NearbyCafe) => void;
  // 같은 페이지에 지도가 2개 이상 뜰 수 있으므로 DOM id를 호출부마다 다르게 지정
  containerId?: string;
  radius?: number;
}) {
  const serializedEvents = JSON.stringify(nearbyEvents);
  const serializedCafes = JSON.stringify(nearbyCafes);
  const [mapError, setMapError] = useState<string | null>(null);

  const mapRef = useRef<any>(null);
  const naverRef = useRef<any>(null);
  const webviewRef = useRef<WebView>(null);
  const circlesRef = useRef<any[]>([]);
  const shopMarkerRef = useRef<any>(null);
  const eventMarkersRef = useRef<any[]>([]);
  const cafeMarkersRef = useRef<any[]>([]);
  const openWindowsRef = useRef<any[]>([]);

  const recenterToStore = () => {
    if (Platform.OS === 'web') {
      const n = naverRef.current;
      const m = mapRef.current;
      if (n && m) {
        m.setCenter(new n.maps.LatLng(lat, lon));
        m.setZoom(15);
      }
    } else {
      webviewRef.current?.reload();
    }
  };

  const RecenterButton = () => (
    <TouchableOpacity
      onPress={recenterToStore}
      accessibilityLabel="내 매장 위치로 돌아가기"
      activeOpacity={0.85}
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        width: 42,
        height: 42,
        borderRadius: 21,
        backgroundColor: '#FFFFFF',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(78,54,41,0.12)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 4,
      }}
    >
      <Ionicons name="locate" size={20} color={colors.espressoBrown} />
    </TouchableOpacity>
  );
  const mapUri = useMemo(() => {
    const payload = encodeURIComponent(
      JSON.stringify({
        lat,
        lon,
        regionName,
        shopLabel,
        radius,
        events: nearbyEvents,
        cafes: nearbyCafes.slice(0, 25).map((c) => ({
          name: c.name,
          lat: c.lat,
          lon: c.lon,
          category: c.category,
          distance_m: c.distance_m,
        })),
      }),
    );
    return `${API_BASE_URL}/map/?key=${encodeURIComponent(NAVER_CLIENT_ID)}&d=${payload}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, regionName, shopLabel, NAVER_CLIENT_ID]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let disposed = false;

    setMapError(null);
    loadNaverMaps()
      .then((naverObj) => {
        if (disposed) return;
        naverRef.current = naverObj;
        const container = document.getElementById(containerId);
        if (!container) return;

        const targetZoom = radius <= 500 ? 16 : radius <= 1000 ? 15 : 14;
        const centerLatLng = new naverObj.maps.LatLng(lat, lon);

        // 1) 지도 객체가 없으면 최초 1회 생성
        if (!mapRef.current) {
          container.innerHTML = '';
          const map = new naverObj.maps.Map(container, {
            center: centerLatLng,
            zoom: targetZoom,
            zoomControl: false,
          });
          mapRef.current = map;

          // 동심원 최초 생성 (2000m, 1000m, 500m)
          const circleConfigs = [
            { r: 2000, color: '#8C7968', fill: '#D8CFC4' },
            { r: 1000, color: '#A38F7B', fill: '#B5A493' },
            { r: 500, color: '#E28257', fill: '#E28257' },
          ];

          circlesRef.current = circleConfigs.map((cfg) => {
            const isSelected = radius === cfg.r;
            return new naverObj.maps.Circle({
              map,
              center: centerLatLng,
              radius: cfg.r,
              fillColor: cfg.fill,
              fillOpacity: isSelected ? 0.20 : 0.05,
              strokeColor: cfg.color,
              strokeOpacity: isSelected ? 0.85 : 0.25,
              strokeWeight: isSelected ? 2.5 : 1,
              strokeStyle: isSelected ? 'solid' : 'shortdash',
            });
          });

          // 내 매장 마커 최초 생성
          const shopMarkerContent = `
            <div style="position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;">
              <style>
                @keyframes shopRippleAura {
                  0% { transform: scale(0.6); opacity: 0.85; }
                  100% { transform: scale(2.2); opacity: 0; }
                }
              </style>
              <div style="position:absolute;width:24px;height:24px;border-radius:50%;background:rgba(226,130,87,0.45);animation:shopRippleAura 1.8s infinite ease-out;border:none;"></div>
              <div style="position:relative;z-index:2;width:12px;height:12px;border-radius:50%;background:#3B2314;box-shadow:0 2px 6px rgba(0,0,0,0.35);border:2px solid #FFFFFF;"></div>
            </div>
          `;

          const shopMarker = new naverObj.maps.Marker({
            position: centerLatLng,
            map,
            zIndex: 500,
            icon: {
              content: shopMarkerContent,
              anchor: new naverObj.maps.Point(14, 14),
            },
          });
          shopMarkerRef.current = shopMarker;

          const infoWindow = new naverObj.maps.InfoWindow({
            content: '<div style="padding:10px;min-width:140px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>📍 ' + shopLabel + '</b><br/>' + regionName + '</div>',
            borderWidth: 1,
            borderColor: '#8C6F56',
            borderRadius: 8,
            backgroundColor: '#FFFFFF',
            anchorSize: new naverObj.maps.Size(10, 10),
          });

          naverObj.maps.Event.addListener(shopMarker, 'click', () => {
            if (infoWindow.getMap()) {
              infoWindow.close();
            } else {
              infoWindow.open(map, shopMarker);
            }
          });

          naverObj.maps.Event.addListener(map, 'click', () => {
            openWindowsRef.current.forEach((w) => {
              if (w.getMap()) w.close();
            });
          });
        } else {
          // 2) 지도가 이미 존재할 때: 부드러운 Zoom 모핑(morph) 적용!
          const map = mapRef.current;
          if (map.getZoom() !== targetZoom) {
            map.morph(centerLatLng, targetZoom, { duration: 400 });
          }

          // 동심원 옵션만 부드럽게 업데이트
          const radii = [2000, 1000, 500];
          circlesRef.current.forEach((circle, idx) => {
            const rVal = radii[idx];
            const isSelected = radius === rVal;
            circle.setOptions({
              fillOpacity: isSelected ? (rVal === 500 ? 0.22 : rVal === 1000 ? 0.20 : 0.18) : 0.05,
              strokeOpacity: isSelected ? 0.85 : 0.25,
              strokeWeight: isSelected ? (rVal === 500 ? 2.5 : 2) : 1,
              strokeStyle: isSelected ? 'solid' : 'shortdash',
            });
          });
        }

        const map = mapRef.current;

        // 3) 카페 마커 갱신
        cafeMarkersRef.current.forEach((m) => m.setMap(null));
        cafeMarkersRef.current = [];
        openWindowsRef.current = [];

        // [한글 주석: 주변 카페 마커 — 점 크기 9px + 명확한 시인성의 선명한 웜 브라운 #7A6250]
        nearbyCafes.forEach((cafe) => {
          if (!cafe.lat || !cafe.lon) return;
          const cafeMarkerContent = `
            <div title="${cafe.name}" style="width:9px;height:9px;background:#7A6250;border-radius:50%;border:1.5px solid #FFFFFF;cursor:pointer;box-shadow:0 1.5px 3.5px rgba(0,0,0,0.3);transition:transform 0.15s ease;"></div>
          `;
          const cafeMarker = new naverObj.maps.Marker({
            position: new naverObj.maps.LatLng(cafe.lat, cafe.lon),
            map,
            zIndex: 400,
            icon: {
              content: cafeMarkerContent,
              anchor: new naverObj.maps.Point(4.5, 4.5),
            },
          });
          cafeMarkersRef.current.push(cafeMarker);

          const cWindow = new naverObj.maps.InfoWindow({
            content:
              '<div style="padding:9px 11px;min-width:150px;line-height:150%;font-size:11px;font-family:-apple-system,sans-serif">' +
              '<b>☕ ' + cafe.name + '</b><br/>' + cafe.category + '<br/>내 매장에서 ' + cafe.distance_m + 'm' +
              (onCafePress ? '<br/><span style="color:#10B981;font-weight:700">눌러서 리뷰 분석 보기</span>' : '') +
              '</div>',
            borderWidth: 1,
            borderColor: '#10B981',
            borderRadius: 8,
            backgroundColor: '#FFFFFF',
          });
          openWindowsRef.current.push(cWindow);

          naverObj.maps.Event.addListener(cafeMarker, 'click', () => {
            if (cWindow.getMap()) {
              cWindow.close();
            } else {
              cWindow.open(map, cafeMarker);
            }
            onCafePress?.(cafe);
          });
        });

        // 4) 행사 마커 갱신
        eventMarkersRef.current.forEach((m) => m.setMap(null));
        eventMarkersRef.current = [];
        nearbyEvents.forEach((e: any) => {
          if (!e.lat || !e.lon) return;
          const eventMarker = new naverObj.maps.Marker({
            position: new naverObj.maps.LatLng(e.lat, e.lon),
            map,
            zIndex: 300,
            icon: {
              content: '<div style="width:10px;height:10px;background:#E28257;border-radius:50%;border:1.5px solid #FFFFFF;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>',
              anchor: new naverObj.maps.Point(5, 5),
            },
          });
          eventMarkersRef.current.push(eventMarker);

          const eWindow = new naverObj.maps.InfoWindow({
            content: '<div style="padding:10px;min-width:160px;line-height:140%;font-size:11px;font-family:-apple-system,sans-serif"><b>🎉 ' + e.name + '</b><br/>장소: ' + e.place + '<br/>거리: ' + e.distance_km + 'km<br/>날짜: ' + e.date + '</div>',
            borderWidth: 1,
            borderColor: '#E28257',
            borderRadius: 8,
            backgroundColor: '#FFFFFF',
          });
          openWindowsRef.current.push(eWindow);

          naverObj.maps.Event.addListener(eventMarker, 'click', () => {
            if (eWindow.getMap()) {
              eWindow.close();
            } else {
              eWindow.open(map, eventMarker);
            }
          });
        });
      })
      .catch((err: Error) => {
        if (disposed) return;
        console.error('네이버 지도 로딩 실패:', err);
        setMapError(err.message || NAVER_MAP_ERROR);
      });

    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, regionName, shopLabel, radius, serializedEvents, serializedCafes, containerId]);

  if (Platform.OS !== 'web') {
    return (
      <View style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          // [중요] HTML 문자열 + baseUrl 방식(loadHTMLString)은 iOS가 하위 리소스에 Referer를
          // 붙이지 않아, Referer로 도메인을 검증하는 네이버 지도가 인증을 거부한다.
          // 그래서 지도 HTML을 백엔드가 실제 URL로 서빙하고 여기서는 그 URL을 로드한다.
          // NCP 콘솔 Maps Application의 "Web 서비스 URL"에 이 API 도메인을 등록해야 한다.
          source={{ uri: mapUri }}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          // 지도 페이지가 카페 마커 탭을 알려 준다 → 앱이 리뷰 분석 카드를 연다
          onMessage={(event) => {
            try {
              const msg = JSON.parse(event.nativeEvent.data);
              if (msg?.type === 'cafe' && msg.name) {
                const hit = nearbyCafes.find((c) => c.name === msg.name);
                if (hit) onCafePress?.(hit);
              }
            } catch {
              // 지도 엔진 알림('naver') 등 JSON이 아닌 메시지는 무시
            }
          }}
          style={{ flex: 1, backgroundColor: '#F8F6F2' }}
        />
        <RecenterButton />
      </View>
    );
  }

  // 웹에서 네이버 지도가 실패하면 다른 지도로 대체하지 않고 사유를 그대로 보여 준다
  if (mapError) {
    return (
      <View
        style={{
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          backgroundColor: colors.creamSand,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 }}>
          {mapError}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ width: '100%', height: '100%' }}>
      <View id={containerId} style={{ width: '100%', height: '100%' }} />
      <RecenterButton />
    </View>
  );
}
