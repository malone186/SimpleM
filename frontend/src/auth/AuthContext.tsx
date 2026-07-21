// c:\STUDY\SimpleM\frontend\src\auth\AuthContext.tsx
// [한글 주석] 파이어베이스 인증(Firebase Auth)과 로컬 세션(AsyncStorage)을 활용한 점주 인증 상태 관리자입니다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile as updateFirebaseProfile,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithCredential,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';

import { auth } from '../lib/firebase';
import { API_BASE_URL } from '../lib/api/client';

// [한글 주석] 모바일 환경에서 로그인 후 브라우저 창을 닫기 위해 초기화합니다.
WebBrowser.maybeCompleteAuthSession();

export type User = { email: string; name: string; photo?: string };
type StoredUser = User & { password?: string };

type AuthContextValue = {
  user: User | null;
  token: string | null; // [한글 주석] 백엔드 API 호출용 Firebase ID Token (Authorization: Bearer ...)
  booting: boolean;
  login: (email: string, password: string, autoLogin: boolean) => Promise<void>;
  signup: (name: string, email: string, password: string, autoLogin: boolean) => Promise<void>;
  loginWithGoogle: (autoLogin: boolean) => Promise<void>;
  loginWithApple: (autoLogin: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; store_name?: string; password?: string; photo?: string }) => Promise<void>;
};

const SESSION_KEY = 'simplem:session'; // [한글 주석] 자동 로그인 체크 시 로컬에 저장할 세션 키

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
  const [socialAutoLogin, setSocialAutoLogin] = useState(true);

  // [한글 주석] 구글이 허용하는 리디렉션 주소를 생성합니다. (exp:// 로컬 주소가 나오면 아래에서 HTTPS 프록시로 강제 우회)
  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'simplem',
  });

  // [한글 주석] 일부 환경에서 여전히 로컬 사설 주소(exp://)가 반환될 경우, 구글 400 에러를 방지하기 위해 강제로 정식 HTTPS 프록시 주소로 우회 처리합니다.
  const finalRedirectUri = redirectUri.startsWith('exp://')
    ? 'https://auth.expo.io/@anonymous/frontend'
    : redirectUri;

  // [한글 주석] 구글 콘솔 등록을 위해 현재 앱이 생성한 리디렉션 URI 주소를 터미널 로그에 인쇄합니다.
  useEffect(() => {
    console.log('🔗 [Google 소셜 로그인 리디렉션 URI]:', finalRedirectUri);
  }, [finalRedirectUri]);

  // [한글 주석] expo-auth-session을 이용해 모바일 환경에서의 Google 소셜 로그인 요청을 세팅합니다.
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      redirectUri: finalRedirectUri,
      scopes: ['openid', 'profile', 'email'],
      responseType: 'id_token',
    },
    {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    }
  );

  // [한글 주석] 자동 로그인 여부에 따라 디스크에 세션을 남기거나 지웁니다.
  const persistSession = useCallback(async (u: User & { token: string }, autoLogin: boolean) => {
    if (autoLogin) {
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
    } else {
      await AsyncStorage.removeItem(SESSION_KEY);
    }
  }, []);

  // [한글 주석] 모바일 Google 로그인 성공 시 웹뷰로부터 인증 정보(id_token)를 받아와 처리합니다.
  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params;
      (async () => {
        try {
          if (!auth) throw new Error('Firebase가 초기화되지 않았습니다.');
          const credential = GoogleAuthProvider.credential(id_token);
          const result = await signInWithCredential(auth, credential);
          const fbUser = result.user;
          const idToken = await fbUser.getIdToken();
          const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '구글사장님';

          // 백엔드 프로필 동기화
          const res = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              name: userName,
              store_name: `${userName} 매장`,
            }),
          });

          if (!res.ok) {
            console.warn('백엔드 계정 동기화 경고: 소셜 회원 연동이 완전하지 않을 수 있습니다.');
          }

          const u = {
            email: fbUser.email || 'google-사장님@test.com',
            name: userName,
            token: idToken,
          };

          setUser({ email: u.email, name: u.name });
          setToken(idToken);
          await persistSession(u, socialAutoLogin);
        } catch (err) {
          console.error('모바일 구글 로그인 후 처리 실패:', err);
        }
      })();
    }
  }, [response, persistSession, socialAutoLogin]);

  // [한글 주석] 앱 구동 시 로컬 저장소에서 세션을 읽어 자동 로그인을 복원합니다.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as User & { token?: string };
          if (saved.token && !isTokenExpired(saved.token)) {
            setUser({ email: saved.email, name: saved.name, photo: saved.photo });
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
      // 1) 데모 계정이 없으면 가입시킨다 (이미 있으면 400 — 무시하고 로그인으로 진행)
      try {
        await fetch(`${API_BASE_URL}/api/v1/auth/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name, store_name: `${name} 매장` }),
        });
      } catch {
        // 네트워크 오류는 아래 로그인에서 다시 드러나므로 여기선 무시
      }

      // 2) 로그인해서 백엔드가 서명한 진짜 토큰을 받는다
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
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

  // [한글 주석] Firebase Auth를 통해 사용자를 인증하고 ID Token을 획득하여 백엔드와 동기화합니다.
  // 가짜 Firebase 키 상황일 경우 백엔드 자체 로컬 인증 API로 즉시 우회합니다.
  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '';
      // [한글 주석] 'mock-' 또는 'demo-' 키일 경우 파이어베이스가 아닌 백엔드 자체 인증으로 우회합니다.
      const isMockFirebase =
        FIREBASE_API_KEY.startsWith('mock-') ||
        FIREBASE_API_KEY.startsWith('demo-') ||
        !FIREBASE_API_KEY;

      if (isMockFirebase) {
        try {
          // [한글 주석: 가짜 키 상태이므로 백엔드의 로컬 로그인 API 창구를 노크하여 전용 토큰을 얻어옵니다]
          const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
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
          const u = {
            email: data.email,
            name: data.name,
            token: data.access_token,
          };

          // 로컬 환경 상태값 세팅 및 세션 영구 보관
          setUser({ email: u.email, name: u.name });
          setToken(u.token);
          await persistSession(u, autoLogin);
          return;
        } catch (error: any) {
          throw new Error(error.message || '로컬 로그인 중 오류가 발생했습니다.');
        }
      }

      try {
        // 1. Firebase Auth를 통한 이메일/비밀번호 로그인 처리
        const userCredential = await signInWithEmailAndPassword(
          auth,
          email.trim().toLowerCase(),
          password
        );
        const fbUser = userCredential.user;

        // 2. 백엔드 통신 및 인증에 사용할 ID Token(구글 공개키로 검증 가능한 서명 토큰) 획득
        const idToken = await fbUser.getIdToken();
        const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '사장님';

        // 3. 백엔드 DB와 회원 연동(Lazy Signup 유도)을 위해 백엔드 API 호출
        // 빈 패치(PATCH) 정보를 보내 사용자 정보를 백엔드와 동기화시킵니다.
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            name: userName,
            store_name: `${userName} 매장`,
          }),
        });

        if (!response.ok) {
          console.warn('백엔드 계정 동기화 경고: 회원 정보가 완전하게 연동되지 않았을 수 있습니다.');
        }

        const u = {
          email: fbUser.email || email,
          name: userName,
          token: idToken,
        };

        // 4. 로컬 상태 값 업데이트 및 영구 보관 설정
        setUser({ email: u.email, name: u.name });
        setToken(idToken);
        await persistSession(u, autoLogin);

      } catch (error: any) {
        // Firebase 에러 코드를 한글 메시지로 친절하게 반환합니다.
        let msg = '로그인 중 오류가 발생했습니다.';
        if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
          msg = '이메일 또는 비밀번호가 일치하지 않습니다.';
        } else if (error.code === 'auth/invalid-email') {
          msg = '유효하지 않은 이메일 형식입니다.';
        }
        throw new Error(msg);
      }
    },
    [persistSession]
  );

  // [한글 주석] Firebase Auth로 계정을 최초 생성하고 닉네임을 설정합니다.
  // 가짜 Firebase 키 상황일 경우 백엔드 자체 로컬 회원가입 API로 즉시 우회합니다.
  const signup = useCallback(
    async (name: string, email: string, password: string, autoLogin: boolean) => {
      const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '';
      const isMockFirebase = FIREBASE_API_KEY.startsWith('mock-') || !FIREBASE_API_KEY;

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
  const loginWithGoogle = useCallback(
    async (autoLogin: boolean) => {
      const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '';
      const isMockFirebase = FIREBASE_API_KEY.startsWith('mock-') || !FIREBASE_API_KEY;

      // [한글 주석] Mock 모드일 때는 백엔드 로컬 인증으로 전용 데모 계정에 진짜 토큰을 발급받아 우회 로그인합니다.
      // (하드코딩된 owner 계정 대신 데모 계정 자동 가입 방식 — 비밀번호 불일치로 죽지 않는다.
      //  이메일은 백엔드 EmailStr 검증을 통과해야 하므로 ASCII만 사용)
      if (isMockFirebase) {
        await loginWithBackendDemo('google-demo@test.com', '구글사장님', 'demo-social-1234', autoLogin);
        return;
      }

      if (Platform.OS !== 'web') {
        // [한글 주석] 모바일 환경일 경우 AuthSession의 promptAsync를 호출하여 웹 브라우저를 엽니다.
        setSocialAutoLogin(autoLogin);
        if (request) {
          const result = await promptAsync();
          if (result.type !== 'success') {
            throw new Error('구글 로그인이 취소되었거나 실패했습니다.');
          }
        } else {
          throw new Error('구글 로그인 요청이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        }
        return;
      }

      if (!auth) throw new Error('Firebase가 초기화되지 않았습니다.');

      try {
        const provider = new GoogleAuthProvider();
        // 팝업 창을 띄워 구글 로그인 시도
        const result = await signInWithPopup(auth, provider);
        const fbUser = result.user;
        const idToken = await fbUser.getIdToken();
        const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '구글사장님';

        // 백엔드 프로필 동기화
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            name: userName,
            store_name: `${userName} 매장`,
          }),
        });

        if (!response.ok) {
          console.warn('백엔드 계정 동기화 경고: 소셜 회원 연동이 완전하지 않을 수 있습니다.');
        }

        const u = {
          email: fbUser.email || 'google-사장님@test.com',
          name: userName,
          token: idToken,
        };

        setUser({ email: u.email, name: u.name });
        setToken(idToken);
        await persistSession(u, autoLogin);
      } catch (err: any) {
        console.error('구글 로그인 실패:', err);
        throw new Error(err.message || '구글 로그인 중 오류가 발생했습니다.');
      }
    },
    [persistSession, loginWithBackendDemo, request, promptAsync]
  );

  // [한글 주석] 애플 계정을 이용한 소셜 로그인을 처리합니다. (Mock 모드 지원)
  const loginWithApple = useCallback(
    async (autoLogin: boolean) => {
      const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '';
      const isMockFirebase = FIREBASE_API_KEY.startsWith('mock-') || !FIREBASE_API_KEY;

      if (isMockFirebase) {
        // [한글 주석] Mock 모드일 때는 백엔드 로컬 인증으로 데모 계정에 진짜 토큰을 발급받습니다.
        await loginWithBackendDemo('apple-demo@test.com', '애플사장님', 'demo-social-1234', autoLogin);
        return;
      }

      if (Platform.OS !== 'web') {
        // [한글 주석] 모바일 환경에서는 expo-apple-authentication을 이용해 기기 자체의 네이티브 Apple 로그인 창을 호출합니다.
        try {
          const appleCredential = await AppleAuthentication.signInAsync({
            requestedScopes: [
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
          });

          if (!appleCredential.identityToken) {
            throw new Error('Apple 로그인 토큰을 가져오지 못했습니다.');
          }

          // [한글 주석] 가져온 identityToken을 이용하여 Firebase OAuth 자격증명(Credential)을 생성합니다.
          const provider = new OAuthProvider('apple.com');
          const credential = provider.credential({
            idToken: appleCredential.identityToken,
          });

          // [한글 주석] Firebase Auth에 로그인합니다.
          const result = await signInWithCredential(auth, credential);
          const fbUser = result.user;
          const idToken = await fbUser.getIdToken();
          
          // 애플 계정에서 반환해 주는 닉네임이나 이메일을 파싱합니다.
          const familyName = appleCredential.fullName?.familyName || '';
          const givenName = appleCredential.fullName?.givenName || '';
          const fullName = [familyName, givenName].filter(Boolean).join('') || fbUser.displayName || '애플사장님';
          const email = appleCredential.email || fbUser.email || 'apple-사장님@test.com';

          // [한글 주석] 로그인에 성공했으므로 백엔드 서버의 데이터베이스와 회원 프로필 정보를 동기화합니다.
          const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              name: fullName,
              store_name: `${fullName} 매장`,
            }),
          });

          if (!response.ok) {
            console.warn('백엔드 계정 동기화 경고: 소셜 회원 연동이 완전하지 않을 수 있습니다.');
          }

          const u = {
            email,
            name: fullName,
            token: idToken,
          };

          setUser({ email: u.email, name: u.name });
          setToken(idToken);
          await persistSession(u, autoLogin);
          return;
        } catch (err: any) {
          // 사용자가 취소한 경우는 단순 경고/에러 처리만 하고 넘어갑니다.
          if (err.code === 'ERR_REQUEST_CANCELED') {
            console.log('애플 로그인이 사용자에 의해 취소되었습니다.');
            throw new Error('애플 로그인이 취소되었습니다.');
          }
          console.error('모바일 애플 로그인 처리 중 실패:', err);
          throw new Error(err.message || '애플 로그인 처리 중 문제가 발생했습니다.');
        }
      }

      if (!auth) throw new Error('Firebase가 초기화되지 않았습니다.');

      try {
        const provider = new OAuthProvider('apple.com');
        // 팝업 창을 띄워 애플 로그인 시도
        const result = await signInWithPopup(auth, provider);
        const fbUser = result.user;
        const idToken = await fbUser.getIdToken();
        const userName = fbUser.displayName || fbUser.email?.split('@')[0] || '애플사장님';

        // 백엔드 프로필 동기화
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            name: userName,
            store_name: `${userName} 매장`,
          }),
        });

        if (!response.ok) {
          console.warn('백엔드 계정 동기화 경고: 소셜 회원 연동이 완전하지 않을 수 있습니다.');
        }

        const u = {
          email: fbUser.email || 'apple-사장님@test.com',
          name: userName,
          token: idToken,
        };

        setUser({ email: u.email, name: u.name });
        setToken(idToken);
        await persistSession(u, autoLogin);
      } catch (err: any) {
        console.error('애플 로그인 실패:', err);
        throw new Error(err.message || '애플 로그인 중 오류가 발생했습니다.');
      }
    },
    [persistSession, loginWithBackendDemo]
  );

  // [한글 주석] 로그아웃 시 Firebase 세션을 끊고 로컬 세션을 완전히 파기합니다.
  const logout = useCallback(async () => {
    try {
      // Firebase 미초기화(키 없음) 시 auth 는 null — 백엔드 우회 모드이므로 건너뛴다.
      if (auth) await signOut(auth);
    } catch (err) {
      console.error('Firebase 로그아웃 실패:', err);
    }
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

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
        const updated: User = {
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

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        booting,
        login,
        signup,
        loginWithGoogle,
        loginWithApple,
        logout,
        updateProfile,
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

