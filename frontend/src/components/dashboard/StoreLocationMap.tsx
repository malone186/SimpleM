// [매장 위치 네이버 지도 공용 컴포넌트]
// 프로필 화면·매장 지도 화면 등 어디서든 재사용한다.
// 네이버 지도 전용 — 인증/로딩이 실패하면 다른 지도로 바꿔치기하지 않고 실패를 그대로 알린다.
// 웹은 브라우저 DOM에 직접 렌더, 네이티브는 백엔드가 서빙하는 지도 페이지를 WebView로 띄운다.
import { useEffect, useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { API_BASE_URL } from '../../lib/api/client';
import { getGpsPosition } from '../../lib/api/forecast';
import type { NearbyEvent } from '../../lib/api/forecast';
import { NAVER_CLIENT_ID, NAVER_MAP_ERROR, loadNaverMaps } from '../../lib/naverMap';
import { colors } from '../../theme';

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
  const [mapError, setMapError] = useState<string | null>(null);

  // [현위치 표시] 기기 GPS 좌표 — 매장 핀(브라운)과 별개로 파란 점으로 표시한다.
  // getDevicePosition은 저장된 매장 좌표를 우선 반환해 현위치가 안 보였으므로 순수 GPS 함수를 쓴다.
  const [myPos, setMyPos] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    let alive = true;
    getGpsPosition().then((pos) => {
      if (alive && pos) setMyPos(pos);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 네이티브 WebView가 로드할 백엔드 지도 URL.
  // HTML 문자열을 직접 넣으면 iOS가 Referer를 안 보내 네이버 인증이 실패하므로,
  // 백엔드(/map/)가 서빙하는 실제 URL을 로드해 Referer가 전송되게 한다.
  const mapUri = useMemo(() => {
    const payload = encodeURIComponent(
      JSON.stringify({ lat, lon, regionName, shopLabel, events: nearbyEvents, me: myPos }),
    );
    return `${API_BASE_URL}/map/?key=${encodeURIComponent(NAVER_CLIENT_ID)}&d=${payload}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, regionName, shopLabel, serializedEvents, NAVER_CLIENT_ID, myPos]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let disposed = false;

    const draw = (naverObj: any) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';

      const map = new naverObj.maps.Map(container, {
        center: new naverObj.maps.LatLng(lat, lon),
        zoom: 14,
        zoomControl: false,
      });

      // 내 매장 마커
      const shopMarker = new naverObj.maps.Marker({
        position: new naverObj.maps.LatLng(lat, lon),
        map,
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

      // 인근 축제 마커들 (열린 정보창을 모아두었다가 지도 빈 곳 클릭 시 일괄 닫기)
      const eventWindows: any[] = [];
      nearbyEvents.forEach((e: any) => {
        if (!e.lat || !e.lon) return;
        const eventMarker = new naverObj.maps.Marker({
          position: new naverObj.maps.LatLng(e.lat, e.lon),
          map,
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
      });

      // 지도 빈 곳을 클릭하면 열려 있는 행사 정보창을 모두 닫는다
      naverObj.maps.Event.addListener(map, 'click', () => {
        eventWindows.forEach((w) => {
          if (w.getMap()) w.close();
        });
      });

      // 현위치 파란 점 (매장 핀과 구분되는 GPS 위치 — 좌표를 못 받았으면 생략)
      if (myPos) {
        new naverObj.maps.Marker({
          position: new naverObj.maps.LatLng(myPos.lat, myPos.lon),
          map,
          icon: {
            content:
              '<div title="현위치" style="width:14px;height:14px;background:#1A73E8;border:3px solid #FFFFFF;border-radius:50%;box-shadow:0 0 0 5px rgba(26,115,232,0.2),0 2px 5px rgba(0,0,0,0.3)"></div>',
            anchor: new naverObj.maps.Point(7, 7),
          },
          zIndex: 300,
        });
      }
    };

    setMapError(null);
    loadNaverMaps()
      .then((naverObj) => {
        if (disposed) return;
        try {
          draw(naverObj);
        } catch (err) {
          console.error('네이버 지도 초기화 실패:', err);
          setMapError(NAVER_MAP_ERROR);
        }
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
  }, [lat, lon, regionName, shopLabel, serializedEvents, containerId, myPos]);

  if (Platform.OS !== 'web') {
    return (
      <View style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <WebView
          originWhitelist={['*']}
          // [중요] HTML 문자열 + baseUrl 방식(loadHTMLString)은 iOS가 하위 리소스에 Referer를
          // 붙이지 않아, Referer로 도메인을 검증하는 네이버 지도가 인증을 거부한다.
          // 그래서 지도 HTML을 백엔드가 실제 URL로 서빙하고 여기서는 그 URL을 로드한다.
          // NCP 콘솔 Maps Application의 "Web 서비스 URL"에 이 API 도메인을 등록해야 한다.
          source={{ uri: mapUri }}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          style={{ flex: 1, backgroundColor: '#F8F6F2' }}
        />
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

  return <View id={containerId} style={{ width: '100%', height: '100%' }} />;
}
