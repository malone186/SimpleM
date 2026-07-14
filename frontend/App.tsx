import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from './src/auth/AuthContext';
import DeviceFrame from './src/components/DeviceFrame';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <AuthProvider>
      <DeviceFrame>
        <RootNavigator />
        <StatusBar style="auto" />
      </DeviceFrame>
    </AuthProvider>
  );
}
