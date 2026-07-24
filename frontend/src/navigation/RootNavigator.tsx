// 공동 소유 — 탭 추가 시 알파벳순 정렬, 팀 공지
// PRD §6 화면 5개: 대시보드 / 재고 / 발주 / 챗봇 / 운영
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, LayoutAnimation, Platform, View } from 'react-native';
import { PressableScale } from '../components/motion';
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

import BeanOperationScreen from '../screens/operation/BeanOperationScreen';
import StoreMapScreen from '../screens/dashboard/StoreMapScreen';

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
  BeanOperation: undefined;
  Settings: undefined;
  Dessert: undefined;
  StoreMap: undefined;
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

// [한글 주석: 아이폰 iOS / 프리텐다드 미디엄 스타일 ERP 스택 화면 공통 헤더 옵션]
const erpHeader = (title: string, navigation: any) =>
  ({
    headerShown: true,
    title,
    headerTitleAlign: 'left' as const, // 웹 프레임 노치와 겹치지 않게
    headerStyle: { backgroundColor: colors.espressoBrown },
    headerTintColor: colors.creamSand,
    headerTitleStyle: {
      fontSize: 16.5,
      fontWeight: '500' as const, // [한글 주석: 투박한 900 굵기를 지우고 세련된 프리텐다드 미디엄 500 굵기 적용]
      letterSpacing: -0.45, // [한글 주석: 자간을 쫀쫀하게 좁혀 가독성을 높임]
      fontFamily: Platform.select({
        web: 'Pretendard, -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif',
        default: undefined,
      }),
    },
    headerStatusBarHeight: 35, // 아이폰 노치 안전 높이
    headerBackVisible: false, // 네이티브 백버튼 비활성화
    headerLeftContainerStyle: { paddingLeft: 10 },
    headerTitleContainerStyle: { marginLeft: 4 }, // [한글 주석: 화살표와 제목이 어색하게 붙지 않게 4px 여백 확보]
    headerLeft: () => (
      <PressableScale
        onPress={() => {
          // [한글 주석: 뒤로가기 클릭 시 레이아웃 축소 및 화면 이탈 동작을 쫀득한 탄성 감도로 연출]
          LayoutAnimation.configureNext({
            duration: 350,
            update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
          });
          navigation.goBack();
        }}
        style={{ marginLeft: 2, marginRight: 10, padding: 4 }} // [한글 주석: 화살표와 제목 글자 사이에 10px 띄움 간격 조절]
        to={0.88}
      >
        <Ionicons name="arrow-back" size={22} color={colors.creamSand} />
      </PressableScale>
    ),
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
        <Stack.Screen name="Ingredient" component={IngredientScreen} options={({ navigation }) => erpHeader('재료 관리', navigation)} />
        <Stack.Screen name="Menu" component={MenuScreen} options={({ navigation }) => erpHeader('메뉴 관리', navigation)} />
        <Stack.Screen name="SalesInput" component={SalesInputScreen} options={({ navigation }) => erpHeader('판매 입력', navigation)} />
        <Stack.Screen name="Cost" component={CostScreen} options={({ navigation }) => erpHeader('원가 분석', navigation)} />
        <Stack.Screen name="LawSearch" component={LawSearchScreen} options={({ navigation }) => erpHeader('법령 검색', navigation)} />
        <Stack.Screen name="Legal" component={LegalScreen} options={({ navigation }) => erpHeader('약관 및 정책', navigation)} />
        <Stack.Screen name="Document" component={DocumentScreen} options={({ navigation }) => erpHeader('서류 자동화', navigation)} />
        <Stack.Screen name="TaxDraftDetail" component={TaxDraftDetailScreen} options={({ navigation }) => erpHeader('세금 신고 초안', navigation)} />
        <Stack.Screen name="Operation" component={OperationScreen} options={({ navigation }) => erpHeader('스케줄 · 급여', navigation)} />
        <Stack.Screen name="BeanOperation" component={BeanOperationScreen} options={({ navigation }) => erpHeader('운영 · 원두 실리뷰 분석', navigation)} />

        <Stack.Screen name="Settings" component={SettingsScreen} options={({ navigation }) => erpHeader('설정', navigation)} />
        <Stack.Screen name="Dessert" component={DessertScreen} options={({ navigation }) => erpHeader('디저트 관리', navigation)} />
        <Stack.Screen name="StoreMap" component={StoreMapScreen} options={({ navigation }) => erpHeader('매장 위치', navigation)} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation, type TranslationKey } from '../i18n/translations';

const TAB_LABEL_KEYS: Record<keyof RootTabParamList, TranslationKey> = {
  Dashboard: 'tabHome',
  Inventory: 'tabInventory',
  Order: 'tabOrder',
  Chatbot: 'tabChatbot',
  Management: 'tabManagement',
};

function TabsNavigator() {
  // [한글 주석: 전역 다국어 훅 호출 — 사장님이 선택한 언어(ko/en)에 맞게 하단 탭 메뉴명 동적 가공]
  const { t } = useTranslation();
  // [한글 주석: 갤럭시 등 안드로이드 하단 소프트키/제스처 바 영역 높이 동적 측정 훅]
  const insets = useSafeAreaInsets();

  // [한글 주석: 기기별 하단 안전 여백 보정 — 갤럭시 시스템 소프트키와 탭 바가 겹치지 않게 여백 확보]
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'android' ? 16 : 10);
  const tabBarHeight = Platform.select({
    ios: 65 + bottomInset,
    default: 62 + bottomInset,
  });

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
          height: tabBarHeight, // [한글 주석: 안드로이드 소프트키 및 노치 대응 동적 높이]
          paddingBottom: bottomInset, // [한글 주석: 갤럭시 하단 시스템 바에 글자/아이콘 가림 방지 여백]
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
        tabBarLabel: t(TAB_LABEL_KEYS[route.name]),
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
