// 인증 상태 관리 — 회원가입/로그인/로그아웃 + 자동 로그인 영구 저장
// 로그인/회원가입은 백엔드 API(core/auth.py) 연동. 프로필 수정은 로컬 세션 반영.
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
type StoredUser = User & { password: string };

type AuthContextValue = {
  user: User | null;
  token: string | null; // 백엔드 API 호출용 JWT (Authorization: Bearer ...)
  booting: boolean;
  login: (email: string, password: string, autoLogin: boolean) => Promise<void>;
  signup: (name: string, email: string, password: string, autoLogin: boolean) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; password?: string; photo?: string }) => Promise<void>;
};

const USERS_KEY = 'simplem:users';
const SESSION_KEY = 'simplem:session'; // 자동 로그인 체크 시에만 저장

// 데모 계정 — 회원가입 없이 바로 로그인해볼 수 있도록 기본 제공
const DEMO_USER: StoredUser = { email: 'test@test.com', password: '1234', name: '포자카페' };

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

async function readUsers(): Promise<StoredUser[]> {
  const raw = await AsyncStorage.getItem(USERS_KEY);
  return raw ? (JSON.parse(raw) as StoredUser[]) : [];
}

// 데모 계정이 없으면 넣어준다
async function seedDemoUser(): Promise<void> {
  const users = await readUsers();
  if (!users.some((u) => u.email === DEMO_USER.email)) {
    await AsyncStorage.setItem(USERS_KEY, JSON.stringify([...users, DEMO_USER]));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // 앱 시작 시: 데모 계정 시드 + 자동 로그인 세션 복원
  useEffect(() => {
    (async () => {
      try {
        await seedDemoUser();
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
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const persistSession = useCallback(async (u: User & { token: string }, autoLogin: boolean) => {
    if (autoLogin) {
      // 자동 로그인 시, 토큰과 프로필 정보를 로컬 디스크에 안전하게 객체로 저장합니다.
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
    } else {
      await AsyncStorage.removeItem(SESSION_KEY); // 체크 안 하면 이번 세션만 임시 유지
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      // 1. 백엔드 로그인 API로 이메일과 비밀번호를 전송합니다.
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      // 2. 에러(비번 틀림, 없는 메일 등)면 메시지를 화면에 던집니다.
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || '로그인에 실패했어요.');
      }

      // 3. 성공하면 토큰과 닉네임을 받아옵니다.
      const data = await response.json(); // { access_token, token_type, email, name }

      const u = {
        email: data.email,
        name: data.name,
        token: data.access_token,
      };

      // 4. 로그인 상태 업데이트 + 로컬 세션 보관.
      setUser({ email: data.email, name: data.name });
      setToken(data.access_token);
      await persistSession(u, autoLogin);
    },
    [persistSession]
  );

  const signup = useCallback(
    async (name: string, email: string, password: string, autoLogin: boolean) => {
      // 1. 백엔드 회원가입 API로 정보를 송신합니다.
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          name: name.trim(),
          store_name: name.trim(), // 상호명을 점주명·매장명에 모두 채워넣습니다.
        }),
      });

      // 2. 중복 이메일 등의 가입 에러 처리.
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || '회원가입에 실패했어요.');
      }

      // 3. 가입 성공 시 즉시 로그인을 실행해 자동 로그인 상태가 되게 합니다.
      await login(email, password, autoLogin);
    },
    [login]
  );

  const logout = useCallback(async () => {
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  const updateProfile = useCallback(
    async (patch: { name?: string; password?: string; photo?: string }) => {
      if (!user || !token) return;

      // 1. 서버의 프로필 수정 API를 호출하여 데이터베이스에 변경 내역을 영속화합니다.
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: patch.name?.trim() ? patch.name.trim() : undefined,
          password: patch.password ? patch.password : undefined,
          store_name: patch.name?.trim() ? patch.name.trim() : undefined, // 기획안에 맞춰 매장명을 닉네임과 연동합니다.
        }),
      });

      // 2. 서버 에러 발생 시 예외 처리를 거칩니다.
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || '프로필 수정 요청에 실패했습니다.');
      }

      // 3. 서버 정상 갱신 완료 후 로컬 샌드박스 스토리지 캐시 및 사용자 상태를 동기화합니다.
      const data = await response.json();
      const updated: User = {
        email: data.email,
        name: data.name,
        photo: patch.photo !== undefined ? patch.photo : user.photo,
      };

      const users = await readUsers();
      const next = users.map((u) =>
        u.email === user.email
          ? {
              ...u,
              name: data.name,
              password: patch.password ? patch.password : u.password,
              photo: patch.photo !== undefined ? patch.photo : u.photo,
            }
          : u
      );
      await AsyncStorage.setItem(USERS_KEY, JSON.stringify(next));
      setUser(updated);

      // 자동 로그인 세션이 있으면 토큰 등 기존 값은 유지하며 갱신합니다.
      const raw = await AsyncStorage.getItem(SESSION_KEY);
      if (raw) {
        const prev = JSON.parse(raw);
        await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ ...prev, ...updated }));
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
