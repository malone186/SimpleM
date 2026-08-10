import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import * as firebaseAuth from 'firebase/auth';
import { getAuth, initializeAuth, type Auth } from 'firebase/auth';

// [한글 주석] Firebase 클라이언트 앱을 구동하기 위한 필수 환경설정 값들입니다.
// Expo 환경에서는 환경변수명 앞에 'EXPO_PUBLIC_'을 붙여 빌드 시 자동으로 주입받아 사용합니다.
//
// 키가 없거나 'mock-'으로 시작하면 가짜 설정으로 초기화한다 — apiKey가 비어 있으면
// getAuth()가 앱 구동 시점에 auth/invalid-api-key를 던져 화면 전체가 흰 화면이 된다.
// 이 경우 실제 인증은 AuthContext가 백엔드 로컬 인증 API로 우회하므로 Firebase는 호출되지 않는다.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || 'mock-api-key',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || 'mock.firebaseapp.com',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || 'mock-project',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || 'mock-project.appspot.com',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '0',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || 'mock-app-id',
};

// [한글 주석] 유효한 실제 Firebase 키가 있을 때만 초기화합니다. ('mock-', 'demo-' 키는 백엔드 전용 모드로 취급)
const hasRealKey =
  !!firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('mock-') &&
  !firebaseConfig.apiKey.startsWith('demo-');

// [네이티브 세션 영속화] 웹은 getAuth가 알아서 localStorage에 세션을 남기지만,
// 네이티브에서 getAuth는 '메모리 영속화'라 앱을 껐다 켜면 Firebase 세션이 사라진다.
// 그러면 AsyncStorage에 복원된 ID 토큰(1시간 만료)을 갱신해 줄 Firebase 사용자가 없어,
// 자동 로그인이 한 시간을 못 넘기고 401로 죽는다. 그래서 네이티브는 initializeAuth +
// AsyncStorage 영속화로 초기화한다. getReactNativePersistence는 RN 전용 엔트리에만
// 있는 export라 웹용 타입 선언에 없다 → 런타임 존재 확인 후 꺼내 쓴다.
function createAuth(app: FirebaseApp): Auth {
  const getRNPersistence = (firebaseAuth as Record<string, unknown>)
    .getReactNativePersistence as ((storage: unknown) => unknown) | undefined;
  if (Platform.OS !== 'web' && getRNPersistence) {
    try {
      return initializeAuth(app, {
        persistence: getRNPersistence(AsyncStorage) as never,
      });
    } catch {
      // 이미 초기화된 앱(핫 리로드 등) — 기존 인스턴스를 그대로 쓴다
      return getAuth(app);
    }
  }
  return getAuth(app);
}

// 타입은 Auth 로 노출하되(호출부 타입 유지), 키가 없으면 런타임 값은 null 이다.
// firebase 를 실제로 호출하는 지점(로그인/가입의 비-mock 경로)은 유효 키가 있을 때만 실행되고,
// logout/updateProfile 의 무조건 호출부는 AuthContext 에서 null 가드로 감싼다.
export const auth = (hasRealKey ? createAuth(initializeApp(firebaseConfig)) : null) as Auth;
