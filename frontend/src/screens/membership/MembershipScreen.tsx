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
import { SvgXml } from 'react-native-svg';
import * as Print from 'expo-print';

import {
  chargeBalance,
  createChargePlan,
  createCustomer,
  deleteChargePlan,
  deleteCustomer,
  dismissCheckIn,
  fetchChargePlans,
  fetchCheckIns,
  fetchCostAnalysis,
  fetchChurnRisk,
  fetchPrepaidSummary,
  fetchStoreQr,
  fetchQuickMenus,
  issueCoupon,
  fetchRefundEstimate,
  refundBalance,
  searchCustomers,
  useBalance,
  type ChargePlan,
  type CheckIn,
  type ChurnRiskCustomer,
  type CostAnalysis,
  type Customer,
  type PrepaidSummary,
  type QuickMenu,
  type StoreQr,
} from '../../lib/api/membership';
import { sendNotification } from '../../lib/membership/notify';
import { showAlert } from '../../lib/ui/alert';
import { useAuth } from '../../auth/AuthContext';
import { colors } from '../../theme';

const won = (n: number) => `${n.toLocaleString()}원`;

export default function MembershipScreen() {
  const { token, user } = useAuth();
  // 직원(알바) 계정이면 재무·마케팅·상품설계는 감춘다. 계산대에서 필요한 건
  // 대기 손님 결제 / 충전 상품으로 충전 / 회원 등록뿐이다. (RootNavigator가 화면
  // 자체를 이 하나로 제한하고, 여기서는 화면 안의 사장님 전용 카드를 걸러낸다.)
  const isStaff = !!user?.isStaff;
  // [한글 주석] 선불 현황 카드는 팀 요청으로 화면에서 뺐다.
  // summary는 '회원 N명' 숫자 하나 때문에 남겨 둔다 —
  // 회원 목록은 50개까지만 받으므로 그걸로 세면 51명부터 틀린다.
  // 백엔드의 선수금/매출 분리 계산은 그대로 둔다. 화면에 안 보이는 것과
  // 숫자를 안 나누는 것은 다른 문제이고, 섞여서 쌓이면 되돌릴 수 없다.
  const [summary, setSummary] = useState<PrepaidSummary | null>(null);
  const [churn, setChurn] = useState<ChurnRiskCustomer[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<ChargePlan[]>([]);
  const [menus, setMenus] = useState<QuickMenu[]>([]);
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [storeQr, setStoreQr] = useState<StoreQr | null>(null);
  const [cost, setCost] = useState<CostAnalysis | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 모달
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  // [한글 주석] 사장님이 손님 번호를 '대신' 입력하는 경로다.
  // 손님이 직접 넣는 QR 경로에는 동의 체크가 있는데 여기는 없었다.
  // 동의를 받았다는 근거가 앱 어디에도 남지 않으면 구조적으로 비어 있는 것이다.
  const [newAgree, setNewAgree] = useState(false);
  const [target, setTarget] = useState<Customer | null>(null);
  const [useAmount, setUseAmount] = useState('');
  const [busy, setBusy] = useState(false);

  // 충전 상품 만들기
  const [planOpen, setPlanOpen] = useState(false);
  const [payInput, setPayInput] = useState('');
  const [creditInput, setCreditInput] = useState('');

  const payNum = parseInt(payInput.replace(/\D/g, ''), 10) || 0;
  const creditNum = parseInt(creditInput.replace(/\D/g, ''), 10) || 0;
  // [한글 주석] 할인율은 적립액 기준이다.
  // 5만원 내고 6만원어치를 받으면 손님이 체감하는 할인은 20%가 아니라 16.7%다.
  // 결제액 기준으로 표시하면 실제보다 크게 보여 마진 판단을 그르친다.
  const planDiscount = creditNum > 0 ? ((creditNum - payNum) / creditNum) * 100 : 0;
  const planValid = payNum > 0 && creditNum >= payNum;

  const load = useCallback(async () => {
    // [한글 주석] 토큰이 아직 복원되지 않은 첫 렌더에서 호출하면 401이 뜬다.
    // 로딩 상태를 유지하고 토큰이 들어온 뒤 다시 시도한다.
    if (!token) return;
    setError(null);
    try {
      // 선수금 현황·뜸해진 단골·실질 원가율은 사장님 전용 API(require_owner)라 직원이
      // 부르면 403이 나 화면 상단에 에러가 뜬다. 어차피 직원에겐 감추는 카드이므로
      // 아예 호출하지 않고 안전한 기본값을 쓴다.
      const [p, list, m, ci] = await Promise.all([
        fetchChargePlans(token),
        searchCustomers(token, query),
        fetchQuickMenus(token).catch(() => [] as QuickMenu[]),
        fetchCheckIns(token).catch(() => [] as CheckIn[]),
      ]);
      const [s, c, ca] = isStaff
        ? [null, [] as ChurnRiskCustomer[], null]
        : await Promise.all([
            fetchPrepaidSummary(token, 30),
            fetchChurnRisk(token, 20),
            fetchCostAnalysis(token, 90).catch(() => null),
          ]);
      setSummary(s);
      setChurn(c);
      setPlans(p.filter((x) => x.is_active));
      setCustomers(list);
      setMenus(m);
      setCheckins(ci);
      setCost(ca);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, query, isStaff]);

  useEffect(() => {
    load();
  }, [load]);

  const notify = async (phone: string, text: string) => {
    const r = await sendNotification(phone, text);
    if (!r.ok) {
      // [한글 주석] 복사가 실패했으면 문구를 그대로 보여준다.
      // "복사 실패"만 알리면 사장님이 할 수 있는 게 없다.
      showAlert('알림 문구', r.text ? `${r.reason}

${r.text}` : (r.reason ?? '전송할 수 없습니다.'));
    } else if (r.reason) {
      showAlert('알림', r.reason);
    }
  };

  // [한글 주석] 잔액 0원 손님에게만 쿠폰을 준다.
  // 잔액이 있으면 서버가 거부하지만, 화면에서도 버튼을 안 띄워 헛손질을 막는다.
  const onIssueCoupon = (r: ChurnRiskCustomer) => {
    const menu = menus[0];
    const title = menu ? `${menu.name} 1잔 무료` : '음료 1잔 무료';
    showAlert(
      '쿠폰 발급',
      `${r.name || r.phone_masked}님께 "${title}" 쿠폰을 드립니다.
` +
      `30일간 유효하며, 잔액과는 별개로 관리됩니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '발급하고 알림',
          onPress: async () => {
            try {
              const res = await issueCoupon(token!, r.customer_id, {
                title,
                amount: menu?.price ?? 0,
                menu_id: menu?.id,
                reason: `${r.days_since_visit}일째 미방문`,
              });
              await load();
              await notify(res.phone, res.sms_text);
            } catch (e) {
              showAlert('발급 실패', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]
    );
  };

  const onRegister = async () => {
    if (!newPhone.trim() || !newAgree) return;
    setBusy(true);
    try {
      await createCustomer(token!, { phone: newPhone, name: newName.trim() || undefined });
      setRegisterOpen(false);
      setNewPhone('');
      setNewName('');
      setNewAgree(false);
      await load();
    } catch (e) {
      showAlert('등록 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCreatePlan = async () => {
    if (!planValid) return;
    setBusy(true);
    try {
      await createChargePlan(token!, { pay_amount: payNum, credit_amount: creditNum });
      setPlanOpen(false);
      setPayInput('');
      setCreditInput('');
      await load();
    } catch (e) {
      showAlert('상품 추가 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeletePlan = (plan: ChargePlan) => {
    // [한글 주석] 실제로 지우지 않고 비활성화한다.
    // 이 상품으로 이미 충전한 거래가 남아 있어, 지우면 이력에서 근거가 사라진다.
    showAlert(
      '충전 상품 삭제',
      `${won(plan.pay_amount)} → ${won(plan.credit_amount)} 상품을 더 이상 쓰지 않으시겠어요?\n지난 충전 기록은 그대로 남습니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteChargePlan(token!, plan.id);
              await load();
            } catch (e) {
              showAlert('삭제 실패', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]
    );
  };

  // [한글 주석] 충전 전에 조건을 손님에게 알린다.
  //
  //   손님은 "6만원이 적립됐으니 내 돈 6만원"이라고 생각한다.
  //   나중에 환불받을 때 2.5만원만 나오면 그때 처음 알게 되고, 그게 분쟁이 된다.
  //   약관 조항을 쓰는 건 법적 판단이 필요하지만, '얼마가 보너스인지'를
  //   충전 전에 알리는 건 사실 전달이라 지금 할 수 있다.
  //   손님이 모르고 넣었다가 나중에 아는 상황만 막아도 분쟁 대부분이 사라진다.
  const confirmAndCharge = (customer: Customer, plan: ChargePlan) => {
    if (plan.bonus_amount <= 0) {
      onCharge(customer, plan);
      return;
    }
    showAlert(
      '충전 전 손님께 안내',
      `결제 ${won(plan.pay_amount)} → 적립 ${won(plan.credit_amount)}
` +
      `이 중 ${won(plan.bonus_amount)}은 보너스입니다.

` +
      `· 이 매장에서만 사용하실 수 있습니다
` +
      `· 환불 시에는 실제 결제하신 금액을 기준으로 계산됩니다
` +
      `· 잔액은 문자로 보내드리는 링크에서 확인하실 수 있습니다`,
      [
        { text: '취소', style: 'cancel' },
        { text: '안내함 · 충전', onPress: () => onCharge(customer, plan) },
      ]
    );
  };

  const onCharge = async (customer: Customer, plan: ChargePlan) => {
    setBusy(true);
    try {
      const res = await chargeBalance(token!, customer.id, { charge_plan_id: plan.id });
      setTarget(null);
      await load();
      // [한글 주석] 충전 직후 바로 알림을 보낼 수 있게 묻는다.
      // 나중에 따로 보내려면 결국 안 보내게 된다.
      showAlert(
        '충전 완료',
        `${won(res.balance)} 잔액이 되었습니다.\n손님께 알림을 보낼까요?`,
        [
          { text: '나중에', style: 'cancel' },
          { text: '알림 보내기', onPress: () => notify(res.phone, res.sms_text) },
        ]
      );
    } catch (e) {
      showAlert('충전 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteCustomer = (customer: Customer) => {
    // [한글 주석] 잔액이 남아 있으면 서버가 거부한다.
    // 화면에서도 미리 알려 헛손질과 불안을 줄인다.
    const who = customer.name || customer.phone_masked;
    const warn = customer.balance > 0
      ? `잔액 ${won(customer.balance)}이 남아 있어 삭제할 수 없습니다.
먼저 환불 처리해 주세요.`
      : `${who}님을 목록에서 지웁니다.
이용 기록이 있으면 기록은 남고 목록에서만 숨겨집니다.`;

    showAlert('회원 삭제', warn, customer.balance > 0 ? [{ text: '확인' }] : [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          try {
            const r = await deleteCustomer(token!, customer.id);
            setTarget(null);
            await load();
            showAlert('완료', r.message);
          } catch (e) {
            showAlert('삭제 실패', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  };

  const onRefund = (customer: Customer) => {
    // [한글 주석] 환불은 되돌릴 수 없는 현금 지출이라 두 단계로 확인한다.
    // 보너스를 뺀 기준액을 먼저 보여줘 사장님이 근거를 알고 결정하게 한다.
    (async () => {
      try {
        const est = await fetchRefundEstimate(token!, customer.id);
        const bonusNote = est.bonus_excluded > 0
          ? `

적립 보너스 ${won(est.bonus_excluded)}은 실제로 받은 돈이 아니라 제외한 금액입니다.`
          : '';
        // [한글 주석] 잔액에서 빼는 금액과 건네는 현금이 다르다.
        // 잔액 60,000(실제 낸 돈 50,000)이면 잔액은 60,000이 사라지고 현금은 50,000이 나간다.
        // 둘을 같은 값으로 보내면 보너스가 남아 다음 환불에서 또 계산돼 돈이 샌다.
        showAlert(
          '잔액 환불',
          `잔액 ${won(est.balance)}을 모두 차감하고
현금 ${won(est.suggested)}을 돌려드립니다.` +
          bonusNote +
          `

환불 기준은 매장 약관에 따라 다를 수 있습니다.`,
          [
            { text: '취소', style: 'cancel' },
            {
              text: `${won(est.suggested)} 환불`,
              style: 'destructive',
              onPress: async () => {
                try {
                  await refundBalance(token!, customer.id,
                    { amount: est.balance, memo: '고객 요청 환불' });
                  setTarget(null);
                  await load();
                  showAlert('환불 완료', `현금 ${won(est.suggested)}을 환불 처리했습니다.`);
                } catch (e) {
                  showAlert('환불 실패', e instanceof Error ? e.message : String(e));
                }
              },
            },
          ]
        );
      } catch (e) {
        showAlert('오류', e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const onUse = async (customer: Customer, presetAmount?: number, memo?: string,
                       menuId?: number) => {
    const amount = presetAmount ?? parseInt(useAmount.replace(/\D/g, ''), 10);
    if (!amount) return;
    setBusy(true);
    try {
      const res = await useBalance(token!, customer.id, { amount, memo, menu_id: menuId });
      setUseAmount('');
      setTarget(null);
      await load();
      showAlert(
        '사용 완료',
        `${won(amount)} 차감 · 잔액 ${won(res.balance)}\n손님께 알림을 보낼까요?`,
        [
          { text: '나중에', style: 'cancel' },
          { text: '알림 보내기', onPress: () => notify(res.phone, res.sms_text) },
        ]
      );
    } catch (e) {
      showAlert('사용 실패', e instanceof Error ? e.message : String(e));
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

      {/* ⓪ 결제 요청 대기 — 계산대에서 지금 당장 처리할 일이라 최상단에 둔다.
             손님이 QR을 찍고 누르면 여기 뜬다. 구두로 이름·번호를 묻지 않아도 된다. */}
      {checkins.length > 0 && (
        <View style={[styles.card, styles.waitCard]}>
          <View style={styles.cardHead}>
            <Ionicons name="hand-left-outline" size={16} color={colors.pointOrange} />
            <Text style={styles.cardTitle}>손님 요청</Text>
            <Text style={styles.waitBadge}>{checkins.length}명 대기</Text>
          </View>
          <View style={{ gap: 8 }}>
            {checkins.map((ci) => {
              // [한글 주석] 회원 목록은 50명까지만 받는다. 회원이 그보다 많으면
              // 대기 중인 손님이 목록 밖에 있을 수 있으므로, 없으면 대기 정보로
              // 바로 만들어 쓴다. 결제 모달에 필요한 값(id·이름·잔액)은 다 들어있다.
              const c: Customer =
                customers.find((x) => x.id === ci.customer_id) ?? {
                  id: ci.customer_id,
                  phone: ci.phone,
                  phone_masked: ci.phone_masked,
                  name: ci.name,
                  balance: ci.balance,
                  memo: null,
                  is_active: true,
                  created_at: '',
                  visit_count: 0,
                  last_visit_at: null,
                  days_since_visit: null,
                };
              return (
                <View key={ci.checkin_id} style={styles.waitRow}>
                  <Pressable style={{ flex: 1 }} onPress={() => setTarget(c)}>
                    <Text style={styles.waitName}>
                      {ci.name || ci.phone_masked}
                      {ci.is_signup && <Text style={styles.newTag}>  신규</Text>}
                    </Text>
                    {/* [한글 주석] 신규 등록은 충전부터 해야 하고,
                        기존 회원은 메뉴를 눌러 차감하면 된다. 할 일이 다르므로 문구를 나눈다. */}
                    <Text style={styles.sub}>
                      {ci.is_signup
                        ? `${ci.phone_masked} · 충전이 필요합니다`
                        : `잔액 ${won(ci.balance)}`}
                      {ci.waited_minutes > 0 ? ` · ${ci.waited_minutes}분 전` : ' · 방금'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.waitBtn} onPress={() => setTarget(c)}>
                    <Text style={styles.waitBtnText}>{ci.is_signup ? '충전' : '결제'}</Text>
                  </Pressable>
                  <Pressable
                    hitSlop={8}
                    onPress={async () => {
                      await dismissCheckIn(token!, ci.checkin_id);
                      await load();
                    }}
                  >
                    <Ionicons name="close" size={16} color="#B0A79E" />
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* ① 뜸해진 단골 — 이 기능의 목적이라 맨 위에 둔다. 직원에겐 숨긴다(단골 관리·문자
             발송은 사장님 마케팅 판단이라 계산대 업무가 아니다). */}
      {!isStaff && (
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
                  {r.balance > 0 ? (
                    <Text style={styles.balanceHint}>잔액 {won(r.balance)} 남음</Text>
                  ) : r.coupon_title ? (
                    <Text style={styles.couponHint}>🎟 {r.coupon_title}</Text>
                  ) : (
                    <Text style={styles.noReasonHint}>잔액 없음 · 올 이유가 없습니다</Text>
                  )}
                </View>
                {/* [한글 주석] 잔액 0원이고 쿠폰도 없는 손님에게만 쿠폰 버튼을 띄운다.
                    잔액이 있으면 이미 올 이유가 있어 쿠폰은 이중 혜택이다. */}
                {r.needs_coupon && (
                  <Pressable style={styles.couponBtn} onPress={() => onIssueCoupon(r)}>
                    <Text style={styles.couponBtnText}>쿠폰</Text>
                  </Pressable>
                )}
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
      )}

      {/* 실질 원가율 — 선불 회원제가 남는 장사인지 판단하는 숫자. 마진 정보라 직원에겐 숨긴다. */}
      {!isStaff && cost?.has_data && (
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Ionicons name="calculator-outline" size={16} color={colors.mochaBrown} />
            <Text style={styles.cardTitle}>선불 고객 실질 원가율</Text>
            <Text style={styles.periodText}>최근 {cost.period_days}일</Text>
          </View>

          {/* [한글 주석] 메뉴판 원가율과 나란히 둔다.
              충전 보너스로 깎인 몫이 몇 %p인지 눈으로 보여야 판단이 된다. */}
          <View style={styles.rateRow}>
            <View style={styles.rateBox}>
              <Text style={styles.rateLabel}>메뉴판 기준</Text>
              <Text style={styles.rateValue}>{cost.list_cost_rate}%</Text>
            </View>
            <Ionicons name="arrow-forward" size={14} color="#B0A79E" />
            <View style={[styles.rateBox, styles.rateBoxMain]}>
              <Text style={styles.rateLabel}>실질 (할인 반영)</Text>
              <Text style={[styles.rateValue, styles.rateValueMain]}>
                {cost.real_cost_rate}%
              </Text>
            </View>
          </View>

          <Text style={styles.rateNote}>
            충전 보너스 {cost.discount_rate}% 때문에 실제 받는 돈이 적어
            원가율이 {Math.round((cost.real_cost_rate - cost.list_cost_rate) * 10) / 10}%p 높습니다.
            {cost.normal_cost_rate != null
              ? ` 일반 판매는 ${cost.normal_cost_rate}%입니다.`
              : ''}
          </Text>

          {cost.items.length > 0 && (
            <View style={{ gap: 5, marginTop: 4 }}>
              {cost.items.slice(0, 5).map((it) => (
                <View key={it.menu_id} style={styles.costItem}>
                  <Text style={styles.costName} numberOfLines={1}>{it.name}</Text>
                  <Text style={styles.costCount}>{it.count}잔</Text>
                  <Text style={[
                    styles.costRate,
                    it.real_cost_rate >= 40 && { color: '#B23B2E' },
                  ]}>
                    {it.real_cost_rate}%
                  </Text>
                </View>
              ))}
            </View>
          )}

          {cost.unknown_count > 0 && (
            <Text style={styles.dim}>
              메뉴 없이 금액만 차감한 {cost.unknown_count}건({won(cost.unknown_sales)})은
              원가를 알 수 없어 제외했습니다.
            </Text>
          )}
        </View>
      )}

      {/* 계산대 QR — 손님이 자기 폰으로 찍는다 (우리 앱엔 카메라가 필요 없다).
             직원도 본다 — 계산대에 서는 사람이 손님에게 이 QR을 보여줘야 결제 요청이
             시작된다. 조회는 읽기 전용이라(백엔드 store-qr을 get_current_user로) 안전하다. */}
      <Pressable
        style={styles.qrCta}
        onPress={async () => {
          try {
            if (!storeQr) setStoreQr(await fetchStoreQr(token!));
            setQrOpen(true);
          } catch (e) {
            showAlert('QR 오류', e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <Ionicons name="qr-code-outline" size={18} color={colors.espressoBrown} />
        <View style={{ flex: 1 }}>
          <Text style={styles.qrCtaTitle}>계산대 QR</Text>
          <Text style={styles.qrCtaSub}>
            붙여두면 손님이 폰으로 찍어 결제 요청을 보냅니다
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color="#B0A79E" />
      </Pressable>

      {/* ③ 충전 상품 — 사장님이 직접 설계한다 */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="pricetags-outline" size={16} color={colors.mochaBrown} />
          <Text style={styles.cardTitle}>충전 상품</Text>
          {/* 상품 설계·삭제는 사장님만. 직원은 만들어진 상품을 골라 충전만 한다. */}
          {!isStaff && (
            <Pressable style={styles.addBtn} onPress={() => setPlanOpen(true)}>
              <Ionicons name="add" size={13} color="#FFF" />
              <Text style={styles.addBtnText}>상품 추가</Text>
            </Pressable>
          )}
        </View>

        {plans.length === 0 ? (
          <Text style={styles.dim}>
            아직 없습니다. 예를 들어 "5만원 결제 → 6만원 적립"처럼 만들어 두면
            충전할 때 눌러서 쓰실 수 있습니다.
          </Text>
        ) : (
          <View style={{ gap: 6 }}>
            {plans.map((p) => (
              <View key={p.id} style={styles.planManageRow}>
                <Text style={styles.planPay}>{won(p.pay_amount)}</Text>
                <Ionicons name="arrow-forward" size={12} color="#9A8F86" />
                <Text style={styles.planCredit}>{won(p.credit_amount)}</Text>
                <Text style={styles.planBonus}>+{won(p.bonus_amount)}</Text>
                <Text style={styles.planRate}>-{p.discount_rate}%</Text>
                {!isStaff && (
                  <Pressable onPress={() => onDeletePlan(p)} hitSlop={8}>
                    <Ionicons name="trash-outline" size={14} color="#B0A79E" />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}
      </View>

      {/* ④ 회원 */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="people-outline" size={16} color={colors.mochaBrown} />
          {/* 직원은 요약(summary)을 못 불러오므로 검색 목록 수로 대신 표시한다 */}
          <Text style={styles.cardTitle}>회원 {summary?.customer_count ?? customers.length}명</Text>
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

      {/* 계산대 QR 모달 */}
      <Modal visible={qrOpen} transparent animationType="fade"
             onRequestClose={() => setQrOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>계산대 QR</Text>
            <Text style={styles.dim}>
              인쇄해서 계산대에 붙여 두세요. 손님이 폰 카메라로 찍으면
              결제 요청이 이 화면 맨 위에 뜹니다.
            </Text>

            {!!storeQr?.svg && (
              <View style={styles.qrBox}>
                <SvgXml xml={storeQr.svg} width={200} height={200} />
              </View>
            )}

            <Text style={styles.qrUrl} selectable numberOfLines={2}>
              {storeQr?.url}
            </Text>

            <View style={styles.sheetBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setQrOpen(false)}>
                <Text style={styles.cancelText}>닫기</Text>
              </Pressable>
              <Pressable
                style={styles.primaryBtn}
                onPress={async () => {
                  if (!storeQr) return;
                  try {
                    // [한글 주석] SVG를 그대로 인쇄한다. 비트맵으로 바꾸면
                    // A4로 크게 뽑을 때 가장자리가 뭉개져 스캔 실패가 는다.
                    await Print.printAsync({
                      html: `<html><body style="margin:0;display:flex;flex-direction:column;
                        align-items:center;justify-content:center;height:100vh;
                        font-family:-apple-system,'Malgun Gothic',sans-serif;">
                        <div style="font-size:28px;font-weight:700;margin-bottom:8px;">
                          ${storeQr.store_name ?? '선불 회원'}</div>
                        <div style="font-size:16px;color:#666;margin-bottom:24px;">
                          카메라로 찍어 잔액 결제를 요청하세요</div>
                        ${storeQr.svg}
                      </body></html>`,
                    });
                  } catch (e) {
                    showAlert('인쇄 실패', e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                <Text style={styles.primaryText}>인쇄</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 충전 상품 만들기 모달 */}
      <Modal visible={planOpen} transparent animationType="fade"
             onRequestClose={() => setPlanOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>충전 상품 만들기</Text>

            <Text style={styles.fieldLabel}>손님이 내는 금액</Text>
            <TextInput
              style={styles.input}
              placeholder="50000"
              placeholderTextColor="#B0A79E"
              value={payInput}
              onChangeText={setPayInput}
              keyboardType="number-pad"
            />

            <Text style={styles.fieldLabel}>잔액으로 적립될 금액</Text>
            <TextInput
              style={styles.input}
              placeholder="60000"
              placeholderTextColor="#B0A79E"
              value={creditInput}
              onChangeText={setCreditInput}
              keyboardType="number-pad"
            />

            {/* [한글 주석] 입력하는 동안 할인율을 바로 보여준다.
                이 숫자가 곧 마진에서 깎이는 몫이라, 저장 전에 판단할 수 있어야 한다. */}
            {payNum > 0 && creditNum > 0 && (
              <View style={[styles.previewBox, !planValid && styles.previewBad]}>
                {planValid ? (
                  <>
                    <Text style={styles.previewMain}>
                      {won(payNum)} → {won(creditNum)}
                    </Text>
                    <Text style={styles.previewSub}>
                      보너스 {won(creditNum - payNum)} · 실질 할인 {planDiscount.toFixed(1)}%
                    </Text>
                    <Text style={styles.previewNote}>
                      적립액 기준입니다. 4,500원 커피가 손님에겐{' '}
                      {Math.round(4500 * (1 - planDiscount / 100)).toLocaleString()}원꼴이 됩니다.
                    </Text>
                  </>
                ) : (
                  <Text style={styles.previewBadText}>
                    적립액이 결제액보다 적습니다. 손님이 손해 보는 상품입니다.
                  </Text>
                )}
              </View>
            )}

            <View style={styles.sheetBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setPlanOpen(false)}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, (!planValid || busy) && { opacity: 0.4 }]}
                onPress={onCreatePlan}
                disabled={!planValid || busy}
              >
                <Text style={styles.primaryText}>추가</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

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
            {/* [한글 주석] 사실만 고지한다 — 무엇에 쓰는지, 손님이 뭘 할 수 있는지.
                약관 조항은 법적 판단이 필요하므로 여기서는 쓰지 않는다. */}
            <View style={styles.consentBox}>
              <Text style={styles.consentTitle}>손님께 이렇게 안내해 주세요</Text>
              <Text style={styles.consentItem}>· 번호는 잔액 조회와 안내 문자에만 씁니다</Text>
              <Text style={styles.consentItem}>· 손님은 문자로 받은 링크로 잔액을 확인할 수 있습니다</Text>
              <Text style={styles.consentItem}>· 원하시면 언제든 삭제해 드립니다</Text>
            </View>
            <Pressable
              style={styles.agreeRow}
              onPress={() => setNewAgree((v) => !v)}
            >
              <Ionicons
                name={newAgree ? 'checkbox' : 'square-outline'}
                size={18}
                color={newAgree ? colors.pointOrange : '#B0A79E'}
              />
              <Text style={styles.agreeText}>
                손님께 안내하고 동의를 받았습니다
              </Text>
            </Pressable>
            <View style={styles.sheetBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setRegisterOpen(false)}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, (busy || !newAgree) && { opacity: 0.4 }]}
                onPress={onRegister}
                disabled={busy || !newAgree}
              >
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
                  <Pressable
                    onPress={() => { setTarget(null); setPlanOpen(true); }}
                    style={styles.emptyPlanBtn}
                  >
                    <Ionicons name="add-circle-outline" size={14} color={colors.pointOrange} />
                    <Text style={styles.emptyPlanText}>
                      충전 상품이 없습니다. 눌러서 만드세요.
                    </Text>
                  </Pressable>
                ) : (
                  <View style={{ gap: 6 }}>
                    {plans.map((p) => (
                      <Pressable key={p.id} style={styles.planRow}
                                 onPress={() => confirmAndCharge(target, p)} disabled={busy}>
                        <Text style={styles.planPay}>{won(p.pay_amount)} 결제</Text>
                        <Ionicons name="arrow-forward" size={12} color="#9A8F86" />
                        <Text style={styles.planCredit}>{won(p.credit_amount)} 적립</Text>
                        <Text style={styles.planRate}>-{p.discount_rate}%</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <Text style={styles.sectionLabel}>사용</Text>

                {/* [한글 주석] 차감은 방문할 때마다 일어난다. 금액을 손으로 치면
                    매번 몇 초가 들고 오타로 엉뚱한 금액이 빠질 수도 있다.
                    메뉴를 누르면 금액과 메모가 한 번에 채워져,
                    손님 이용 내역도 '4,500원 사용'이 아니라 '아메리카노'로 읽힌다. */}
                {menus.length > 0 && (
                  <View style={styles.menuGrid}>
                    {menus.map((m) => {
                      const over = m.price > target.balance;
                      return (
                        <Pressable
                          key={m.id}
                          style={[styles.menuBtn, over && styles.menuBtnOver]}
                          onPress={() => onUse(target, m.price, m.name, m.id)}
                          disabled={busy || over}
                        >
                          <Text style={[styles.menuName, over && styles.menuTextOver]}
                                numberOfLines={1}>
                            {m.name}
                          </Text>
                          <Text style={[styles.menuPrice, over && styles.menuTextOver]}>
                            {m.price.toLocaleString()}원
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    placeholder={menus.length > 0 ? '직접 입력' : '금액'}
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

                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  <Pressable style={[styles.cancelBtn, { flex: 1 }]}
                             onPress={() => setTarget(null)}>
                    <Text style={styles.cancelText}>닫기</Text>
                  </Pressable>
                  {/* 환불(현금 지출)·삭제는 사장님 전용(require_owner)이라 직원에겐 숨긴다.
                      직원이 하는 건 충전과 차감뿐이다. */}
                  {!isStaff && target.balance > 0 && (
                    <Pressable style={styles.refundBtn} onPress={() => onRefund(target)}>
                      <Text style={styles.refundText}>환불</Text>
                    </Pressable>
                  )}
                  {!isStaff && (
                    <Pressable style={styles.refundBtn} onPress={() => onDeleteCustomer(target)}>
                      <Text style={styles.refundText}>삭제</Text>
                    </Pressable>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
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
  periodText: { fontSize: 11, color: '#9A8F86', marginLeft: 'auto' },
  badge: { fontSize: 11, fontWeight: '800', color: '#B23B2E',
           backgroundColor: '#FDECEA', paddingHorizontal: 7, paddingVertical: 2,
           borderRadius: 9, overflow: 'hidden' },

  churnRow: { flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: '#FDF7F6', borderRadius: 10, padding: 10 },
  name: { fontSize: 13, fontWeight: '700', color: colors.espressoBrown },
  sub: { fontSize: 11, color: '#7A6E65', marginTop: 2, lineHeight: 16 },
  overdue: { color: '#B23B2E', fontWeight: '700' },
  balanceHint: { fontSize: 11, color: colors.trendGreenText, fontWeight: '700', marginTop: 2 },
  couponHint: { fontSize: 11, color: colors.pointOrange, fontWeight: '700', marginTop: 2 },
  noReasonHint: { fontSize: 11, color: '#B0A79E', marginTop: 2 },
  couponBtn: { borderWidth: 1, borderColor: colors.pointOrange, borderRadius: 8,
               paddingHorizontal: 10, paddingVertical: 7 },
  couponBtnText: { fontSize: 11, fontWeight: 'bold', color: colors.pointOrange },
  smsBtn: { flexDirection: 'row', alignItems: 'center', gap: 3,
            backgroundColor: colors.pointOrange, paddingHorizontal: 10,
            paddingVertical: 7, borderRadius: 8 },
  smsBtnText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },



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
  consentBox: { backgroundColor: '#FAF8F6', borderRadius: 9, padding: 11, gap: 3 },
  consentTitle: { fontSize: 11.5, fontWeight: '700', color: '#7A6E65', marginBottom: 2 },
  consentItem: { fontSize: 11, color: '#7A6E65', lineHeight: 16 },
  agreeRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6 },
  agreeText: { flex: 1, fontSize: 12, color: colors.espressoBrown, fontWeight: '600' },

  planRow: { flexDirection: 'row', alignItems: 'center', gap: 6,
             backgroundColor: '#FAF8F6', borderRadius: 9, padding: 11 },
  planManageRow: { flexDirection: 'row', alignItems: 'center', gap: 6,
                   backgroundColor: '#FAF8F6', borderRadius: 9,
                   paddingHorizontal: 11, paddingVertical: 9 },
  planBonus: { fontSize: 11, color: colors.trendGreenText, fontWeight: '700' },

  emptyPlanBtn: { flexDirection: 'row', alignItems: 'center', gap: 5,
                  backgroundColor: '#FAF8F6', borderRadius: 9, padding: 12,
                  borderWidth: 1, borderColor: colors.mutedSand, borderStyle: 'dashed' },
  emptyPlanText: { fontSize: 12, color: colors.pointOrange, fontWeight: '600' },

  menuGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  menuBtn: { flexGrow: 1, minWidth: '30%', backgroundColor: '#FAF8F6',
             borderRadius: 9, paddingVertical: 9, paddingHorizontal: 8,
             borderWidth: 1, borderColor: colors.mutedSand, alignItems: 'center' },
  // 잔액을 넘는 메뉴는 눌러도 실패하므로 미리 흐리게 해 헛손질을 막는다
  menuBtnOver: { opacity: 0.35 },
  menuName: { fontSize: 11.5, fontWeight: '600', color: colors.espressoBrown },
  menuPrice: { fontSize: 12.5, fontWeight: '800', color: colors.pointOrange, marginTop: 2 },
  menuTextOver: { color: '#9A8F86' },

  // 결제 요청 대기 — 계산대에서 지금 처리할 일이라 눈에 띄게
  waitCard: { borderColor: colors.pointOrange, borderWidth: 1.5 },
  waitBadge: { fontSize: 11, fontWeight: '800', color: '#FFF',
               backgroundColor: colors.pointOrange, paddingHorizontal: 8,
               paddingVertical: 3, borderRadius: 9, overflow: 'hidden' },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 8,
             backgroundColor: '#FFF8F2', borderRadius: 10, padding: 11 },
  waitName: { fontSize: 14, fontWeight: '800', color: colors.espressoBrown },
  newTag: { fontSize: 11, fontWeight: '800', color: colors.trendGreenText },
  waitBtn: { backgroundColor: colors.pointOrange, paddingHorizontal: 14,
             paddingVertical: 8, borderRadius: 8 },
  waitBtnText: { color: '#FFF', fontSize: 12.5, fontWeight: 'bold' },

  qrCta: { flexDirection: 'row', alignItems: 'center', gap: 10,
           backgroundColor: '#FFF', borderRadius: 14, padding: 14,
           borderWidth: 1, borderColor: colors.mutedSand },
  qrCtaTitle: { fontSize: 13.5, fontWeight: 'bold', color: colors.espressoBrown },
  qrCtaSub: { fontSize: 11, color: '#7A6E65', marginTop: 2 },
  qrBox: { alignItems: 'center', backgroundColor: '#FFF', borderRadius: 12,
           padding: 12, marginVertical: 4 },
  qrUrl: { fontSize: 10.5, color: '#B0A79E', textAlign: 'center' },

  // 환불은 되돌릴 수 없는 지출이라 눈에 띄되 주 동선에서는 비켜 있게 둔다
  refundBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8,
               borderWidth: 1, borderColor: '#D9B3AE', alignItems: 'center',
               justifyContent: 'center' },
  refundText: { fontSize: 12.5, fontWeight: '700', color: '#B23B2E' },

  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rateBox: { flex: 1, backgroundColor: '#FAF8F6', borderRadius: 10, padding: 11 },
  rateBoxMain: { backgroundColor: '#FFF4EC' },
  rateLabel: { fontSize: 10.5, color: '#9A8F86' },
  rateValue: { fontSize: 20, fontWeight: '800', color: '#9A8F86', marginTop: 2 },
  rateValueMain: { color: colors.pointOrange },
  rateNote: { fontSize: 11, color: '#7A6E65', lineHeight: 17 },
  costItem: { flexDirection: 'row', alignItems: 'center', gap: 8,
              paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#F2EFEC' },
  costName: { flex: 1, fontSize: 12, color: colors.espressoBrown },
  costCount: { fontSize: 11, color: '#9A8F86' },
  costRate: { fontSize: 12.5, fontWeight: '800', color: colors.espressoBrown,
              minWidth: 46, textAlign: 'right' },

  fieldLabel: { fontSize: 11.5, color: '#7A6E65', marginBottom: 3 },
  previewBox: { backgroundColor: '#F4F8F4', borderRadius: 9, padding: 11, gap: 3 },
  previewBad: { backgroundColor: '#FDECEA' },
  previewMain: { fontSize: 14, fontWeight: '800', color: colors.espressoBrown },
  previewSub: { fontSize: 12, fontWeight: '700', color: colors.trendGreenText },
  previewNote: { fontSize: 10.5, color: '#7A6E65', lineHeight: 15, marginTop: 2 },
  previewBadText: { fontSize: 12, color: '#B23B2E', fontWeight: '600', lineHeight: 17 },
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
