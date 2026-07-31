// [매장 고정 위치] 회원가입 지도 핀으로 등록한 매장 좌표를 서버(DB)에서 읽고 쓰는 창구.
//
// 왜 서버에 두는가: 예전에는 가입 기기의 AsyncStorage에만 저장해서, 다른 기기로 로그인하거나
// 앱을 다시 깔면 매장 위치가 사라지고 지도가 '기기 현위치'로 그려졌다. 사장님이 집에서 앱을
// 켜면 매장이 집으로 이사한 것처럼 보였다. 이제 위치는 계정에 붙고, 기기는 캐시만 갖는다.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiFetch } from './client';
import { STORE_LOCATION_KEY, type StoredStoreLocation } from './forecast';

// ── 매장 기본 정보 (업종·영업 시간) ────────────────────────────────
// 이 값들은 원래 기기 AsyncStorage에만 있었다. 앱을 지웠다 깔거나 다른 기기로 로그인하면
// '카페 / 09:00 / 21:00' 기본값으로 되돌아갔는데, 저장 화면은 "확정 업데이트됐어요"라고
// 말했다. 가입 화면에서 받은 운영 시간은 아예 어디에도 저장되지 않았다.
// 이제 서버(store_profiles)가 보관한다.
//
// 주의: 여기의 business_type(업종 — 카페/베이커리/음식점)은 아래 MyProfile의
// store_biz_type(상권 유형 — 오피스/대학가, 주변 카페 분석용)과 다른 값이다.

export type StoreProfile = {
  business_type: string;
  open_hour: string; // "HH:MM"
  close_hour: string; // "HH:MM"
  /** 사장님이 실제로 저장한 적이 있는가. false면 서버 값은 손대지 않은 기본값이다. */
  configured: boolean;
};

/** 내 매장 정보 조회 — 저장한 적 없으면 서버가 기본값을 만들어 돌려준다. */
export const getStoreProfile = (token: string) =>
  apiFetch<StoreProfile>('/api/v1/store/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });

/** 내 매장 정보 저장 — 보낸 항목만 갱신된다(부분 수정). */
export const updateStoreProfile = (
  token: string,
  patch: Partial<Omit<StoreProfile, 'configured'>>,
) =>
  apiFetch<StoreProfile>('/api/v1/store/profile', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });

/** 매장 정보 확정 — 계정(서버)이 원본, 기기 설정은 보조.
 *
 *  매장 위치에 쓰는 resolveStoreLocation과 같은 '1회 이전' 방식이다:
 *  1) 서버에 저장된 적이 있으면(configured) 그 값이 정답 — 기기 값을 덮어쓴다.
 *  2) 아직 없으면, 가입할 때 입력해 기기에 남아 있던 값을 서버로 올린다.
 *     (가입 화면의 운영 시간이 예전엔 여기서 그냥 버려졌다)
 *  3) 서버가 안 되면 기기 값을 그대로 쓴다 — 화면이 비어 보이진 않게.
 */
export async function resolveStoreProfile(
  token: string,
  local: { business_type: string; open_hour: string; close_hour: string },
): Promise<StoreProfile> {
  const server = await getStoreProfile(token);
  if (server.configured) return server;
  try {
    return await updateStoreProfile(token, local);
  } catch (e) {
    console.warn('기기에 있던 매장 정보를 계정으로 옮기지 못했습니다:', e);
    return { ...local, configured: false };
  }
}

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
