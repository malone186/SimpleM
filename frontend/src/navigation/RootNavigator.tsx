// 공동 소유 — 탭 추가 시 알파벳순 정렬, 팀 공지
// PRD §6 화면 5개: 대시보드 / 재고 / 발주 / 챗봇 / 운영
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { useAuth } from '../auth/AuthContext';
import AuthScreen from '../screens/auth/AuthScreen';
import ChatbotScreen from '../screens/chatbot/ChatbotScreen';
import DashboardScreen from '../screens/dashboard/DashboardScreen';
import InventoryScreen from '../screens/inventory/InventoryScreen';
import OperationScreen from '../screens/operation/OperationScreen';
import OrderScreen from '../screens/order/OrderScreen';
import { colors, typography } from '../theme';

export type RootTabParamList = {
  Dashboard: undefined;
  Inventory: undefined;
  Order: undefined;
  Chatbot: undefined;
  Operation: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

const ICONS: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'home',
  Inventory: 'file-tray-stacked',
  Order: 'cart',
  Chatbot: 'chatbubble-ellipses',
  Operation: 'briefcase',
};

const LABELS: Record<keyof RootTabParamList, string> = {
  Dashboard: '홈',
  Inventory: '재고',
  Order: '발주',
  Chatbot: '챗봇',
  Operation: '운영',
};

export default function RootNavigator() {
  const { user, booting } = useAuth();

  // 자동 로그인 세션 복원 중
  if (booting) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.creamSand }}>
        <ActivityIndicator color={colors.pointOrange} />
      </View>
    );
  }

  // 미로그인 → 로그인/회원가입 화면만 노출 (탭 앱 숨김)
  if (!user) {
    return <AuthScreen />;
  }

  return (
    <NavigationContainer>
      <Tab.Navigator
        initialRouteName="Dashboard"
        screenOptions={({ route }) => ({
          headerShown: false,
          animation: 'shift', // 탭 전환 시 콘텐츠가 스르륵 밀려 들어옴
          tabBarActiveTintColor: colors.pointOrange,
          tabBarInactiveTintColor: colors.mochaBrown,
          tabBarStyle: {
            backgroundColor: colors.white,
            borderTopColor: colors.mutedSand,
            height: 64,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarLabelStyle: { ...typography.L5, fontWeight: '700' },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name={ICONS[route.name]} size={size ?? 22} color={color} />
          ),
          tabBarLabel: LABELS[route.name],
        })}
      >
        <Tab.Screen name="Dashboard" component={DashboardScreen} />
        <Tab.Screen name="Inventory" component={InventoryScreen} />
        <Tab.Screen name="Order" component={OrderScreen} />
        <Tab.Screen name="Chatbot" component={ChatbotScreen} />
        <Tab.Screen name="Operation" component={OperationScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
