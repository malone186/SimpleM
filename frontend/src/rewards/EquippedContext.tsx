// 착용 중인 꾸미기 아이템을 앱 전역에서 공유한다.
//
// 왜 컨텍스트인가: 상점에서 산 아이템이 홈 화면 마스코트에도 즉시 반영돼야 한다.
// 화면마다 각자 조회하면 상점에서 사고 홈으로 돌아왔을 때 예전 모습이 그대로 남는다.
// 한 곳에서 들고 있다가 구매·착용 시 refresh()로 갱신하면 브루를 그리는 모든 화면이
// 같이 바뀐다.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '../auth/AuthContext';
import type { BrewAccessory, BrewMood } from '../components/brew/Brew';
import { getEquipped } from '../lib/api/rewards';

type EquippedValue = {
  /** 배경 효과 등 브루 위/뒤에 겹쳐 그릴 것들 */
  accessories: BrewAccessory[];
  /** 착용한 포즈. 아무것도 안 샀으면 undefined → 화면 기본 포즈를 쓴다 */
  poseMood?: BrewMood;
  /** 구매·착용 후 호출 — 브루를 그리는 모든 화면이 함께 갱신된다 */
  refresh: () => Promise<void>;
};

const EquippedContext = createContext<EquippedValue>({
  accessories: [],
  poseMood: undefined,
  refresh: async () => {},
});

export function EquippedProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [accessories, setAccessories] = useState<BrewAccessory[]>([]);
  const [poseMood, setPoseMood] = useState<BrewMood | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!token) {
      setAccessories([]);
      setPoseMood(undefined);
      return;
    }
    try {
      const equipped = await getEquipped(token);
      // 포즈는 브루 그림 자체를 갈아끼우고, 나머지는 겹쳐 그린다
      const pose = equipped.find((e) => e.slot === 'pose');
      setPoseMood(pose?.mood as BrewMood | undefined);
      setAccessories(equipped.filter((e) => e.slot !== 'pose') as BrewAccessory[]);
    } catch {
      // 꾸미기는 부가 기능이다 — 실패해도 기본 브루로 그리고 넘어간다.
    }
  }, [token]);

  // 로그인/로그아웃 시 자동 반영 (계정이 바뀌면 남의 아이템이 보이면 안 된다)
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <EquippedContext.Provider value={{ accessories, poseMood, refresh }}>{children}</EquippedContext.Provider>
  );
}

/** 착용 중인 아이템 + 갱신 함수. Provider 밖에서 불러도 빈 배열이라 안전하다. */
export function useEquipped(): EquippedValue {
  return useContext(EquippedContext);
}
