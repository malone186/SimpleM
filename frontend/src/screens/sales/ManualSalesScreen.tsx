// 수동 매출 입력 — 현금·카드를 직접 적어 그날 매출과 카드 입금 예정을 계산하는 화면.
//
// 예전엔 판매 입력 화면 안에 이 폼이 크게 자리 잡고 있었지만, POS 파일 불러오기를 메인으로
// 올리면서 '직접 입력'은 여기 별도 화면으로 분리했다(SalesInputScreen에서 버튼으로 진입).
//
// 설계 의도(사장님 피드백 반영):
//   · POS 연동이 없는 매장에서 메뉴별 잔 수를 매일 세는 사람은 없다. 그래서 필수 입력은
//     '현금 얼마 / 카드 얼마'뿐이고, 카드사별 상세와 잔 수는 접어 둔 선택 입력이다.
//   · 대신 입력한 대가로 카드사별 수수료·입금 예정일을 계산해 준다.
//   · 날짜는 화살표로 하루씩 옮기거나, 달력 버튼으로 원하는 날짜로 바로 점프할 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { listMenus, listRecentSales, recordSales, type MenuItem, type RecentSale } from '../../lib/api/sales';
import { celebrateBreakeven } from '../../lib/breakevenCelebrate';
import {
  getDaySales,
  getDeposits,
  getSettlementSettings,
  saveDaySales,
  type CardIssuer,
  type DaySales,
  type DepositSchedule,
  type SettlementSettings,
} from '../../lib/api/settlement';
import { colors, typography } from '../../theme';

const won = (n: number) => `₩${n.toLocaleString()}`;
const pad2 = (x: number) => String(x).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shiftDays = (base: string, delta: number) => {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return iso(d);
};
const dateLabel = (target: string) => {
  const today = iso(new Date());
  if (target === today) return '오늘';
  if (target === shiftDays(today, -1)) return '어제';
  const d = new Date(`${target}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
};
// "12,000" 같은 표시용 문자열 ↔ 숫자
const digits = (s: string) => s.replace(/[^0-9]/g, '');
const comma = (s: string) => {
  const n = digits(s);
  return n ? Number(n).toLocaleString() : '';
};
const num = (s: string) => Number(digits(s) || 0);

// 카드사별 입력 한 줄
type CardRow = { issuer: string; amount: string; cardType: 'credit' | 'check' };

export default function ManualSalesScreen() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();

  const [target, setTarget] = useState(() => iso(new Date()));
  const [calOpen, setCalOpen] = useState(false);
  const [settings, setSettings] = useState<SettlementSettings | null>(null);
  const [day, setDay] = useState<DaySales | null>(null);
  const [deposits, setDeposits] = useState<DepositSchedule | null>(null);

  // 입력 상태
  const [cash, setCash] = useState('');
  const [cardSimple, setCardSimple] = useState(''); // 카드사 구분 없이 총액만 넣는 간편 모드
  const [rows, setRows] = useState<CardRow[]>([]);
  const [byIssuer, setByIssuer] = useState(false); // 카드사별 상세 입력 펼침
  const [cups, setCups] = useState('');
  const [showCups, setShowCups] = useState(false);
  const [saving, setSaving] = useState(false);

  // 메뉴별 등록(재고 차감용) — 접이식
  const [showMenuMode, setShowMenuMode] = useState(false);
  const [menus, setMenus] = useState<MenuItem[] | null>(null);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const issuers: CardIssuer[] = settings?.issuers ?? [];

  const reloadDeposits = useCallback(async () => {
    if (!token) return;
    try {
      setDeposits(await getDeposits(token));
    } catch (e) {
      console.error('입금 예정 조회 실패:', e);
    }
  }, [token]);

  // 설정 + 입금 예정은 화면 진입 시 한 번
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getSettlementSettings(token);
        if (!cancelled) setSettings(s);
      } catch (e) {
        console.error('정산 설정 조회 실패:', e);
      }
    })();
    reloadDeposits();
    return () => {
      cancelled = true;
    };
  }, [token, reloadDeposits]);

  // 날짜가 바뀌면 그날 입력값을 폼에 다시 채운다 (수정 = 재입력)
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await getDaySales(token, target);
        if (cancelled) return;
        setDay(d);
        setCash(d.cash ? d.cash.toLocaleString() : '');
        setCups(d.cups ? String(d.cups) : '');
        // 카드사를 나누지 않고 저장한 날('미지정'만 있는 날)은 간편 모드 그대로 되살린다
        const onlyUnknown = d.cards.length > 0 && d.cards.every((c) => c.issuer === 'unknown');
        if (onlyUnknown) {
          setByIssuer(false);
          setRows([]);
          setCardSimple(d.card_total.toLocaleString());
        } else if (d.cards.length > 0) {
          setByIssuer(true);
          setRows(d.cards.map((c) => ({
            issuer: c.issuer,
            amount: c.amount.toLocaleString(),
            cardType: c.card_type,
          })));
          setCardSimple('');
        } else {
          setByIssuer(false);
          setRows([]);
          setCardSimple('');
        }
      } catch (e) {
        console.error('일 매출 조회 실패:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, target]);

  // 메뉴는 접이식 영역을 처음 펼칠 때만 불러온다 (기본 화면을 가볍게)
  useEffect(() => {
    if (!token || !showMenuMode || menus !== null) return;
    (async () => {
      try {
        const rowsM = await listMenus(token);
        setMenus(rowsM.filter((m) => m.selling_price > 0));
        setRecent(await listRecentSales(token, 5));
      } catch (e) {
        console.error('메뉴 조회 실패:', e);
        setMenus([]);
      }
    })();
  }, [token, showMenuMode, menus]);

  const cardTotal = byIssuer
    ? rows.reduce((s, r) => s + num(r.amount), 0)
    : num(cardSimple);
  const total = num(cash) + cardTotal;

  // 입력 중에도 수수료·입금일이 실시간으로 보여야 '왜 카드사를 나눠 적는지' 납득이 된다
  const preview = useMemo(() => {
    if (!settings) return null;
    const list = byIssuer
      ? rows.filter((r) => num(r.amount) > 0)
      : cardTotal > 0
        ? [{ issuer: '', amount: String(cardTotal), cardType: 'credit' as const }]
        : [];
    return list.map((r) => {
      const meta = issuers.find((i) => i.code === r.issuer);
      const pct = r.cardType === 'check' ? settings.check_fee_pct : settings.credit_fee_pct;
      const amount = num(r.amount);
      const fee = Math.round((amount * pct) / 100);
      return {
        name: meta?.name ?? '카드 합계',
        color: meta?.color ?? colors.mochaBrown,
        lag: meta?.lag ?? null,
        amount,
        fee,
        net: amount - fee,
      };
    });
  }, [settings, rows, byIssuer, cardTotal, issuers]);

  const feePreview = (preview ?? []).reduce((s, p) => s + p.fee, 0);

  const addRow = (code: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRows((r) => (r.some((x) => x.issuer === code) ? r : [...r, { issuer: code, amount: '', cardType: 'credit' }]));
  };
  const removeRow = (code: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRows((r) => r.filter((x) => x.issuer !== code));
  };

  const save = async () => {
    if (!token || saving) return;
    if (total <= 0) {
      toast('입력할 금액이 없어요', '현금이나 카드 금액을 먼저 적어 주세요.');
      return;
    }
    setSaving(true);
    try {
      const cards = byIssuer
        ? rows.filter((r) => num(r.amount) > 0).map((r) => ({
            issuer: r.issuer,
            amount: num(r.amount),
            card_type: r.cardType,
          }))
        : cardTotal > 0
          // 카드사를 안 나눈 경우엔 임의의 카드사로 몰아넣지 않고 '미지정'에 담는다.
          // 입금일은 법정 상한(3영업일)으로 보수적으로 잡히므로, 실제보다 빨리 들어올지언정
          // "들어올 줄 알았는데 없다"는 어긋남은 생기지 않는다.
          ? [{ issuer: 'unknown', amount: cardTotal, card_type: 'credit' as const }]
          : [];
      const saved = await saveDaySales(token, {
        date: target,
        cash: num(cash),
        cash_cups: cups ? Number(cups) : null,
        cards,
      });
      setDay(saved);
      await reloadDeposits();
      toast('매출을 저장했어요', `${dateLabel(target)} 합계 ${won(saved.total)} · 수수료 ${won(saved.fee_total)}`);
    } catch (e) {
      console.error('매출 저장 실패:', e);
      toast('저장 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  // ---- 메뉴별 등록(재고 차감) ----
  const add = (id: number) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  const sub = (id: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) - 1) }));
  const cartCount = Object.values(cart).reduce((s, q) => s + q, 0);
  const cartTotal = Object.entries(cart).reduce((s, [id, q]) => {
    const m = menus?.find((x) => x.id === Number(id));
    return s + (m ? m.selling_price * q : 0);
  }, 0);

  const registerMenuSales = async () => {
    if (!token || submitting) return;
    const items = Object.entries(cart)
      .filter(([, q]) => q > 0)
      .map(([id, q]) => ({ menu_id: Number(id), quantity: q }));
    if (items.length === 0) return;
    setSubmitting(true);
    try {
      const res = await recordSales(token, items);
      setCart({});
      setRecent(await listRecentSales(token, 5));
      // 본전을 넘겼으면 축하가 먼저, 아니면 평소 안내
      if (!celebrateBreakeven(res.breakeven_reward)) {
        toast('판매를 등록했어요', '레시피 기준으로 재고가 자동 차감됩니다.');
      }
    } catch (e) {
      console.error('판매 등록 실패:', e);
      toast('등록 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setSubmitting(false);
    }
  };

  const nextDeposit = deposits?.next_deposit ?? null;

  return (
    <Screen>
      <ScreenTitle
        title="직접 입력"
        subtitle="현금·카드만 적으면 수수료와 입금 예정일까지 계산해 드려요"
      />

      {/* ── 날짜 선택 (화살표 ±1일 + 달력 버튼으로 원하는 날짜 점프) ── */}
      <BouncyDateBar
        target={target}
        dateLabel={dateLabel(target)}
        onPrev={() => setTarget((d) => shiftDays(d, -1))}
        onNext={() => setTarget((d) => (d >= iso(new Date()) ? d : shiftDays(d, 1)))}
        onOpenCalendar={() => setCalOpen(true)}
        isMaxDate={target >= iso(new Date())}
      />

      <CalendarSheet
        visible={calOpen}
        value={target}
        onSelect={(d) => setTarget(d)}
        onClose={() => setCalOpen(false)}
      />

      {/* ── 현금 / 카드 입력 (이 화면의 본체) ───────── */}
      <Card>
        <View style={styles.inputHead}>
          <Text style={styles.inputHeadTitle}>오늘 얼마 파셨어요?</Text>
          {day?.has_entry && <Badge label="입력됨" tone="green" />}
        </View>

        <MoneyField
          icon="cash-outline"
          label="현금 매출"
          hint="현금 + 계좌이체"
          value={cash}
          onChange={(v) => setCash(comma(v))}
        />

        <View style={{ height: 10 }} />

        {!byIssuer ? (
          <MoneyField
            icon="card-outline"
            label="카드 매출"
            hint="카드사 구분 없이 총액"
            value={cardSimple}
            onChange={(v) => setCardSimple(comma(v))}
          />
        ) : (
          <View>
            <Text style={styles.fieldLabel}>카드 매출 (카드사별)</Text>
            {rows.map((r) => {
              const meta = issuers.find((i) => i.code === r.issuer);
              return (
                <View key={r.issuer} style={styles.issuerRow}>
                  <View style={[styles.issuerDot, { backgroundColor: meta?.color ?? colors.mochaBrown }]} />
                  <Text style={styles.issuerName} numberOfLines={1}>
                    {meta?.name ?? r.issuer}
                  </Text>
                  <TouchableOpacity
                    onPress={() =>
                      setRows((rs) =>
                        rs.map((x) =>
                          x.issuer === r.issuer
                            ? { ...x, cardType: x.cardType === 'credit' ? 'check' : 'credit' }
                            : x,
                        ),
                      )
                    }
                    style={styles.typeChip}
                  >
                    <Text style={styles.typeChipText}>{r.cardType === 'check' ? '체크' : '신용'}</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={styles.issuerInput}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    placeholder="0"
                    placeholderTextColor="#BBAA99"
                    value={r.amount}
                    onChangeText={(v) =>
                      setRows((rs) => rs.map((x) => (x.issuer === r.issuer ? { ...x, amount: comma(v) } : x)))
                    }
                  />
                  <TouchableOpacity onPress={() => removeRow(r.issuer)} style={styles.rowDelete}>
                    <Ionicons name="close" size={15} color={colors.mochaBrown} />
                  </TouchableOpacity>
                </View>
              );
            })}

            {/* 아직 안 쓴 카드사 칩 — 눌러서 줄 추가 */}
            <View style={styles.chipWrap}>
              {issuers
                .filter((i) => i.selectable !== false && !rows.some((r) => r.issuer === i.code))
                .map((i) => (
                  <TouchableOpacity key={i.code} onPress={() => addRow(i.code)} style={styles.addChip}>
                    <View style={[styles.issuerDot, { backgroundColor: i.color }]} />
                    <Text style={styles.addChipText}>{i.name}</Text>
                    <Ionicons name="add" size={13} color={colors.mochaBrown} />
                  </TouchableOpacity>
                ))}
            </View>
          </View>
        )}

        {/* 간편 ↔ 카드사별 전환 */}
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setByIssuer((b) => !b);
          }}
          style={styles.switchMode}
        >
          <Ionicons name={byIssuer ? 'contract-outline' : 'options-outline'} size={14} color={colors.pointOrange} />
          <Text style={styles.switchModeText}>
            {byIssuer ? '카드 총액만 간단히 입력하기' : '카드사별로 나눠 적기 (입금일·수수료 정확도 ↑)'}
          </Text>
        </TouchableOpacity>

        {/* 잔 수는 선택 — 세는 사장님만 */}
        {!showCups ? (
          <TouchableOpacity
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setShowCups(true);
            }}
            style={styles.optionalToggle}
          >
            <Ionicons name="cafe-outline" size={13} color={colors.mochaBrown} />
            <Text style={styles.optionalToggleText}>잔 수도 적을래요 (선택 — 객단가가 계산돼요)</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ marginTop: 12 }}>
            <MoneyField
              icon="cafe-outline"
              label="총 판매 잔 수"
              hint="선택 입력"
              value={cups}
              onChange={(v) => setCups(digits(v))}
              suffix="잔"
            />
          </View>
        )}

        {/* 합계 + 즉시 계산되는 수수료 */}
        <View style={styles.totalBox}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>합계</Text>
            <Text style={styles.totalValue}>{won(total)}</Text>
          </View>
          {cardTotal > 0 && settings && (
            <>
              <View style={styles.totalRow}>
                <Text style={styles.totalSubLabel}>카드 수수료 (예상)</Text>
                <Text style={styles.totalSubValue}>−{won(feePreview)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={[styles.totalSubLabel, { fontWeight: '800', color: colors.espressoBrown }]}>
                  실제 손에 남는 돈
                </Text>
                <Text style={[styles.totalSubValue, { color: colors.trendGreenText, fontWeight: '900' }]}>
                  {won(total - feePreview)}
                </Text>
              </View>
            </>
          )}
          {cups && total > 0 && (
            <Text style={styles.avgHint}>
              객단가 {won(Math.round(total / Number(cups)))} · {cups}잔
            </Text>
          )}
        </View>

        <PressableScale style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={save}>
          <Ionicons name="checkmark-circle" size={17} color={colors.white} />
          <Text style={styles.saveBtnText}>{saving ? '저장 중…' : `${dateLabel(target)} 매출 저장`}</Text>
        </PressableScale>
      </Card>

      {/* ── 방금 입력한 날의 카드사별 입금 예정 ───────── */}
      {day && day.cards.length > 0 && (
        <Card tone="cream">
          <Text style={styles.miniTitle}>{dateLabel(target)} 카드 매출은 이렇게 들어와요</Text>
          {day.cards.map((c) => (
            <View key={`${c.issuer}-${c.card_type}`} style={styles.depRow}>
              <View style={[styles.issuerDot, { backgroundColor: c.color }]} />
              <Text style={styles.depName}>
                {c.issuer_name}
                <Text style={styles.depType}>{c.card_type === 'check' ? ' 체크' : ''}</Text>
              </Text>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.depNet}>{won(c.net)}</Text>
                <Text style={styles.depMeta}>
                  {c.deposit_date.slice(5).replace('-', '/')} 입금 · 수수료 {c.fee_pct}%
                </Text>
              </View>
            </View>
          ))}
          <Text style={styles.disclaimer}>
            카드사 계약(가맹점 등급)에 따라 하루 정도 차이가 날 수 있어요. 통장과 다르면 설정에서
            카드사별 입금 소요일을 고칠 수 있습니다.
          </Text>
        </Card>
      )}

      {/* ── 다가오는 입금 예정 요약 ───────────────── */}
      <SectionTitle>통장에 들어올 돈</SectionTitle>
      {!deposits ? (
        <Card>
          <View style={styles.stateWrap}>
            <ActivityIndicator color={colors.mochaBrown} />
            <Text style={styles.stateText}>입금 예정을 계산하는 중…</Text>
          </View>
        </Card>
      ) : deposits.schedule.length === 0 ? (
        <Card>
          <Text style={styles.stateText}>
            아직 입력된 카드 매출이 없어요. 위에서 오늘 카드 매출을 적으면 언제 얼마가 들어올지 알려드릴게요.
          </Text>
        </Card>
      ) : (
        <>
          <Card>
            <View style={styles.summaryRow}>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>다음 입금</Text>
                <Text style={styles.summaryValue}>
                  {nextDeposit ? won(nextDeposit.net) : '—'}
                </Text>
                <Text style={styles.summaryHint}>
                  {nextDeposit
                    ? `${nextDeposit.deposit_date.slice(5).replace('-', '/')} (${nextDeposit.weekday})`
                    : '예정 없음'}
                </Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>이번 주 입금</Text>
                <Text style={styles.summaryValue}>{won(deposits.this_week_net)}</Text>
                <Text style={styles.summaryHint}>일요일까지</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>미입금 잔액</Text>
                <Text style={styles.summaryValue}>{won(deposits.pending_net)}</Text>
                <Text style={styles.summaryHint}>수수료 {won(deposits.pending_fee)} 제외</Text>
              </View>
            </View>
            <Text style={styles.feeNote}>{deposits.fee_note}</Text>
          </Card>

          {deposits.schedule
            .filter((s) => !s.settled)
            .slice(0, 8)
            .map((s) => (
              <Card key={s.deposit_date}>
                <View style={styles.schedHead}>
                  <View>
                    <Text style={styles.schedDate}>
                      {s.deposit_date.slice(5).replace('-', '월 ')}일 ({s.weekday})
                    </Text>
                    <Text style={styles.schedSub}>
                      {s.items.map((i) => i.issuer_name).join(' · ')}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.schedNet}>{won(s.net)}</Text>
                    <Text style={styles.schedGross}>
                      매출 {won(s.gross)} − 수수료 {won(s.fee)}
                    </Text>
                  </View>
                </View>
              </Card>
            ))}
        </>
      )}

      {/* ── 메뉴별 등록 (재고 차감이 필요한 사람만) ───── */}
      <TouchableOpacity
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setShowMenuMode((v) => !v);
        }}
        style={styles.advancedToggle}
      >
        <Ionicons name="cube-outline" size={15} color={colors.mochaBrown} />
        <Text style={styles.advancedToggleText}>메뉴별로 등록해서 재고 자동 차감하기</Text>
        <Ionicons name={showMenuMode ? 'chevron-up' : 'chevron-down'} size={15} color={colors.mochaBrown} />
      </TouchableOpacity>

      {showMenuMode && (
        <>
          <Card tone="cream">
            <Text style={styles.stateText}>
              레시피에 등록된 재료가 판매 잔 수만큼 자동으로 빠져요. 재고를 앱으로 관리하는 경우에만 쓰시면 됩니다.
            </Text>
          </Card>

          {menus === null && (
            <Card>
              <View style={styles.stateWrap}>
                <ActivityIndicator color={colors.mochaBrown} />
                <Text style={styles.stateText}>메뉴를 불러오는 중…</Text>
              </View>
            </Card>
          )}

          {menus !== null && menus.length === 0 && (
            <Card>
              <Text style={styles.stateText}>
                등록된 메뉴가 없어요. 메뉴 관리에서 먼저 메뉴를 등록해 주세요.
              </Text>
            </Card>
          )}

          {(menus ?? []).map((m) => {
            const q = cart[m.id] ?? 0;
            return (
              <Card key={m.id}>
                <View style={styles.menuRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.menuName}>{m.name}</Text>
                    <Text style={styles.menuPrice}>{won(m.selling_price)}</Text>
                  </View>
                  <View style={styles.stepper}>
                    <TouchableOpacity onPress={() => sub(m.id)} style={styles.stepBtn}>
                      <Ionicons name="remove" size={18} color={colors.espressoBrown} />
                    </TouchableOpacity>
                    <Text style={styles.qty}>{q}</Text>
                    <TouchableOpacity onPress={() => add(m.id)} style={styles.stepBtn}>
                      <Ionicons name="add" size={18} color={colors.espressoBrown} />
                    </TouchableOpacity>
                  </View>
                </View>
              </Card>
            );
          })}

          {cartCount > 0 && (
            <PressableScale
              style={[styles.saveBtn, submitting && { opacity: 0.6 }]}
              onPress={registerMenuSales}
            >
              <Text style={styles.saveBtnText}>
                {submitting ? '등록 중…' : `${cartCount}잔 · ${won(cartTotal)} 판매 등록`}
              </Text>
            </PressableScale>
          )}

          {recent.length > 0 && (
            <Card>
              <Text style={styles.miniTitle}>최근 등록</Text>
              {recent.map((s) => (
                <View key={s.id} style={styles.recentRow}>
                  <Text style={styles.recentName}>{s.name}</Text>
                  <Text style={styles.recentQty}>{s.quantity}잔</Text>
                </View>
              ))}
            </Card>
          )}
        </>
      )}

      <TouchableOpacity onPress={() => navigation.navigate('Settings', { section: 'settlement' })} style={styles.settingsLink}>
        <Ionicons name="settings-outline" size={13} color={colors.mochaBrown} />
        <Text style={styles.settingsLinkText}>수수료율·카드사 입금일 설정 바꾸기</Text>
      </TouchableOpacity>
    </Screen>
  );
}

// 큰 금액 입력 필드 — 이 화면에서 가장 눈에 띄어야 하는 요소
function MoneyField({
  icon,
  label,
  hint,
  value,
  onChange,
  suffix = '원',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
}) {
  return (
    <View>
      <View style={styles.fieldLabelRow}>
        <Ionicons name={icon} size={14} color={colors.mochaBrown} />
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <View style={styles.fieldBox}>
        <TextInput
          style={styles.fieldInput}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="0"
          placeholderTextColor="#C4B5A5"
          value={value}
          onChangeText={onChange}
        />
        <Text style={styles.fieldSuffix}>{suffix}</Text>
      </View>
    </View>
  );
}

// ── [한글 주석: 아이폰 물방울처럼 쫀득하고 통통 튀는 Bouncy Elastic 날짜 선택바] ──
// 가운데 날짜를 누르면 달력이 열려 원하는 날짜로 바로 점프할 수 있다.
function BouncyDateBar({
  target,
  dateLabel,
  onPrev,
  onNext,
  onOpenCalendar,
  isMaxDate,
}: {
  target: string;
  dateLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onOpenCalendar: () => void;
  isMaxDate: boolean;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  const triggerBouncy = (direction: -1 | 1) => {
    // 쫀득하게 0.85까지 당겨졌다가 1.0으로 통통 튀어오르는 물방울 스프링 애니메이션
    scaleAnim.setValue(0.85);
    slideAnim.setValue(direction * 16);

    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1.0,
        friction: 3.5,
        tension: 210,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 4.2,
        tension: 180,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handlePrev = () => {
    triggerBouncy(-1);
    onPrev();
  };

  const handleNext = () => {
    if (isMaxDate) return;
    triggerBouncy(1);
    onNext();
  };

  return (
    <View style={styles.dateBar}>
      <PressableScale
        onPress={handlePrev}
        style={styles.dateArrowBtn}
        to={0.82}
      >
        <Ionicons name="chevron-back" size={18} color={colors.espressoBrown} />
      </PressableScale>

      <PressableScale onPress={onOpenCalendar} style={{ flex: 1 }} to={0.96}>
        <Animated.View
          style={[
            styles.dateCenter,
            {
              transform: [{ scale: scaleAnim }, { translateX: slideAnim }],
            },
          ]}
        >
          <Text style={styles.dateLabel}>{dateLabel}</Text>
          <View style={styles.dateSubRow}>
            <Ionicons name="calendar-outline" size={11} color={colors.mochaBrown} />
            <Text style={styles.dateSub}>{target}</Text>
          </View>
        </Animated.View>
      </PressableScale>

      <PressableScale
        onPress={handleNext}
        disabled={isMaxDate}
        style={[styles.dateArrowBtn, isMaxDate && { opacity: 0.25 }]}
        to={0.82}
      >
        <Ionicons name="chevron-forward" size={18} color={colors.espressoBrown} />
      </PressableScale>
    </View>
  );
}

// ── 달력 시트: RN 내장 Modal 기반 순수 JS 월 달력 (네이티브 재빌드 불필요) ──
// 미래 날짜는 매출을 미리 적을 수 없으니 비활성. 날짜를 누르면 그 날짜로 점프 후 닫힘.
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function CalendarSheet({
  visible,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  value: string;
  onSelect: (d: string) => void;
  onClose: () => void;
}) {
  const today = iso(new Date());
  const [view, setView] = useState(() => {
    const d = new Date(`${value}T00:00:00`);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // 달력을 열 때마다 현재 선택된 날짜의 달로 맞춘다
  useEffect(() => {
    if (!visible) return;
    const d = new Date(`${value}T00:00:00`);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  }, [visible, value]);

  const startPad = new Date(view.y, view.m, 1).getDay(); // 0=일
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(startPad).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const nextMonth = () => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));
  // 미래 달로는 넘어갈 수 없다
  const atCurrentMonth = view.y === new Date().getFullYear() && view.m === new Date().getMonth();

  const dateStr = (day: number) => `${view.y}-${pad2(view.m + 1)}-${pad2(day)}`;
  const pick = (day: number) => {
    onSelect(dateStr(day));
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.calBackdrop} onPress={onClose}>
        <Pressable style={styles.calSheet} onPress={() => {}}>
          <View style={styles.calHead}>
            <TouchableOpacity onPress={prevMonth} style={styles.calNav}>
              <Ionicons name="chevron-back" size={18} color={colors.espressoBrown} />
            </TouchableOpacity>
            <Text style={styles.calTitle}>
              {view.y}년 {view.m + 1}월
            </Text>
            <TouchableOpacity
              onPress={nextMonth}
              disabled={atCurrentMonth}
              style={[styles.calNav, atCurrentMonth && { opacity: 0.25 }]}
            >
              <Ionicons name="chevron-forward" size={18} color={colors.espressoBrown} />
            </TouchableOpacity>
          </View>

          <View style={styles.calWeekRow}>
            {WEEKDAYS.map((w, i) => (
              <Text
                key={w}
                style={[
                  styles.calWeek,
                  i === 0 && { color: '#C0392B' },
                  i === 6 && { color: '#2C6FBB' },
                ]}
              >
                {w}
              </Text>
            ))}
          </View>

          <View style={styles.calGrid}>
            {cells.map((day, i) => {
              if (day == null) return <View key={i} style={styles.calCell} />;
              const ds = dateStr(day);
              const disabled = ds > today;
              const selected = ds === value;
              const isToday = ds === today;
              const col = i % 7;
              return (
                <TouchableOpacity
                  key={i}
                  disabled={disabled}
                  onPress={() => pick(day)}
                  style={styles.calCell}
                >
                  <View
                    style={[
                      styles.calDay,
                      isToday && !selected && styles.calDayToday,
                      selected && styles.calDaySelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.calDayText,
                        col === 0 && !selected && { color: '#C0392B' },
                        col === 6 && !selected && { color: '#2C6FBB' },
                        selected && styles.calDayTextSelected,
                        disabled && styles.calDayDisabled,
                      ]}
                    >
                      {day}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            onPress={() => {
              onSelect(today);
              onClose();
            }}
            style={styles.calTodayBtn}
          >
            <Ionicons name="today-outline" size={14} color={colors.pointOrange} />
            <Text style={styles.calTodayText}>오늘로 이동</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFDF9',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.16)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  dateArrowBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F1EA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dateCenter: { alignItems: 'center' },
  dateLabel: { fontSize: 16, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.4 },
  dateSubRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  dateSub: { fontSize: 11, fontWeight: '600', color: colors.mochaBrown },

  // ── 달력 시트 ──
  calBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(46, 32, 24, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  calSheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFDF9',
    borderRadius: 22,
    padding: 18,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  calHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  calNav: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F1EA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  calTitle: { fontSize: 16, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.3 },
  calWeekRow: { flexDirection: 'row', marginBottom: 4 },
  calWeek: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.mochaBrown,
    paddingVertical: 4,
  },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  calDay: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calDayToday: { borderWidth: 1.5, borderColor: colors.pointOrange },
  calDaySelected: { backgroundColor: colors.espressoBrown },
  calDayText: { fontSize: 14, fontWeight: '700', color: colors.espressoBrown },
  calDayTextSelected: { color: colors.white, fontWeight: '900' },
  calDayDisabled: { color: '#CFC3B6', fontWeight: '500' },
  calTodayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 12,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: colors.coffeeCream,
  },
  calTodayText: { fontSize: 13.5, fontWeight: '800', color: colors.pointOrange },

  inputHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  inputHeadTitle: { fontSize: 17, fontWeight: '900', color: colors.espressoBrown },

  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
  fieldLabel: { ...typography.L4, color: colors.espressoBrown },
  fieldHint: { ...typography.L5, color: colors.mochaBrown, marginLeft: 2 },
  fieldBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FBF8F3',
    borderWidth: 1.5,
    borderColor: 'rgba(140,111,86,0.22)',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 52,
    overflow: 'hidden',
  },
  fieldInput: {
    flex: 1,
    minWidth: 0, // [한글 주석: 웹 flexbox 가변 대응으로 원 단위가 밖으로 밀려나가지 않게 방지]
    fontSize: 22,
    fontWeight: '900',
    color: colors.espressoBrown,
    textAlign: 'right',
    padding: 0,
    marginRight: 4,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  fieldSuffix: { ...typography.L3, color: colors.mochaBrown, marginLeft: 2, flexShrink: 0 },

  issuerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#FBF8F3',
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.16)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 7,
  },
  issuerDot: { width: 8, height: 8, borderRadius: 4 },
  issuerName: { ...typography.L4, color: colors.espressoBrown, width: 78 },
  typeChip: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeChipText: { fontSize: 10, fontWeight: '800', color: colors.mochaBrown },
  issuerInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: colors.espressoBrown,
    textAlign: 'right',
    padding: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  rowDelete: { padding: 3 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  addChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingLeft: 9,
    paddingRight: 7,
    paddingVertical: 6,
  },
  addChipText: { fontSize: 11, fontWeight: '700', color: colors.espressoBrown },

  switchMode: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 12 },
  switchModeText: { fontSize: 11.5, fontWeight: '700', color: colors.pointOrange },
  optionalToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 },
  optionalToggleText: { ...typography.L5, color: colors.mochaBrown },

  totalBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 14,
    marginTop: 16,
    gap: 6,
  },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalLabel: { ...typography.L4, color: colors.mochaBrown },
  totalValue: { fontSize: 22, fontWeight: '900', color: colors.espressoBrown },
  totalSubLabel: { ...typography.L5, color: colors.mochaBrown },
  totalSubValue: { ...typography.L4, color: colors.mochaBrown },
  avgHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 14,
  },
  saveBtnText: { ...typography.L3, color: colors.white },

  miniTitle: { ...typography.L4, color: colors.espressoBrown, marginBottom: 10 },
  depRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  depName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  depType: { ...typography.L5, color: colors.mochaBrown },
  depNet: { ...typography.L3, color: colors.espressoBrown },
  depMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  disclaimer: { ...typography.L5, color: colors.mochaBrown, lineHeight: 15, marginTop: 10, opacity: 0.9 },

  summaryRow: { flexDirection: 'row', alignItems: 'stretch' },
  summaryItem: { flex: 1, alignItems: 'center', gap: 3 },
  summaryDivider: { width: 1, backgroundColor: colors.mutedSand, marginHorizontal: 6 },
  summaryLabel: { ...typography.L5, color: colors.mochaBrown },
  summaryValue: { fontSize: 15, fontWeight: '900', color: colors.espressoBrown },
  summaryHint: { fontSize: 9.5, fontWeight: '600', color: colors.mochaBrown },
  feeNote: { ...typography.L5, color: colors.mochaBrown, marginTop: 12, textAlign: 'center' },

  schedHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  schedDate: { ...typography.L3, color: colors.espressoBrown },
  schedSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  schedNet: { ...typography.L3, color: colors.trendGreenText },
  schedGross: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },

  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  advancedToggleText: { ...typography.L4, color: colors.espressoBrown, flex: 1 },

  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },
  menuRow: { flexDirection: 'row', alignItems: 'center' },
  menuName: { ...typography.L3, color: colors.espressoBrown },
  menuPrice: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: { ...typography.L3, color: colors.espressoBrown, minWidth: 18, textAlign: 'center' },
  recentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5 },
  recentName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  recentQty: { ...typography.L4, color: colors.mochaBrown },

  settingsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8 },
  settingsLinkText: { ...typography.L5, color: colors.mochaBrown, textDecorationLine: 'underline' },
});
