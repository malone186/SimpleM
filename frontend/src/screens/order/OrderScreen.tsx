// 발주 승인 (프론트 A) — PRD ERP-8, AI-3, §1.4
// AI/챗봇이 만든 발주 '초안'을 사람이 검토 후 확정. 자동 발주 금지.
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Alert, Platform, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import Brew from '../../components/brew/Brew';
import EmptyState from '../../components/brew/EmptyState';
import { PopIn } from '../../components/motion';
import { Badge, Button, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';
import { listOrderDrafts, updateOrderStatus, OrderDraft } from '../../lib/api/inventory';

// 웹과 모바일 환경을 모두 아우르는 알림 팝업 헬퍼 함수
function notify(title: string, message: string) {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n${message}`);
  } else {
    Alert.alert(title, message);
  }
}

export default function OrderScreen() {
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const [loading, setLoading] = useState(true);

  // 로컬 세션 보관소에서 암호화 로그인 출입증(Token)을 획득합니다.
  const getAuthToken = async () => {
    const raw = await AsyncStorage.getItem('simplem:session');
    if (raw) {
      const session = JSON.parse(raw);
      return session?.token || null;
    }
    return null;
  };

  // 백엔드 주방에 물어보고 부족 재고 기반 발주 추천 초안 리스트를 새로 채워옵니다.
  const loadDrafts = async () => {
    try {
      setLoading(true);
      const token = await getAuthToken();
      if (!token) return;

      const data = await listOrderDrafts(token);
      setDrafts(data);
    } catch (e) {
      console.error('발주 추천 목록 조회 실패:', e);
      notify('오류 발생', '발주 추천 정보를 받아오지 못했습니다. 네트워크 연결을 확인하세요.');
    } finally {
      setLoading(false);
    }
  };

  // 화면이 활성화될 때 자동으로 발주 추천을 갱신합니다.
  useEffect(() => {
    loadDrafts();
  }, []);

  // 사장님이 발주안을 승인(확정)하거나 반려(취소)하는 행동을 처리합니다.
  const handleStatusChange = async (id: number, status: 'CONFIRMED' | 'REJECTED') => {
    try {
      const token = await getAuthToken();
      if (!token) return;

      const res = await updateOrderStatus(token, id, status);
      
      // 승인/반려 완료 팝업 알림 후 목록을 새로 갱신합니다.
      notify(status === 'CONFIRMED' ? '승인 및 발주 완료' : '발주 초안 반려', res.message);
      await loadDrafts();
    } catch (e) {
      console.error('발주 처리 에러:', e);
      notify('처리 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 대기 상태(DRAFT)의 발주 초안 개수를 셉니다.
  const pendingCount = drafts.filter((d) => d.status === 'DRAFT').length;
  const allSettled = drafts.length > 0 && pendingCount === 0;

  // 1. 데이터 로딩 화면
  if (loading) {
    return (
      <Screen>
        <ScreenTitle title="발주 승인" />
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.espressoBrown} />
          <Text style={styles.loadingText}>실시간 매장 재고 현황을 분석하고 있어요...</Text>
        </View>
      </Screen>
    );
  }

  // 2. 추천할 발주가 아예 없는 안전한 상태 — 턱 괸 브루 빈 화면 (#2)
  if (drafts.length === 0) {
    return (
      <Screen>
        <ScreenTitle title="발주 승인" />
        <EmptyState
          mood="resting"
          title="지금은 검토할 발주가 없어요"
          description="모든 식재료 재고가 안전 수량 이상으로 넉넉해요. 재고가 부족해지면 브루가 여기에 추천 발주안을 올릴게요."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenTitle title="발주 승인" subtitle={`검토 대기 ${pendingCount}건 · 승인해야 발주가 확정돼요`} />

      {/* 모두 처리한 순간 — 웃는 브루 + 하트 (#6 성취) */}
      {allSettled && (
        <PopIn>
          <Card tone="cream" style={styles.celebrate}>
            <Brew mood="happy" size={64} />
            <View style={{ flex: 1 }}>
              <Text style={styles.celebrateTitle}>오늘 발주를 다 처리했어요! 💛</Text>
              <Text style={styles.celebrateSub}>브루가 부족한 창고를 다 채워 넣었어요. 고생하셨어요 사장님!</Text>
            </View>
          </Card>
        </PopIn>
      )}

      {drafts.map((d) => {
        return (
          <Card key={d.id} style={d.status !== 'DRAFT' ? styles.settled : undefined}>
            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.vendor}>{d.vendor}</Text>
                <Text style={styles.reason}>{d.reason}</Text>
              </View>
              {d.status === 'DRAFT' && <Badge label={d.source} tone="orange" />}
              {d.status === 'CONFIRMED' && <Badge label="발주 확정" tone="green" />}
              {d.status === 'REJECTED' && <Badge label="반려됨" tone="neutral" />}
            </View>

            <View style={styles.itemBox}>
              {d.items.map((it, i) => (
                <View key={i} style={styles.itemRow}>
                  <Text style={styles.itemName}>{it.ingredient_name}</Text>
                  <Text style={styles.itemQty}>{it.quantity}개</Text>
                  <Text style={styles.itemPrice}>₩{(it.quantity * it.price_at_order).toLocaleString()}</Text>
                </View>
              ))}
              <Divider />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>합계</Text>
                <Text style={styles.totalValue}>₩{d.total_amount.toLocaleString()}</Text>
              </View>
            </View>

            {d.status === 'DRAFT' ? (
              <View style={styles.actions}>
                <Button
                  label="반려"
                  variant="secondary"
                  onPress={() => handleStatusChange(d.id, 'REJECTED')}
                  style={{ flex: 1 }}
                />
                <Button
                  label="승인하고 발주"
                  onPress={() => handleStatusChange(d.id, 'CONFIRMED')}
                  style={{ flex: 1.6 }}
                />
              </View>
            ) : (
              <View style={styles.settledRow}>
                <Ionicons
                  name={d.status === 'CONFIRMED' ? 'checkmark-circle' : 'close-circle'}
                  size={16}
                  color={d.status === 'CONFIRMED' ? colors.trendGreenText : colors.mochaBrown}
                />
                <Text style={styles.settledText}>
                  {d.status === 'CONFIRMED' ? '발주가 확정되어 실제 재고에 반영되었습니다' : '초안을 반려했습니다'}
                </Text>
              </View>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  loadingText: { marginTop: 12, color: colors.mochaBrown, ...typography.L4 },
  settled: { opacity: 0.72 },
  celebrate: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  celebrateTitle: { ...typography.L3, color: colors.espressoBrown },
  celebrateSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, lineHeight: 15 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  vendor: { ...typography.L3, color: colors.espressoBrown },
  reason: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, lineHeight: 15 },
  itemBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  itemName: { ...typography.L5, color: colors.espressoBrown, flex: 1 },
  itemQty: { ...typography.L5, color: colors.mochaBrown, width: 52, textAlign: 'right' },
  itemPrice: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 76, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { ...typography.L4, color: colors.mochaBrown },
  totalValue: { ...typography.L3, color: colors.pointOrange },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  settledRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  settledText: { ...typography.L5, color: colors.mochaBrown },
});

