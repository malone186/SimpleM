// 손익분기점 — "얼마를 팔아야 본전인가"
//
// 사장님이 매달 보는 숫자는 매출 하나뿐이라, 매출이 늘어도 통장이 그대로인 이유를
// 설명할 길이 없다. 한 잔도 안 팔아도 나가는 돈(고정비)과 팔릴 때마다 따라 붙는 돈
// (재료비·카드 수수료)을 나눠 보여 주고, 그 경계선이 어디인지 알려 주는 화면이다.
//
// 입력은 고정비 네 칸만 받는다. 변동비율은 서버가 최근 판매에서 자동으로 뽑고,
// 레시피가 없어 못 뽑는 매장만 직접 적는다.
import { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import { FadeInUp, PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Card, ProgressBar, SectionTitle } from '../../components/ui';
import {
  FIXED_COST_FIELDS,
  clearVariableRatio,
  getBreakeven,
  getFixedCosts,
  saveFixedCosts,
  simulateBreakeven,
  suggestFixedCosts,
  type Breakeven,
  type FixedCostField,
  type FixedCosts,
  type FixedCostSuggestion,
} from '../../lib/api/breakeven';
import { colors, spacing, typography } from '../../theme';
import { useBottomInset } from '../../theme/responsive';

const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

// 입력칸은 문자열로 들고 있다 — 타이핑 중간의 빈 문자열·앞자리 0을 숫자로 바꾸면
// 커서가 튀고 지울 수가 없다. 저장할 때만 숫자로 바꾼다.
type Draft = Record<FixedCostField, string>;

const emptyDraft: Draft = { rent: '', labor: '', utilities: '', other: '' };

const toDraft = (f: FixedCosts): Draft =>
  FIXED_COST_FIELDS.reduce(
    (acc, k) => ({ ...acc, [k]: f[k] ? String(f[k]) : '' }),
    emptyDraft,
  );

const digitsOf = (s: string) => Number(s.replace(/[^0-9]/g, '')) || 0;

export default function BreakEvenScreen() {
  const { token } = useAuth();
  const bottomInset = useBottomInset();

  const [fixed, setFixed] = useState<FixedCosts | null>(null);
  const [result, setResult] = useState<Breakeven | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [openDays, setOpenDays] = useState('');
  const [ratioText, setRatioText] = useState(''); // 변동비율 직접 입력 (자동이면 비어 있다)
  const [targetProfit, setTargetProfit] = useState('');
  const [suggestion, setSuggestion] = useState<FixedCostSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    // 로딩 해제를 finally에 맡기면 여기서 빠져나갈 때 영영 안 풀린다 (스피너 고정)
    if (!token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const [f, r] = await Promise.all([getFixedCosts(token), getBreakeven(token)]);
      setFixed(f);
      setResult(r);
      setOpenDays(String(f.open_days_per_month));
      setRatioText(f.custom_variable_ratio != null ? String(f.custom_variable_ratio) : '');

      // 아직 한 번도 저장 안 한 매장이면, 빈 칸 대신 앱이 이미 아는 값으로 미리 채운다.
      // (지난 지출·급여) — 사장님은 타이핑 대신 확인만 하면 된다. 온보딩 벽 낮추기.
      if (!f.configured) {
        try {
          const sg = await suggestFixedCosts(token);
          if (sg.has_any) {
            setSuggestion(sg);
            setDraft(FIXED_COST_FIELDS.reduce(
              (acc, k) => ({ ...acc, [k]: sg.suggested[k] ? String(sg.suggested[k]) : '' }),
              emptyDraft,
            ));
            setOpenDays(String(sg.open_days_per_month));
            return;
          }
        } catch {
          /* 제안 실패는 무해 — 그냥 빈 칸으로 둔다 */
        }
      }
      setDraft(toDraft(f));
    } catch (e) {
      toast('불러오기 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const draftTotal = FIXED_COST_FIELDS.reduce((sum, k) => sum + digitsOf(draft[k]), 0);

  const save = async () => {
    if (!token) return;
    const days = Number(openDays) || 0;
    if (days < 1 || days > 31) {
      return toast('입력 확인', '한 달 영업일수는 1~31일 사이로 적어 주세요.');
    }
    const ratio = ratioText.trim() === '' ? null : Number(ratioText);
    if (ratio != null && (Number.isNaN(ratio) || ratio < 0 || ratio >= 100)) {
      return toast('입력 확인', '변동비율은 0 이상 100 미만(%)으로 적어 주세요.');
    }

    setSaving(true);
    try {
      const patch: Parameters<typeof saveFixedCosts>[1] = {
        ...FIXED_COST_FIELDS.reduce((acc, k) => ({ ...acc, [k]: digitsOf(draft[k]) }), {}),
        open_days_per_month: days,
      };
      // 비워 두면 '자동으로 되돌리기'다 — PUT으로는 null을 보낼 수 없어 전용 경로를 쓴다
      const res = ratio == null
        ? await saveFixedCosts(token, patch).then(() => clearVariableRatio(token))
        : await saveFixedCosts(token, { ...patch, custom_variable_ratio: ratio });

      setFixed(res.fixed_costs);
      setResult(res.breakeven);
      toast('저장했어요', '손익분기점을 다시 계산했습니다.');
    } catch (e) {
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  // 목표이익 — 저장하지 않고 '이만큼 남기려면 얼마 팔아야 하나'만 다시 계산한다
  const applyTarget = async () => {
    if (!token) return;
    try {
      setResult(await simulateBreakeven(token, { target_profit: digitsOf(targetProfit) }));
    } catch (e) {
      toast('계산 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.pointOrange} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 32 }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.mochaBrown} />
      }
    >
      {/* ── 결과 ── 이 화면에서 제일 먼저 읽혀야 하는 숫자라 맨 위에 둔다 */}
      <FadeInUp>
        {result?.computed ? <ResultCard r={result} /> : <NeedsCard r={result} />}
      </FadeInUp>

      {/* ── 고정비 입력 ── */}
      <FadeInUp delay={60}>
        <SectionTitle>매달 나가는 고정비</SectionTitle>
        <Card>
          <Text style={styles.cardHint}>
            한 잔도 안 팔아도 나가는 돈이에요. 사장님 본인 급여와 보험료도 넣어야 정확합니다.
          </Text>

          {/* 자동 채우기 안내 — 지난 지출·급여에서 미리 넣었으니 확인만 하면 된다 */}
          {suggestion && (
            <View style={styles.suggestBanner}>
              <Ionicons name="sparkles" size={14} color="#C07030" />
              <Text style={styles.suggestText}>
                지난 지출·급여에서 미리 채웠어요. 맞는지 확인하고 저장하세요.
              </Text>
            </View>
          )}

          {FIXED_COST_FIELDS.map((key) => (
            <View key={key} style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabel}>{fixed?.labels?.[key] ?? key}</Text>
                {suggestion?.sources?.[key] && (
                  <Text style={styles.fieldSource}>{suggestion.sources[key]}</Text>
                )}
              </View>
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={draft[key]}
                  onChangeText={(t) => setDraft((d) => ({ ...d, [key]: t.replace(/[^0-9]/g, '') }))}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor="#A1A1AA"
                />
                <Text style={styles.inputUnit}>원</Text>
              </View>
            </View>
          ))}

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>고정비 합계</Text>
            <Text style={styles.totalValue}>{won(draftTotal)}</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>한 달 영업일수</Text>
            {/* 기본 minWidth(140)가 width(110)를 이겨 박스가 커지던 충돌 — 둘 다 110으로 고정 */}
            <View style={[styles.inputWrap, { width: 110, minWidth: 110 }]}>
              <TextInput
                style={styles.input}
                value={openDays}
                onChangeText={(t) => setOpenDays(t.replace(/[^0-9]/g, ''))}
                keyboardType="numeric"
                placeholder="26"
                placeholderTextColor="#A1A1AA"
              />
              <Text style={styles.inputUnit}>일</Text>
            </View>
          </View>

          <PressableScale
            style={[styles.saveBtn, saving && { opacity: 0.6 }]}
            onPress={saving ? undefined : save}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Ionicons name="calculator" size={15} color={colors.white} />
                <Text style={styles.saveBtnText}>저장하고 다시 계산</Text>
              </>
            )}
          </PressableScale>
        </Card>
      </FadeInUp>

      {/* ── 변동비율 ── 자동으로 잡혔으면 근거를, 못 잡았으면 입력칸을 보여 준다 */}
      <FadeInUp delay={120}>
        <SectionTitle>팔릴 때마다 나가는 돈</SectionTitle>
        <Card>
          {result?.variable_cost_ratio != null && (
            <View style={styles.ratioHead}>
              <Text style={styles.ratioValue}>{result.variable_cost_ratio}%</Text>
              <Badge
                label={result.variable_cost_source === 'auto' ? '판매 데이터로 자동' : '직접 입력'}
                tone={result.variable_cost_source === 'auto' ? 'green' : 'neutral'}
              />
            </View>
          )}
          {result?.variable_breakdown?.length ? (
            result.variable_breakdown.map((p) => (
              <View key={p.label} style={styles.partRow}>
                <Text style={styles.partLabel}>{p.label}</Text>
                <Text style={styles.partPct}>{p.pct}%</Text>
                <Text style={styles.partSource}>{p.source}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.cardHint}>
              메뉴 레시피가 등록되면 재료비율이 실제 판매에서 자동으로 잡혀요.
            </Text>
          )}

          <View style={[styles.field, { marginTop: 12 }]}>
            <Text style={styles.fieldLabel}>직접 적기 (선택)</Text>
            <View style={[styles.inputWrap, { width: 110, minWidth: 110 }]}>
              <TextInput
                style={styles.input}
                value={ratioText}
                onChangeText={(t) => setRatioText(t.replace(/[^0-9.]/g, ''))}
                keyboardType="numeric"
                placeholder="자동"
                placeholderTextColor="#A1A1AA"
              />
              <Text style={styles.inputUnit}>%</Text>
            </View>
          </View>
          <Text style={styles.cardHint}>
            비워 두면 판매 데이터로 자동 계산해요. 위 '저장하고 다시 계산'을 눌러야 반영됩니다.
          </Text>
        </Card>
      </FadeInUp>

      {/* ── 목표이익 ── 본전 말고 '이만큼 남기려면' */}
      {result?.computed && (
        <FadeInUp delay={180}>
          <SectionTitle>이만큼 남기려면?</SectionTitle>
          <Card>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>월 목표이익</Text>
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={targetProfit}
                  onChangeText={(t) => setTargetProfit(t.replace(/[^0-9]/g, ''))}
                  onSubmitEditing={applyTarget}
                  keyboardType="numeric"
                  placeholder="3000000"
                  placeholderTextColor="#A1A1AA"
                />
                <Text style={styles.inputUnit}>원</Text>
              </View>
            </View>
            <PressableScale style={styles.targetBtn} onPress={applyTarget}>
              <Text style={styles.targetBtnText}>계산하기</Text>
            </PressableScale>

            {!!result.target_profit && result.target_revenue != null && (
              <View style={styles.targetResult}>
                <Text style={styles.targetResultText}>
                  월 {won(result.target_profit)}을 남기려면{'\n'}
                  <Text style={styles.targetResultStrong}>
                    한 달 {won(result.target_revenue)} · 하루 {won(result.target_daily_revenue ?? 0)}
                  </Text>
                  {result.target_daily_cups ? `\n(하루 약 ${result.target_daily_cups}잔)` : ''}
                </Text>
              </View>
            )}
          </Card>
        </FadeInUp>
      )}

      <Text style={styles.footNote}>
        최근 판매 구조가 유지된다는 가정 위의 예상치예요. 재료 단가나 메뉴 구성이 바뀌면 다시 계산됩니다.
      </Text>
    </ScrollView>
  );
}

/** 계산이 된 경우 — 본전 매출과 지금 위치 */
function ResultCard({ r }: { r: Breakeven }) {
  const gap = r.gap_to_breakeven ?? 0;
  const over = gap <= 0;
  const pct = r.achievement_pct ?? null;

  return (
    <Card style={styles.heroCard}>
      <Text style={styles.heroLabel}>한 달에 이만큼 팔아야 본전</Text>
      <Text style={styles.heroValue}>{won(r.breakeven_revenue ?? 0)}</Text>
      <Text style={styles.heroSub}>
        하루 {won(r.breakeven_daily_revenue ?? 0)}
        {r.breakeven_daily_cups ? ` · 약 ${r.breakeven_daily_cups}잔` : ''}
        {r.open_days_per_month ? ` (${r.open_days_per_month}일 영업 기준)` : ''}
      </Text>

      {pct != null && (
        <View style={styles.progressBlock}>
          <View style={styles.progressHead}>
            <Text style={styles.progressLabel}>최근 실적 {won(r.current_monthly_revenue ?? 0)}</Text>
            <Badge label={`${pct}%`} tone={over ? 'green' : 'orange'} />
          </View>
          {/* 100%를 넘어도 바가 꽉 찬 상태로 멈춘다 — 넘긴 정도는 아래 문장이 말해 준다 */}
          <ProgressBar ratio={pct / 100} tone={over ? 'green' : 'mocha'} />
          <Text style={[styles.progressHint, over && styles.progressHintOver]}>
            {over
              ? `본전을 넘겼어요 · 이대로면 월 ${won(r.estimated_profit ?? 0)} 남습니다`
              : `${won(gap)} 모자라요`}
          </Text>
        </View>
      )}

      <View style={styles.metaGrid}>
        <MetaCell label="공헌이익률" value={`${r.contribution_margin_ratio}%`} />
        <MetaCell label="변동비율" value={`${r.variable_cost_ratio}%`} />
        {r.margin_of_safety_pct != null && (
          <MetaCell label="안전한계율" value={`${r.margin_of_safety_pct}%`} />
        )}
        {r.avg_ticket != null && <MetaCell label="객단가" value={won(r.avg_ticket)} />}
      </View>

      {!!r.warning && (
        <View style={styles.warnBox}>
          <Ionicons name="alert-circle" size={14} color="#B23B2E" />
          <Text style={styles.warnText}>{r.warning}</Text>
        </View>
      )}
    </Card>
  );
}

/** 계산이 안 되는 경우 — 0원 대신 무엇이 부족한지 말한다 */
function NeedsCard({ r }: { r: Breakeven | null }) {
  const danger = r?.impossible;
  return (
    <Card style={[styles.heroCard, styles.needsCard, danger && styles.needsCardDanger]}>
      <Ionicons
        name={danger ? 'warning' : 'information-circle'}
        size={30}
        color={danger ? '#B23B2E' : colors.mochaBrown}
      />
      <Text style={[styles.needsTitle, danger && { color: '#B23B2E' }]}>
        {danger ? '지금 구조로는 본전을 넘길 수 없어요' : '조금만 더 알려 주세요'}
      </Text>
      <Text style={styles.needsBody}>
        {r?.message ?? '고정비를 입력하면 손익분기점을 계산해 드릴게요.'}
      </Text>
    </Card>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  content: { padding: spacing.globalPadding },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.creamSand },

  heroCard: { marginBottom: 14 },
  heroLabel: { ...typography.L5, color: colors.mochaBrown },
  heroValue: { ...typography.L2, color: colors.espressoBrown, marginTop: 2 },
  heroSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },

  progressBlock: { marginTop: 16 },
  progressHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 },
  progressLabel: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  progressHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 6 },
  progressHintOver: { color: colors.trendGreenText, fontWeight: '700' },

  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  metaCell: {
    flexGrow: 1,
    minWidth: '46%',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  metaLabel: { ...typography.L5, color: colors.mochaBrown },
  metaValue: { ...typography.L3, color: colors.espressoBrown, marginTop: 1 },

  warnBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: '#F6DED8',
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
  },
  warnText: { ...typography.L5, color: '#B23B2E', flex: 1, lineHeight: 16 },

  needsCard: { alignItems: 'center', gap: 6, paddingVertical: 26 },
  needsCardDanger: { borderColor: '#E9BDB4', borderWidth: 1.2 },
  needsTitle: { ...typography.L3, color: colors.espressoBrown, marginTop: 4 },
  needsBody: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 },

  cardHint: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginBottom: 4 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 10,
  },
  fieldLabel: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', flexShrink: 1 },
  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, flexWrap: 'wrap' },
  fieldSource: { ...typography.L5, color: '#3E9B4F', fontSize: 10, fontWeight: '600' },
  suggestBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(192,112,48,0.10)', borderRadius: 10,
    paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12, marginTop: 2,
  },
  suggestText: { ...typography.L5, color: '#8A5A2B', fontWeight: '600', flexShrink: 1, lineHeight: 15 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingHorizontal: 11,
    height: 40,
    minWidth: 140,
  },
  input: {
    flex: 1,
    // 웹의 <input>은 고유 최소 폭이 있어 flex여도 줄어들지 않는다 — 그대로 두면
    // 옆의 단위 글자('일'·'%')를 박스 밖, 심하면 카드 밖까지 밀어낸다. 0으로 풀어준다.
    minWidth: 0,
    textAlign: 'right',
    color: colors.espressoBrown,
    fontSize: 14,
    fontWeight: '700',
    // 웹에서 숫자 입력칸의 기본 파란 외곽선을 지운다
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  inputUnit: { ...typography.L5, color: colors.mochaBrown },

  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
  },
  totalLabel: { ...typography.L4, color: colors.espressoBrown },
  totalValue: { ...typography.L3, color: colors.pointOrange },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    height: 44,
    marginTop: 16,
  },
  saveBtnText: { ...typography.L4, fontWeight: '800', color: colors.white },

  ratioHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  ratioValue: { ...typography.L2, color: colors.espressoBrown },
  partRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  partLabel: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 78 },
  partPct: { ...typography.L4, color: colors.pointOrange, width: 52 },
  partSource: { ...typography.L5, color: colors.mochaBrown, flex: 1, textAlign: 'right' },

  targetBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
    marginTop: 12,
  },
  targetBtnText: { ...typography.L5, fontWeight: '800', color: colors.espressoBrown },
  targetResult: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 13,
    marginTop: 12,
  },
  targetResultText: { ...typography.L5, color: colors.mochaBrown, lineHeight: 20 },
  targetResultStrong: { ...typography.L3, color: colors.espressoBrown },

  footNote: {
    ...typography.L5,
    color: colors.mochaBrown,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 18,
  },
});
