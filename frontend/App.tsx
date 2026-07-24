import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/auth/AuthContext';
import { PreferencesProvider } from './src/preferences/PreferencesContext';
import { DessertProvider } from './src/dessert/DessertContext';
import DeviceFrame from './src/components/DeviceFrame';
import Splash from './src/components/Splash';
import { ToastHost } from './src/components/toast';
import AlertsWatcher from './src/notifications/AlertsWatcher';
import WebAppearance from './src/components/WebAppearance';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <PreferencesProvider>
        <AuthProvider>
          <DessertProvider>
          <DeviceFrame>
            <RootNavigator />
            <StatusBar style="auto" />
            {/* 인앱 토스트/확인 다이얼로그 (브라우저 alert 대체) */}
            <ToastHost />
            {/* 알림 설정(재고 부족·단가 급등·리포트 주기·방해 금지)을 실제 알림으로 연결 */}
            <AlertsWatcher />
            {/* 첫 실행 시 로고 1초 노출 후 페이드아웃 */}
            <Splash />
            {/* 설정의 글자 크기·다크모드를 앱 콘텐츠에 실제 적용 (웹) */}
            <WebAppearance />
          </DeviceFrame>
          </DessertProvider>
        </AuthProvider>
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}

