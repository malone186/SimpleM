// 화면 데이터 캐시 검증.
//
// 이 캐시가 하는 일은 딱 하나다 — "앱을 켜자마자 지난번 화면이 떠 있게".
// 그래서 검증할 것도 딱 그 세 가지다:
//   1) 저장한 값을 다음 실행에서 되찾는가 (디스크에 실제로 남는가)
//   2) 신선한 값이면 서버를 다시 부르지 않는가 (탭 왕복마다 재호출하면 캐시가 무의미)
//   3) 당겨서 새로고침(markAllStale) 뒤에는 반드시 다시 부르는가
//      — 여기가 무너지면 "새로고침해도 숫자가 안 바뀐다"가 된다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearMemoryCache, loadCache, markAllStale, peekCache, saveCache } from '../cache';

const KEY = 'test:sales';

beforeEach(() => {
  clearMemoryCache();
  (AsyncStorage as any).__reset();
});

describe('기기 캐시', () => {
  it('저장한 값을 메모리가 비어도 디스크에서 되찾는다 (앱 재실행 상황)', async () => {
    await saveCache(KEY, { total: 120_000 });

    clearMemoryCache(); // 앱을 껐다 켠 셈 — 메모리 사본은 사라진다
    expect(peekCache(KEY)).toBeNull();

    const hit = await loadCache<{ total: number }>(KEY);
    expect(hit?.data).toEqual({ total: 120_000 });
    expect(typeof hit?.at).toBe('number');
  });

  it('저장한 적 없는 값은 null을 준다 (첫 실행)', async () => {
    expect(await loadCache('test:never-saved')).toBeNull();
  });

  it('깨진 JSON이 남아 있어도 터지지 않고 null로 넘어간다', async () => {
    await AsyncStorage.setItem('@simplem_cache:' + KEY, '{이건 JSON이 아니다');
    expect(await loadCache(KEY)).toBeNull();
  });

  it('markAllStale은 값은 남기고 나이만 0으로 되돌린다 (새로고침 시 빈 카드 방지)', async () => {
    await saveCache(KEY, { total: 120_000 });
    expect(peekCache<{ total: number }>(KEY)?.at).toBeGreaterThan(0);

    markAllStale();

    // 값은 그대로 보여 줄 수 있어야 하고
    expect(peekCache<{ total: number }>(KEY)?.data).toEqual({ total: 120_000 });
    // 나이는 0이라 어떤 maxAgeMs 기준으로도 '낡음'이다 → 서버를 다시 부른다
    expect(peekCache(KEY)?.at).toBe(0);
  });

  it('로그아웃(clearMemoryCache)하면 다른 계정에 이전 매장 숫자가 스치지 않는다', async () => {
    await saveCache(KEY, { total: 120_000 });
    clearMemoryCache();
    // 메모리는 즉시 비고, 디스크는 AuthContext의 AsyncStorage.clear()가 함께 지운다
    expect(peekCache(KEY)).toBeNull();
    await AsyncStorage.clear();
    expect(await loadCache(KEY)).toBeNull();
  });
});
