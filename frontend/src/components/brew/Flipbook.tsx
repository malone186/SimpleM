// 플립북 재생기 — 구운 프레임(20장)을 돌리는 부분만 떼어낸 것.
//
// 예전 방식: setInterval(90ms)로 현재 프레임 번호를 state에 넣고, 프레임 20장을 겹쳐 둔 채
// 해당 장만 opacity 1로 바꿨다. 문제가 둘이었다.
//   1) 프레임마다 JS가 깨어나 리렌더한다 — 홈처럼 다른 일이 도는 화면에선 그만큼 끊긴다.
//   2) 90ms = 초당 11장. 장면이 뚝뚝 끊겨 보인다. 그렇다고 프레임을 더 굽는 건 불가능하다
//      (모션캡처 리깅 원본이 남아 있지 않다 — scripts/bake_mascot.py 머리말 참고).
//
// 지금 방식: Animated.Value 하나를 0 → 프레임수 로 '연속으로' 흘리고, 각 프레임은 그 값에
// 자기 구간에서만 불이 켜지도록 interpolate를 걸어 둔다. 그러면
//   - JS는 재생 시작·끝에만 한 번씩 관여한다 (프레임당 0회). 네이티브 드라이버가 다 한다.
//   - 프레임이 딱 갈리지 않고 이웃끼리 겹쳐 넘어간다 — 11장짜리가 모션블러처럼 이어져 보인다.
// 새 그림 한 장 없이 부드러워지는 게 핵심이다.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, type ImageStyle, type StyleProp } from 'react-native';

import { startLoop } from '../../lib/animLoop';

/** 다음 프레임이 덮어 오는 데 걸리는 비율. 0.5면 한 프레임 구간의 뒤쪽 절반에서 섞인다.
 *  키우면 부드럽지만 두 자세가 겹쳐 보이고(잔상), 0에 가까우면 예전처럼 딱딱 끊긴다. */
const BLEND = 0.5;

/** i번째 프레임의 불투명도 곡선.
 *
 * 프레임을 겹치는 방식이 중요하다. 두 장을 각각 반투명으로 섞으면(처음 짰던 방식) 겹치는
 * 순간 합성 알파가 1에 못 미친다 — 0.5와 0.32를 겹치면 0.66이라 배경이 비칠 만큼 옅어지고,
 * 그게 초당 11번 반복되니 '깜빡인다'로 보인다.
 *
 * 그래서 섞지 않고 '덮는다'. 아래에 깔린 현재 프레임은 계속 불투명(1)하게 두고 그 위로 다음
 * 프레임이 0→1로 올라온다. 어느 순간에도 밑에 불투명한 한 장이 깔려 있으니 합성 알파는 항상
 * 1이다. 다음 장이 1에 도달한 뒤엔 아래 장을 즉시 꺼도 완전히 가려져 티가 안 난다.
 *
 * (합성 알파가 1인지는 __tests__/flipbook.test.ts가 t를 훑으며 검사한다)
 */
export function frameOpacityRange(i: number, n: number): { inputRange: number[]; outputRange: number[]; extrapolate: 'clamp' } {
  if (i === 0) {
    // 첫 장은 시작부터 켜져 있다 (아래에서 올라올 게 없다)
    return { inputRange: [0, 1, 1.001], outputRange: [1, 1, 0], extrapolate: 'clamp' };
  }
  if (i === n - 1) {
    // 마지막 장은 끝까지 켜 둔다 — 그 위를 '이음매' 레이어(첫 장 복제)가 덮는다
    return { inputRange: [i - BLEND, i, n], outputRange: [0, 1, 1], extrapolate: 'clamp' };
  }
  return { inputRange: [i - BLEND, i, i + 1, i + 1.001], outputRange: [0, 1, 1, 0], extrapolate: 'clamp' };
}

/** 루프 이음매용 레이어(첫 프레임 복제)의 불투명도 곡선 */
export function seamOpacityRange(n: number): { inputRange: number[]; outputRange: number[]; extrapolate: 'clamp' } {
  return { inputRange: [n - BLEND, n], outputRange: [0, 1], extrapolate: 'clamp' };
}

export default function Flipbook({
  frames,
  size,
  fps = 11,
  loop = true,
  onEnd,
  style,
}: {
  frames: any[];
  size: number;
  fps?: number;
  loop?: boolean;
  onEnd?: () => void;
  style?: StyleProp<ImageStyle>;
}) {
  const n = frames.length;
  const t = useRef(new Animated.Value(0)).current;
  // onEnd가 매 렌더 새 함수여도 애니메이션을 다시 시작하지 않도록 ref로 받는다
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => {
    if (n === 0) return;
    const cycle = () => {
      t.setValue(0); // 매 바퀴 처음 프레임부터
      return Animated.timing(t, {
        toValue: n,
        duration: (n / fps) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      });
    };

    if (loop) {
      // Animated.loop을 쓰지 않는다 — 웹에서 한 바퀴만 돌고 멈춘다(animLoop.ts 참고).
      // 착용한 '춤추는 브루'가 한 번 추고 굳어 버리던 원인이 정확히 이거였다.
      return startLoop(cycle).stop;
    }
    const run = cycle();
    run.start(({ finished }) => {
      // 한 번 재생이 끝났을 때만 알린다. 중간에 언마운트돼 멈춘 경우는 제외.
      if (finished) endRef.current?.();
    });
    return () => run.stop();
  }, [t, n, fps, loop]);

  // 프레임이 하나뿐이면 겹칠 상대가 없다 (구간이 뒤집혀 interpolate가 터진다)
  if (n <= 1) {
    return n === 1 ? (
      <Image
        source={frames[0]}
        resizeMode="contain"
        style={[{ position: 'absolute', top: 0, left: 0, width: size, height: size }, style]}
      />
    ) : null;
  }

  const frameOpacity = (i: number) => t.interpolate(frameOpacityRange(i, n));

  return (
    <>
      {frames.map((src, i) => (
        <Animated.Image
          key={i}
          source={src}
          resizeMode="contain"
          style={[
            { position: 'absolute', top: 0, left: 0, width: size, height: size, opacity: frameOpacity(i) },
            style,
          ]}
        />
      ))}
      {/* 루프 이음매 — 첫 프레임을 맨 위에 한 장 더 깔아, 마지막 장 위로 덮어 오게 한다.
          첫 장은 스택 맨 아래라 마지막 장을 가릴 수 없어서 여기만 예외로 복제한다.
          t가 끝(n)에서 0으로 되감기는 순간, 보이는 그림은 양쪽 다 '첫 프레임'이라 티가 안 난다.

          반복 재생일 때만 깐다. 한 번 재생(탭 반응)에까지 두면 동작이 끝나는 순간 첫 자세가
          위로 덮여 올라와, 마무리 자세 대신 시작 자세가 잠깐 비쳤다 사라진다. */}
      {loop && (
        <Animated.Image
          source={frames[0]}
          resizeMode="contain"
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              width: size,
              height: size,
              opacity: t.interpolate(seamOpacityRange(n)),
            },
            style,
          ]}
        />
      )}
    </>
  );
}
