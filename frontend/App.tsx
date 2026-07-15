import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from './src/auth/AuthContext';
import DeviceFrame from './src/components/DeviceFrame';
import Splash from './src/components/Splash';
import { ToastHost } from './src/components/toast';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <AuthProvider>
      <DeviceFrame>
        <RootNavigator />
        <StatusBar style="auto" />
        {/* 인앱 토스트/확인 다이얼로그 (브라우저 alert 대체) */}
        <ToastHost />
        {/* 첫 실행 시 로고 1초 노출 후 페이드아웃 */}
        <Splash />
      </DeviceFrame>
    </AuthProvider>
  );
}
