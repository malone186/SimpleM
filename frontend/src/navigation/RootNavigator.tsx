// 공동 소유 — 화면 추가 시 알파벳순으로 Stack.Screen 추가, 팀 공지
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import ChatbotScreen from '../screens/chatbot/ChatbotScreen';
import DashboardScreen from '../screens/dashboard/DashboardScreen';
import InventoryScreen from '../screens/inventory/InventoryScreen';
import SchedulePayrollScreen from '../screens/operation/schedule-payroll/SchedulePayrollScreen';
import TaxScreen from '../screens/operation/tax/TaxScreen';
import OrderScreen from '../screens/order/OrderScreen';

export type RootStackParamList = {
  Chatbot: undefined;
  Dashboard: undefined;
  Inventory: undefined;
  Order: undefined;
  SchedulePayroll: undefined;
  Tax: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Dashboard">
        <Stack.Screen name="Chatbot" component={ChatbotScreen} options={{ title: '챗봇' }} />
        <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ title: '대시보드' }} />
        <Stack.Screen name="Inventory" component={InventoryScreen} options={{ title: '재고' }} />
        <Stack.Screen name="Order" component={OrderScreen} options={{ title: '발주' }} />
        <Stack.Screen name="SchedulePayroll" component={SchedulePayrollScreen} options={{ title: '스케줄 · 급여' }} />
        <Stack.Screen name="Tax" component={TaxScreen} options={{ title: '세금' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
