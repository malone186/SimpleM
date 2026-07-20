// c:\STUDY\SimpleM\frontend\src\auth\AuthContext.tsx
// [한글 주석] 파이어베이스 인증(Firebase Auth)과 로컬 세션(AsyncStorage)을 활용한 점주 인증 상태 관리자입니다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile as updateFirebaseProfile,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { auth } from '../lib/firebase';
import { API_BASE_URL } from '../lib/api/client';

export type User = { email: string; name: string; photo?: string };
type StoredUser = User & { password?: string };

type AuthContextValue = {
  user: User | null;
  token: string | null; // [한글 주석] 백엔드 API 호출용 Firebase ID Token (Authorization: Bearer ...)
  booting: boolean;
  login: (email: string, password: string, autoLogin: boolean) => Promise<void>;
  signup: (name: string, email: string, password: string, autoLogin: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; password?: string; photo?: string }) => Promise<void>;
};

const SESSION_KEY = 'simplem:session'; // [한글 주석] 자동 로그인 체크 시 로컬에 저장할 세션 키

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // [한글 주석] 앱 구동 시 로컬 저장소에서 세션을 읽어 자동 로그인을 복원합니다.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as User & { token?: string };
          setUser({ email: saved.email, name: saved.name, photo: saved.photo });
          setToken(saved.token ?? null);
        }
      } catch (err) {
        console.error('세션 복원 실패:', err);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // [한글 주석] 자동 로그인 여부에 따라 디스크에 세션을 남기거나 지웁니다.
  const persistSession = useCallback(async (u: User & { token: string }, autoLogin: boolean) => {
    if (autoLogin) {
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
    } else {
      await AsyncStorage.removeItem(SESSION_KEY);
    }
  }, []);

  // [한글 주석] Firebase Auth를 통해 사용자를 인증하고 ID Token을 획득하여 백엔드와 동기화합니다.
  // 가짜 Firebase 키 상황일 경우 백엔드 자체 로컬 인증 API로 즉시 우회합니다.
  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY || '';
      const isMockFirebase = FIREBASE_API_KEY.startsWith('mock-') || !FIREBASE_API_KEY;

      if (isMockFirebase) {
        try {
          // [한글 주석: 가짜 키 상태이므로 백엔드의 로컬 로그인 API 창구를 노크하여 전용 토큰을 얻어옵니다]
          const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
          });

          if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || '이메일 또는 비밀번호가 일치하지 않습니다.');
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
            const errData = await res.json();
            throw new Error(errData.detail || '회원가입 요청에 실패했습니다.');
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

  // [한글 주석] 로그아웃 시 Firebase 세션을 끊고 로컬 세션을 완전히 파기합니다.
  const logout = useCallback(async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Firebase 로그아웃 실패:', err);
    }
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  // [한글 주석] 로그인된 점주님의 정보(이름/비밀번호)를 Firebase 및 백엔드 데이터베이스에 동시 갱신합니다.
  const updateProfile = useCallback(
    async (patch: { name?: string; password?: string; photo?: string }) => {
      if (!user || !token) return;

      try {
        const currentUser = auth.currentUser;
        
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
            store_name: patch.name?.trim() ? patch.name.trim() : undefined,
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
    <AuthContext.Provider value={{ user, token, booting, login, signup, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

