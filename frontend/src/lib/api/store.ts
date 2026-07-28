// [매장 고정 위치] 회원가입 지도 핀으로 등록한 매장 좌표를 서버(DB)에서 읽고 쓰는 창구.
//
// 왜 서버에 두는가: 예전에는 가입 기기의 AsyncStorage에만 저장해서, 다른 기기로 로그인하거나
// 앱을 다시 깔면 매장 위치가 사라지고 지도가 '기기 현위치'로 그려졌다. 사장님이 집에서 앱을
// 켜면 매장이 집으로 이사한 것처럼 보였다. 이제 위치는 계정에 붙고, 기기는 캐시만 갖는다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiFetch } from './client';
import { STORE_LOCATION_KEY, type StoredStoreLocation } from './forecast';

export type MyProfile = {
  id: number;
  email: string;
  name: string;
  store_name: string;
  phone?: string | null;
  created_at: string;
  store_lat?: number | null;
  store_lon?: number | null;
  store_address?: string | null;
  store_biz_type?: string | null;
};

export type StoreLocation = {
  lat: number;
  lon: number;
  address?: string;
  bizType?: string;
};

/** 내 프로필(매장 고정 위치 포함) 조회 */
export const getMyProfile = (token: string) =>
  apiFetch<MyProfile>('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });

/** 매장 고정 위치 등록/변경 — 지도 핀을 옮겼을 때 호출 */
export const saveStoreLocation = (token: string, loc: StoreLocation) =>
  apiFetch<MyProfile>('/api/v1/auth/profile', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      store_lat: loc.lat,
      store_lon: loc.lon,
      store_address: loc.address ?? undefined,
      store_biz_type: loc.bizType ?? undefined,
    }),
  });

/** 기기 캐시에 매장 위치를 기록 — 다음 실행에서 서버 응답 전에 지도를 먼저 그린다 */
export async function cacheRegisteredStore(loc: StoredStoreLocation & { bizType?: string }): Promise<void> {
  try {
    await AsyncStorage.setItem(STORE_LOCATION_KEY, JSON.stringify(loc));
  } catch {
    // 캐시 실패는 치명적이지 않다 — 서버 값이 원본이다
  }
}

export type ResolvedStoreLocation = StoredStoreLocation & {
  /** 계정에 등록된 위치인가 (false면 이 기기 캐시만 있는 상태) */
  registered: boolean;
};

/** 매장 고정 위치 확정 — 계정(DB)이 원본, 기기 캐시는 보조.
 *
 *  1) 서버에 등록돼 있으면 그 값을 쓰고 기기 캐시를 갱신한다.
 *  2) 서버에 없고 기기 캐시만 있으면(구버전 앱에서 가입한 계정) 그 값을 계정으로 올려 준다 — 1회 이전.
 *  3) 둘 다 없으면 null → 화면이 '매장 위치 등록'을 안내한다. 기기 GPS로 추측하지 않는다.
 */
export async function resolveStoreLocation(token: string): Promise<ResolvedStoreLocation | null> {
  const { getStoredStoreLocation } = await import('./forecast');
  const cached = await getStoredStoreLocation();

  let profile: MyProfile | null = null;
  try {
    profile = await getMyProfile(token);
  } catch (e) {
    console.warn('매장 위치 조회 실패 — 기기 캐시로 표시합니다:', e);
    return cached ? { ...cached, registered: false } : null;
  }

  if (typeof profile.store_lat === 'number' && typeof profile.store_lon === 'number') {
    const loc: StoredStoreLocation = {
      lat: profile.store_lat,
      lon: profile.store_lon,
      region: profile.store_address || cached?.region,
    };
    await cacheRegisteredStore({ ...loc, bizType: profile.store_biz_type ?? undefined });
    return { ...loc, registered: true };
  }

  // 계정엔 없고 이 기기에만 있는 경우 — 예전 버전에서 가입한 계정이므로 계정으로 옮겨 준다
  if (cached) {
    try {
      await saveStoreLocation(token, { lat: cached.lat, lon: cached.lon, address: cached.region });
      return { ...cached, registered: true };
    } catch (e) {
      console.warn('기기에 저장된 매장 위치를 계정으로 옮기지 못했습니다:', e);
      return { ...cached, registered: false };
    }
  }
  return null;
}
