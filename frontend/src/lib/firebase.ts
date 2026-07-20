// c:\STUDY\SimpleM\frontend\src\lib\firebase.ts
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

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

// [한글 주석] Firebase 앱을 한 번만 초기화하여 싱글톤 객체로 관리합니다.
const app = initializeApp(firebaseConfig);

// [한글 주석] 이메일/비밀번호 로그인을 처리할 Firebase Auth 인스턴스를 생성하여 내보냅니다.
export const auth = getAuth(app);
