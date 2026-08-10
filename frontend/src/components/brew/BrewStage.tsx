// 브루의 무대 — 게임 룸에서 브루가 서 있는(그리고 원하면 돌아다니는) 자리.
//
// 좌표는 '중앙 기준'이다. translateX가 0이면 정확히 무대 한가운데다.
// 예전엔 0을 왼쪽 끝으로 보고 travel/2에서 시작했는데, 캐릭터를 감싼 Animated.View에는
// 폭이 없어서 RN 기본 세로 배치상 무대 폭만큼 늘어나고 그 안에서 다시 가운데 정렬된다.
// 즉 translateX 0이 이미 중앙인데 거기에 travel/2를 또 더해 오른쪽으로 밀려 있었다.
//
// 좌우 반전(scaleX:-1)은 걷어냈다. 새 그림 없이 방향을 바꿀 수 있다고 봤는데, 브루의
// 앞치마에는 'BREW' 글씨가 박혀 있어서 뒤집으면 'W3R8'로 읽힌다. 글자가 있는 캐릭터는
// 통짜 반전으로 방향을 만들 수 없다 — 반대쪽을 보는 그림이 따로 있어야 한다.
//
// 걷는 그림도 없다(모션캡처 5종에 걸음이 없고 리깅 원본이 없어 새로 굽지도 못한다).
// 그래서 이동은 가로 이동 + 폴짝 동작 조합으로 만든다.
//
// 그리고 아무 포즈나 걸어 다니게 하면 안 된다. 상점 포즈 15종 중 8종은 앞치마 언저리에서
// 잘린 반신 컷이라 발이 없다. 전신 포즈(FULL_BODY_MOODS)일 때만 걷고 그림자를 깐다.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import MascotEasterEgg from '../dashboard/MascotEasterEgg';
import { FULL_BODY_MOODS, type BrewMood } from './Brew';
import type { BrewContext } from './useBrewBrain';
import { useEquipped } from '../../rewards/EquippedContext';

/** 초당 몇 px 움직이는지. 폴짝 한 번(520ms)에 한 뼘 정도 가도록 맞췄다. */
const SPEED = 46;
/** 이동을 마치고 다음 이동까지 쉬는 시간 */
const REST_MIN = 2600;
const REST_MAX = 7000;

export default function BrewStage({
  size,
  width,
  // 기본값이 전신 포즈여야 한다. 예전 기본값이던 'top'은 발 없는 반신 컷이라,
  // 아무 포즈도 안 산 사장님에게 그림자 달고 떠다니는 상반신이 보였다.
  mood = 'hero',
  context,
  roam = false,
  style,
}: {
  size: number;
  /** 무대 가로 폭(px). 브루는 이 안에서만 움직인다. */
  width: number;
  mood?: BrewMood;
  context?: BrewContext;
  /** 켜면 무대를 좌우로 돌아다닌다. 끄면 한가운데 서서 잔동작만 한다(기본). */
  roam?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  // 착용 포즈가 실제로 보이는 그림이다 — MascotEasterEgg 안에서 poseMood가 mood를 이긴다.
  // 걸을지 말지는 '보이는 그림'으로 판단해야 하므로 여기서도 같은 값을 봐야 한다.
  const { poseMood } = useEquipped();
  const shownMood = poseMood ?? mood;
  const fullBody = FULL_BODY_MOODS.has(shownMood);

  // 중앙에서 좌우로 얼마나 벗어날 수 있는지 (한쪽 방향 최대치)
  const reach = Math.max(0, (width - size) / 2);
  const canRoam = roam && fullBody && reach > 4;

  const x = useRef(new Animated.Value(0)).current; // 0 = 무대 정중앙
  const [walking, setWalking] = useState(false);
  const posRef = useRef(0);

  useEffect(() => {
    if (!canRoam) {
      // 돌아다니지 않을 땐 항상 정중앙에 세운다 (직전에 걸어가던 자리에 굳지 않게)
      setWalking(false);
      posRef.current = 0;
      x.setValue(0);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;

    const stepOnce = () => {
      if (!alive) return;
      // 지금 자리에서 충분히 떨어진 곳을 고른다 — 제자리에서 찔끔거리지 않게
      let target = (Math.random() * 2 - 1) * reach;
      if (Math.abs(target - posRef.current) < reach * 0.5) target = -posRef.current;
      const dist = Math.abs(target - posRef.current);
      posRef.current = target;
      setWalking(true);

      Animated.timing(x, {
        toValue: target,
        duration: (dist / SPEED) * 1000,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!alive || !finished) return;
        setWalking(false);
        timer = setTimeout(stepOnce, REST_MIN + Math.random() * (REST_MAX - REST_MIN));
      });
    };

    timer = setTimeout(stepOnce, 1800);
    return () => {
      alive = false;
      clearTimeout(timer);
      // 진행 중인 이동을 멈추고 현재 위치를 기억한다 — 안 멈추면 다음 효과의 이동과
      // 같은 값을 두 애니메이션이 동시에 당겨 브루가 튄다.
      x.stopAnimation((v) => { posRef.current = v; });
    };
  }, [canRoam, reach, x]);

  return (
    // alignItems:'center'라서 자식들이 내용 크기로 줄고 가운데 놓인다 —
    // 그래야 translateX 0이 곧 정중앙이 된다.
    <View style={[{ width, height: size, alignItems: 'center' }, style]}>
      {fullBody && (
        // 바닥 그림자 — 브루와 같이 움직인다. 발을 딛고 있다는 유일한 단서라
        // 이게 빠지면 '떠다니는' 것으로 보인다.
        //
        // zIndex를 주는 이유: 그림자는 position:absolute고 캐릭터는 일반 흐름이라,
        // 웹에서는 positioned 형제가 위에 그려져 그림자가 브루를 덮는다
        // (Brew.tsx의 배경 장식에서 이미 겪은 문제와 같다).
        <Animated.View pointerEvents="none" style={[styles.shadowRow, { transform: [{ translateX: x }] }]}>
          <View
            style={{
              width: size * 0.4,
              height: size * 0.07,
              borderRadius: size * 0.2,
              backgroundColor: 'rgba(40, 26, 18, 0.22)',
            }}
          />
        </Animated.View>
      )}
      <Animated.View style={{ zIndex: 1, transform: [{ translateX: x }] }}>
        <MascotEasterEgg
          mood={mood}
          size={size}
          motion
          interactiveMotions
          autonomous
          context={context}
          // 걷는 동안엔 이동용 폴짝만 시킨다 — 쉬는 구간이 없는 동작이라야 이동 내내 뛴다.
          // (잔동작 hop은 1.5초씩 쉬어서, 걸을 때 쓰면 대부분 안 뛰고 미끄러진다)
          idleMotion={walking ? 'walk' : null}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadowRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    zIndex: 0,
  },
});
