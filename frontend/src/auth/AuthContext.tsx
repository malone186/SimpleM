// c:\STUDY\SimpleM\frontend\src\auth\AuthContext.tsx
// [한글 주석] 백엔드 자체 로그인(/api/v1/auth)과 로컬 세션(AsyncStorage)을 활용한 점주 인증 상태 관리자입니다.
// [데모 우회] 원래는 Firebase Auth를 썼으나, Firebase 설정값(웹 config) 없이도 실행할 수 있도록
//            백엔드의 이메일/비밀번호 로그인 API(HS256 JWT 발급)를 직접 호출하도록 대체했습니다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

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
  updateProfile: (patch: { name?: string; store_name?: string; password?: string; photo?: string }) => Promise<void>;
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

  // [한글 주석] 백엔드 로그인 API로 이메일/비밀번호를 검증하고 JWT 토큰을 획득합니다.
  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      let response: Response;
      try {
        // 1. 백엔드 자체 로그인 API 호출 (성공 시 HS256 JWT 발급)
        response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            password,
          }),
        });
      } catch {
        // 네트워크 자체가 실패한 경우 (백엔드 미실행 등)
        throw new Error('백엔드 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.');
      }

      if (!response.ok) {
        // 백엔드가 내려준 한글 에러 메시지를 그대로 노출합니다.
        let msg = '이메일 또는 비밀번호가 일치하지 않습니다.';
        try {
          const errData = await response.json();
          if (errData?.detail) msg = errData.detail;
        } catch { /* 본문 파싱 실패 시 기본 메시지 사용 */ }
        throw new Error(msg);
      }

      // 2. 토큰/사용자 정보 파싱 (Token 스키마: access_token, email, name)
      const data = await response.json();
      const u = {
        email: data.email ?? email,
        name: data.name ?? email.split('@')[0],
        token: data.access_token as string,
      };

      // 3. 로컬 상태 값 업데이트 및 영구 보관 설정
      setUser({ email: u.email, name: u.name });
      setToken(u.token);
      await persistSession(u, autoLogin);
    },
    [persistSession]
  );

  // [한글 주석] 백엔드 회원가입 API로 계정을 생성한 뒤 곧바로 로그인합니다.
  const signup = useCallback(
    async (name: string, email: string, password: string, autoLogin: boolean) => {
      let response: Response;
      try {
        // 1. 백엔드 회원가입 API 호출 (UserCreate: email, password, name, store_name)
        response = await fetch(`${API_BASE_URL}/api/v1/auth/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            password,
            name: name.trim(),
            store_name: `${name.trim()} 매장`,
          }),
        });
      } catch {
        throw new Error('백엔드 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.');
      }

      if (!response.ok) {
        let msg = '회원가입 중 오류가 발생했습니다.';
        try {
          const errData = await response.json();
          if (errData?.detail) msg = errData.detail;
        } catch { /* 본문 파싱 실패 시 기본 메시지 사용 */ }
        throw new Error(msg);
      }

      // 2. 가입 즉시 로그인을 진행하여 토큰 획득
      await login(email, password, autoLogin);
    },
    [login]
  );

  // [한글 주석] 로그아웃 시 로컬 세션을 완전히 파기합니다.
  const logout = useCallback(async () => {
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  // [한글 주석] 로그인된 점주님의 정보(이름/상호/비밀번호)를 백엔드 데이터베이스에 갱신합니다.
  const updateProfile = useCallback(
    async (patch: { name?: string; store_name?: string; password?: string; photo?: string }) => {
      if (!user || !token) return;

      try {
        // 1. 백엔드 데이터베이스 프로필 수정 API 호출 (토큰을 통해 매핑된 회원 레코드 수정)
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

