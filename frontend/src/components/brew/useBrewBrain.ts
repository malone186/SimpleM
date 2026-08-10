// BrewBrain — 브루가 '스스로' 움직이게 하는 층.
//
// 지금까지 브루는 눌러야만 반응했다. 탭하면 춤추고, 안 누르면 정해진 잔동작 하나를
// 무한 반복한다. 동작을 아무리 늘려도 '누르면 나오는 재생목록'에 머무는 이유가 이거다.
// 여기서는 반대로, 아무도 안 누를 때 브루가 알아서 다음 동작을 고른다.
//
// 고르는 기준은 가게 상태다. 밤이면 기지개를 켜고 축 처지고, 매출이 오르면 신나고,
// 재고가 비면 갸웃한다. 그래서 이 층은 '연출'이 아니라 '가게 상태를 몸으로 말하는' 층에
// 가깝다 — 브루 등장 지도의 원칙(표정 = 가게 상태)을 잔동작까지 밀어 넣은 것.
//
// 성능 주의: 화면에 안 보일 땐 반드시 꺼야 한다(enabled=false). 예전에 홈에서 상시
// 루프가 돌아 프레임을 깎아먹은 적이 있어서, 기본값은 '꺼짐'이고 켜는 쪽이 명시한다.
import { useEffect, useRef, useState } from 'react';

import { type MotionName } from './brewMotions';
import type { BrewOneShot } from './Brew';

/** 브루가 읽는 가게 상태. 전부 선택 — 모르면 시간대만으로도 돌아간다. */
export type BrewContext = {
  /** 매출 흐름 (어제 대비) */
  salesTrend?: 'up' | 'down' | 'flat';
  /** 재고가 부족한 재료 수 */
  lowStock?: number;
  /** 남은 할 일 수 */
  todosLeft?: number;
  /** 오늘 연속 출석을 채웠는지 */
  streakDone?: boolean;
};

type Action = { motion: MotionName; weight: number };

/** 지금 시각(0~23)에 어울리는 동작 가중치 */
function byHour(hour: number): Action[] {
  if (hour >= 5 && hour < 11) {
    // 아침 — 문 열 준비. 두리번거리고 기지개를 켠다
    return [
      { motion: 'stretch', weight: 3 },
      { motion: 'lookAround', weight: 3 },
      { motion: 'breathe', weight: 2 },
      { motion: 'nod', weight: 1 },
    ];
  }
  if (hour >= 11 && hour < 17) {
    // 낮 — 한창때. 가장 활발하다
    return [
      { motion: 'hop', weight: 3 },
      { motion: 'lookAround', weight: 3 },
      { motion: 'nod', weight: 2 },
      { motion: 'breathe', weight: 2 },
    ];
  }
  if (hour >= 17 && hour < 22) {
    // 저녁 — 마감 준비. 차분해진다
    return [
      { motion: 'breathe', weight: 4 },
      { motion: 'tilt', weight: 2 },
      { motion: 'nod', weight: 2 },
      { motion: 'stretch', weight: 1 },
    ];
  }
  // 심야 — 졸리다
  return [
    { motion: 'breathe', weight: 5 },
    { motion: 'droop', weight: 3 },
    { motion: 'stretch', weight: 2 },
  ];
}

/** 가게 상태가 시간대 기본값 위에 얹는 가중치 */
function byContext(ctx: BrewContext): Action[] {
  const out: Action[] = [];
  if (ctx.salesTrend === 'up') out.push({ motion: 'excited', weight: 4 }, { motion: 'hop', weight: 2 });
  if (ctx.salesTrend === 'down') out.push({ motion: 'droop', weight: 3 }, { motion: 'tilt', weight: 1 });
  if (ctx.lowStock && ctx.lowStock > 0) out.push({ motion: 'tilt', weight: 2 + Math.min(ctx.lowStock, 3) });
  if (ctx.todosLeft && ctx.todosLeft > 0) out.push({ motion: 'lookAround', weight: 2 }, { motion: 'nod', weight: 1 });
  if (ctx.streakDone) out.push({ motion: 'excited', weight: 2 });
  return out;
}

function weightedPick(actions: Action[]): MotionName {
  const total = actions.reduce((sum, a) => sum + a.weight, 0);
  if (total <= 0) return 'breathe';
  let roll = Math.random() * total;
  for (const a of actions) {
    roll -= a.weight;
    if (roll <= 0) return a.motion;
  }
  return actions[actions.length - 1].motion;
}

// 전신 모션(손인사·점프·댄스…)은 두뇌가 스스로 내지 않는다.
//
// 한때 가끔 끼워 넣게 해 뒀는데, 그러면 상점에서 산 '춤추는 브루'를 착용해도 몇 초 뒤에
// 손인사가 덮어써서 고른 것과 다른 게 나온다. 착용 포즈는 사장님이 고른 브루의 정체고,
// 전신 모션은 그림 전체를 갈아끼우는 거라 얹는 게 아니라 바꿔치기가 된다.
// 전신 모션이 나오는 건 탭했을 때뿐이다 — 그건 눌러서 부른 거라 바뀌어도 납득이 된다.
// 두뇌가 맡는 건 그림을 유지한 채 몸만 움직이는 잔동작이다.

export function useBrewBrain({
  enabled = false,
  context = {},
  minGapMs = 5200,
  maxGapMs = 12000,
}: {
  enabled?: boolean;
  context?: BrewContext;
  minGapMs?: number;
  maxGapMs?: number;
} = {}) {
  const [idleMotion, setIdleMotion] = useState<MotionName | null>(null);
  const [oneShot, setOneShot] = useState<BrewOneShot | null>(null);
  // 매 렌더 새 객체로 오는 context 때문에 타이머가 재시작되지 않게 ref로 읽는다
  const ctxRef = useRef(context);
  ctxRef.current = context;

  useEffect(() => {
    if (!enabled) {
      setIdleMotion(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;

    const step = () => {
      if (!alive) return;
      const hour = new Date().getHours();
      setIdleMotion(weightedPick([...byHour(hour), ...byContext(ctxRef.current)]));
      timer = setTimeout(step, minGapMs + Math.random() * (maxGapMs - minGapMs));
    };

    // 화면에 뜨자마자 큰 동작이 튀어나오면 놀란다 — 잠깐 숨 고르고 시작
    timer = setTimeout(step, 1200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, minGapMs, maxGapMs]);

  // oneShot은 두뇌가 쓰지 않지만 상태는 여기서 들고 있는다 — 전신 모션 재생 통로를 한 곳으로
  // 모아 두면, 탭 반응과 잔동작이 서로의 상태를 덮어써 깜빡이는 일이 생기지 않는다.
  return { idleMotion, oneShot, setOneShot };
}
