import { initializeApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

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

// 타입은 Auth 로 노출하되(호출부 타입 유지), 키가 없으면 런타임 값은 null 이다.
// firebase 를 실제로 호출하는 지점(로그인/가입의 비-mock 경로)은 유효 키가 있을 때만 실행되고,
// logout/updateProfile 의 무조건 호출부는 AuthContext 에서 null 가드로 감싼다.
export const auth = (hasRealKey ? getAuth(initializeApp(firebaseConfig)) : null) as Auth;
