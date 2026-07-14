// 인증 상태 관리 — 회원가입/로그인/로그아웃 + 자동 로그인 영구 저장
// 백엔드 연동 전 데모: AsyncStorage에 가입자/세션을 저장하는 목업 구현.
// 실제로는 core/auth.py(Firebase) 연동으로 교체.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type User = { email: string; name: string; photo?: string };
type StoredUser = User & { password: string };

type AuthContextValue = {
  user: User | null;
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
  const [booting, setBooting] = useState(true);

  // 앱 시작 시: 데모 계정 시드 + 자동 로그인 세션 복원
  useEffect(() => {
    (async () => {
      try {
        await seedDemoUser();
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) setUser(JSON.parse(raw) as User);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const persistSession = useCallback(async (u: User, autoLogin: boolean) => {
    if (autoLogin) {
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
    } else {
      await AsyncStorage.removeItem(SESSION_KEY); // 체크 안 하면 이번 세션만 유지
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string, autoLogin: boolean) => {
      const users = await readUsers();
      const found = users.find((u) => u.email === email.trim().toLowerCase());
      if (!found) throw new Error('가입되지 않은 이메일이에요.');
      if (found.password !== password) throw new Error('비밀번호가 일치하지 않아요.');
      const u: User = { email: found.email, name: found.name, photo: found.photo };
      setUser(u);
      await persistSession(u, autoLogin);
    },
    [persistSession]
  );

  const signup = useCallback(
    async (name: string, email: string, password: string, autoLogin: boolean) => {
      const normalized = email.trim().toLowerCase();
      const users = await readUsers();
      if (users.some((u) => u.email === normalized)) {
        throw new Error('이미 가입된 이메일이에요.');
      }
      const newUser: StoredUser = { email: normalized, name: name.trim(), password };
      await AsyncStorage.setItem(USERS_KEY, JSON.stringify([...users, newUser]));
      const u: User = { email: newUser.email, name: newUser.name };
      setUser(u);
      await persistSession(u, autoLogin);
    },
    [persistSession]
  );

  const logout = useCallback(async () => {
    setUser(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  }, []);

  const updateProfile = useCallback(
    async (patch: { name?: string; password?: string; photo?: string }) => {
      if (!user) return;
      const users = await readUsers();
      const next = users.map((u) =>
        u.email === user.email
          ? {
              ...u,
              name: patch.name?.trim() ? patch.name.trim() : u.name,
              password: patch.password ? patch.password : u.password,
              photo: patch.photo !== undefined ? patch.photo : u.photo,
            }
          : u
      );
      await AsyncStorage.setItem(USERS_KEY, JSON.stringify(next));
      const updated: User = {
        email: user.email,
        name: patch.name?.trim() || user.name,
        photo: patch.photo !== undefined ? patch.photo : user.photo,
      };
      setUser(updated);
      // 자동 로그인 세션이 있으면 갱신
      const raw = await AsyncStorage.getItem(SESSION_KEY);
      if (raw) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(updated));
    },
    [user]
  );

  return (
    <AuthContext.Provider value={{ user, booting, login, signup, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
