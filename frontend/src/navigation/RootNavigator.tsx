// 공동 소유 — 탭 추가 시 알파벳순 정렬, 팀 공지
// PRD §6 화면 5개: 대시보드 / 재고 / 발주 / 챗봇 / 운영
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, LayoutAnimation, Platform, View } from 'react-native';
import { PressableScale } from '../components/motion';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../auth/AuthContext';
import { navigationRef, navigateToTarget } from '../notifications/navigationTarget';
import { takePendingTarget } from '../notifications/pushRegistration';
import AdminScreen from '../screens/admin/AdminScreen';
import AuthScreen from '../screens/auth/AuthScreen';
import ChatbotScreen from '../screens/chatbot/ChatbotScreen';
import CostScreen from '../screens/cost/CostScreen';
import DashboardScreen from '../screens/dashboard/DashboardScreen';
import DocumentScreen from '../screens/document/DocumentScreen';
import IngredientScreen from '../screens/ingredient/IngredientScreen';
import InventoryScreen from '../screens/inventory/InventoryScreen';
import LegalScreen from '../screens/legal/LegalScreen';
import ManagementScreen from '../screens/management/ManagementScreen';
import ManualSalesScreen from '../screens/sales/ManualSalesScreen';
import MarketingScreen from '../screens/marketing/MarketingScreen';
import MenuScreen from '../screens/menu/MenuScreen';
import OperationScreen from '../screens/operation/OperationScreen';
import OrderScreen from '../screens/order/OrderScreen';
import ProfileScreen from '../screens/profile/ProfileScreen';
import SalesInputScreen from '../screens/sales/SalesInputScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import BrewRoomScreen from '../screens/shop/BrewRoomScreen';
import ShopScreen from '../screens/shop/ShopScreen';
import StaffScreen from '../screens/staff/StaffScreen';
import TaxDraftDetailScreen from '../screens/document/TaxDraftDetailScreen';
import { colors, typography } from '../theme';
import type { TaxEstimate } from '../lib/api/operation';

export type RootTabParamList = {
  Dashboard: undefined;
  // focusIngredientId: 재고 부족 알림에서 넘어올 때 강조·스크롤할 재료
  //   ts: 같은 재료 알림을 다시 눌러도 파라미터가 바뀌어 재실행되도록 하는 클릭 시각
  Inventory: { focusIngredientId?: number; ts?: number } | undefined;
  // prefill: 다른 화면(경영 리포트 등)에서 버튼으로 넘어올 때 입력창에 미리 채울 질문
  //   ts: 같은 질문을 다시 눌러도 파라미터가 바뀌어 재입력되도록 하는 클릭 시각
  Chatbot: { prefill?: string; ts?: number } | undefined;
  Management: undefined;
};

const ADMIN_EMAILS = ['admin@simplem.com'];

const Tab = createBottomTabNavigator<RootTabParamList>();

import BeanOperationScreen from '../screens/operation/BeanOperationScreen';
import MembershipScreen from '../screens/membership/MembershipScreen';
import StaffAccountScreen from '../screens/membership/StaffAccountScreen';
import StoreMapScreen from '../screens/dashboard/StoreMapScreen';

export type RootStackParamList = {
  Tabs: undefined;
  Profile: undefined;
  Ingredient: undefined;
  // focusMenuIds: 매출 입력에서 방금 등록한 메뉴들 — 강조 표시하고 레시피 작성으로 유도
  Menu: { focusMenuIds?: number[] } | undefined;
  SalesInput: undefined;
  ManualSales: undefined;
  // prefillMenu: 투두의 '홍보하러 가기'로 진입 시 홍보할 메뉴명 자동 입력 (ts: 재진입 갱신용)
  Marketing: { prefillMenu?: string; ts?: number } | undefined;
  Cost: undefined;
  Legal: { doc?: 'privacy' | 'terms' } | undefined;
  Document: undefined;
  TaxDraftDetail: { tax: TaxEstimate };
  Operation: undefined;
  Staff: undefined;
  BeanOperation: undefined;
  Membership: undefined;
  StaffAccount: undefined;
  // section: 특정 설정 하위 화면으로 바로 진입 (예: 카드 정산 설정)
  Settings: { section?: 'account' | 'notification' | 'appearance' | 'inquiry' | 'legal' | 'settlement' } | undefined;
  StoreMap: undefined;
  // openVault: 게임 룸에서 '보관함' 버튼으로 들어올 때 보관함 시트를 바로 연다
  Shop: { openVault?: boolean } | undefined;
  BrewRoom: undefined; // 브루의 카페 (게임 룸) — 홈 우상단 버튼
};
const Stack = createNativeStackNavigator<RootStackParamList>();


const ICONS: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'home',
  Inventory: 'file-tray-stacked',
  Chatbot: 'chatbubble-ellipses',
  Management: 'grid',
};

const LABELS: Record<keyof RootTabParamList, string> = {
  Dashboard: '홈',
  Inventory: '재고',
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
    // [한글 주석] 예전에는 35를 박아 뒀는데 기기마다 상태바 높이가 제각각이다
    // (아이폰 다이나믹 아일랜드 59pt, 갤럭시 펀치홀 24~40dp, 플립 커버 화면은 거의 0).
    // 값을 주지 않으면 React Navigation 이 실제 SafeArea inset 을 그대로 쓴다 → 네이티브는 자동에 맡긴다.
    // 웹 미리보기는 진짜 inset 이 0이라 목업 노치에 제목이 가리므로 그때만 고정값을 유지한다.
    headerStatusBarHeight: Platform.OS === 'web' ? 35 : undefined,
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
    // [한글 주석: 계정이 변경될 때(로그아웃 후 타 계정 로그인) key={user.email}을 통해 컴포넌트 트리를 완전히 새로 마운트하여 이전 계정의 화면 메모리 State(영수증, 재고 등)를 리셋합니다]
    // ref/onReady: 푸시 알림을 탭해 앱이 켜진 경우 네비게이터가 준비된 뒤 그 화면으로 보낸다
    // (AlertsWatcher가 컨테이너 바깥에 있어 useNavigation을 못 쓴다 — notifications/navigationTarget.ts)
    <NavigationContainer
      // 직원 계정은 email이 비어 있다(매장 이메일을 노출하지 않으려고).
      // 그대로 두면 직원끼리 전환할 때 이전 화면 상태가 남으므로 이름으로 보완한다.
      key={user.email || `staff:${user.name}`}
      ref={navigationRef}
      onReady={() => {
        const target = takePendingTarget();
        if (target) navigateToTarget(target);
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabsNavigator} />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen name="Ingredient" component={IngredientScreen} options={({ navigation }) => erpHeader('재료 관리', navigation)} />
        <Stack.Screen name="Menu" component={MenuScreen} options={({ navigation }) => erpHeader('메뉴 관리', navigation)} />
        <Stack.Screen name="SalesInput" component={SalesInputScreen} options={({ navigation }) => erpHeader('매출 입력', navigation)} />
        <Stack.Screen name="ManualSales" component={ManualSalesScreen} options={({ navigation }) => erpHeader('직접 입력', navigation)} />
        <Stack.Screen name="Marketing" component={MarketingScreen} options={({ navigation }) => erpHeader('홍보 스튜디오', navigation)} />
        <Stack.Screen name="Cost" component={CostScreen} options={({ navigation }) => erpHeader('원가 분석', navigation)} />
        <Stack.Screen name="Legal" component={LegalScreen} options={({ navigation }) => erpHeader('약관 및 정책', navigation)} />
        <Stack.Screen name="Document" component={DocumentScreen} options={({ navigation }) => erpHeader('서류 자동화', navigation)} />
        <Stack.Screen name="TaxDraftDetail" component={TaxDraftDetailScreen} options={({ navigation }) => erpHeader('세금 신고 초안', navigation)} />
        <Stack.Screen name="Operation" component={OperationScreen} options={({ navigation }) => erpHeader('직원 · 스케줄', navigation)} />
        <Stack.Screen name="Staff" component={StaffScreen} options={({ navigation }) => erpHeader('직원 · 인건비', navigation)} />
        <Stack.Screen name="BeanOperation" component={BeanOperationScreen} options={({ navigation }) => erpHeader('운영 · 원두 실리뷰 분석', navigation)} />
        <Stack.Screen name="Membership" component={MembershipScreen} options={({ navigation }) => erpHeader('단골 · 선불 충전', navigation)} />
        <Stack.Screen name="StaffAccount" component={StaffAccountScreen} options={({ navigation }) => erpHeader('직원 계정', navigation)} />

        <Stack.Screen name="Settings" component={SettingsScreen} options={({ navigation }) => erpHeader('설정', navigation)} />
        <Stack.Screen name="StoreMap" component={StoreMapScreen} options={({ navigation }) => erpHeader('매장 위치', navigation)} />
        <Stack.Screen name="Shop" component={ShopScreen} options={({ navigation }) => erpHeader('포인트 상점', navigation)} />
        {/* 게임 룸 — 배경 그림에 몰입하도록 기본 헤더 없이 자체 상단 바를 쓴다 */}
        <Stack.Screen name="BrewRoom" component={BrewRoomScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation, type TranslationKey } from '../i18n/translations';
import { SwipeableTabWrapper } from '../components/navigation/SwipeableTabWrapper';

const TAB_LABEL_KEYS: Record<keyof RootTabParamList, TranslationKey> = {
  Dashboard: 'tabHome',
  Inventory: 'tabInventory',
  Chatbot: 'tabChatbot',
  Management: 'tabManagement',
};

// [한글 주석: 각 탭 화면을 좌우 슬라이드(스와이프) 감지 래퍼로 감싸주는 헬퍼 컴포넌트]
const withSwipe = (Component: React.ComponentType<any>) => (props: any) => (
  <SwipeableTabWrapper>
    <Component {...props} />
  </SwipeableTabWrapper>
);

const WrappedDashboardScreen = withSwipe(DashboardScreen);
const WrappedInventoryScreen = withSwipe(InventoryScreen);
const WrappedChatbotScreen = withSwipe(ChatbotScreen);
const WrappedManagementScreen = withSwipe(ManagementScreen);

function TabsNavigator() {
  // [한글 주석: 전역 다국어 훅 호출 — 사장님이 선택한 언어(ko/en)에 맞게 하단 탭 메뉴명 동적 가공]
  const { t } = useTranslation();
  // [한글 주석: 갤럭시 등 안드로이드 하단 소프트키/제스처 바 영역 높이 동적 측정 훅]
  const insets = useSafeAreaInsets();

  // [한글 주석: 기기별 하단 안전 여백 보정 — 시스템 제스처/소프트키 인셋(실측값)만 하단에 더하고,
  //  아이콘·라벨 블록 주변의 눈에 보이는 여백은 위·아래 동일하게 유지한다]
  const sysInset = insets.bottom;
  const visualPad = 8; // 아이콘·라벨 블록 위아래 대칭 여백
  const contentHeight = 54; // 아이콘(28) + 간격(2) + 라벨(14) + 아이템 자체 패딩(10)
  const tabBarHeight = contentHeight + visualPad * 2 + sysInset;

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
          paddingBottom: visualPad + sysInset, // [한글 주석: 시스템 바 인셋 + 위와 동일한 대칭 여백]
          paddingTop: visualPad,
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
      <Tab.Screen name="Dashboard" component={WrappedDashboardScreen} />
      <Tab.Screen name="Inventory" component={WrappedInventoryScreen} />
      <Tab.Screen name="Chatbot" component={WrappedChatbotScreen} />
      <Tab.Screen name="Management" component={WrappedManagementScreen} />
    </Tab.Navigator>
  );
}
