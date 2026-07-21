// 공동 소유 — 탭 추가 시 알파벳순 정렬, 팀 공지
// PRD §6 화면 5개: 대시보드 / 재고 / 발주 / 챗봇 / 운영
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Platform, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../auth/AuthContext';
import AdminScreen from '../screens/admin/AdminScreen';
import AuthScreen from '../screens/auth/AuthScreen';
import ChatbotScreen from '../screens/chatbot/ChatbotScreen';
import CostScreen from '../screens/cost/CostScreen';
import DashboardScreen from '../screens/dashboard/DashboardScreen';
import DessertScreen from '../screens/dessert/DessertScreen';
import DocumentScreen from '../screens/document/DocumentScreen';
import IngredientScreen from '../screens/ingredient/IngredientScreen';
import InventoryScreen from '../screens/inventory/InventoryScreen';
import LawSearchScreen from '../screens/law/LawSearchScreen';
import LegalScreen from '../screens/legal/LegalScreen';
import ManagementScreen from '../screens/management/ManagementScreen';
import MenuScreen from '../screens/menu/MenuScreen';
import OperationScreen from '../screens/operation/OperationScreen';
import OrderScreen from '../screens/order/OrderScreen';
import ProfileScreen from '../screens/profile/ProfileScreen';
import SalesInputScreen from '../screens/sales/SalesInputScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import TaxDraftDetailScreen from '../screens/document/TaxDraftDetailScreen';
import { colors, typography } from '../theme';
import type { TaxEstimate } from '../lib/api/operation';

export type RootTabParamList = {
  Dashboard: undefined;
  Inventory: undefined;
  Order: undefined;
  // prefill: 다른 화면(경영 리포트 등)에서 버튼으로 넘어올 때 입력창에 미리 채울 질문
  //   ts: 같은 질문을 다시 눌러도 파라미터가 바뀌어 재입력되도록 하는 클릭 시각
  Chatbot: { prefill?: string; ts?: number } | undefined;
  Management: undefined;
};

const ADMIN_EMAILS = ['admin@simplem.com'];

const Tab = createBottomTabNavigator<RootTabParamList>();

export type RootStackParamList = {
  Tabs: undefined;
  Profile: undefined;
  Ingredient: undefined;
  Menu: undefined;
  SalesInput: undefined;
  Cost: undefined;
  LawSearch: undefined;
  Legal: { doc?: 'privacy' | 'terms' } | undefined;
  Document: undefined;
  TaxDraftDetail: { tax: TaxEstimate };
  Operation: undefined;
  Settings: undefined;
  Dessert: undefined;
};
const Stack = createNativeStackNavigator<RootStackParamList>();

const ICONS: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'home',
  Inventory: 'file-tray-stacked',
  Order: 'cart',
  Chatbot: 'chatbubble-ellipses',
  Management: 'grid',
};

const LABELS: Record<keyof RootTabParamList, string> = {
  Dashboard: '홈',
  Inventory: '재고',
  Order: '발주',
  Chatbot: '챗봇',
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
    headerStatusBarHeight: 35, // [한글 주석] 아이폰 노치(머리부분)와 타이틀 텍스트가 겹치지 않도록 여백을 확보합니다.
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

  // 관리자 → 하단 탭 없이 관리자 콘솔만 노출
  if (ADMIN_EMAILS.includes(user.email)) {
    return <AdminScreen />;
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
        <Stack.Screen name="Legal" component={LegalScreen} options={erpHeader('약관 및 정책')} />
        <Stack.Screen name="Document" component={DocumentScreen} options={erpHeader('서류 자동화')} />
        <Stack.Screen name="TaxDraftDetail" component={TaxDraftDetailScreen} options={erpHeader('세금 신고 초안')} />
        <Stack.Screen name="Operation" component={OperationScreen} options={erpHeader('운영')} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={erpHeader('설정')} />
        <Stack.Screen name="Dessert" component={DessertScreen} options={erpHeader('디저트 관리')} />
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
        tabBarActiveTintColor: colors.pointOrange, // [아이폰 스타일] 웰컴 테마와 매칭되는 활기찬 포인트 오렌지 적용
        tabBarInactiveTintColor: colors.mochaBrown,
        tabBarStyle: {
          backgroundColor: 'rgba(250, 249, 246, 0.96)', // [아이폰 스타일] 맑고 투명도가 살짝 도는 오프화이트 틴트
          borderTopWidth: 0.8,
          borderTopColor: 'rgba(140, 111, 86, 0.08)', // 은은하고 세련된 초슬림 엣지
          height: Platform.OS === 'ios' ? 92 : 84, // [한글 주석: 글씨 잘림 해결] 전체 높이를 시원하게 키워 렌더링 공간 확보
          paddingBottom: Platform.OS === 'ios' ? 24 : 10, // [한글 주석: 가독성 보정] 패딩 소모량을 줄여 내부 콘텐츠가 위로 오를 수 있는 가용 높이를 극대화함
          paddingTop: 8,
          shadowColor: '#4E3629',
          shadowOffset: { width: 0, height: -3 },
          shadowOpacity: 0.04,
          shadowRadius: 10,
          elevation: 8,
          // 웹 브라우저 등에서 하단 스크롤이 비치도록 블러 추가
          ...Platform.select({
            web: {
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }
          })
        },
        tabBarLabelStyle: { 
          fontSize: 10.5, // [가독성 보강] 너무 뚱뚱하지 않고 콤팩트한 폰트 사이즈
          fontWeight: '700',
          marginTop: 2,
          letterSpacing: -0.2, // 세련된 자간 튜닝
        },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={ICONS[route.name]} size={size ?? 20} color={color} // 아이콘 비례 조절
          />
        ),
        tabBarLabel: LABELS[route.name],
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Inventory" component={InventoryScreen} />
      <Tab.Screen name="Order" component={OrderScreen} />
      <Tab.Screen name="Chatbot" component={ChatbotScreen} />
      <Tab.Screen name="Management" component={ManagementScreen} />
    </Tab.Navigator>
  );
}
