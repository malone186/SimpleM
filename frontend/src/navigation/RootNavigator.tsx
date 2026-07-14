// 공동 소유 — 탭 추가 시 알파벳순 정렬, 팀 공지
// PRD §6 화면 5개: 대시보드 / 재고 / 발주 / 챗봇 / 운영
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../auth/AuthContext';
import AuthScreen from '../screens/auth/AuthScreen';
import ChatbotScreen from '../screens/chatbot/ChatbotScreen';
import CostScreen from '../screens/cost/CostScreen';
import DashboardScreen from '../screens/dashboard/DashboardScreen';
import DocumentScreen from '../screens/document/DocumentScreen';
import IngredientScreen from '../screens/ingredient/IngredientScreen';
import InventoryScreen from '../screens/inventory/InventoryScreen';
import LawSearchScreen from '../screens/law/LawSearchScreen';
import ManagementScreen from '../screens/management/ManagementScreen';
import MenuScreen from '../screens/menu/MenuScreen';
import OperationScreen from '../screens/operation/OperationScreen';
import OrderScreen from '../screens/order/OrderScreen';
import ProfileScreen from '../screens/profile/ProfileScreen';
import SalesInputScreen from '../screens/sales/SalesInputScreen';
import { colors, typography } from '../theme';

export type RootTabParamList = {
  Dashboard: undefined;
  Inventory: undefined;
  Order: undefined;
  Chatbot: undefined;
  Operation: undefined;
  Management: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

export type RootStackParamList = {
  Tabs: undefined;
  Profile: undefined;
  Ingredient: undefined;
  Menu: undefined;
  SalesInput: undefined;
  Cost: undefined;
  LawSearch: undefined;
  Document: undefined;
};
const Stack = createNativeStackNavigator<RootStackParamList>();

const ICONS: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'home',
  Inventory: 'file-tray-stacked',
  Order: 'cart',
  Chatbot: 'chatbubble-ellipses',
  Operation: 'briefcase',
  Management: 'grid',
};

const LABELS: Record<keyof RootTabParamList, string> = {
  Dashboard: '홈',
  Inventory: '재고',
  Order: '발주',
  Chatbot: '챗봇',
  Operation: '운영',
  Management: '관리',
};

// ERP 스택 화면 공통 헤더 옵션 (테마)
const erpHeader = (title: string) =>
  ({
    headerShown: true,
    title,
    headerTitleAlign: 'left' as const, // 웹 프레임 노치와 겹치지 않게
    headerStyle: { backgroundColor: colors.espressoBrown },
    headerTintColor: colors.creamSand,
    headerTitleStyle: { fontWeight: '900' as const },
    animation: 'slide_from_right' as const,
  });

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
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabsNavigator} />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen name="Ingredient" component={IngredientScreen} options={erpHeader('재료 관리')} />
        <Stack.Screen name="Menu" component={MenuScreen} options={erpHeader('메뉴 관리')} />
        <Stack.Screen name="SalesInput" component={SalesInputScreen} options={erpHeader('판매 입력')} />
        <Stack.Screen name="Cost" component={CostScreen} options={erpHeader('원가 분석')} />
        <Stack.Screen name="LawSearch" component={LawSearchScreen} options={erpHeader('법령 검색')} />
        <Stack.Screen name="Document" component={DocumentScreen} options={erpHeader('서류 자동화')} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function TabsNavigator() {
  return (
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
      <Tab.Screen name="Management" component={ManagementScreen} />
    </Tab.Navigator>
  );
}
