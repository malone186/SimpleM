// Animated.loop 대체 — 반복이 실제로 반복되게 한다.
//
// React Native의 Animated.loop은 useNativeDriver:true면 JS 반복을 아예 만들지 않고
// 네이티브 드라이버에 "iterations: -1"을 넘겨 버린다:
//
//   if (animation._isUsingNativeDriver()) { animation._startNativeLoop(iterations); }
//   else { restart(); }   // ← JS로 반복하는 길은 여기뿐이다
//
// 그런데 _isUsingNativeDriver()는 '설정에 true라고 적었는지'를 돌려줄 뿐 네이티브 모듈이
// 실제로 있는지는 보지 않는다(config.useNativeDriver || false). 웹에는 그 모듈이 없어서
// RN이 "Falling back to JS-based animation" 경고와 함께 JS로 재생하는데, iterations는
// 네이티브 설정에만 실려 가고 JS 재생 경로는 쳐다보지도 않는다.
//
// 결과: 웹에서 Animated.loop(...useNativeDriver:true)은 한 바퀴만 돌고 영원히 멈춘다.
// 브루가 '한 번 움직이고 마는' 것처럼 보였던 원인이 이것이다.
//
// 그래서 반복을 이 파일에서 직접 만든다. 한 바퀴가 끝나면 콜백에서 다음 바퀴를 시작하므로
// 드라이버가 무엇이든 계속 돈다. 비용은 한 바퀴에 콜백 한 번(초 단위)이라 무시할 만하다.
import type { Animated } from 'react-native';

export type LoopHandle = { stop: () => void };

/**
 * make()가 만든 애니메이션을 끝날 때마다 다시 시작한다.
 *
 * make를 함수로 받는 이유: 같은 CompositeAnimation 객체를 재시작하면 내부 상태가 남아
 * 두 번째 바퀴부터 시작 위치가 어긋난다. 매 바퀴 새로 만드는 편이 안전하다.
 *
 * 주의 — make()가 길이 0짜리 애니메이션을 만들면 콜백이 즉시 동기 호출되어 무한 재귀에
 * 빠진다. 호출부는 항상 0보다 긴 동작을 넘겨야 한다.
 */
export function startLoop(make: () => Animated.CompositeAnimation): LoopHandle {
  let alive = true;
  let current: Animated.CompositeAnimation | null = null;

  const run = () => {
    if (!alive) return;
    current = make();
    current.start(({ finished }) => {
      // finished=false는 stop()으로 끊긴 경우다 — 그때는 다시 시작하지 않는다
      if (finished && alive) run();
    });
  };

  run();
  return {
    stop: () => {
      alive = false;
      current?.stop();
    },
  };
}
