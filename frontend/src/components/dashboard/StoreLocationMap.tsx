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
import { NAVER_CLIENT_ID, NAVER_MAP_ERROR, loadNaverMaps, mapPageOrigin } from '../../lib/naverMap';
import { colors } from '../../theme';

/** 행사 이름·장소는 뉴스·공공데이터에서 온 남의 글이다 — 지도 말풍선에 그대로 넣지 않는다 */
function esc(text: unknown) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 지도 이름표용으로 줄인 행사명 — 자르더라도 낱말 한가운데서 끊지 않는다.
 *  ("어린이메이킹 [행복맘…"처럼 잘리면 무슨 행사인지 알 수 없다) */
export function shortEventLabel(name: string, max = 26) {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // 공백이 너무 앞쪽이면(글자를 절반도 못 살리면) 그냥 자른다 — 띄어쓰기 없는 이름이 그렇다
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** 지도 말풍선 속 카페 요약 — 행사 말풍선과 같은 결.
 *  '리뷰 분석 보기'는 진짜 버튼이다. 예전엔 그냥 글자여서 눌러도 아무 일도 안 났고,
 *  대신 핀을 누르는 순간 분석 시트가 저절로 함께 떠 있었다. */
function cafeInfoHtml(cafe: NearbyCafe, index: number, pressable: boolean, mapId: string) {
  const call = `window.__brewMap&&window.__brewMap['${mapId}']&&window.__brewMap['${mapId}'].cafe(${index})`;
  return (
    '<div style="padding:12px 13px 11px;min-width:164px;max-width:220px;' +
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;">' +
    '<div style="font-size:12.5px;font-weight:800;color:#3B2314;line-height:1.35;' +
    'word-break:keep-all">☕ ' + esc(cafe.name) + '</div>' +
    '<div style="font-size:10.5px;color:#8C7968;margin-top:5px;line-height:1.45">' +
    esc(cafe.category || '카페') + '<br/>내 매장에서 ' + (cafe.distance_m || 0) + 'm</div>' +
    (pressable
      ? '<div onclick="' + call + '" ' +
        'style="margin-top:10px;text-align:center;background:#7A6250;color:#FFF;font-size:10.5px;' +
        'font-weight:800;padding:8px;border-radius:10px;cursor:pointer;">리뷰 분석 보기 ›</div>'
      : '') +
    '</div>'
  );
}

/** 지도 말풍선 속 행사 요약 — 핀을 누르면 이만큼만 먼저 보여 준다.
 *  전체 시트를 바로 띄우면 "저게 뭐지?" 하고 한 번 눌러 본 것치고 너무 무겁다.
 *  여기서 언제·어디서·얼마나 가까운지까지 훑고, 더 볼 사람만 '자세히 보기'로 넘어간다. */
function eventInfoHtml(e: any, index: number, mapId: string) {
  const when = e.ongoing ? '오늘' : `D-${e.d_day ?? 0}`;
  const tone = e.ongoing ? '#C2410C' : '#E28257';
  const call = `window.__brewMap&&window.__brewMap['${mapId}']&&window.__brewMap['${mapId}'].evt(${index})`;
  return (
    '<div style="padding:12px 13px 11px;min-width:172px;max-width:224px;' +
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;">' +
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
    '<span style="background:' + tone + ';color:#FFF;font-size:9.5px;font-weight:800;' +
    'padding:2.5px 8px;border-radius:999px;letter-spacing:-.2px">' + esc(when) + '</span>' +
    (e.boost_pct
      ? '<span style="font-size:9.5px;font-weight:800;color:#B4542C">예측 +' + e.boost_pct + '%</span>'
      : '') +
    '</div>' +
    '<div style="font-size:12.5px;font-weight:800;color:#3B2314;line-height:1.35;' +
    'word-break:keep-all">' + esc(e.name) + '</div>' +
    '<div style="font-size:10.5px;color:#8C7968;margin-top:5px;line-height:1.45;' +
    'word-break:keep-all">' + esc(e.date) + '<br/>' + esc(e.place || '장소 미상') +
    (e.distance_km != null ? ' · ' + e.distance_km + 'km' : '') + '</div>' +
    // 더 볼 사람만 넘어간다 — 여기가 무거운 시트로 가는 유일한 문이다
    '<div onclick="' + call + '" ' +
    'style="margin-top:10px;text-align:center;background:' + tone + ';color:#FFF;font-size:10.5px;' +
    'font-weight:800;padding:8px;border-radius:10px;cursor:pointer;">자세히 보기 ›</div>' +
    '</div>'
  );
}

/** 행사 핀 — 점 하나로는 카페 점과 구별이 안 돼(둘 다 작은 원, 게다가 500m 원이 주황이다)
 *  이름표를 붙인다. 점은 좌표 정확히 그 자리에, 이름표는 오른쪽에 매단다.
 *
 *  이름표는 두 줄까지 접힌다 — 한 줄로 묶어 두면 긴 행사명이 앞부분만 남아 못 알아본다.
 *  한글은 word-break:keep-all로 낱말 단위로 접는다.
 *
 *  오늘 열리는 행사는 이름표가 천천히 숨을 쉰다 — 목록을 안 봐도 "지금 이거"가 먼저 눈에 든다.
 *  이름표 끝의 › 는 "눌러서 더 볼 수 있다"는 표시다. */
function eventMarkerHtml(name: string, ongoing = false) {
  const label = esc(shortEventLabel(name));
  const bg = ongoing ? '#C2410C' : '#D2601A';
  return (
    '<div style="position:relative;width:0;height:0;">' +
    '<style>@keyframes evtBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}' +
    '@keyframes evtRing{0%{transform:scale(0.7);opacity:.7}100%{transform:scale(2.1);opacity:0}}</style>' +
    (ongoing
      ? '<div style="position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;' +
        'background:rgba(194,65,12,0.45);animation:evtRing 2s infinite ease-out;"></div>'
      : '') +
    '<div style="position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;' +
    'background:' + bg + ';border:2.5px solid #FFFFFF;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></div>' +
    '<div style="position:absolute;left:12px;top:-13px;display:flex;align-items:center;gap:4px;' +
    // width:max-content가 없으면 안 된다 — 지도 마커는 폭 0짜리 상자 안에 절대배치라,
    // 줄바꿈을 허용한 순간 상자가 min-content(글자 한 칸)까지 쪼그라든다.
    'box-sizing:border-box;width:-webkit-max-content;width:max-content;max-width:156px;' +
    'padding:4px 7px 4px 9px;background:' + bg + ';border:1.5px solid #FFFFFF;' +
    'border-radius:13px;font-size:10.5px;font-weight:800;color:#FFFFFF;cursor:pointer;' +
    'font-family:-apple-system,sans-serif;box-shadow:0 3px 8px rgba(120,60,20,0.30);' +
    (ongoing ? 'animation:evtBreath 2.4s infinite ease-in-out;transform-origin:left center;' : '') +
    '">' +
    // 두 줄까지: 한글은 keep-all로 낱말째 넘기고, 넘치면 그때만 말줄임
    '<span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;' +
    'white-space:normal;word-break:keep-all;overflow-wrap:anywhere;line-height:1.3;">🎪 ' + label + '</span>' +
    '<span style="opacity:.75;font-weight:700;flex:none">›</span></div>' +
    '</div>'
  );
}

export default function StoreLocationMap({
  lat,
  lon,
  regionName,
  shopLabel,
  nearbyEvents = [],
  nearbyCafes = [],
  onCafePress,
  onEventPress,
  containerId = 'naver-map-container',
  radius = 1000,
}: {
  lat: number;
  lon: number;
  regionName: string;
  shopLabel: string;
  nearbyEvents?: NearbyEvent[];
  // 주변 경쟁 카페 (네이버 지역정보 수집분) — 갈색 점으로 표시하고 탭하면 상세 분석으로 연결
  nearbyCafes?: NearbyCafe[];
  onCafePress?: (cafe: NearbyCafe) => void;
  // 행사 핀 탭 — 지도 안 말풍선 대신 앱의 행사 상세 시트를 연다.
  // 말풍선은 글자가 작고 잘려서, 정작 "그래서 뭘 하면 되나"까지 이어지지 않았다.
  onEventPress?: (eventName: string) => void;
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
  const shopWindowRef = useRef<any>(null);
  // 마지막으로 적용한 반경 — 반경이 그대로면 지도를 다시 매장으로 끌어오지 않는다
  const appliedRadiusRef = useRef<number | null>(null);
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
  // 지도 페이지 주소에는 '지도를 띄우는 데 꼭 필요한 값'만 싣는다.
  //
  // [중요] 카페·행사 목록을 여기 실으면 안 된다. 네이버 지도 SDK는 인증할 때 페이지 주소를
  // 통째로 oapi.map.naver.com/v3/auth 의 url 파라미터로 넘기는데, 목록까지 실으면 주소가
  // 8KB를 넘겨 그 인증 요청이 414(URI Too Long)로 끊긴다. SDK는 이를 인증 실패로 보고
  // navermap_authFailure를 불러, 타일이 잠깐 그려지다 지도가 통째로 꺼진다.
  // (웹은 앱 자신의 짧은 주소에서 SDK를 부르므로 이 문제를 겪지 않는다 — 앱에서만 났던 이유.)
  //
  // 목록은 아래 injectMapData()가 페이지 로드 후 주입한다. 덤으로 카페·행사 응답이
  // 도착할 때마다 WebView를 새로 읽던 깜빡임도 사라진다 (주소가 안 바뀌므로).
  const mapUri = useMemo(() => {
    const payload = encodeURIComponent(JSON.stringify({ lat, lon, regionName, shopLabel, radius }));
    // 지도 페이지는 API 주소가 아니라 '네이버에 등록된 도메인'에서 받아온다 —
    // 로컬 개발(LAN http 주소)에서 열면 네이버가 인증을 거부해 지도가 안 뜬다.
    return `${mapPageOrigin(API_BASE_URL)}/map/?key=${encodeURIComponent(NAVER_CLIENT_ID)}&d=${payload}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, regionName, shopLabel, radius, NAVER_CLIENT_ID]);

  // [네이티브] 카페·행사 목록은 주소가 아니라 주입으로 넘긴다 (이유는 mapUri 주석 참고).
  // 지도 페이지의 window.applyMapData(정식 창구)를 부른다. 아직 첫 그리기 전이면 false가
  // 오므로 true가 될 때까지만 다시 부른다.
  // 그 함수가 없는 옛 배포본을 만나면 페이지 전역(D·gMap·initNaver)을 직접 갈아끼운다 —
  // 앱은 OTA로 먼저 바뀌고 서버는 나중에 배포될 수 있어서, 그 사이에도 핀이 떠야 한다.
  const injectedOnceRef = useRef(false);
  const injectMapData = () => {
    if (Platform.OS === 'web') return;
    // 아직 아무 데이터도 없는 첫 로드에서는 그냥 둔다 (괜히 한 번 더 그릴 필요가 없다).
    // 한 번이라도 넣은 뒤에는 빈 목록도 넣어야 지난 핀이 남지 않는다.
    if (!nearbyCafes.length && !nearbyEvents.length && !injectedOnceRef.current) return;
    // 행사·카페 이름은 외부(공공데이터·네이버)에서 온 남의 글이다. JSON.stringify가 따옴표를
    // 막아 주지만, 줄바꿈으로 취급되는 U+2028/2029만은 따로 빼 준다.
    const lit = (v: unknown) =>
      JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const cafes = nearbyCafes.slice(0, 25).map((c) => ({
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      category: c.category,
      distance_m: c.distance_m,
    }));
    injectedOnceRef.current = true;
    webviewRef.current?.injectJavaScript(`(function(){try{
      var d={cafes:${lit(cafes)},events:${lit(nearbyEvents)}};
      var n=0;(function draw(){
        if(window.applyMapData){ if(window.applyMapData(d)) return; if(n++<60) setTimeout(draw,150); return; }
        // 폴백(옛 배포본): 전역을 직접 갈아끼운다.
        // 페이지가 스스로 첫 그리기를 마칠 때까지 기다린다 — 먼저 끼어들면 지도가 두 번 그려진다
        D.cafes=d.cafes; D.events=d.events;
        if(!window.gMap){ if(n++<60) setTimeout(draw,150); return; }
        try{ if(gMap.destroy) gMap.destroy(); }catch(e){}
        var c=document.getElementById('map'); if(c) c.innerHTML='';
        gMap=null; initNaver();
      })();
    }catch(e){}})(); true;`);
  };

  useEffect(() => {
    injectMapData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedCafes, serializedEvents, mapUri]);

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

          // 내 매장 말풍선도 '열린 말풍선' 목록에 넣는다 — 빠져 있어서 매장 핀을 누른 뒤
          // 카페 핀을 누르면 말풍선 두 개가 동시에 떠 있었다.
          openWindowsRef.current.push(infoWindow);
          shopWindowRef.current = infoWindow;

          naverObj.maps.Event.addListener(shopMarker, 'click', () => {
            const wasOpen = !!infoWindow.getMap();
            openWindowsRef.current.forEach((w) => { if (w.getMap()) w.close(); });
            if (!wasOpen) infoWindow.open(map, shopMarker);
          });

          naverObj.maps.Event.addListener(map, 'click', () => {
            openWindowsRef.current.forEach((w) => {
              if (w.getMap()) w.close();
            });
          });
        } else {
          // 2) 지도가 이미 존재할 때: 반경이 바뀐 경우에만 부드러운 Zoom 모핑(morph)
          //    이 효과는 카페·행사 응답이 도착할 때마다 다시 돈다. 조건 없이 morph하면
          //    사장님이 특정 골목을 확대해 보던 중에 지도가 매장으로 도로 끌려갔다.
          const map = mapRef.current;
          if (appliedRadiusRef.current !== radius && map.getZoom() !== targetZoom) {
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
        appliedRadiusRef.current = radius;

        // 3) 카페 마커 갱신
        cafeMarkersRef.current.forEach((m) => m.setMap(null));
        cafeMarkersRef.current = [];
        // 목록을 비우기 전에 먼저 닫는다. 그냥 비우면 열려 있던 말풍선이 지도에 남는데,
        // 참조가 사라져 어떤 핸들러도 다시 못 닫는다 — 화면을 나갔다 와야 없어졌다.
        // (이 효과는 행사 응답이 늦게 도착할 때 다시 도므로 실제로 일어난다)
        openWindowsRef.current.forEach((w) => { if (w.getMap()) w.close(); });
        openWindowsRef.current = shopWindowRef.current ? [shopWindowRef.current] : [];

        // 말풍선 버튼 → 앱 시트로 가는 통로. 지도가 한 페이지에 둘 이상 뜰 수 있어
        // (프로필 화면에도 같은 컴포넌트가 있다) containerId로 칸을 나눈다 —
        // 전역 하나만 쓰면 나중에 뜬 지도가 앞 지도의 버튼을 가로챈다.
        const bridge = ((window as any).__brewMap = (window as any).__brewMap || {});
        bridge[containerId] = {
          cafe: (i: number) => {
            const target = nearbyCafes[i];
            if (target) onCafePress?.(target);
          },
          evt: (i: number) => {
            const target = nearbyEvents[i] as any;
            if (target?.name) onEventPress?.(target.name);
          },
        };

        // [한글 주석: 주변 카페 마커 — 점 크기 9px + 명확한 시인성의 선명한 웜 브라운 #7A6250]
        nearbyCafes.forEach((cafe, idx) => {
          if (!cafe.lat || !cafe.lon) return;
          const cafeMarkerContent = `
            <div title="${esc(cafe.name)}" style="width:9px;height:9px;background:#7A6250;border-radius:50%;border:1.5px solid #FFFFFF;cursor:pointer;box-shadow:0 1.5px 3.5px rgba(0,0,0,0.3);transition:transform 0.15s ease;"></div>
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
            content: cafeInfoHtml(cafe, idx, !!onCafePress, containerId),
            borderWidth: 1,
            borderColor: 'rgba(140, 121, 104, 0.40)',
            borderRadius: 14,
            backgroundColor: '#FFFFFF',
            anchorColor: '#FFFFFF',
            anchorSize: new naverObj.maps.Size(12, 8),
          });
          openWindowsRef.current.push(cWindow);

          // 말풍선만 연다 — 분석 시트는 말풍선의 버튼으로만. 예전엔 둘이 동시에 떠서
          // 지도를 한 번 눌렀을 뿐인데 창이 두 개 겹쳤다.
          naverObj.maps.Event.addListener(cafeMarker, 'click', () => {
            const wasOpen = !!cWindow.getMap();
            openWindowsRef.current.forEach((w) => { if (w.getMap()) w.close(); });
            if (!wasOpen) cWindow.open(map, cafeMarker);
          });
        });

        // 4) 행사 마커 갱신
        eventMarkersRef.current.forEach((m) => m.setMap(null));
        eventMarkersRef.current = [];
        nearbyEvents.forEach((e: any, idx: number) => {
          if (!e.lat || !e.lon) return;
          const eventMarker = new naverObj.maps.Marker({
            position: new naverObj.maps.LatLng(e.lat, e.lon),
            map,
            // 카페(400)보다 위, 내 매장(500)보다 아래 — 행사가 카페 점에 가려지지 않게
            zIndex: 450,
            icon: {
              content: eventMarkerHtml(e.name, !!e.ongoing),
              anchor: new naverObj.maps.Point(0, 0),
            },
          });
          eventMarkersRef.current.push(eventMarker);

          const eWindow = new naverObj.maps.InfoWindow({
            content: eventInfoHtml(e, idx, containerId),
            borderWidth: 1,
            borderColor: 'rgba(226, 130, 87, 0.40)',
            borderRadius: 14,
            backgroundColor: '#FFFFFF',
            anchorColor: '#FFFFFF',
            anchorSize: new naverObj.maps.Size(12, 8),
          });
          openWindowsRef.current.push(eWindow);

          // 누르면 가벼운 요약부터. 전체 시트는 말풍선의 '자세히 보기'로만 열린다.
          naverObj.maps.Event.addListener(eventMarker, 'click', () => {
            const wasOpen = !!eWindow.getMap();
            openWindowsRef.current.forEach((w) => { if (w.getMap()) w.close(); });
            if (!wasOpen) eWindow.open(map, eventMarker);
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

  // 주소가 바뀌면(좌표·반경·행사 갱신) 지난 실패는 잊고 다시 시도한다 —
  // 안 그러면 한 번 실패한 뒤로는 화면을 나갔다 오기 전까지 안내 문구만 남는다.
  useEffect(() => {
    if (Platform.OS !== 'web') setMapError(null);
  }, [mapUri]);

  // 화면을 떠나면 말풍선 버튼의 통로도 걷는다 (전역에 남겨 두면 죽은 콜백이 쌓인다)
  useEffect(
    () => () => {
      const bridge = (window as any)?.__brewMap;
      if (bridge) delete bridge[containerId];
    },
    [containerId],
  );

  // 지도를 못 불러왔을 때 보여 줄 안내 — 네이티브·웹 공용.
  // 예전엔 네이티브가 실패해도 빈 상자만 남아서 "지도가 안 나온다"는 말밖에 할 수 없었다.
  const ErrorBox = ({ message }: { message: string }) => (
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
        {message}
      </Text>
    </View>
  );

  if (Platform.OS !== 'web') {
    // [중요] 실패 안내는 '지도 페이지 자체'가 실패했을 때만 띄운다.
    // onError·onHttpError는 지도 타일·폰트 같은 하위 요청이 한 번 실패해도 불린다.
    // 그것까지 잡아서 WebView를 안내 문구로 갈아치웠더니, 멀쩡히 그려지던 지도가
    // 떴다가 꺼졌다("반짝거리다 꺼진다"). 주소가 지도 페이지와 같을 때만 실패로 본다.
    const isMapPage = (url?: string) => !!url && url.split('?')[0] === mapUri.split('?')[0];
    return (
      <View style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          // 페이지 자체를 못 받아온 경우(주소 오타·서버 다운·iOS ATS의 http 차단 등)만
          // 화면에 드러낸다. 네이버 인증 실패는 지도 페이지가 스스로 안내를 그린다.
          onError={({ nativeEvent }) => {
            if (!isMapPage(nativeEvent.url)) return;
            setMapError(`지도 페이지를 열지 못했습니다.\n${nativeEvent.description ?? NAVER_MAP_ERROR}`);
          }}
          onHttpError={({ nativeEvent }) => {
            if (!isMapPage(nativeEvent.url)) return;
            setMapError(`지도 페이지 응답 오류 (${nativeEvent.statusCode}).\n잠시 후 다시 시도해 주세요.`);
          }}
          // [중요] HTML 문자열 + baseUrl 방식(loadHTMLString)은 iOS가 하위 리소스에 Referer를
          // 붙이지 않아, Referer로 도메인을 검증하는 네이버 지도가 인증을 거부한다.
          // 그래서 지도 HTML을 백엔드가 실제 URL로 서빙하고 여기서는 그 URL을 로드한다.
          // NCP 콘솔 Maps Application의 "Web 서비스 URL"에 이 API 도메인을 등록해야 한다.
          source={{ uri: mapUri }}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          // 페이지가 준비되면 카페·행사 목록을 넣어 준다 (주소로는 못 보낸다 — mapUri 주석 참고)
          onLoadEnd={injectMapData}
          // 지도 페이지가 마커 탭을 알려 준다 → 앱이 카페 리뷰 분석 / 행사 상세 시트를 연다
          onMessage={(event) => {
            const raw = event.nativeEvent.data;
            // 지도 페이지는 실패하면 'naver-FAILED: 사유'를 보내 준다. 사유에 페이지 origin이
            // 들어 있어 "어느 주소에서 열린 지도가 거부됐는지"가 바로 드러난다 —
            // 지금까지는 이 메시지를 통째로 무시해서, 지도가 왜 꺼졌는지 알 길이 없었다.
            if (typeof raw === 'string' && raw.startsWith('naver-FAILED')) {
              const reason = raw.replace(/^naver-FAILED:?\s*/, '');
              setMapError(`네이버 지도를 불러오지 못했습니다.\n${reason}\n(지도 주소: ${mapUri.split('/map/')[0]})`);
              return;
            }
            try {
              const msg = JSON.parse(raw);
              if (msg?.type === 'cafe') {
                // 인덱스를 먼저 쓴다 — 이름으로 찾으면 '메가커피'가 반경 안에 둘일 때
                // 먼 쪽 핀을 눌러도 가까운 쪽이 열린다 (웹은 이미 인덱스를 쓴다)
                const hit = typeof msg.index === 'number'
                  ? nearbyCafes[msg.index]
                  : nearbyCafes.find((c) => c.name === msg.name);
                if (hit) onCafePress?.(hit);
              }
              if (msg?.type === 'event' && msg.name) onEventPress?.(String(msg.name));
            } catch {
              // 지도 엔진 알림('naver') 등 JSON이 아닌 메시지는 무시
            }
          }}
          style={{ flex: 1, backgroundColor: '#F8F6F2' }}
        />
        {/* 안내는 지도 위에 덮어 씌운다 — WebView를 통째로 떼어내면 다시 붙을 때
            페이지를 처음부터 다시 받아, 실패↔재시도가 화면 깜빡임으로 보인다. */}
        {mapError ? (
          <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
            <ErrorBox message={mapError} />
          </View>
        ) : null}
        <RecenterButton />
      </View>
    );
  }

  // 웹에서 네이버 지도가 실패하면 다른 지도로 대체하지 않고 사유를 그대로 보여 준다
  if (mapError) return <ErrorBox message={mapError} />;

  return (
    <View style={{ width: '100%', height: '100%' }}>
      <View id={containerId} style={{ width: '100%', height: '100%' }} />
      <RecenterButton />
    </View>
  );
}
