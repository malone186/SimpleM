// c:\STUDY\SimpleM\frontend\src\lib\firebase.ts
import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// [한글 주석] Firebase 클라이언트 앱을 구동하기 위한 필수 환경설정 값들입니다.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || "demo-api-key",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

let app: any = null;
let auth: any = null;

try {
  // [한글 주석] 이미 앱이 생성되어 있는지 확인하고 생성되지 않은 경우에만 초기화합니다.
  if (!getApps().length) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApps()[0];
  }
  auth = getAuth(app);
} catch (error) {
  // [한글 주석] Firebase 키가 설정되지 않은 로컬 개발 환경에서도 앱이 차단되지 않도록 예외 처리
  console.warn("Firebase 초기화 에러 (더미 모드로 대체 구동됩니다):", error);
}

export { app, auth };

