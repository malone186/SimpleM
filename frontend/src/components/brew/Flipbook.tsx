// 플립북 재생기 — 구운 프레임을 돌리는 부분만 떼어낸 것.
//
// 예전 방식: setInterval(90ms)로 현재 프레임 번호를 state에 넣고, 프레임 20장을 겹쳐 둔 채
// 해당 장만 opacity 1로 바꿨다. 문제가 둘이었다.
//   1) 프레임마다 JS가 깨어나 리렌더한다 — 홈처럼 다른 일이 도는 화면에선 그만큼 끊긴다.
//   2) 90ms = 초당 11장. 장면이 뚝뚝 끊겨 보인다. 그렇다고 프레임을 더 굽는 건 불가능하다
//      (모션캡처 리깅 원본이 남아 있지 않다 — scripts/bake_mascot.py 머리말 참고).
//
// 지금 방식: Animated.Value 하나를 0 → 프레임수 로 '연속으로' 흘리고, 각 레이어는 그 값에
// interpolate를 걸어 자기 할 일(투명도·시트 좌표)을 한다. JS는 재생 시작·끝에만 관여하고
// 프레임당 0회 — 네이티브 드라이버가 다 한다. 프레임이 딱 갈리지 않고 이웃끼리 겹쳐
// 넘어가서(BLEND) 11장짜리가 모션블러처럼 이어져 보인다.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, type ImageStyle, type StyleProp } from 'react-native';

import { startLoop } from '../../lib/animLoop';

/** 다음 프레임이 덮어 오는 데 걸리는 비율. 0.5면 한 프레임 구간의 뒤쪽 절반에서 섞인다.
 *  키우면 부드럽지만 두 자세가 겹쳐 보이고(잔상), 0에 가까우면 예전처럼 딱딱 끊긴다. */
const BLEND = 0.5;

/** i번째 프레임의 불투명도 곡선 (낱장 frames 경로 전용 — 시트 경로는 아래 2겹 계단을 쓴다).
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

/** 루프 이음매용 레이어(첫 프레임 복제)의 불투명도 곡선 (낱장 frames 경로 전용) */
export function seamOpacityRange(n: number): { inputRange: number[]; outputRange: number[]; extrapolate: 'clamp' } {
  return { inputRange: [n - BLEND, n], outputRange: [0, 1], extrapolate: 'clamp' };
}

/** 스프라이트 시트 한 장 + 격자 좌표. bake_mascot.py pack이 굽고 index가 메타를 싣는다.
 *  프레임을 개별 파일로 두면 모션 하나에 에셋이 수백 개가 되는데(OTA는 업데이트당 1000개
 *  제한에 걸린다), 시트면 (모션×색)당 1개다. 렌더링은 프레임별로 시트를 클리핑해 보여준다. */
export type FlipSheet = { src: any; frame: [number, number]; cols: number; rows: number; count: number };

// ── 시트 2겹 재생 ───────────────────────────────────────────────────────────
// 예전엔 프레임 수만큼(bad 모션은 96겹) 시트 전체 크기의 이미지 뷰를 쌓고 투명도만 갈랐다.
// 뷰·레이어가 프레임 수에 비례해 불어나 아이폰에서 GPU/메모리가 눌려 기기 재시작까지 갔다.
// 지금은 어떤 모션이든 딱 2겹이다:
//   base    — 항상 불투명. 현재 프레임 칸을 보여주고, 다음 칸으로는 overlay가 완전히 덮은
//             순간에만 점프한다 (점프가 새어 보일 틈이 없다).
//   overlay — 다음 프레임 칸을 0→1로 덮어 온다(크로스페이드 곡선은 예전과 동일). 다 덮어
//             base가 같은 칸으로 넘어오면 소리 없이 꺼지고, 꺼진 채 다음 칸으로 이동한다.
// '점프'는 interpolate 특성상 극소 구간(SNAP)의 선형 이동이라 중간 칸이 스치는데, 그 순간은
// 반드시 가려져 있거나(base) 투명(overlay)하다 — __tests__/flipbookSheet.test.tsx가 못 박는다.
const BASE_JUMP = 0.01; // base가 다음 칸으로 점프를 시작하는 시점 (프레임 경계 직후)
const SNAP = 0.002; //     칸 점프에 쓰는 극소 구간 — 사실상 순간이동
const HOLD = 0.03; //      전환 뒤 overlay가 완전 불투명으로 버티는 시간 (BASE_JUMP+SNAP을 덮는다)
const FADE = 0.03; //      그 후 overlay가 꺼지는 데 걸리는 시간
const RELOC = 0.2; //      overlay가 (꺼진 뒤) 다음 칸으로 이동을 시작하는 시점

export type Stair = { inputRange: number[]; outputRange: number[] };

/** i번째 칸이 클리핑 창에 오도록 시트를 밀어 둘 이동량 */
export function cellOffset(i: number, sheet: FlipSheet, size: number): { x: number; y: number } {
  return { x: -size * (i % sheet.cols), y: -size * Math.floor(i / sheet.cols) };
}

/** (시각, 프레임 인덱스) 계단을 x·y 좌표 계단 두 개로 푼다.
 *  격자를 접는 순간(줄바꿈) x·y가 함께 뛰어야 해서 같은 입력 구간을 공유한다. */
function toXY(input: number[], idx: number[], sheet: FlipSheet, size: number): { x: Stair; y: Stair } {
  const xs = idx.map((i) => cellOffset(i, sheet, size).x);
  const ys = idx.map((i) => cellOffset(i, sheet, size).y);
  if (input.length < 2) {
    // interpolate는 구간이 2점 이상이어야 한다 — 점프가 없으면 상수 구간으로 채운다
    return {
      x: { inputRange: [0, 1], outputRange: [xs[0] ?? 0, xs[0] ?? 0] },
      y: { inputRange: [0, 1], outputRange: [ys[0] ?? 0, ys[0] ?? 0] },
    };
  }
  return { x: { inputRange: input, outputRange: xs }, y: { inputRange: input, outputRange: ys } };
}

/** base 칸 계단: t∈[i, i+1)에 i번째 칸. 점프는 overlay가 1로 덮고 있는 직후 구간에서만. */
export function baseCellStairs(n: number, sheet: FlipSheet, size: number): { x: Stair; y: Stair } {
  const input: number[] = [0];
  const idx: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    input.push(i + BASE_JUMP, i + BASE_JUMP + SNAP);
    idx.push(i - 1, i);
  }
  return toXY(input, idx, sheet, size);
}

/** overlay 칸 계단: 덮어 올 프레임을 미리 물고 있다가, 꺼진 뒤(RELOC)에야 다음 칸으로 이동.
 *  루프면 마지막 이동이 첫 칸(이음매)으로 돌아온다 — t가 n에서 0으로 되감겨도 같은 그림. */
export function overlayCellStairs(n: number, sheet: FlipSheet, size: number, loop: boolean): { x: Stair; y: Stair } {
  const input: number[] = [];
  const idx: number[] = [];
  if (loop) {
    // 시작(t=0)엔 이음매에서 넘어온 첫 칸을 물고 있다
    input.push(0);
    idx.push(0);
    for (let i = 0; i < n; i += 1) {
      input.push(i + RELOC, i + RELOC + SNAP);
      idx.push(i, (i + 1) % n);
    }
  } else {
    // 한 번 재생은 이음매가 없다 — 처음부터 두 번째 프레임을 물고 시작한다
    input.push(0);
    idx.push(Math.min(1, n - 1));
    for (let i = 1; i < n - 1; i += 1) {
      input.push(i + RELOC, i + RELOC + SNAP);
      idx.push(i, i + 1);
    }
  }
  return toXY(input, idx, sheet, size);
}

/** overlay 불투명도: [i-BLEND, i] 0→1 (크로스페이드), [i, i+HOLD] 1 (밑에서 base가 점프),
 *  [i+HOLD, i+HOLD+FADE] 1→0 (밑에 같은 그림이 깔려 있어 티가 안 난다). */
export function overlayOpacityStair(n: number, loop: boolean): Stair {
  const input: number[] = [];
  const out: number[] = [];
  if (loop) {
    // 되감긴 직후 — 이음매로 켜진 채 넘어와서, base가 첫 칸으로 점프할 때까지 버틴다
    input.push(0, HOLD, HOLD + FADE);
    out.push(1, 1, 0);
  } else {
    input.push(0);
    out.push(0);
  }
  for (let i = 1; i < n; i += 1) {
    input.push(i - BLEND, i, i + HOLD, i + HOLD + FADE);
    out.push(0, 1, 1, 0);
  }
  if (loop) {
    // 이음매 — 첫 칸이 마지막 칸 위로 덮어 오고, 그대로 t=0의 시작 상태와 이어진다
    input.push(n - BLEND, n);
    out.push(0, 1);
  }
  return { inputRange: input, outputRange: out };
}

export default function Flipbook({
  frames,
  sheet,
  size,
  fps = 11,
  loop = true,
  onEnd,
  style,
}: {
  frames?: any[];
  sheet?: FlipSheet;
  size: number;
  fps?: number;
  loop?: boolean;
  onEnd?: () => void;
  style?: StyleProp<ImageStyle>;
}) {
  const n = sheet ? sheet.count : (frames?.length ?? 0);
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

  // 시트 한 겹 — 클리핑 창(size×size) 안에서 시트 전체를 transform으로 밀어 원하는 칸을 보인다.
  // left/top은 네이티브 드라이버가 못 굴리므로 반드시 translate를 쓴다.
  const sheetLayer = (opacity: any, tx: any, ty: any, key: string) => {
    if (!sheet) return null;
    return (
      <Animated.View
        key={key}
        style={[
          { position: 'absolute', top: 0, left: 0, width: size, height: size, opacity, overflow: 'hidden' },
          style as StyleProp<any>,
        ]}
      >
        <Animated.Image
          source={sheet.src}
          resizeMode="stretch"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size * sheet.cols,
            height: size * sheet.rows,
            transform: [{ translateX: tx }, { translateY: ty }],
          }}
        />
      </Animated.View>
    );
  };

  // 프레임이 하나뿐이면 겹칠 상대가 없다 (구간이 뒤집혀 interpolate가 터진다)
  if (n <= 1) {
    if (n !== 1) return null;
    if (sheet) {
      const at = cellOffset(0, sheet, size);
      return sheetLayer(1, at.x, at.y, 'only');
    }
    return (
      <Image
        source={frames![0]}
        resizeMode="contain"
        style={[{ position: 'absolute', top: 0, left: 0, width: size, height: size }, style]}
      />
    );
  }

  if (sheet) {
    const base = baseCellStairs(n, sheet, size);
    const over = overlayCellStairs(n, sheet, size, loop);
    const overOp = overlayOpacityStair(n, loop);
    const clamp = { extrapolate: 'clamp' as const };
    return (
      <>
        {sheetLayer(
          1,
          t.interpolate({ ...base.x, ...clamp }),
          t.interpolate({ ...base.y, ...clamp }),
          'base',
        )}
        {sheetLayer(
          t.interpolate({ ...overOp, ...clamp }),
          t.interpolate({ ...over.x, ...clamp }),
          t.interpolate({ ...over.y, ...clamp }),
          'overlay',
        )}
      </>
    );
  }

  const frameOpacity = (i: number) => t.interpolate(frameOpacityRange(i, n));

  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Animated.Image
          key={i}
          source={frames![i]}
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
          위로 덮여 올라와, 마무리 자세 대신 시작 자세가 잠깐 비쳤다 사라졌다. */}
      {loop && (
        <Animated.Image
          source={frames![0]}
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
