// c:\STUDY\SimpleM\frontend\src\auth\AuthContext.tsx
// [한글 주석] 파이어베이스 인증(Firebase Auth)과 로컬 세션(AsyncStorage)을 활용한 점주 인증 상태 관리자입니다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  updateProfile as updateFirebaseProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  onIdTokenChanged,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';

import { auth } from '../lib/firebase';
import { shouldRetryWithBackendLogin } from './loginFallback';
import { API_BASE_URL } from '../lib/api/client';
import { clearMemoryCache } from '../lib/cache';
import { unregisterFromPush } from '../notifications/pushRegistration';

// [한글 주석] 모바일 환경에서 로그인 후 브라우저 창을 닫기 위해 초기화합니다.
WebBrowser.maybeCompleteAuthSession();

// [한글 주석] isStaff — 직원 계정으로 로그인했는지.
// 화면에서 사장님 전용 항목(매출·정산·급여·환불)을 감추는 데 쓴다.
// 실제 차단은 서버가 하고(require_owner), 여기서는 안 보이게만 한다.
export type User = { email: string; name: string; photo?: string; isStaff?: boolean };
type StoredUser = User & { password?: string };

type AuthContextValue = {
  user: User | null;
  token: string | null; // [한글 주석] 백엔드 API 호출용 Firebase ID Token (Authorization: Bearer ...)
  booting: boolean;
  login: (email: string, password: string, autoLogin: boolean) => Promise<void>;
  // 직원 계정 로그인 — 아이디/비밀번호는 사장님이 발급한다
  loginAsStaff: (loginId: string, password: string, autoLogin: boolean) => Promise<void>;
  // store: 가입 2단계 지도 핀으로 확정한 매장 고정 위치 — 계정에 저장되어 기기가 바뀌어도 따라간다
  signup: (
    name: string,
    email: string,
    password: string,
    autoLogin: boolean,
    acquisitionSource?: string,
    phone?: string,
    store?: { lat?: number; lon?: number; address?: string; bizType?: string },
  ) => Promise<void>;
  loginWithGoogle: (autoLogin: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; store_name?: string; password?: string; photo?: string }) => Promise<void>;
  // Firebase Auth가 실제로 켜져 있는지 — 켜져 있으면 비밀번호 재설정은 Firebase 메일 방식이 맞다
  // (로그인이 Firebase 비밀번호를 검증하므로). 꺼져 있으면(mock) 백엔드 본인확인 방식으로 폴백.
  firebaseAuthEnabled: boolean;
  // Firebase 비밀번호 재설정 메일 발송 — 로그인이 검증하는 바로 그 비밀번호를 바꾼다.
  sendResetEmail: (email: string) => Promise<void>;
};

const SESSION_KEY = 'simplem:session'; // [한글 주석] 자동 로그인 체크 시 로컬에 저장할 세션 키

// [한글 주석] 모바일 구글 로그인 브리지 페이지가 배포된 웹 주소 (Firebase 승인 도메인이어야 함)
const WEB_APP_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ||
  'https://brewnote-web-915817944047.asia-northeast3.run.app';

const AuthContext = createContext<AuthContextValue | null>(null);

// JWT의 exp(만료 시각)를 확인한다 — 백엔드 토큰은 24시간 유효라서,
// 자동 로그인으로 복원한 토큰이 이미 죽어 있으면 모든 API가 401을 뱉는다.
// 디코드 실패(구버전 토큰 등)도 만료로 취급해 재로그인을 유도한다.
function isTokenExpired(token: string): boolean {
  try {
    const payloadPart = token.split('.')[1];
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      Array.from(atob(base64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
    );
    const { exp } = JSON.parse(json) as { exp?: number };
    if (!exp) return false; // exp 없는 토큰은 만료 개념이 없으므로 통과
    return exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // 토큰 자동 갱신 콜백에서 "지금 로그인된 상태인가"를 최신 값으로 읽기 위한 참조
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  // [한글 주석] 자동 로그인 여부에 따라 디스크에 세션을 남기거나 지웁니다.
  const persistSession = useCallback(async (u: User & { token: string }, autoLogin: boolean) => {
    // 복원할 수 없는 토큰은 아예 저장하지 않는다.
    //
    // 백엔드가 안 뜬 상태로 로그인하면 아래 데모 폴백이 'demo-local-access-token-owner-cafe'
    // 같은 JWT가 아닌 문자열을 토큰으로 넘긴다. 그걸 저장해두면 다음 실행 때 isTokenExpired가
    // (파싱 실패 → 만료로 간주) 세션을 지워버려서, 사장님 눈에는 "자동 로그인이 안 된다"로 보인다.
    // 게다가 그 토큰은 백엔드가 401로 거절하므로 억지로 복원해봐야 모든 API가 실패한다.
    // 저장 시점에 한 번 걸러두면 이 상태 자체가 만들어지지 않는다.
    if (autoLogin && !isTokenExpired(u.token)) {
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
      return;
    }
    if (autoLogin && __DEV__) {
      console.warn(
        '[auth] 자동 로그인 저장을 건너뜁니다 — 복원 불가능한 토큰. ' +
          '백엔드 로그인이 실패해 데모 세션으로 우회했는지 확인하세요 (백엔드 실행 및 --host 0.0.0.0).',
      );
    }
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  // [로그인 속도] 백엔드 프로필 동기화(Lazy Signup 유도)는 로그인 완료를 막지 않는다.
  // Neon DB 콜드스타트 탓에 이 요청이 수 초 걸릴 수 있는데, 예전엔 이걸 await로 기다려
  // 로그인 버튼이 몇 초씩 멈춰 있었다. 실패해도 다음 API 호출의 get_current_user가
  // 어차피 Lazy Signup을 다시 수행하므로 백그라운드 전송으로 충분하다.
  const syncProfileInBackground = useCallback((idToken: string, name: string) => {
    fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      // store_name은 보내지 않는다 — 여기서 `${name} 매장`을 매번 보내면, 사장님이
      // 프로필에서 바꾼 상호명이 다음 로그인 때마다 기본값으로 되돌아간다 (상호명으로
      // 아이디 찾기도 같이 깨진다). 기본 상호명은 백엔드 Lazy Signup이 최초 1회 채운다.
      body: JSON.stringify({
        name,
      }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn('백엔드 계정 동기화 경고: 회원 정보가 완전하게 연동되지 않았을 수 있습니다.');
        }
      })
      .catch(() => {
        console.warn('백엔드 계정 동기화 경고: 회원 정보가 완전하게 연동되지 않았을 수 있습니다.');
      });
  }, []);

  // [토큰 자동 갱신] Firebase는 ID 토큰(약 1시간 만료)을 백그라운드에서 자동 갱신한다.
  // 그 변경을 구독해 앱이 들고 있는 토큰과 저장된 세션을 항상 최신으로 유지 → 한 시간 뒤 401 방지.
  //
  // [주의] 로그인 화면(user === null)에서는 토큰을 심지 않는다.
  // Firebase는 자동 로그인을 꺼도 기기에 자체 세션을 남기기 때문에, 앱을 다시 켰을 때
  // 이 콜백이 살아있는 토큰을 꽂아 넣곤 했다. 그러면 로그인도 안 했는데 알림 감시자가
  // 돌면서 재고 부족·리포트 토스트가 로그인 화면 위로 튀어나온다.
  useEffect(() => {
    if (!auth) return;
    const unsub = onIdTokenChanged(auth, async (fbUser) => {
      if (!fbUser) return; // Firebase 사용자 없음(로그아웃/백엔드 데모 로그인)엔 관여하지 않는다
      if (!userRef.current) return; // 앱 세션이 없는 상태(로그인 화면) — 토큰을 되살리지 않는다
      try {
        const fresh = await fbUser.getIdToken(); // 만료 임박이면 갱신된 새 토큰을 돌려준다
        setToken(fresh);
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          saved.token = fresh;
          await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(saved));
        }
      } catch {
        // 갱신 실패는 무시 — 다음 변경 이벤트에 재시도
      }
    });
    return unsub;
  }, []);

  // [한글 주석] 앱 구동 시 로컬 저장소에서 세션을 읽어 자동 로그인을 복원합니다.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as User & { token?: string };
          if (saved.token && !isTokenExpired(saved.token)) {
            // [한글 주석] isStaff를 반드시 함께 복원한다.
            // 빠뜨리면 직원으로 로그인해도 새로고침 한 번에 사장님 화면으로 돌아가
            // 매출·정산 카드가 다시 보인다(서버는 막지만 화면이 어긋난다).
            setUser({
              email: saved.email, name: saved.name, photo: saved.photo,
              isStaff: saved.isStaff,
            });
            setToken(saved.token);
          } else {
            // 토큰이 없거나 만료됨 — 로그인된 척하다가 API마다 401 나는 것보다
            // 세션을 지우고 로그인 화면으로 보내는 게 낫다
            await AsyncStorage.removeItem(SESSION_KEY);
          }
        }
      } catch (err) {
        console.error('세션 복원 실패:', err);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // [한글 주석] Mock 모드 소셜 로그인용: 백엔드 데모 계정으로 진짜 JWT를 발급받는다.
  // 예전엔 'mock-google-session-jwt-token' 같은 가짜 문자열을 토큰으로 저장했는데,
  // 백엔드가 검증하지 못해 로그인 직후 모든 API가 401로 죽었다. 반드시 진짜 토큰을 받아야 한다.
  const loginWithBackendDemo = useCallback(
    async (email: string, name: string, password: string, autoLogin: boolean) => {
      // [로그인 속도] 로그인부터 먼저 시도한다 — 데모 계정은 최초 1회 이후엔 항상 존재하므로
      // 매번 signup→login 2회 왕복하던 것을 보통 1회 왕복으로 줄인다.
      const tryLogin = () =>
        fetch(`${API_BASE_URL}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

      let res = await tryLogin();

      // 401(계정 없음)일 때만 가입 후 한 번 더 로그인한다
      if (res.status === 401) {
        try {
          await fetch(`${API_BASE_URL}/api/v1/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name, store_name: `${name} 매장` }),
          });
        } catch {
          // 네트워크 오류는 아래 재로그인에서 다시 드러나므로 여기선 무시
        }
        res = await tryLogin();
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.detail || '데모 소셜 로그인에 실패했습니다. 백엔드 서버가 켜져 있는지 확인해 주세요.');
      }
      const data = await res.json();
      const u = { email: data.email, name: data.name, token: data.access_token };
      setUser({ email: u.email, name: u.name });
      setToken(u.token);
      await persistSession(u, autoLogin);
    },
    [persistSession]
  );

  // [한글 주석] 백엔드 자체 로그인(/auth/login) — 백엔드 DB에만 있는 계정용.
  // 백엔드가 돌려주는 HS256 토큰은 get_current_user가 Firebase 토큰과 똑같이 받아 준다.
  const loginViaBackend = useCallback(
    async (cleanEmail: string, password: string, autoLogin: boolean) => {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        let errMsg = '이메일 또는 비밀번호가 일치하지 않습니다.';
        if (typeof errData.detail === 'string') {
          errMsg = errData.detail;
        } else if (Array.isArray(errData.detail) && errData.detail[0]?.msg) {
          errMsg = errData.detail[0].msg;
        }
        throw new Error(errMsg);
      }

      const data = await res.json();
      const u = { email: data.email, name: data.name, token: data.access_token };
      setUser({ email: u.email, name: u.name });
      setToken(u.token);
      await persistSession(u, autoLogin);
    },
    [persistSession],
  );

  // [한글 주석] Firebase Auth를 통해 사용자를 인증하고 ID Token을 획득하여 백엔드와 동기화합니다.
  // 가짜 Firebase 키 상황일 경우 백엔드 자체 로컬 인증 API로 즉시 우회합니다.
  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      const cleanEmail = email.trim().toLowerCase();

      // [한글 주석] auth는 실제 Firebase 키가 있을 때만 non-null (lib/firebase.ts).
      // 'mock-'/'demo-' 키나 키 없음이면 백엔드 자체 인증만 쓴다.
      if (!auth) {
        await loginViaBackend(cleanEmail, password, autoLogin);
        return;
      }

      try {
        // 1. Firebase Auth를 통한 이메일/비밀번호 로그인 처리
        const userCredential = await signInWithEmailAndPassword(
          auth,
          cleanEmail,
          password
        );
        const fbUser = userCredential.user;

        // 2. 백엔드 통신 및 인증에 사용할 ID Token(구글 공개키로 검증 가능한 서명 토큰) 획득
        const idToken = await fbUser.getIdToken();
        const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '사장님';

        const u = {
          email: fbUser.email || email,
          name: userName,
          token: idToken,
        };

        // 3. 즉시 로그인 완료 처리 — 백엔드 동기화를 기다리지 않아 화면 전환이 바로 일어난다
        setUser({ email: u.email, name: u.name });
        setToken(idToken);
        await persistSession(u, autoLogin);

        // 4. 백엔드 DB 회원 연동(Lazy Signup 유도)은 백그라운드에서 진행
        syncProfileInBackground(idToken, userName);

      } catch (error: any) {
        // [핵심] Firebase가 거절했다고 로그인을 포기하면 안 된다.
        //
        // 계정이 사는 곳이 두 군데다. 앱에서 가입하면 Firebase에 생기지만,
        // 데모/시드 계정(owner@cafe.com)과 백엔드 /auth/signup으로 만든 계정은
        // 백엔드 DB에만 있다. 예전엔 이 경로에서 Firebase만 물어보고 끝내서,
        // DB에 멀쩡히 있는 계정이 비밀번호를 맞게 넣어도 "일치하지 않습니다"만 떴다.
        // Firebase가 자격증명 문제로 막았을 때는 백엔드 로그인을 한 번 더 두드린다.
        if (shouldRetryWithBackendLogin(error?.code)) {
          try {
            await loginViaBackend(cleanEmail, password, autoLogin);
            return;
          } catch {
            // 백엔드에도 없는 계정 — 아래 Firebase 기준 안내 문구로 떨어진다
          }
        }

        // Firebase 에러 코드를 한글 메시지로 친절하게 반환합니다.
        let msg = '로그인 중 오류가 발생했습니다.';
        if (
          error.code === 'auth/user-not-found' ||
          error.code === 'auth/wrong-password' ||
          error.code === 'auth/invalid-credential' ||
          error.code === 'auth/invalid-login-credentials'
        ) {
          msg = '이메일 또는 비밀번호가 일치하지 않습니다.';
        } else if (error.code === 'auth/invalid-email') {
          msg = '유효하지 않은 이메일 형식입니다.';
        } else if (error.code === 'auth/too-many-requests') {
          msg = '로그인 시도가 너무 많았어요. 잠시 후 다시 시도해 주세요.';
        } else if (error.code === 'auth/network-request-failed') {
          msg = '네트워크 연결을 확인해 주세요.';
        }
        throw new Error(msg);
      }
    },
    [persistSession, syncProfileInBackground, loginViaBackend]
  );

  // [한글 주석] Firebase Auth로 계정을 최초 생성하고 닉네임을 설정합니다.
  // 가짜 Firebase 키 상황일 경우 백엔드 자체 로컬 회원가입 API로 즉시 우회합니다.
  const signup = useCallback(
    async (
      name: string,
      email: string,
      password: string,
      autoLogin: boolean,
      acquisitionSource?: string,
      phone?: string,
      store?: { lat?: number; lon?: number; address?: string; bizType?: string },
    ) => {
      // [한글 주석] 판단 기준을 lib/firebase.ts 한 곳으로 모은다 — 'demo-' 키를 여기서만
      // 놓쳐서 auth(null)로 Firebase를 호출하는 사고를 막는다.
      const isMockFirebase = !auth;

      // [매장 고정 위치] 좌표는 짝으로만 의미가 있다 — 한쪽만 있으면 보내지 않는다
      const hasPin = typeof store?.lat === 'number' && typeof store?.lon === 'number';
      const storePayload = hasPin
        ? {
            store_lat: store!.lat,
            store_lon: store!.lon,
            ...(store!.address ? { store_address: store!.address } : {}),
            ...(store!.bizType ? { store_biz_type: store!.bizType } : {}),
          }
        : {};

      if (isMockFirebase) {
        try {
          // [한글 주석: 가짜 키 상태이므로 백엔드의 로컬 회원가입 API를 호출하여 즉시 DB 등록을 요청합니다]
          const res = await fetch(`${API_BASE_URL}/api/v1/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email.trim().toLowerCase(),
              password,
              name: name.trim(),
              store_name: `${name.trim()} 매장`,
              // 휴대폰 번호 — 아이디/비밀번호 찾기 본인 확인용 (선택)
              ...(phone ? { phone } : {}),
              // [유입 경로] 선택값 — 미선택 시 전송하지 않아 백엔드가 NULL로 저장(추정 폴백)
              ...(acquisitionSource ? { acquisition_source: acquisitionSource } : {}),
              // [매장 고정 위치] 가입 지도 핀 — 이후 모든 매장 지도가 이 좌표로 고정된다
              ...storePayload,
            }),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            let errMsg = '회원가입 요청에 실패했습니다.';
            if (typeof errData.detail === 'string') {
              errMsg = errData.detail;
            } else if (Array.isArray(errData.detail) && errData.detail[0]?.msg) {
              errMsg = errData.detail[0].msg;
            }
            throw new Error(errMsg);
          }

          // 가입에 성공했다면 즉시 로컬 연계 로그인 기능 호출
          await login(email, password, autoLogin);
          return;
        } catch (error: any) {
          throw new Error(error.message || '로컬 회원가입 중 오류가 발생했습니다.');
        }
      }

      try {
        // 1. Firebase Auth 상에 회원 계정 생성
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          email.trim().toLowerCase(),
          password
        );

        // 2. Firebase 프로필의 닉네임(displayName) 설정
        await updateFirebaseProfile(userCredential.user, {
          displayName: name.trim(),
        });

        // 3. 가입 즉시 로그인을 진행하여 토큰 획득 및 백엔드 데이터베이스 동기화(Lazy Signup) 유도
        await login(email, password, autoLogin);

        // 4. 휴대폰 번호와 매장 고정 위치는 Firebase 계정에 없는 정보라 백엔드 프로필에 별도로 심는다.
        //    (휴대폰 = 아이디/비번 찾기용, 매장 위치 = 매장 지도·상권 분석 기준점)
        //    실패해도 가입은 이미 끝났으므로 배경 전송으로 충분하다.
        const extraPatch = { ...(phone ? { phone } : {}), ...storePayload };
        if (Object.keys(extraPatch).length > 0) {
          userCredential.user.getIdToken().then((idToken) =>
            fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
              body: JSON.stringify(extraPatch),
            }),
          ).catch(() => {
            console.warn('가입 부가정보(휴대폰·매장 위치) 동기화 경고: 프로필 화면에서 다시 등록할 수 있습니다.');
          });
        }

      } catch (error: any) {
        let msg = '회원가입 중 오류가 발생했습니다.';
        if (error.code === 'auth/email-already-in-use') {
          msg = '이미 등록된 이메일 주소입니다. 다른 이메일을 사용해 주세요.';
        } else if (error.code === 'auth/weak-password') {
          msg = '비밀번호가 너무 취약합니다. 6자리 이상으로 작성해 주세요.';
        } else if (error.code === 'auth/invalid-email') {
          msg = '유효하지 않은 이메일 형식입니다.';
        }
        throw new Error(msg);
      }
    },
    [login]
  );

  // [한글 주석] 구글 계정을 이용한 소셜 로그인을 처리합니다. (Mock 모드 지원)
  // [한글 주석] 직원 계정 로그인.
  // 서버가 주는 토큰의 sub에는 '매장(사장님) 이메일'이 담겨 있어
  // 기존 API가 매장을 그대로 인식한다. 여기서는 화면 표시용으로 이름만 받는다.
  const loginAsStaff = useCallback(
    async (loginId: string, password: string, autoLogin: boolean) => {
      const res = await fetch(`${API_BASE_URL}/api/v1/staff-accounts/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login_id: loginId, password }),
      });
      if (!res.ok) {
        let detail = '아이디 또는 비밀번호가 올바르지 않습니다.';
        try {
          const body = await res.json();
          if (typeof body?.detail === 'string') detail = body.detail;
        } catch {
          // 본문 파싱 실패는 기본 메시지로 둔다
        }
        throw new Error(detail);
      }
      const data = await res.json();
      const idToken: string = data.access_token;

      // 이메일은 매장 식별자라 직원에게 보여줄 값이 아니다 — 이름만 쓴다
      const u: User = { email: '', name: data.name ?? '직원', isStaff: true };
      setUser(u);
      setToken(idToken);
      await persistSession({ ...u, token: idToken }, autoLogin);
    },
    [persistSession],
  );

  const loginWithGoogle = useCallback(
    async (autoLogin: boolean) => {
      const isMockFirebase = !auth;

      // [한글 주석] Mock 모드일 때는 백엔드 로컬 인증으로 전용 데모 계정에 진짜 토큰을 발급받아 우회 로그인합니다.
      // (하드코딩된 owner 계정 대신 데모 계정 자동 가입 방식 — 비밀번호 불일치로 죽지 않는다.
      //  이메일은 백엔드 EmailStr 검증을 통과해야 하므로 ASCII만 사용)
      if (isMockFirebase) {
        await loginWithBackendDemo('google-demo@test.com', '구글사장님', 'demo-social-1234', autoLogin);
        return;
      }

      if (!auth) throw new Error('Firebase가 초기화되지 않았습니다.');

      if (Platform.OS !== 'web') {
        // [모바일 구글 로그인 — 브리지 방식]
        // 예전 expo-auth-session 직접 호출은 client_id 미설정 + 폐쇄된 auth.expo.io 프록시 탓에
        // 구글이 400을 뱉었다. 대신 Firebase 승인 도메인인 우리 웹(brewnote-web)의
        // 브리지 페이지를 커스텀 탭으로 열고, 거기서 구글 로그인 후 딥링크로 id_token을 돌려받는다.
        // → 구글/파이어베이스 콘솔에 아무것도 추가 등록할 필요가 없다.
        const returnUrl = AuthSession.makeRedirectUri({ scheme: 'simplem', path: 'google-auth' });
        // [한글 주석] public/serve.json이 cleanUrls를 꺼둔 상태라 .html 경로가 리디렉션 없이(쿼리 보존) 그대로 서빙된다
        const bridgeUrl = `${WEB_APP_BASE_URL}/google-auth-bridge.html?return=${encodeURIComponent(returnUrl)}`;

        const session = await WebBrowser.openAuthSessionAsync(bridgeUrl, returnUrl);
        if (session.type !== 'success' || !session.url) {
          throw new Error('구글 로그인이 취소되었거나 실패했습니다.');
        }

        // [한글 주석] RN의 URLSearchParams 구현이 불완전할 수 있어 정규식으로 직접 파싱한다.
        const errMatch = /[#?&]error=([^&]+)/.exec(session.url);
        if (errMatch) {
          throw new Error(decodeURIComponent(errMatch[1]));
        }
        const tokenMatch = /[#?&]id_token=([^&]+)/.exec(session.url);
        if (!tokenMatch) {
          throw new Error('구글 인증 정보를 받지 못했습니다. 다시 시도해 주세요.');
        }
        const googleIdToken = decodeURIComponent(tokenMatch[1]);

        try {
          // [한글 주석] 돌려받은 구글 id_token으로 이 기기의 Firebase 세션을 정식 개설한다 (토큰 자동 갱신 유지)
          const credential = GoogleAuthProvider.credential(googleIdToken);
          const result = await signInWithCredential(auth, credential);
          const fbUser = result.user;
          const idToken = await fbUser.getIdToken();
          const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '구글사장님';

          const u = {
            email: fbUser.email || 'google-사장님@test.com',
            name: userName,
            token: idToken,
          };

          // 즉시 로그인 완료 — 백엔드 프로필 동기화는 백그라운드로
          setUser({ email: u.email, name: u.name });
          setToken(idToken);
          await persistSession(u, autoLogin);
          syncProfileInBackground(idToken, userName);
        } catch (err: any) {
          console.error('모바일 구글 로그인 후 처리 실패:', err);
          throw new Error(err.message || '구글 로그인 중 오류가 발생했습니다.');
        }
        return;
      }

      try {
        const provider = new GoogleAuthProvider();
        // 팝업 창을 띄워 구글 로그인 시도
        const result = await signInWithPopup(auth, provider);
        const fbUser = result.user;
        const idToken = await fbUser.getIdToken();
        const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '구글사장님';

        const u = {
          email: fbUser.email || 'google-사장님@test.com',
          name: userName,
          token: idToken,
        };

        // 즉시 로그인 완료 — 백엔드 프로필 동기화는 백그라운드로
        setUser({ email: u.email, name: u.name });
        setToken(idToken);
        await persistSession(u, autoLogin);
        syncProfileInBackground(idToken, userName);
      } catch (err: any) {
        console.error('구글 로그인 실패:', err);
        throw new Error(err.message || '구글 로그인 중 오류가 발생했습니다.');
      }
    },
    [persistSession, loginWithBackendDemo, syncProfileInBackground]
  );

  // [한글 주석: 로그아웃 시 Firebase 세션을 끊고 로컬 저장소(AsyncStorage)의 모든 데이터를 완전 초기화 파기합니다]
  const logout = useCallback(async () => {
    // 푸시 토큰 해제를 '가장 먼저' — 토큰을 지운 뒤엔 인증 헤더를 못 만든다.
    // 이걸 빠뜨리면 로그아웃해도 서버의 device_tokens 행이 남아 이전 사장님의 알림이
    // 이 기기로 계속 간다 (다음 로그인 때 소유자가 옮겨질 때까지).
    if (token) await unregisterFromPush(token);

    try {
      // Firebase 미초기화(키 없음) 시 auth 는 null — 백엔드 우회 모드이므로 건너뛴다.
      if (auth) await signOut(auth);
    } catch (err) {
      console.error('Firebase 로그아웃 실패:', err);
    }
    setUser(null);
    setToken(null);
    // [한글 주석: 다른 계정으로 로그인할 때 영수증, 임시 노트, 캐시 등 이전 사용자의 로컬 데이터가 남아있지 않도록 전체 삭제]
    // 화면 데이터 캐시는 디스크(AsyncStorage.clear)와 메모리 사본을 함께 비워야
    // 다른 사장님 계정으로 바꿔 로그인했을 때 이전 매장 숫자가 잠깐 스치지 않는다.
    clearMemoryCache();
    await AsyncStorage.clear();
  }, [token]);

  // [한글 주석] 로그인된 점주님의 정보(이름/비밀번호)를 Firebase 및 백엔드 데이터베이스에 동시 갱신합니다.
  const updateProfile = useCallback(
    async (patch: { name?: string; store_name?: string; password?: string; photo?: string }) => {
      if (!user || !token) return;

      try {
        // Firebase 미초기화(키 없음) 시 auth 는 null 이므로 currentUser 도 없다.
        const currentUser = auth ? auth.currentUser : null;

        // 1. 이름 변경 시 Firebase 인증 프로필 정보 갱신
        if (patch.name && currentUser) {
          await updateFirebaseProfile(currentUser, {
            displayName: patch.name.trim(),
          });
        }

        // 2. 백엔드 데이터베이스 프로필 수정 API 호출 (토큰을 통해 매핑된 회원 레코드 수정)
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: patch.name?.trim() ? patch.name.trim() : undefined,
            password: patch.password ? patch.password : undefined,
            // 상호(store_name)는 이름과 독립적으로 수정 — 넘어온 경우에만 반영
            store_name: patch.store_name?.trim() ? patch.store_name.trim() : undefined,
          }),
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.detail || '프로필 수정 요청에 실패했습니다.');
        }

        const data = await response.json();
        // 기존 user를 펼쳐 isStaff 같은 부가 필드를 보존한다 — 새로 조립하면 직원
        // 세션이 프로필 수정 한 번에 사장님 모드 UI로 뒤집혔다.
        const updated: User = {
          ...user,
          email: data.email,
          name: data.name,
          photo: patch.photo !== undefined ? patch.photo : user.photo,
        };

        // 3. 로컬 상태 및 AsyncStorage 갱신
        setUser(updated);

        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const prev = JSON.parse(raw);
          await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ ...prev, ...updated }));
        }
      } catch (err: any) {
        throw new Error(err.message || '프로필 수정 중 오류가 발생했습니다.');
      }
    },
    [user, token]
  );

  // auth는 실제 Firebase 키가 있을 때만 non-null (lib/firebase.ts). 로그인이 Firebase 비밀번호를
  // 검증하므로, 재설정도 Firebase 메일 방식이어야 로그인이 보는 비밀번호가 실제로 바뀐다.
  const firebaseAuthEnabled = !!auth;

  // 비밀번호 재설정 메일 발송. 계정 존재 여부가 새어나가지 않도록 계정 없음도 조용히 성공 처리.
  //  1) 백엔드 커스텀 메일 우선 — 서버에 서비스계정+SMTP가 설정돼 있으면 우리 문구·디자인 메일이 나간다.
  //  2) 미설정(503)/실패면 Firebase 기본 재설정 메일로 폴백 — 어느 경우든 재설정은 동작한다.
  const sendResetEmail = useCallback(async (email: string) => {
    const clean = email.trim().toLowerCase();
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/reset-password-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: clean }),
      });
      if (res.ok) return; // 커스텀 메일 발송(또는 계정없음 → 조용히 성공)
      // 503(미설정) 등 → 아래 Firebase 기본 메일로 폴백
    } catch {
      // 네트워크 실패 → 폴백
    }

    if (!auth) throw new Error('이 환경에서는 이메일 재설정을 쓸 수 없습니다.');
    try {
      await sendPasswordResetEmail(auth, clean);
    } catch (e: any) {
      if (e?.code === 'auth/user-not-found') return; // 이메일 열거 방지
      if (e?.code === 'auth/invalid-email') throw new Error('유효하지 않은 이메일 형식입니다.');
      throw new Error('재설정 메일 발송에 실패했어요. 잠시 후 다시 시도해 주세요.');
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        booting,
        login,
        signup,
        loginAsStaff,
      loginWithGoogle,
        logout,
        updateProfile,
        firebaseAuthEnabled,
        sendResetEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

