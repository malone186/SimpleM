import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/auth/AuthContext';
import { PreferencesProvider } from './src/preferences/PreferencesContext';
import { DessertProvider } from './src/dessert/DessertContext';
import { EquippedProvider } from './src/rewards/EquippedContext';
import DeviceFrame from './src/components/DeviceFrame';
import ErrorBoundary from './src/components/ErrorBoundary';
import Splash from './src/components/Splash';
import { ToastHost } from './src/components/toast';
import AlertsWatcher from './src/notifications/AlertsWatcher';
import WebAppearance from './src/components/WebAppearance';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  // Pretendard — 토스류 앱들이 쓰는 한글 본문 폰트. theme/index.ts의 typography가 이 이름을 쓴다.
  // 로드 전에 그리면 안드로이드가 '모르는 폰트'로 죽을 수 있어 잠깐(수십 ms) 빈 화면을 반환한다
  // (첫 1초는 어차피 Splash가 덮는다).
  const [fontsLoaded] = useFonts({
    'Pretendard-Regular': require('./assets/fonts/Pretendard-Regular.otf'),
    'Pretendard-Medium': require('./assets/fonts/Pretendard-Medium.otf'),
    'Pretendard-SemiBold': require('./assets/fonts/Pretendard-SemiBold.otf'),
    'Pretendard-Bold': require('./assets/fonts/Pretendard-Bold.otf'),
    'Pretendard-ExtraBold': require('./assets/fonts/Pretendard-ExtraBold.otf'),
  });
  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <PreferencesProvider>
        <AuthProvider>
          <DessertProvider>
          {/* 상점에서 산 꾸미기 아이템을 브루가 나오는 모든 화면에 공유 */}
          <EquippedProvider>
          <DeviceFrame>
            {/* 화면 하나가 터져도 앱 전체가 흰 화면이 되지 않도록 감싼다 */}
            <ErrorBoundary>
              <RootNavigator />
            </ErrorBoundary>
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
          </EquippedProvider>
          </DessertProvider>
        </AuthProvider>
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}

