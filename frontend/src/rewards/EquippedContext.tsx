// 착용 중인 꾸미기 아이템을 앱 전역에서 공유한다.
//
// 왜 컨텍스트인가: 상점에서 산 아이템이 홈 화면 마스코트에도 즉시 반영돼야 한다.
// 화면마다 각자 조회하면 상점에서 사고 홈으로 돌아왔을 때 예전 모습이 그대로 남는다.
// 한 곳에서 들고 있다가 구매·착용 시 refresh()로 갱신하면 브루를 그리는 모든 화면이
// 같이 바뀐다.
//
// 처음부터 '꾸며진 모습'으로: 서버 조회(getEquipped)는 네트워크라 한 박자 늦어, 그동안
// 기본 브루가 잠깐 보였다 꾸며진 모습으로 바뀌는 깜빡임이 있었다. 마지막 착용 모습을
// 로컬(AsyncStorage)에 캐시해 앱을 켜자마자 그 모습으로 hydrate하면 처음부터 꾸며진 채 뜬다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { useAuth } from '../auth/AuthContext';
import type { BrewAccessory, BrewMood } from '../components/brew/Brew';
import { getEquipped } from '../lib/api/rewards';

const CACHE_KEY = 'equipped_cache_v1';

type Cached = { accessories: BrewAccessory[]; poseMood?: BrewMood; apronColor?: string };

type EquippedValue = {
  /** 배경 효과 등 브루 위/뒤에 겹쳐 그릴 것들 */
  accessories: BrewAccessory[];
  /** 착용한 포즈. 아무것도 안 샀으면 undefined → 화면 기본 포즈를 쓴다 */
  poseMood?: BrewMood;
  /** 착용한 앞치마 색(navy·forest 등). 없으면 undefined → 기본 갈색 앞치마 */
  apronColor?: string;
  /** 구매·착용 후 호출 — 브루를 그리는 모든 화면이 함께 갱신된다 */
  refresh: () => Promise<void>;
};

const EquippedContext = createContext<EquippedValue>({
  accessories: [],
  poseMood: undefined,
  apronColor: undefined,
  refresh: async () => {},
});

export function EquippedProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [accessories, setAccessories] = useState<BrewAccessory[]>([]);
  const [poseMood, setPoseMood] = useState<BrewMood | undefined>(undefined);
  const [apronColor, setApronColor] = useState<string | undefined>(undefined);
  const prevToken = useRef<string | null | undefined>(undefined);

  // ① 앱 시작 시 캐시된 모습으로 즉시 그린다 (깜빡임 제거).
  useEffect(() => {
    AsyncStorage.getItem(CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        const c = JSON.parse(raw) as Cached;
        setAccessories(c.accessories ?? []);
        setPoseMood(c.poseMood);
        setApronColor(c.apronColor);
      })
      .catch(() => {}); // 캐시가 없거나 깨졌으면 기본 모습으로
  }, []);

  const refresh = useCallback(async () => {
    // 로그아웃(토큰 없음)은 아래 effect가 처리한다 — 여기서 초기 null에 캐시를 지우지
    // 않도록 그냥 반환한다(안 그러면 hydrate한 꾸민 모습이 곧바로 지워진다).
    if (!token) return;
    try {
      const equipped = await getEquipped(token);
      // 포즈는 브루 그림 자체를 갈아끼우고, 앞치마는 색만 바꾸고, 나머지는 겹쳐 그린다
      const pose = equipped.find((e) => e.slot === 'pose');
      const apron = equipped.find((e) => e.slot === 'apron');
      const acc = equipped.filter((e) => e.slot !== 'pose' && e.slot !== 'apron') as BrewAccessory[];
      const nextPose = pose?.mood as BrewMood | undefined;
      const nextApron = apron?.color;
      setPoseMood(nextPose);
      setApronColor(nextApron);
      setAccessories(acc);
      // 다음 실행 때 처음부터 이 모습으로 뜨도록 캐시 갱신
      AsyncStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ accessories: acc, poseMood: nextPose, apronColor: nextApron } satisfies Cached),
      ).catch(() => {});
    } catch {
      // 꾸미기는 부가 기능이다 — 실패해도 캐시/기본 모습으로 그리고 넘어간다.
    }
  }, [token]);

  // 로그인/로그아웃 시 자동 반영
  useEffect(() => {
    refresh();
  }, [refresh]);

  // ② 로그아웃 감지(토큰 있었다 → 없어짐)에만 상태·캐시를 비운다.
  //    (계정이 바뀌면 남의 모습이 남으면 안 된다. 초기 로딩 중 null은 여기 안 걸린다.)
  useEffect(() => {
    if (prevToken.current && !token) {
      setAccessories([]);
      setPoseMood(undefined);
      setApronColor(undefined);
      AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
    }
    prevToken.current = token;
  }, [token]);

  return (
    <EquippedContext.Provider value={{ accessories, poseMood, apronColor, refresh }}>{children}</EquippedContext.Provider>
  );
}

/** 착용 중인 아이템 + 갱신 함수. Provider 밖에서 불러도 빈 배열이라 안전하다. */
export function useEquipped(): EquippedValue {
  return useContext(EquippedContext);
}
