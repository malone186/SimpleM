// 단골 회원 · 선불 충전 화면 (사장님용)
//
// [한글 주석] 화면 구성의 근거:
//
//   1. 맨 위는 '뜸해진 단골'이다. 이게 이 기능의 목적이기 때문이다.
//      회원 목록을 먼저 보여주면 사장님이 매일 열어볼 이유가 없다.
//      "오늘 연락할 사람"이 먼저 보여야 습관이 된다.
//
//   2. 선수금은 매출과 분리해서, 부채라는 걸 문구로 명시한다.
//      충전액을 매출로 착각하면 나중에 커피가 나갈 때 매출이 안 잡혀 혼란스럽다.
//
//   3. 검색은 번호 뒷자리로 한다. 계산대에서 이름을 묻는 것보다 빠르다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  chargeBalance,
  createCustomer,
  fetchChargePlans,
  fetchChurnRisk,
  fetchPrepaidSummary,
  searchCustomers,
  useBalance,
  type ChargePlan,
  type ChurnRiskCustomer,
  type Customer,
  type PrepaidSummary,
} from '../../lib/api/membership';
import { sendNotification } from '../../lib/membership/notify';
import { colors } from '../../theme';

const won = (n: number) => `${n.toLocaleString()}원`;

export default function MembershipScreen() {
  const [summary, setSummary] = useState<PrepaidSummary | null>(null);
  const [churn, setChurn] = useState<ChurnRiskCustomer[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<ChargePlan[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 모달
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [target, setTarget] = useState<Customer | null>(null);
  const [useAmount, setUseAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, c, p, list] = await Promise.all([
        fetchPrepaidSummary(30),
        fetchChurnRisk(20),
        fetchChargePlans(),
        searchCustomers(query),
      ]);
      setSummary(s);
      setChurn(c);
      setPlans(p.filter((x) => x.is_active));
      setCustomers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const notify = async (phone: string, text: string) => {
    const r = await sendNotification(phone, text);
    if (!r.ok) Alert.alert('알림 전송', r.reason ?? '전송할 수 없습니다.');
    else if (r.reason) Alert.alert('알림', r.reason);
  };

  const onRegister = async () => {
    if (!newPhone.trim()) return;
    setBusy(true);
    try {
      await createCustomer({ phone: newPhone, name: newName.trim() || undefined });
      setRegisterOpen(false);
      setNewPhone('');
      setNewName('');
      await load();
    } catch (e) {
      Alert.alert('등록 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCharge = async (customer: Customer, plan: ChargePlan) => {
    setBusy(true);
    try {
      const res = await chargeBalance(customer.id, { charge_plan_id: plan.id });
      setTarget(null);
      await load();
      // [한글 주석] 충전 직후 바로 알림을 보낼 수 있게 묻는다.
      // 나중에 따로 보내려면 결국 안 보내게 된다.
      Alert.alert(
        '충전 완료',
        `${won(res.balance)} 잔액이 되었습니다.\n손님께 알림을 보낼까요?`,
        [
          { text: '나중에', style: 'cancel' },
          { text: '알림 보내기', onPress: () => notify(res.phone, res.sms_text) },
        ]
      );
    } catch (e) {
      Alert.alert('충전 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUse = async (customer: Customer) => {
    const amount = parseInt(useAmount.replace(/\D/g, ''), 10);
    if (!amount) return;
    setBusy(true);
    try {
      const res = await useBalance(customer.id, { amount });
      setUseAmount('');
      setTarget(null);
      await load();
      Alert.alert(
        '사용 완료',
        `${won(amount)} 차감 · 잔액 ${won(res.balance)}\n손님께 알림을 보낼까요?`,
        [
          { text: '나중에', style: 'cancel' },
          { text: '알림 보내기', onPress: () => notify(res.phone, res.sms_text) },
        ]
      );
    } catch (e) {
      Alert.alert('사용 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.espressoBrown} />
        <Text style={styles.dim}>단골 정보를 불러오는 중…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
      }
    >
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>불러오지 못했습니다.{'\n'}{error}</Text>
        </View>
      )}

      {/* ① 뜸해진 단골 — 이 기능의 목적이라 맨 위에 둔다 */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="alert-circle-outline" size={16} color="#B23B2E" />
          <Text style={styles.cardTitle}>뜸해진 단골</Text>
          <Text style={styles.badge}>{churn.length}명</Text>
        </View>

        {churn.length === 0 ? (
          <Text style={styles.dim}>
            아직 없습니다. 각 손님의 평소 방문 주기를 알아야 판단할 수 있어
            방문 3회 이상 이력이 쌓이면 표시됩니다.
          </Text>
        ) : (
          <View style={{ gap: 8 }}>
            {churn.map((r) => (
              <View key={r.customer_id} style={styles.churnRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{r.name || r.phone_masked}</Text>
                  <Text style={styles.sub}>
                    평소 {r.median_interval_days}일마다 · <Text style={styles.overdue}>
                      {r.days_since_visit}일째 안 옴 (평소의 {r.overdue_ratio}배)
                    </Text>
                  </Text>
                  {r.balance > 0 && (
                    <Text style={styles.balanceHint}>잔액 {won(r.balance)} 남음</Text>
                  )}
                </View>
                <Pressable
                  style={styles.smsBtn}
                  onPress={() => notify(r.phone, r.sms_text)}
                >
                  <Ionicons name="chatbubble-outline" size={12} color="#FFF" />
                  <Text style={styles.smsBtnText}>알림</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* ② 선수금 — 매출이 아니라 부채임을 명시한다 */}
      {summary && (
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Ionicons name="wallet-outline" size={16} color={colors.mochaBrown} />
            <Text style={styles.cardTitle}>선불 충전 현황</Text>
            <Text style={styles.periodText}>최근 {summary.period_days}일</Text>
          </View>

          <View style={styles.liabilityBox}>
            <Text style={styles.liabilityLabel}>아직 안 쓴 잔액 (갚아야 할 금액)</Text>
            <Text style={styles.liabilityValue}>{won(summary.active_balance_total)}</Text>
            <Text style={styles.liabilityNote}>
              충전액은 매출이 아닙니다. 커피를 드릴 때 매출로 잡힙니다.
            </Text>
          </View>

          <View style={styles.statGrid}>
            <Stat label="실제 입금" value={won(summary.charged_total)} />
            <Stat label="적립 총액" value={won(summary.credited_total)} />
            <Stat label="매출 인식" value={won(summary.used_total)} highlight />
            <Stat label="나간 보너스" value={won(summary.bonus_given)} />
          </View>
        </View>
      )}

      {/* ③ 회원 */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="people-outline" size={16} color={colors.mochaBrown} />
          <Text style={styles.cardTitle}>회원 {summary?.customer_count ?? 0}명</Text>
          <Pressable style={styles.addBtn} onPress={() => setRegisterOpen(true)}>
            <Ionicons name="add" size={13} color="#FFF" />
            <Text style={styles.addBtnText}>회원 등록</Text>
          </Pressable>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search" size={14} color="#9A8F86" />
          <TextInput
            style={styles.searchInput}
            placeholder="번호 뒷자리 또는 이름"
            placeholderTextColor="#B0A79E"
            value={query}
            onChangeText={setQuery}
            keyboardType="default"
          />
        </View>

        {customers.length === 0 ? (
          <Text style={styles.dim}>회원이 없습니다.</Text>
        ) : (
          <View style={{ gap: 6 }}>
            {customers.map((c) => (
              <Pressable key={c.id} style={styles.customerRow} onPress={() => setTarget(c)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{c.name || c.phone_masked}</Text>
                  <Text style={styles.sub}>
                    {c.phone_masked} · 방문 {c.visit_count}회
                    {c.days_since_visit != null ? ` · ${c.days_since_visit}일 전` : ''}
                  </Text>
                </View>
                <Text style={styles.balance}>{won(c.balance)}</Text>
                <Ionicons name="chevron-forward" size={14} color="#B0A79E" />
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* 회원 등록 모달 */}
      <Modal visible={registerOpen} transparent animationType="fade"
             onRequestClose={() => setRegisterOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>회원 등록</Text>
            <TextInput
              style={styles.input}
              placeholder="010-1234-5678"
              placeholderTextColor="#B0A79E"
              value={newPhone}
              onChangeText={setNewPhone}
              keyboardType="phone-pad"
            />
            <TextInput
              style={styles.input}
              placeholder="이름 (선택)"
              placeholderTextColor="#B0A79E"
              value={newName}
              onChangeText={setNewName}
            />
            <Text style={styles.consentNote}>
              번호는 잔액 조회·안내에만 사용합니다. 손님께 동의를 받고 입력해 주세요.
            </Text>
            <View style={styles.sheetBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setRegisterOpen(false)}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
                         onPress={onRegister} disabled={busy}>
                <Text style={styles.primaryText}>등록</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 충전 / 사용 모달 */}
      <Modal visible={!!target} transparent animationType="fade"
             onRequestClose={() => setTarget(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            {!!target && (
              <>
                <Text style={styles.sheetTitle}>{target.name || target.phone_masked}</Text>
                <Text style={styles.sheetBalance}>잔액 {won(target.balance)}</Text>

                <Text style={styles.sectionLabel}>충전</Text>
                {plans.length === 0 ? (
                  <Text style={styles.dim}>
                    충전 상품이 없습니다. 설정에서 먼저 추가해 주세요.
                  </Text>
                ) : (
                  <View style={{ gap: 6 }}>
                    {plans.map((p) => (
                      <Pressable key={p.id} style={styles.planRow}
                                 onPress={() => onCharge(target, p)} disabled={busy}>
                        <Text style={styles.planPay}>{won(p.pay_amount)} 결제</Text>
                        <Ionicons name="arrow-forward" size={12} color="#9A8F86" />
                        <Text style={styles.planCredit}>{won(p.credit_amount)} 적립</Text>
                        <Text style={styles.planRate}>-{p.discount_rate}%</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <Text style={styles.sectionLabel}>사용</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    placeholder="금액"
                    placeholderTextColor="#B0A79E"
                    value={useAmount}
                    onChangeText={setUseAmount}
                    keyboardType="number-pad"
                  />
                  <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
                             onPress={() => onUse(target)} disabled={busy}>
                    <Text style={styles.primaryText}>차감</Text>
                  </Pressable>
                </View>

                <Pressable style={styles.cancelBtn} onPress={() => setTarget(null)}>
                  <Text style={styles.cancelText}>닫기</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, highlight && { color: colors.trendGreenText }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.creamSand },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10,
            backgroundColor: colors.creamSand },
  dim: { fontSize: 12, color: '#9A8F86', lineHeight: 18 },

  errorBox: { backgroundColor: '#FDECEA', borderRadius: 10, padding: 12 },
  errorText: { fontSize: 12, color: '#B23B2E', lineHeight: 18 },

  card: { backgroundColor: '#FFF', borderRadius: 14, padding: 14, gap: 10,
          borderWidth: 1, borderColor: colors.mutedSand },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: 'bold', color: colors.espressoBrown },
  badge: { fontSize: 11, fontWeight: '800', color: '#B23B2E',
           backgroundColor: '#FDECEA', paddingHorizontal: 7, paddingVertical: 2,
           borderRadius: 9, overflow: 'hidden' },
  periodText: { fontSize: 11, color: '#9A8F86', marginLeft: 'auto' },

  churnRow: { flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: '#FDF7F6', borderRadius: 10, padding: 10 },
  name: { fontSize: 13, fontWeight: '700', color: colors.espressoBrown },
  sub: { fontSize: 11, color: '#7A6E65', marginTop: 2, lineHeight: 16 },
  overdue: { color: '#B23B2E', fontWeight: '700' },
  balanceHint: { fontSize: 11, color: colors.trendGreenText, fontWeight: '700', marginTop: 2 },
  smsBtn: { flexDirection: 'row', alignItems: 'center', gap: 3,
            backgroundColor: colors.pointOrange, paddingHorizontal: 10,
            paddingVertical: 7, borderRadius: 8 },
  smsBtnText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  liabilityBox: { backgroundColor: '#FAF8F6', borderRadius: 10, padding: 12, gap: 3 },
  liabilityLabel: { fontSize: 11, color: '#7A6E65' },
  liabilityValue: { fontSize: 22, fontWeight: '900', color: colors.espressoBrown },
  liabilityNote: { fontSize: 10.5, color: '#B0A79E', lineHeight: 15, marginTop: 2 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statBox: { flexGrow: 1, minWidth: '45%', backgroundColor: '#FAF8F6',
             borderRadius: 8, padding: 9 },
  statLabel: { fontSize: 10.5, color: '#9A8F86' },
  statValue: { fontSize: 13, fontWeight: '800', color: colors.espressoBrown, marginTop: 2 },

  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto',
            backgroundColor: colors.pointOrange, paddingHorizontal: 9,
            paddingVertical: 6, borderRadius: 8 },
  addBtnText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 6,
               backgroundColor: '#FAF8F6', borderRadius: 8, paddingHorizontal: 10 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 12.5, color: colors.espressoBrown },

  customerRow: { flexDirection: 'row', alignItems: 'center', gap: 8,
                 paddingVertical: 9, paddingHorizontal: 4,
                 borderBottomWidth: 1, borderBottomColor: '#F2EFEC' },
  balance: { fontSize: 13, fontWeight: '800', color: colors.espressoBrown },

  backdrop: { flex: 1, backgroundColor: colors.black40, justifyContent: 'center',
              alignItems: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 420, backgroundColor: '#FFF',
           borderRadius: 16, padding: 16, gap: 8 },
  sheetTitle: { fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown },
  sheetBalance: { fontSize: 18, fontWeight: '900', color: colors.espressoBrown },
  sectionLabel: { fontSize: 11.5, fontWeight: '700', color: '#7A6E65', marginTop: 8 },

  input: { borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 8,
           paddingHorizontal: 11, paddingVertical: 9, fontSize: 13,
           color: colors.espressoBrown, marginBottom: 6 },
  consentNote: { fontSize: 10.5, color: '#B0A79E', lineHeight: 15 },

  planRow: { flexDirection: 'row', alignItems: 'center', gap: 6,
             backgroundColor: '#FAF8F6', borderRadius: 9, padding: 11 },
  planPay: { fontSize: 12.5, fontWeight: '700', color: colors.espressoBrown },
  planCredit: { fontSize: 12.5, fontWeight: '800', color: colors.trendGreenText },
  planRate: { fontSize: 11, fontWeight: '800', color: colors.pointOrange,
              marginLeft: 'auto' },

  sheetBtns: { flexDirection: 'row', gap: 8, marginTop: 4 },
  cancelBtn: { flex: 1, paddingVertical: 10, borderRadius: 8,
               alignItems: 'center', backgroundColor: '#F2EFEC' },
  cancelText: { fontSize: 12.5, fontWeight: '700', color: '#7A6E65' },
  primaryBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center',
                backgroundColor: colors.pointOrange, justifyContent: 'center' },
  primaryText: { fontSize: 12.5, fontWeight: 'bold', color: '#FFF' },
});
