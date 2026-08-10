// 카드 정산 설정 — 처음 쓰는 사장님도 이해할 수 있게 만든 설정 화면.
//
// 왜 다시 만들었나:
//   기존 화면은 '연매출 구간 라디오 6개'와 '카드사별 D+n 스테퍼 11줄'을 그냥 펼쳐
//   놨다. 이미 뜻을 아는 사람에겐 충분하지만, 처음 보는 사장님은 (1) 우대수수료율이
//   뭔지 (2) 우리 가게가 어느 구간인지 (3) D+2 영업일이 며칠인지 셋 다 모른다.
//   그래서 아무것도 안 건드리고 나가고, 앱은 조용히 기본값으로 계산한다.
//
// 그래서 세 가지를 넣었다:
//   ① 3단계 설정 마법사 — 한 번에 하나씩만 물어본다(설정 이력이 없으면 자동 시작).
//   ② 우리 매장 매출로 구간 추천 — "연매출 3억 이하인가요?"는 부가세 신고서를 봐야
//      답할 수 있는 질문이라, 앱에 쌓인 매출로 먼저 추정해 제안한다.
//   ③ 미리보기 계산기 — 설정을 바꿀 때마다 "10만원 결제 → 수수료 400원 → 99,600원이
//      8/4(화)에 입금"이 같이 바뀐다. 숫자가 눈앞에서 움직여야 뜻이 이해된다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { dateKey } from '../../lib/dateKey';
import {
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import {
  DEFAULT_SETTLEMENT_SETTINGS,
  getSettlementPreview,
  getSettlementSettings,
  getTierSuggestion,
  updateSettlementSettings,
  type SettlementPreview,
  type SettlementSettings,
  type TierSuggestion,
} from '../../lib/api/settlement';
import { colors, typography } from '../../theme';
import { PressableScale } from '../motion';
import { toast } from '../toast';
import { Badge, Button, Card, Divider, SectionTitle } from '../ui';
import { Segmented } from '../ui/Segmented';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const won = (n: number) => `₩${Math.round(n || 0).toLocaleString('ko-KR')}`;
const eok = (n: number) => `${(n / 100_000_000).toFixed(1)}억원`;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// 미리보기 금액 프리셋 — 카페 한 건 결제로 흔한 금액대
const AMOUNT_PRESETS = [5_000, 50_000, 100_000];

const CONFIDENCE_LABEL: Record<string, { label: string; tone: 'green' | 'orange' | 'neutral' }> = {
  high: { label: '데이터 충분', tone: 'green' },
  medium: { label: '참고용', tone: 'orange' },
  low: { label: '기록이 적어요', tone: 'neutral' },
};

const springy = () =>
  LayoutAnimation.configureNext({
    duration: 280,
    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    update: { type: LayoutAnimation.Types.spring, springDamping: 0.82 },
    delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  });

// 서버가 안 될 때 쓰는 대략 계산 — 주말만 건너뛴다(공휴일표는 서버에만 있다).
// 화면이 통째로 멈추는 것보다 '대략값 + 안내'가 낫다는 기존 화면 방침을 따른다.
function localPreview(
  s: SettlementSettings,
  amount: number,
  cardType: 'credit' | 'check',
  issuerCode: string,
): SettlementPreview {
  const iss = s.issuers.find((i) => i.code === issuerCode) ?? s.issuers[0];
  const pct = cardType === 'check' ? s.check_fee_pct : s.credit_fee_pct;
  const fee = Math.round((amount * pct) / 100);
  const iso = (d: Date) =>
    dateKey(d);

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const cur = new Date(start);
  const skipped: SettlementPreview['skipped'] = [];
  let left = iss?.lag ?? 2;
  while (left > 0) {
    cur.setDate(cur.getDate() + 1);
    const wd = cur.getDay();
    if (wd === 0 || wd === 6) {
      skipped.push({
        date: iso(cur),
        label: `${cur.getMonth() + 1}/${cur.getDate()}`,
        reason: wd === 6 ? '토요일' : '일요일',
      });
    } else {
      left -= 1;
    }
  }
  return {
    issuer: iss?.code ?? 'shinhan',
    issuer_name: iss?.name ?? '카드사',
    color: iss?.color ?? colors.mochaBrown,
    card_type: cardType,
    amount,
    cups: null,
    fee_pct: pct,
    fee,
    net: amount - fee,
    lag: iss?.lag ?? 2,
    deposit_date: iso(cur),
    sale_date: iso(start),
    deposit_weekday: WEEKDAY[cur.getDay()],
    calendar_days: Math.round((cur.getTime() - start.getTime()) / 86_400_000),
    skipped,
    tier_label: s.tier_label,
  };
}

export default function SettlementSetupPanel() {
  const { token } = useAuth();

  const [data, setData] = useState<SettlementSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);

  // 마법사 — 설정 이력이 없으면(configured=false) 자동으로 켠다
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState(0); // 0 수수료율 · 1 입금일 · 2 확인

  // 구간 추천
  const [suggestion, setSuggestion] = useState<TierSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  // 계약서 요율 직접 입력
  const [customOpen, setCustomOpen] = useState(false);
  const [creditInput, setCreditInput] = useState('');
  const [checkInput, setCheckInput] = useState('');

  // 미리보기 계산기
  const [amount, setAmount] = useState(50_000);
  const [amountText, setAmountText] = useState('50000');
  const [cardType, setCardType] = useState<'credit' | 'check'>('credit');
  const [previewIssuer, setPreviewIssuer] = useState('shinhan');
  const [preview, setPreview] = useState<SettlementPreview | null>(null);

  // 접이식 영역
  const [lagOpen, setLagOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setData(DEFAULT_SETTLEMENT_SETTINGS);
      setOffline(true);
      setWizard(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    getSettlementSettings(token)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setCreditInput(res.custom_credit_fee != null ? String(res.custom_credit_fee) : '');
        setCheckInput(res.custom_check_fee != null ? String(res.custom_check_fee) : '');
        setCustomOpen(res.revenue_tier === 'custom');
        setWizard(!res.configured); // 처음 들어온 사장님에겐 마법사부터
        setLoading(false);
      })
      .catch((e) => {
        console.error('정산 설정 조회 실패:', e);
        if (cancelled) return;
        setData(DEFAULT_SETTLEMENT_SETTINGS);
        setOffline(true);
        setWizard(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 설정·금액이 바뀔 때마다 미리보기 갱신 (연타 방지로 300ms 묶음)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!data) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    // 서버 응답을 기다리는 동안에도 숫자가 비지 않게 로컬 계산으로 먼저 채운다
    setPreview(localPreview(data, amount, cardType, previewIssuer));
    if (!token) return;
    timerRef.current = setTimeout(() => {
      getSettlementPreview(token, { amount, card_type: cardType, issuer: previewIssuer })
        .then(setPreview)
        .catch(() => {
          /* 로컬 계산값을 그대로 둔다 */
        });
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [token, data, amount, cardType, previewIssuer]);

  const apply = useCallback(
    async (body: Parameters<typeof updateSettlementSettings>[1], silent = false) => {
      if (saving || !data) return false;
      setSaving(true);
      try {
        if (token) {
          const next = await updateSettlementSettings(token, body);
          setData(next);
          if (!silent) toast('저장했어요', '바뀐 설정이 바로 계산에 반영돼요.');
          return true;
        }
        throw new Error('no token');
      } catch (e: any) {
        // apiFetch는 "400 · 사유" 형태로 던진다. 4xx는 서버가 못 받아준 게 아니라
        // 입력이 틀렸다는 뜻이므로, 오프라인 저장으로 넘기지 말고 사유를 그대로 보여준다.
        const msg = typeof e?.message === 'string' ? e.message : '';
        const clientError = /^4\d\d\s·\s/.test(msg);
        if (clientError) {
          toast('저장하지 못했어요', msg.replace(/^\d{3}\s·\s/, ''));
          return false;
        }
        console.error('정산 설정 저장 실패:', e);
        // 서버가 안 되더라도 화면은 계속 쓸 수 있게 로컬 상태만 갱신한다
        setOffline(true);
        setData((prev) => (prev ? applyLocally(prev, body) : prev));
        if (!silent) toast('오프라인 저장', '서버에 연결되면 다시 저장해 주세요.');
        return true;
      } finally {
        setSaving(false);
      }
    },
    [data, saving, token],
  );

  const loadSuggestion = useCallback(async () => {
    if (!token) {
      toast('추천할 수 없어요', '로그인 후 매출이 쌓이면 자동으로 추천해 드려요.');
      return;
    }
    setSuggesting(true);
    try {
      const res = await getTierSuggestion(token);
      springy();
      setSuggestion(res);
    } catch (e) {
      console.error('구간 추천 실패:', e);
      toast('추천 실패', '매출 데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSuggesting(false);
    }
  }, [token]);

  const saveCustomFees = useCallback(async () => {
    const credit = Number(creditInput);
    const check = Number(checkInput);
    if (!creditInput || !checkInput || Number.isNaN(credit) || Number.isNaN(check)) {
      toast('요율을 적어 주세요', '계약서에 적힌 신용·체크 수수료율을 둘 다 입력해 주세요.');
      return;
    }
    if (credit < 0 || credit > 10 || check < 0 || check > 10) {
      toast('숫자를 확인해 주세요', '수수료율은 0~10% 사이로 입력해 주세요. (예: 1.5)');
      return;
    }
    await apply({ revenue_tier: 'custom', custom_credit_fee: credit, custom_check_fee: check });
  }, [apply, checkInput, creditInput]);

  const setLag = useCallback(
    (code: string, next: number) => {
      if (!data) return;
      const clamped = Math.max(0, Math.min(10, next));
      const overrides = Object.fromEntries(
        // 백엔드는 lag_overrides를 통째로 덮어쓴다 — 한 카드사만 보내면 나머지가 날아간다
        data.issuers.map((i) => [i.code, i.code === code ? clamped : i.lag]),
      );
      apply({ lag_overrides: overrides }, true);
    },
    [apply, data],
  );

  const resetLags = useCallback(() => {
    if (!data) return;
    apply({ lag_overrides: Object.fromEntries(data.issuers.map((i) => [i.code, i.default_lag])) });
  }, [apply, data]);

  if (loading && !data) {
    return (
      <Card>
        <View style={{ paddingVertical: 26, alignItems: 'center', gap: 10 }}>
          <ActivityIndicator color={colors.mochaBrown} />
          <Text style={s.hint}>정산 설정을 불러오는 중…</Text>
        </View>
      </Card>
    );
  }
  if (!data) return null;

  const selectableIssuers = data.issuers.filter((i) => i.selectable);
  const customizedIssuers = data.issuers.filter((i) => i.customized);

  // ── 조각 렌더러 ─────────────────────────────────────────────
  const renderTierPicker = () => (
    <>
      <View style={s.explainBox}>
        <Ionicons name="card-outline" size={16} color={colors.espressoBrown} />
        <Text style={s.explainText}>
          카드로 <Text style={s.bold}>10,000원</Text>을 받으면 카드사가 수수료를 떼고 나머지를
          통장에 넣어줘요. 그 떼는 비율이 <Text style={s.bold}>카드 수수료율</Text>이고, 연매출
          구간에 따라 나라에서 정한 우대요율이 적용돼요.
        </Text>
      </View>

      {/* 잘 모르는 사장님을 위한 지름길 — 앱에 쌓인 매출로 구간을 짚어 준다 */}
      <PressableScale
        style={[s.suggestBtn, suggesting && { opacity: 0.6 }]}
        onPress={loadSuggestion}
        disabled={suggesting}
        to={0.97}
      >
        {suggesting ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : (
          <Ionicons name="sparkles-outline" size={15} color={colors.white} />
        )}
        <Text style={s.suggestBtnText}>
          {suggesting ? '매출 확인 중…' : '연매출이 얼마인지 모르겠어요 → 추천받기'}
        </Text>
      </PressableScale>

      {suggestion && (
        <View style={s.suggestBox}>
          {suggestion.available ? (
            <>
              <View style={s.suggestHead}>
                <Text style={s.suggestTitle}>추천: {suggestion.tier_label}</Text>
                <Badge
                  label={CONFIDENCE_LABEL[suggestion.confidence ?? 'low'].label}
                  tone={CONFIDENCE_LABEL[suggestion.confidence ?? 'low'].tone}
                />
              </View>
              <Text style={s.suggestLine}>
                하루 평균 <Text style={s.bold}>{won(suggestion.daily_avg ?? 0)}</Text> · 1년 환산{' '}
                <Text style={s.bold}>약 {eok(suggestion.annual_estimate ?? 0)}</Text>
              </Text>
              <Text style={s.suggestMeta}>{suggestion.basis}</Text>
              <Text style={s.suggestMeta}>{suggestion.note}</Text>
              <Button
                label={`이 구간으로 설정하기 (신용 ${suggestion.credit_fee_pct}% / 체크 ${suggestion.check_fee_pct}%)`}
                style={{ marginTop: 10 }}
                textStyle={{ fontSize: 12.5 }}
                onPress={() => {
                  setCustomOpen(false);
                  apply({ revenue_tier: suggestion.recommended_tier });
                }}
              />
            </>
          ) : (
            <Text style={s.suggestLine}>{suggestion.reason}</Text>
          )}
        </View>
      )}

      <Text style={s.groupLabel}>직접 고르기</Text>
      <View style={{ gap: 7 }}>
        {data.tiers
          .filter((t) => t.code !== 'custom')
          .map((tier) => {
            const active = data.revenue_tier === tier.code;
            const recommended = suggestion?.available && suggestion.recommended_tier === tier.code;
            return (
              <PressableScale
                key={tier.code}
                style={[s.tierRow, active && s.tierRowActive]}
                onPress={() => {
                  setCustomOpen(false);
                  apply({ revenue_tier: tier.code });
                }}
                to={0.98}
              >
                <Ionicons
                  name={active ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={active ? colors.espressoBrown : colors.mochaBrown}
                />
                <View style={{ flex: 1 }}>
                  <View style={s.tierTitleRow}>
                    <Text style={[s.tierLabel, active && { fontWeight: '900' }]}>{tier.label}</Text>
                    {recommended ? <Badge label="추천" tone="green" /> : null}
                  </View>
                  {/* 요율(%)만 보여주면 감이 안 온다 — 만원 결제 시 실제 금액으로 환산 */}
                  <Text style={s.tierExample}>
                    10,000원 결제 시 수수료 {won(Math.round(10_000 * tier.credit / 100))} · 체크카드{' '}
                    {won(Math.round(10_000 * tier.check / 100))}
                  </Text>
                </View>
                <Text style={s.tierRate}>{tier.credit}%</Text>
              </PressableScale>
            );
          })}

        {/* 계약서 요율 직접 입력 */}
        <PressableScale
          style={[s.tierRow, data.revenue_tier === 'custom' && s.tierRowActive]}
          onPress={() => {
            springy();
            setCustomOpen((v) => !v);
          }}
          to={0.98}
        >
          <Ionicons
            name={data.revenue_tier === 'custom' ? 'radio-button-on' : 'radio-button-off'}
            size={18}
            color={data.revenue_tier === 'custom' ? colors.espressoBrown : colors.mochaBrown}
          />
          <View style={{ flex: 1 }}>
            <Text style={[s.tierLabel, data.revenue_tier === 'custom' && { fontWeight: '900' }]}>
              계약서에 적힌 요율로 직접 입력
            </Text>
            <Text style={s.tierExample}>카드사와 따로 계약했거나 통보받은 요율이 다를 때</Text>
          </View>
          <Ionicons
            name={customOpen ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.mochaBrown}
          />
        </PressableScale>

        {customOpen && (
          <View style={s.customBox}>
            <View style={s.customRow}>
              <Text style={s.customLabel}>신용카드</Text>
              <TextInput
                style={s.customInput}
                value={creditInput}
                onChangeText={setCreditInput}
                keyboardType="decimal-pad"
                placeholder="1.5"
                placeholderTextColor="rgba(140,111,86,0.45)"
                maxLength={5}
              />
              <Text style={s.customUnit}>%</Text>
            </View>
            <View style={s.customRow}>
              <Text style={s.customLabel}>체크카드</Text>
              <TextInput
                style={s.customInput}
                value={checkInput}
                onChangeText={setCheckInput}
                keyboardType="decimal-pad"
                placeholder="1.2"
                placeholderTextColor="rgba(140,111,86,0.45)"
                maxLength={5}
              />
              <Text style={s.customUnit}>%</Text>
            </View>
            <Text style={s.customHint}>
              카드사에서 받은 ‘가맹점 수수료율 통보서’나 매출전표 명세에 적혀 있어요.
            </Text>
            <Button
              label="이 요율로 저장"
              variant="secondary"
              style={{ marginTop: 8 }}
              textStyle={{ fontSize: 12.5 }}
              onPress={saveCustomFees}
            />
          </View>
        )}
      </View>

      <View style={s.nowBox}>
        <Ionicons name="checkmark-circle" size={15} color={colors.trendGreenText} />
        <Text style={s.nowText}>
          지금 적용 중 — <Text style={s.bold}>{data.tier_label}</Text> · 신용 {data.credit_fee_pct}% /
          체크 {data.check_fee_pct}%
        </Text>
      </View>
    </>
  );

  const renderLagEditor = () => (
    <>
      <View style={s.explainBox}>
        <Ionicons name="calendar-outline" size={16} color={colors.espressoBrown} />
        <Text style={s.explainText}>
          카드값은 결제 즉시 들어오지 않아요. 보통 <Text style={s.bold}>영업일로 2일 뒤</Text>에
          통장에 들어오는데(이걸 D+2라고 해요), 주말·공휴일은 날짜에서 빼고 세요. 금요일에
          팔았으면 화요일에 들어오는 식이에요.
        </Text>
      </View>

      {preview && (
        <View style={s.lagExample}>
          <Text style={s.lagExampleLabel}>지금 설정 기준 예시</Text>
          <Text style={s.lagExampleText}>
            오늘({preview.sale_date.slice(5).replace('-', '/')}) {preview.issuer_name}로 결제 →{' '}
            <Text style={s.bold}>
              {preview.deposit_date.slice(5).replace('-', '/')}({preview.deposit_weekday})
            </Text>{' '}
            입금 (D+{preview.lag} 영업일)
          </Text>
          {preview.skipped.length > 0 && (
            <Text style={s.lagExampleSkip}>
              건너뛴 날: {preview.skipped.map((k) => `${k.label} ${k.reason}`).join(' · ')}
            </Text>
          )}
        </View>
      )}

      <PressableScale
        style={s.foldRow}
        onPress={() => {
          springy();
          setLagOpen((v) => !v);
        }}
        to={0.98}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.foldTitle}>
            {customizedIssuers.length > 0
              ? `카드사별로 조정함 (${customizedIssuers.length}곳)`
              : '카드사 기본값 그대로 쓰는 중 (권장)'}
          </Text>
          <Text style={s.foldHint}>
            통장에 찍힌 날짜가 앱과 다르면 여기서 카드사별로 고쳐 주세요.
          </Text>
        </View>
        <Ionicons name={lagOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.mochaBrown} />
      </PressableScale>

      {lagOpen && (
        <View style={{ marginTop: 6 }}>
          {data.issuers.map((iss) => (
            <View key={iss.code}>
              <PressableScale
                style={s.lagRow}
                onPress={() => iss.selectable && setPreviewIssuer(iss.code)}
                to={0.99}
              >
                <View style={[s.dot, { backgroundColor: iss.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.lagName}>{iss.name}</Text>
                  {!iss.selectable && (
                    <Text style={s.lagSub}>카드사를 나누지 않고 총액만 입력했을 때 쓰는 값</Text>
                  )}
                  {iss.customized && <Text style={s.lagSub}>직접 조정함 (기본 D+{iss.default_lag})</Text>}
                </View>
                <View style={s.stepper}>
                  <PressableScale
                    style={s.stepBtn}
                    onPress={() => setLag(iss.code, iss.lag - 1)}
                    to={0.88}
                  >
                    <Ionicons name="remove" size={15} color={colors.espressoBrown} />
                  </PressableScale>
                  <Text style={s.lagValue}>D+{iss.lag}</Text>
                  <PressableScale
                    style={s.stepBtn}
                    onPress={() => setLag(iss.code, iss.lag + 1)}
                    to={0.88}
                  >
                    <Ionicons name="add" size={15} color={colors.espressoBrown} />
                  </PressableScale>
                </View>
              </PressableScale>
              <Divider />
            </View>
          ))}
          {customizedIssuers.length > 0 && (
            <Button
              label="카드사 기본값으로 되돌리기"
              variant="ghost"
              textStyle={{ fontSize: 12 }}
              style={{ marginTop: 6 }}
              onPress={resetLags}
            />
          )}
          <Text style={s.footnote}>
            기본값은 여신전문금융업법상 지급기일(영세·중소 2영업일, 일반 3영업일)을 따른 추정치예요.
            BC카드와 간편결제는 회원사·PG를 거쳐 정산돼 보통 하루 더 걸립니다.
          </Text>
        </View>
      )}
    </>
  );

  const renderCalculator = () => (
    <>
      <Text style={s.hint}>
        금액과 카드를 바꿔 보면, 지금 설정으로 실제 얼마가 언제 들어오는지 바로 보여드려요.
      </Text>

      <View style={s.amountRow}>
        {AMOUNT_PRESETS.map((v) => (
          <PressableScale
            key={v}
            style={[s.amountChip, amount === v && s.amountChipActive]}
            onPress={() => {
              setAmount(v);
              setAmountText(String(v));
            }}
            to={0.95}
          >
            <Text style={[s.amountChipText, amount === v && s.amountChipTextActive]}>
              {v.toLocaleString('ko-KR')}원
            </Text>
          </PressableScale>
        ))}
      </View>
      <View style={s.customRow}>
        <Text style={s.customLabel}>직접 입력</Text>
        <TextInput
          style={[s.customInput, { flex: 1 }]}
          value={amountText}
          onChangeText={(t) => {
            const digits = t.replace(/[^0-9]/g, '').slice(0, 9);
            setAmountText(digits);
            setAmount(Number(digits || 0));
          }}
          keyboardType="number-pad"
          placeholder="50000"
          placeholderTextColor="rgba(140,111,86,0.45)"
        />
        <Text style={s.customUnit}>원</Text>
      </View>

      <View style={{ marginTop: 12 }}>
        <Segmented
          options={[
            { value: 'credit', label: '신용카드' },
            { value: 'check', label: '체크카드' },
          ]}
          value={cardType}
          onChange={(v) => setCardType(v as 'credit' | 'check')}
        />
      </View>

      <View style={s.issuerWrap}>
        {selectableIssuers.map((iss) => {
          const active = previewIssuer === iss.code;
          return (
            <PressableScale
              key={iss.code}
              style={[s.issuerChip, active && { backgroundColor: iss.color, borderColor: iss.color }]}
              onPress={() => setPreviewIssuer(iss.code)}
              to={0.95}
            >
              <Text style={[s.issuerChipText, active && { color: colors.white }]}>{iss.name}</Text>
            </PressableScale>
          );
        })}
      </View>

      {preview && (
        <View style={s.resultBox}>
          <View style={s.resultRow}>
            <Text style={s.resultLabel}>결제 금액</Text>
            <Text style={s.resultValue}>{won(preview.amount)}</Text>
          </View>
          <View style={s.resultRow}>
            <Text style={s.resultLabel}>카드 수수료 ({preview.fee_pct}%)</Text>
            <Text style={[s.resultValue, { color: '#B23B2E' }]}>− {won(preview.fee)}</Text>
          </View>
          <Divider style={{ marginVertical: 8 }} />
          <View style={s.resultRow}>
            <Text style={s.resultNetLabel}>통장에 들어올 돈</Text>
            <Text style={s.resultNet}>{won(preview.net)}</Text>
          </View>
          <View style={s.depositLine}>
            <Ionicons name="wallet-outline" size={15} color={colors.espressoBrown} />
            <Text style={s.depositText}>
              <Text style={s.bold}>
                {preview.deposit_date.slice(5).replace('-', '/')}({preview.deposit_weekday})
              </Text>{' '}
              입금 예정 · 오늘부터 {preview.calendar_days}일 뒤 (D+{preview.lag} 영업일)
            </Text>
          </View>
          {preview.skipped.length > 0 && (
            <View style={s.skipWrap}>
              {preview.skipped.map((k) => (
                <View key={k.date} style={s.skipChip}>
                  <Text style={s.skipText}>
                    {k.label} {k.reason} 건너뜀
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </>
  );

  // ── 설정 마법사 ─────────────────────────────────────────────
  if (wizard) {
    const titles = ['카드 수수료율 정하기', '입금까지 걸리는 날 확인', '설정 확인'];
    return (
      <>
        <Card tone="cream">
          <View style={s.wizHead}>
            <View style={s.wizIcon}>
              <Ionicons name="card" size={18} color={colors.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.wizTitle}>카드 정산 설정</Text>
              <Text style={s.wizSub}>
                딱 2가지만 정하면 돼요. 그러면 “카드값 언제 얼마 들어오지?”를 앱이 대신 계산해요.
              </Text>
            </View>
          </View>

          <View style={s.stepBar}>
            {titles.map((t, i) => (
              <View key={t} style={{ flex: 1, alignItems: 'center' }}>
                <View style={[s.stepDot, i <= step && s.stepDotActive]}>
                  {i < step ? (
                    <Ionicons name="checkmark" size={13} color={colors.white} />
                  ) : (
                    <Text style={[s.stepNum, i === step && { color: colors.white }]}>{i + 1}</Text>
                  )}
                </View>
                <Text style={[s.stepLabel, i === step && s.stepLabelActive]} numberOfLines={1}>
                  {['수수료율', '입금일', '확인'][i]}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        <Card>
          <SectionTitle>
            {step + 1}단계 · {titles[step]}
          </SectionTitle>

          {step === 0 && renderTierPicker()}
          {step === 1 && renderLagEditor()}
          {step === 2 && (
            <>
              <View style={s.doneBox}>
                <Text style={s.doneLine}>
                  수수료율 · <Text style={s.bold}>{data.tier_label}</Text> (신용{' '}
                  {data.credit_fee_pct}% / 체크 {data.check_fee_pct}%)
                </Text>
                <Text style={s.doneLine}>
                  입금 소요일 ·{' '}
                  <Text style={s.bold}>
                    {customizedIssuers.length > 0
                      ? `카드사별로 조정함 (${customizedIssuers.length}곳)`
                      : '카드사 기본값 사용'}
                  </Text>
                </Text>
              </View>
              {renderCalculator()}
            </>
          )}

          <View style={s.navRow}>
            {step > 0 ? (
              <Button
                label="이전"
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => {
                  springy();
                  setStep((v) => v - 1);
                }}
              />
            ) : (
              <Button
                label="나중에 할게요"
                variant="ghost"
                style={{ flex: 1 }}
                onPress={() => {
                  springy();
                  setWizard(false);
                }}
              />
            )}
            <Button
              label={step === 2 ? '설정 완료' : '다음'}
              style={{ flex: 1.4 }}
              disabled={saving}
              onPress={() => {
                springy();
                if (step === 2) {
                  // 각 단계에서 이미 저장했으니 여기서는 마법사만 닫는다
                  setWizard(false);
                  toast('설정 완료', '이제 매출만 입력하면 입금 예정일까지 계산해 드려요.');
                } else {
                  setStep((v) => v + 1);
                }
              }}
            />
          </View>

          {step === 0 && !data.configured && (
            <Text style={s.footnote}>
              지금은 기본값(영세 구간)으로 계산 중이에요. 구간을 고르지 않으면 수수료가 실제와
              달라질 수 있어요.
            </Text>
          )}
          {offline && (
            <Text style={s.offlineNote}>
              서버에 연결되지 않아 이 기기에만 저장돼요. 연결되면 다시 저장해 주세요.
            </Text>
          )}
        </Card>
      </>
    );
  }

  // ── 평상시 화면 (설정 완료 후) ──────────────────────────────
  return (
    <>
      <Card>
        <View style={s.summaryHead}>
          <SectionTitle>지금 설정</SectionTitle>
          <PressableScale style={s.redoBtn} onPress={() => { springy(); setStep(0); setWizard(true); }} to={0.95}>
            <Ionicons name="refresh" size={13} color={colors.espressoBrown} />
            <Text style={s.redoText}>다시 안내받기</Text>
          </PressableScale>
        </View>

        <View style={s.summaryGrid}>
          <View style={s.summaryCell}>
            <Text style={s.summaryLabel}>신용카드 수수료</Text>
            <Text style={s.summaryValue}>{data.credit_fee_pct}%</Text>
            <Text style={s.summaryMeta}>10,000원당 {won(Math.round(10_000 * data.credit_fee_pct / 100))}</Text>
          </View>
          <View style={s.summaryCell}>
            <Text style={s.summaryLabel}>체크카드 수수료</Text>
            <Text style={s.summaryValue}>{data.check_fee_pct}%</Text>
            <Text style={s.summaryMeta}>10,000원당 {won(Math.round(10_000 * data.check_fee_pct / 100))}</Text>
          </View>
        </View>
        <Text style={s.summaryTier}>{data.tier_label}</Text>
      </Card>

      <Card>
        <SectionTitle>얼마가 언제 들어오나 (미리보기)</SectionTitle>
        {renderCalculator()}
      </Card>

      <Card>
        <SectionTitle>카드 수수료율</SectionTitle>
        {renderTierPicker()}
      </Card>

      <Card>
        <SectionTitle>카드사별 입금 소요일</SectionTitle>
        {renderLagEditor()}
      </Card>

      <Card tone="cream">
        <SectionTitle>자주 묻는 질문</SectionTitle>
        {HELP.map((item, i) => {
          const open = helpOpen === i;
          return (
            <View key={item.q}>
              <PressableScale
                style={s.helpRow}
                onPress={() => {
                  springy();
                  setHelpOpen(open ? null : i);
                }}
                to={0.99}
              >
                <Text style={s.helpQ}>{item.q}</Text>
                <Ionicons
                  name={open ? 'chevron-up' : 'chevron-down'}
                  size={15}
                  color={colors.mochaBrown}
                />
              </PressableScale>
              {open && <Text style={s.helpA}>{item.a}</Text>}
              {i < HELP.length - 1 && <Divider />}
            </View>
          );
        })}
      </Card>

      {offline && (
        <Text style={s.offlineNote}>
          서버에 연결되지 않아 이 기기에만 저장돼요. 연결되면 다시 저장해 주세요.
        </Text>
      )}
    </>
  );
}

// 서버 저장이 실패했을 때 화면 상태만이라도 맞춰 주는 로컬 반영
function applyLocally(
  prev: SettlementSettings,
  body: Parameters<typeof updateSettlementSettings>[1],
): SettlementSettings {
  let next = { ...prev };
  if (body.revenue_tier) {
    const tier = prev.tiers.find((t) => t.code === body.revenue_tier);
    if (tier) {
      next = {
        ...next,
        revenue_tier: tier.code,
        tier_label: tier.label,
        credit_fee_pct: body.custom_credit_fee ?? tier.credit,
        check_fee_pct: body.custom_check_fee ?? tier.check,
      };
    }
  }
  if (body.lag_overrides) {
    next = {
      ...next,
      issuers: prev.issuers.map((i) => {
        const lag = body.lag_overrides?.[i.code] ?? i.lag;
        return { ...i, lag, customized: lag !== i.default_lag };
      }),
    };
    next.lag_customized = next.issuers.some((i) => i.customized);
  }
  return next;
}

const HELP: { q: string; a: string }[] = [
  {
    q: '우리 가게 수수료율은 어디서 확인하나요?',
    a: '카드사가 보내주는 ‘가맹점 수수료율 통보서’(보통 연 1회 우편·문자)나 여신금융협회 가맹점 매출조회 서비스에서 볼 수 있어요. 연매출 30억 이하면 나라에서 정한 우대요율이 적용되고, 매년 국세청 신고 매출을 기준으로 다시 정해져요.',
  },
  {
    q: 'D+2 영업일이 정확히 며칠인가요?',
    a: '결제한 날은 세지 않고, 그 다음 영업일부터 두 번 세는 날이에요. 주말과 공휴일은 은행이 쉬어서 세지 않아요. 예를 들어 금요일에 결제되면 토·일을 건너뛰고 화요일에 들어옵니다.',
  },
  {
    q: '앱이 알려준 날짜·금액이 통장과 다르면요?',
    a: '앱 숫자는 계약 기준 예상치예요. 통장 입금일이 하루 늦다면 그 카드사의 소요일을 D+3으로 올려 주세요. 금액이 계속 다르면 수수료율을 ‘직접 입력’으로 바꿔 계약서 요율을 넣으면 맞아집니다.',
  },
  {
    q: '신용카드와 체크카드 수수료가 왜 다른가요?',
    a: '체크카드는 통장에서 바로 빠져나가 카드사가 돈을 빌려주지 않아요. 그만큼 비용이 적어 수수료율이 신용카드보다 낮게 정해져 있어요.',
  },
  {
    q: '카드사를 안 나누고 총액만 입력해도 되나요?',
    a: '괜찮아요. 그럴 땐 ‘카드사 미지정’으로 들어가고 입금일은 가장 늦은 기준(3영업일)으로 잡아요. 실제보다 늦게 잡아야 “들어올 줄 알았는데 안 들어왔다”가 생기지 않아서예요.',
  },
];

const s = StyleSheet.create({
  hint: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 4 },
  bold: { fontWeight: '900', color: colors.espressoBrown },
  footnote: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 12 },
  offlineNote: {
    ...typography.L5,
    color: '#B23B2E',
    lineHeight: 16,
    marginTop: 10,
    textAlign: 'center',
  },

  // 마법사 헤더
  wizHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  wizIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.espressoBrown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wizTitle: { fontSize: 16, fontWeight: '900', color: colors.espressoBrown },
  wizSub: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 3 },
  stepBar: { flexDirection: 'row', marginTop: 16 },
  stepDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  stepDotActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  stepNum: { fontSize: 11, fontWeight: '900', color: colors.mochaBrown },
  stepLabel: { ...typography.L5, color: colors.mochaBrown, marginTop: 5 },
  stepLabelActive: { color: colors.espressoBrown, fontWeight: '900' },
  navRow: { flexDirection: 'row', gap: 8, marginTop: 18 },

  // 설명 박스
  explainBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
  },
  explainText: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, flex: 1 },

  // 구간 추천
  suggestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.espressoBrown,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 12,
  },
  suggestBtnText: { color: colors.white, fontSize: 13, fontWeight: '800' },
  suggestBox: {
    backgroundColor: 'rgba(78,125,58,0.07)',
    borderRadius: 12,
    padding: 13,
    marginTop: 10,
    gap: 4,
  },
  suggestHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  suggestTitle: { fontSize: 13.5, fontWeight: '900', color: colors.espressoBrown },
  suggestLine: { ...typography.L4, color: colors.espressoBrown, lineHeight: 18 },
  suggestMeta: { ...typography.L5, color: colors.mochaBrown, lineHeight: 15 },

  groupLabel: {
    ...typography.L5,
    fontWeight: '800',
    color: colors.mochaBrown,
    marginTop: 16,
    marginBottom: 8,
  },

  // 구간 선택 행
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tierRowActive: { backgroundColor: colors.coffeeCream, borderColor: colors.mutedSand },
  tierTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tierLabel: { ...typography.L4, color: colors.espressoBrown },
  tierExample: { ...typography.L5, color: colors.mochaBrown, marginTop: 3, lineHeight: 15 },
  tierRate: { fontSize: 13, fontWeight: '900', color: colors.espressoBrown },

  // 직접 입력
  customBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customLabel: { ...typography.L4, color: colors.espressoBrown, width: 66 },
  customInput: {
    ...typography.L4,
    color: colors.espressoBrown,
    backgroundColor: colors.white,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 84,
    textAlign: 'right',
  },
  customUnit: { ...typography.L4, color: colors.mochaBrown },
  customHint: { ...typography.L5, color: colors.mochaBrown, lineHeight: 15, marginTop: 2 },

  nowBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.trendGreenBg,
    borderRadius: 10,
    padding: 11,
    marginTop: 14,
  },
  nowText: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 16 },

  // 입금 소요일
  lagExample: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    gap: 3,
  },
  lagExampleLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '800' },
  lagExampleText: { ...typography.L4, color: colors.espressoBrown, lineHeight: 18 },
  lagExampleSkip: { ...typography.L5, color: colors.mochaBrown, lineHeight: 15 },

  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 12,
  },
  foldTitle: { ...typography.L4, color: colors.espressoBrown },
  foldHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 3, lineHeight: 15 },

  lagRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  lagName: { ...typography.L4, color: colors.espressoBrown },
  lagSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lagValue: { ...typography.L4, color: colors.espressoBrown, minWidth: 36, textAlign: 'center' },

  // 미리보기 계산기
  amountRow: { flexDirection: 'row', gap: 7, marginTop: 12 },
  amountChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.creamSand,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  amountChipActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  amountChipText: { ...typography.L5, fontWeight: '800', color: colors.mochaBrown },
  amountChipTextActive: { color: colors.white },

  issuerWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  issuerChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.creamSand,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  issuerChipText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },

  resultBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 14,
    marginTop: 14,
  },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 3 },
  resultLabel: { ...typography.L5, color: colors.mochaBrown },
  resultValue: { ...typography.L4, color: colors.espressoBrown },
  resultNetLabel: { ...typography.L4, color: colors.espressoBrown },
  resultNet: { fontSize: 19, fontWeight: '900', color: colors.espressoBrown },
  depositLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 10 },
  depositText: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 16 },
  skipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  skipChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.white,
  },
  skipText: { ...typography.L5, color: colors.mochaBrown },

  // 마법사 마지막 단계 요약
  doneBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 13,
    marginTop: 10,
    gap: 5,
  },
  doneLine: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17 },

  // 평상시 요약 카드
  summaryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  redoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.coffeeCream,
  },
  redoText: { ...typography.L5, fontWeight: '800', color: colors.espressoBrown },
  summaryGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  summaryCell: {
    flex: 1,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 13,
  },
  summaryLabel: { ...typography.L5, color: colors.mochaBrown },
  summaryValue: { fontSize: 21, fontWeight: '900', color: colors.espressoBrown, marginTop: 3 },
  summaryMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  summaryTier: { ...typography.L5, color: colors.mochaBrown, marginTop: 10 },

  // FAQ
  helpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 13,
  },
  helpQ: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  helpA: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, paddingBottom: 13 },
});
