import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from './src/auth/AuthContext';
import { PreferencesProvider } from './src/preferences/PreferencesContext';
import { DessertProvider } from './src/dessert/DessertContext';
import DeviceFrame from './src/components/DeviceFrame';
import Splash from './src/components/Splash';
import { ToastHost } from './src/components/toast';
import WebAppearance from './src/components/WebAppearance';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <PreferencesProvider>
      <AuthProvider>
        <DessertProvider>
        <DeviceFrame>
          <RootNavigator />
          <StatusBar style="auto" />
          {/* 인앱 토스트/확인 다이얼로그 (브라우저 alert 대체) */}
          <ToastHost />
          {/* 첫 실행 시 로고 1초 노출 후 페이드아웃 */}
          <Splash />
          {/* 설정의 글자 크기·다크모드를 앱 콘텐츠에 실제 적용 (웹) */}
          <WebAppearance />
        </DeviceFrame>
        </DessertProvider>
      </AuthProvider>
    </PreferencesProvider>
  );
}
