// [설정 전역 적용 — 웹] 글자 크기를 앱 콘텐츠(#app-screen)에 실제로 반영한다.
//  • 글자 크기: CSS zoom 으로 콘텐츠를 확대/축소(리플로우됨). zoom 이 박스를 키워 가로가
//    프레임을 넘지 않도록 width 를 (프레임 실측폭 ÷ 배율) '픽셀'로 보정한다.
//    (%로 주면 self-zoom 과 컨테이너 %가 순환 계산돼 폭이 어긋남 → 반드시 px)
// 제어값은 <html>(documentElement) 의 CSS 변수로만 설정 — RN-web 재렌더에도 안 지워지도록.
// 실기기(네이티브)엔 #app-screen 이 없어 자동 무시된다.
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { usePreferences } from '../preferences/PreferencesContext';

const STYLE_ID = 'simplem-appearance-style';

export default function WebAppearance() {
  const { fontScale, ready } = usePreferences();

  // 스타일 규칙 1회 주입
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #app-screen {
        zoom: var(--app-zoom, 1);
        width: var(--app-width, 100%) !important;
      }
    `;
    document.head.appendChild(style);
  }, []);

  // 글자 크기 반영
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = document.documentElement;
    const el = document.getElementById('app-screen');
    root.style.setProperty('--app-zoom', String(fontScale));
    if (fontScale === 1 || !el) {
      root.style.setProperty('--app-width', '100%');
    } else {
      const frameW = el.parentElement?.clientWidth || 404; // 줌 영향 없는 프레임 실제 폭
      root.style.setProperty('--app-width', `${frameW / fontScale}px`);
    }
    // 다크모드 제거 — 이전 세션/캐시에 남은 다크 상태가 있어도 확실히 해제
    root.removeAttribute('data-app-theme');
  }, [fontScale, ready]);

  return null;
}
