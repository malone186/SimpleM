// c:\STUDY\SimpleM\frontend\src\lib\firebase.ts
import { initializeApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

// [한글 주석] Firebase 클라이언트 앱을 구동하기 위한 필수 환경설정 값들입니다.
// Expo 환경에서는 환경변수명 앞에 'EXPO_PUBLIC_'을 붙여 빌드 시 자동으로 주입받아 사용합니다.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// [한글 주석] 유효한 Firebase 키가 있을 때만 초기화한다.
// 키가 없거나 mock 상태면 getAuth 가 'auth/invalid-api-key' 로 앱 로드 시점에 크래시하므로,
// 그 경우 초기화를 건너뛰고 auth 를 null 로 둔다. 이때 로그인/가입은 AuthContext 의
// 백엔드 자체 인증(isMockFirebase 우회) 경로로 처리된다.
const hasRealKey = !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('mock-');

// 타입은 Auth 로 노출하되(호출부 타입 유지), 키가 없으면 런타임 값은 null 이다.
// firebase 를 실제로 호출하는 지점(로그인/가입의 비-mock 경로)은 유효 키가 있을 때만 실행되고,
// logout/updateProfile 의 무조건 호출부는 AuthContext 에서 null 가드로 감싼다.
export const auth = (hasRealKey ? getAuth(initializeApp(firebaseConfig)) : null) as Auth;
