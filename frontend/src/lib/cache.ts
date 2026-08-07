// 화면 데이터 기기 캐시 — "앱을 켜자마자 지난번에 보던 화면이 그대로 떠 있게" 하는 장치.
//
// 홈 화면은 재고·할 일·인사이트·예측·리포트를 서버에서 받아 그린다. 이 중 인사이트와
// 예측은 매장 데이터를 통째로 훑어 만드는 계산이라 서버 캐시가 식어 있으면 한 번에 7초가 걸린다.
// 그동안 화면은 완전히 비어 있었다 — 사장님 눈에는 "앱이 느리다"가 아니라 "앱이 멈췄다"로 보인다.
//
// 그래서 받은 응답을 기기에 남겨 두고, 다음 실행 때는
//   1) 저장된 값으로 즉시 그린 뒤
//   2) 서버 응답이 오면 조용히 갈아 끼운다.
// 숫자가 몇 초 낡아 보일 수 있지만, 빈 화면을 7초 보는 것보다 훨씬 낫다.
//
// 로그아웃은 AsyncStorage를 통째로 비우므로(AuthContext) 다른 사장님의 숫자가 남지 않는다.
// 메모리 사본은 clearMemoryCache()로 같이 지운다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

const KEY_PREFIX = '@simplem_cache:';

export type CacheEntry<T> = { at: number; data: T };

// 같은 세션 안에서 탭을 오갈 때 디스크를 다시 읽지 않도록 하는 메모리 사본.
// (첫 렌더에 동기적으로 값을 꺼낼 수 있어 화면 깜빡임도 없앤다)
const memory = new Map<string, CacheEntry<unknown>>();

/** 메모리에 있는 값만 동기적으로 꺼낸다 — 첫 렌더 초기값용 */
export function peekCache<T>(key: string): CacheEntry<T> | null {
  return (memory.get(key) as CacheEntry<T> | undefined) ?? null;
}

/** 메모리 → 디스크 순으로 찾는다 */
export async function loadCache<T>(key: string): Promise<CacheEntry<T> | null> {
  const hit = peekCache<T>(key);
  if (hit) return hit;
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.at !== 'number') return null;
    memory.set(key, parsed);
    return parsed;
  } catch {
    // 저장소 오류/깨진 JSON — 캐시는 없어도 되는 값이라 조용히 넘긴다
    return null;
  }
}

/** 응답을 기기에 남긴다 (실패해도 화면에는 영향 없음) */
export async function saveCache<T>(key: string, data: T): Promise<void> {
  const entry: CacheEntry<T> = { at: Date.now(), data };
  memory.set(key, entry);
  try {
    await AsyncStorage.setItem(KEY_PREFIX + key, JSON.stringify(entry));
  } catch {
    // 용량 초과 등 — 메모리 사본은 남으므로 이번 세션은 정상 동작한다
  }
}

/** 로그아웃 시 호출 — 디스크는 AsyncStorage.clear()가, 메모리는 여기가 지운다 */
export function clearMemoryCache(): void {
  memory.clear();
}

/**
 * 들고 있는 값을 모두 '낡음'으로 표시한다 — 당겨서 새로고침용.
 *
 * 지우지 않고 나이만 0으로 되돌리는 이유: 화면은 지난 값을 계속 보여 주면서
 * (빈 카드가 깜빡이지 않게) 다음 조회만 반드시 서버를 다시 부르게 하려는 것이다.
 */
export function markAllStale(): void {
  memory.forEach((entry, key) => {
    memory.set(key, { at: 0, data: entry.data });
  });
}

type UseCachedOptions = {
  /** 캐시가 이만큼 신선하면 네트워크를 아예 건너뛴다 (탭 왕복마다 재호출 방지) */
  maxAgeMs?: number;
  /** 값이 바뀌면 캐시 나이와 무관하게 강제로 다시 받는다 (당겨서 새로고침) */
  refreshToken?: number;
};

/**
 * 캐시 먼저, 네트워크 나중.
 *
 * key가 null이면 아무것도 하지 않는다 (로그인 전 등).
 * 파라미터가 있는 요청은 key에 담는다 — 예: `sales:calendar:2026-08`.
 */
export function useCachedResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { maxAgeMs = 0, refreshToken = 0 }: UseCachedOptions = {},
) {
  // fetcher는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다 (넣으면 무한 루프)
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | null>(() => (key ? peekCache<T>(key)?.data ?? null : null));
  const [error, setError] = useState<unknown>(null);
  // 보여줄 게 아무것도 없을 때만 '불러오는 중' — 캐시가 있으면 화면은 이미 채워져 있다
  const [loading, setLoading] = useState(false);

  // key가 바뀌면(리포트 일간→주간, 매출 달력 이동 등) 이전 key의 값을 즉시 내린다.
  // 안 그러면 새 응답이 올 때까지 이전 탭의 숫자가 새 탭 이름을 달고 그대로 보인다 —
  // 홈 리포트에서 일간·주간·월간 금액이 똑같이 보이던 원인. effect(비동기)로 미루지 않고
  // 렌더 중에 바꾸는 이유: 한 프레임이라도 (새 탭 라벨 + 옛 숫자) 조합을 그리지 않기 위해서다.
  const prevKeyRef = useRef(key);
  if (prevKeyRef.current !== key) {
    prevKeyRef.current = key;
    setData(key ? peekCache<T>(key)?.data ?? null : null);
    setError(null);
  }

  const prevRefreshRef = useRef(refreshToken);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) {
      setData(null);
      return;
    }
    const forced = prevRefreshRef.current !== refreshToken;
    prevRefreshRef.current = refreshToken;

    let cancelled = false;
    (async () => {
      const hit = await loadCache<T>(key);
      if (cancelled) return;
      if (hit) setData(hit.data);
      // 방금 받은 값이면 다시 부르지 않는다
      if (!forced && hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return;

      if (!hit) setLoading(true);
      try {
        const fresh = await fetcherRef.current();
        if (cancelled) return;
        setData(fresh);
        setError(null);
        void saveCache(key, fresh);
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, refreshToken, maxAgeMs, tick]);

  const refresh = useCallback(() => {
    prevRefreshRef.current = -1; // 다음 실행을 강제 갱신으로
    setTick((x) => x + 1);
  }, []);

  return { data, loading, error, refresh };
}
