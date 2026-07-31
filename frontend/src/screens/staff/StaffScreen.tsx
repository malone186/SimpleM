// 직원 상세 · 인건비 — 이름과 시급만으로는 "얼마 나가는지" 알 수 없어서 만든 화면.
//
// 사장님이 실제로 구분해야 하는 것들(피드백 반영):
//   · 파트타이머냐 / 주 15시간 이상이냐 / 매니저냐
//   · 시급제냐 월급제냐
//   · 4대보험 / 2대보험(고용·산재) / 미가입
//   · 주휴수당이 얼마나 더 붙는지
// 이 네 가지를 고르면 월 인건비와 사업주 부담까지 즉시 계산해 준다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useAuth } from '../../auth/AuthContext';
import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { createEmployee, deleteEmployee } from '../../lib/api/operation';
import {
  getWeeklyPayroll,
  listStaff,
  saveStaffProfile,
  type StaffList,
  type StaffMember,
  type WeeklyPayroll,
} from '../../lib/api/staff';
import { colors, typography } from '../../theme';

const won = (n: number) => `₩${Math.round(n || 0).toLocaleString('ko-KR')}`;
const toNum = (s: string) => Number(s.replace(/[^\d.]/g, '')) || 0;

/**
 * API 실패를 사장님이 뭘 해야 할지 아는 문장으로 바꾼다.
 *
 * apiFetch는 "404 · detail" 형태로 던지므로 상태 코드를 앞에서 읽을 수 있다.
 * 404가 가장 헷갈리는 경우다 — 서버는 살아 있는데 이 기능만 아직 배포가 안 된 상태라,
 * 로그인이나 네트워크를 아무리 확인해도 원인을 못 찾는다.
 */
function describeApiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('404')) {
    return '서버에 직원·인건비 기능이 아직 없어요 (404). 백엔드를 최신 버전으로 배포하면 바로 보입니다.';
  }
  if (msg.startsWith('401') || msg.startsWith('403')) {
    return '로그인이 만료됐어요. 로그아웃 후 다시 로그인해 주세요.';
  }
  if (msg.startsWith('500') || msg.startsWith('502') || msg.startsWith('503')) {
    return '서버에서 오류가 났어요. 잠시 후 다시 시도해 주세요.';
  }
  if (/Network|Failed to fetch|fetch failed/i.test(msg)) {
    return '서버에 연결하지 못했어요. 인터넷 연결과 서버 주소를 확인해 주세요.';
  }
  return `직원 정보를 가져오지 못했어요. (${msg})`;
}

const TYPE_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  part_time: 'time-outline',
  part_time_15: 'people-outline',
  full_time: 'briefcase-outline',
  manager: 'ribbon-outline',
};

export default function StaffScreen() {
  const { token } = useAuth();
  const [data, setData] = useState<StaffList | null>(null);
  const [weekly, setWeekly] = useState<WeeklyPayroll | null>(null);
  // 실패 사유를 그대로 들고 있는다 — "가져오지 못했어요"만 띄우면 사장님도 나도
  // 무엇을 고쳐야 하는지 알 수 없다 (실제로 원인은 '서버에 이 기능이 아직 없음'이었다).
  const [failed, setFailed] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  // 직원 추가 폼
  const [adding, setAdding] = useState(false);
  const [nName, setNName] = useState('');
  const [nRate, setNRate] = useState('');
  const [nRole, setNRole] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [s, w] = await Promise.all([
        listStaff(token),
        getWeeklyPayroll(token).catch(() => null),
      ]);
      setData(s);
      setWeekly(w);
      setFailed(null);
    } catch (e) {
      console.error('직원 목록 조회 실패:', e);
      setFailed(describeApiError(e));
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (emp: StaffMember, body: Record<string, unknown>) => {
    if (!token) return;
    setSaving(emp.id);
    try {
      await saveStaffProfile(token, emp.id, body as any);
      await load();
    } catch (e) {
      console.error('직원 상세 저장 실패:', e);
      toast('저장 실패', '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(null);
    }
  };

  const submitNew = async () => {
    const rate = toNum(nRate);
    if (!nName.trim() || rate <= 0) {
      toast('추가 실패', '이름과 시급을 입력해 주세요.');
      return;
    }
    try {
      await createEmployee({ name: nName.trim(), hourly_rate: rate, role: nRole.trim() || '알바' }, token ?? undefined);
      setNName('');
      setNRate('');
      setNRole('');
      setAdding(false);
      await load();
      toast('직원을 추가했어요', '아래에서 고용형태와 보험을 골라 주세요.');
    } catch (e) {
      console.error('직원 등록 실패:', e);
      toast('추가 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const removeStaff = (emp: StaffMember) =>
    confirmDialog(`'${emp.name}' 직원을 삭제할까요? 스케줄 기록도 함께 지워집니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteEmployee(emp.id);
          await load();
          toast('삭제 완료', `${emp.name} 직원을 삭제했어요.`);
        } catch (e) {
          toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });

  // 근무시간을 알 수 없는 직원 수 — 인건비가 0으로 보이는 유일한 이유다
  const unknownHours = data?.unknown_hours_count ?? 0;

  return (
    <>
      <Screen>
        <ScreenTitle
          title="직원 · 인건비"
          subtitle="고용형태와 보험을 고르면 실제 나가는 돈까지 계산해 드려요"
        />

        {/* 매장 합계 — 사장님이 가장 먼저 보고 싶은 숫자 */}
        {data && data.staff.length > 0 && (
          <Card>
            <Text style={styles.totalLabel}>
              {data.month.replace('-', '년 ')}월 인건비 (예상)
            </Text>
            <Text style={styles.totalValue}>{won(data.total_cost)}</Text>
            <Text style={styles.totalSub}>
              근무 달력에 등록된 총 {data.total_hours}시간 기준
            </Text>
            <View style={styles.totalBreak}>
              <View style={styles.totalCol}>
                <Text style={styles.colLabel}>직원 지급액</Text>
                <Text style={styles.colValue}>{won(data.total_gross)}</Text>
              </View>
              <View style={styles.colDivider} />
              <View style={styles.totalCol}>
                <Text style={styles.colLabel}>사업주 보험 부담</Text>
                <Text style={styles.colValue}>{won(data.total_owner_burden)}</Text>
              </View>
              <View style={styles.colDivider} />
              <View style={styles.totalCol}>
                <Text style={styles.colLabel}>직원 수</Text>
                <Text style={styles.colValue}>{data.staff.length}명</Text>
              </View>
            </View>
            {unknownHours > 0 && (
              <View style={styles.warnBox}>
                <Ionicons name="information-circle-outline" size={14} color="#C98A2B" />
                <Text style={styles.warnText}>
                  근무 시간을 알 수 없는 직원이 {unknownHours}명이라 그만큼 인건비가 빠져 있어요.
                  근무 달력에 스케줄을 넣거나, 아래에서 주 근무시간을 적어 주세요.
                </Text>
              </View>
            )}
          </Card>
        )}

        {/* 이번 주 줄 돈 — 주급 정산하는 매장이 많다 */}
        {weekly && weekly.rows.length > 0 && (
          <Card tone="cream">
            <View style={styles.rowBetween}>
              <Text style={styles.cardHead}>이번 주 줄 돈</Text>
              <Text style={styles.weekTotal}>{won(weekly.total)}</Text>
            </View>
            <Text style={styles.weekRange}>
              {weekly.week_start.slice(5)} ~ {weekly.week_end.slice(5)}
              {weekly.holiday_total > 0 ? ` · 주휴수당 ${won(weekly.holiday_total)} 포함` : ''}
            </Text>
            {weekly.rows.map((r) => (
              <View key={r.employee_id} style={styles.weekRow}>
                <Text style={styles.weekName}>{r.name}</Text>
                <Text style={styles.weekHours}>
                  {r.hours}시간{r.from_schedule ? '' : ' (예정)'}
                </Text>
                <Text style={styles.weekPay}>{won(r.total)}</Text>
              </View>
            ))}
            <Text style={styles.note}>{weekly.note}</Text>
          </Card>
        )}

        <Button label="+ 직원 추가" variant="secondary" onPress={() => setAdding(true)} />

        {!data && !failed && (
          <Card>
            <View style={styles.stateWrap}>
              <ActivityIndicator color={colors.mochaBrown} />
              <Text style={styles.stateText}>직원 정보를 불러오는 중…</Text>
            </View>
          </Card>
        )}

        {failed && (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <Ionicons name="alert-circle-outline" size={17} color="#B23B2E" style={{ marginTop: 1 }} />
              <Text style={[styles.stateText, { textAlign: 'left', flex: 1 }]}>{failed}</Text>
            </View>
            <PressableScale style={styles.retryBtn} onPress={load} to={0.97}>
              <Ionicons name="refresh" size={14} color={colors.espressoBrown} />
              <Text style={styles.retryText}>다시 시도</Text>
            </PressableScale>
          </Card>
        )}

        {data && data.staff.length === 0 && (
          <Card>
            <Text style={styles.stateText}>
              등록된 직원이 없어요. 위 ‘직원 추가’로 이름과 시급을 먼저 넣어 주세요.
            </Text>
          </Card>
        )}

        <SectionTitle>직원별 상세</SectionTitle>

        {(data?.staff ?? []).map((emp) => {
          const expanded = openId === emp.id;
          const p = emp.profile;
          const c = emp.cost;
          const typeLabel =
            data?.employment_types.find((t) => t.code === p.employment_type)?.label ?? p.employment_type;
          const insLabel =
            data?.insurance_types.find((t) => t.code === p.insurance)?.label ?? p.insurance;
          return (
            <Card key={emp.id}>
              <View style={styles.row}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  style={styles.headerHit}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setOpenId(expanded ? null : emp.id);
                  }}
                >
                  <View style={[styles.avatar, { backgroundColor: p.pay_type === 'monthly' ? '#E7DFD4' : colors.coffeeCream }]}>
                    <Ionicons name={TYPE_ICON[p.employment_type] ?? 'person-outline'} size={17} color={colors.espressoBrown} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>
                      {emp.name} <Text style={styles.role}>· {emp.role}</Text>
                    </Text>
                    <Text style={styles.sub}>
                      {typeLabel} · {p.pay_type === 'monthly' ? `월급 ${won(p.monthly_salary)}` : `시급 ${won(emp.hourly_rate)}`}
                    </Text>
                    <View style={styles.chipRow}>
                      <Badge label={insLabel} tone={p.insurance === 'none' ? 'orange' : 'neutral'} />
                      {c.hours_source === 'schedule' && (
                        <Badge label={`이번 달 ${c.monthly_hours}시간`} tone="green" />
                      )}
                      {c.hours_source === 'profile' && (
                        <Badge label={`주 ${c.weekly_hours}시간 (직접 입력)`} tone="neutral" />
                      )}
                      {c.hours_source === 'none' && <Badge label="근무 시간 미입력" tone="orange" />}
                      {c.weekly_holiday_pay > 0 && <Badge label="주휴수당 발생" tone="green" />}
                      {c.below_min_wage && <Badge label="최저임금 미달" tone="danger" />}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.costValue}>
                      {c.hours_source === 'none' ? '—' : won(c.total_cost)}
                    </Text>
                    <Text style={styles.costLabel}>
                      {c.hours_source === 'none' ? '시간 필요' : '이번 달 부담'}
                    </Text>
                  </View>
                  <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={colors.mochaBrown}
                    style={{ marginLeft: 6 }}
                  />
                </TouchableOpacity>
              </View>

              {c.below_min_wage && (
                <View style={styles.dangerBox}>
                  <Ionicons name="alert-circle" size={13} color="#B23B2E" />
                  <Text style={styles.dangerText}>
                    시급 환산 {won(c.effective_hourly)} — 2026년 최저임금 {won(c.min_wage)}보다 낮아요.
                  </Text>
                </View>
              )}

              {expanded && (
                <View style={styles.detail}>
                  {/* 고용형태 */}
                  <Text style={styles.fieldLabel}>고용형태</Text>
                  <View style={styles.optionWrap}>
                    {(data?.employment_types ?? []).map((t) => {
                      const active = p.employment_type === t.code;
                      return (
                        <TouchableOpacity
                          key={t.code}
                          style={[styles.option, active && styles.optionActive]}
                          onPress={() => {
                            // 고용형태를 고르면 주 소정근로시간의 통상값도 같이 채워 준다
                            const presetHours =
                              t.code === 'full_time' || t.code === 'manager' ? 40 :
                              t.code === 'part_time_15' && p.weekly_hours < 15 ? 20 :
                              undefined;
                            patch(emp, {
                              employment_type: t.code,
                              ...(t.code === 'manager' ? { pay_type: 'monthly' } : {}),
                              ...(presetHours ? { weekly_hours: presetHours } : {}),
                            });
                          }}
                        >
                          <Text style={[styles.optionText, active && styles.optionTextActive]}>{t.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.optionNote}>
                    {data?.employment_types.find((t) => t.code === p.employment_type)?.note}
                  </Text>

                  <Divider />

                  {/* 급여형태 */}
                  <Text style={styles.fieldLabel}>급여형태</Text>
                  <View style={styles.optionWrap}>
                    {(['hourly', 'monthly'] as const).map((k) => {
                      const active = p.pay_type === k;
                      return (
                        <TouchableOpacity
                          key={k}
                          style={[styles.option, active && styles.optionActive]}
                          onPress={() => patch(emp, { pay_type: k })}
                        >
                          <Text style={[styles.optionText, active && styles.optionTextActive]}>
                            {k === 'hourly' ? '시급제' : '월급제'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {c.hours_source === 'schedule' && p.pay_type !== 'monthly' && (
                    <Text style={styles.scheduleNote}>
                      이번 달은 근무 달력에 등록된 {c.monthly_hours}시간으로 계산했어요.
                      아래 주 소정근로시간은 스케줄이 없는 달에만 쓰입니다.
                    </Text>
                  )}

                  <NumberField
                    label={p.pay_type === 'monthly' ? '월급 (원)' : '주 소정근로시간'}
                    suffix={p.pay_type === 'monthly' ? '원' : '시간'}
                    initial={p.pay_type === 'monthly' ? String(p.monthly_salary || '') : String(p.weekly_hours || '')}
                    onCommit={(v) =>
                      patch(emp, p.pay_type === 'monthly' ? { monthly_salary: v } : { weekly_hours: v })
                    }
                  />
                  {p.pay_type === 'monthly' && (
                    <NumberField
                      label="주 소정근로시간 (최저임금 확인용)"
                      suffix="시간"
                      initial={String(p.weekly_hours || '')}
                      onCommit={(v) => patch(emp, { weekly_hours: v })}
                    />
                  )}

                  <Divider />

                  {/* 보험 */}
                  <Text style={styles.fieldLabel}>보험 가입</Text>
                  <View style={styles.optionWrap}>
                    {(data?.insurance_types ?? []).map((t) => {
                      const active = p.insurance === t.code;
                      return (
                        <TouchableOpacity
                          key={t.code}
                          style={[styles.option, active && styles.optionActive]}
                          onPress={() => patch(emp, { insurance: t.code })}
                        >
                          <Text style={[styles.optionText, active && styles.optionTextActive]}>{t.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.optionNote}>
                    {data?.insurance_types.find((t) => t.code === p.insurance)?.note}
                  </Text>

                  {/* 주휴수당 토글 */}
                  <View style={styles.switchRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>주휴수당 지급</Text>
                      <Text style={styles.optionNote}>
                        주 15시간 이상이면 법적으로 지급 대상이에요. 시급에 이미 포함해 계약했다면 꺼 두세요.
                      </Text>
                    </View>
                    <Switch
                      value={p.weekly_holiday_pay}
                      onValueChange={(v) => patch(emp, { weekly_holiday_pay: v })}
                      trackColor={{ true: colors.espressoBrown, false: colors.mutedSand }}
                    />
                  </View>

                  <Divider />

                  {/* 계산 결과 */}
                  <Text style={styles.fieldLabel}>이 조건이면 이렇게 나가요</Text>
                  <CostRow
                    label="기본급"
                    value={won(c.base_pay)}
                    sub={
                      c.hours_source === 'schedule'
                        ? `근무 달력 ${c.monthly_hours}시간 × 시급 ${won(c.hourly_rate)}`
                        : c.hours_source === 'profile'
                          ? `주 ${c.weekly_hours}시간 → 월 ${c.monthly_hours}시간 (직접 입력)`
                          : '근무 시간을 아직 몰라 계산할 수 없어요'
                    }
                  />
                  {c.weekly_holiday_pay > 0 && <CostRow label="주휴수당" value={won(c.weekly_holiday_pay)} />}
                  <CostRow label="직원 지급 총액" value={won(c.gross_pay)} strong />
                  {c.withholding_tax > 0 && (
                    <CostRow label="3.3% 원천징수" value={`−${won(c.withholding_tax)}`} sub="지급액에서 공제" />
                  )}
                  {Object.entries(c.owner_insurance).map(([k, v]) => (
                    <CostRow key={k} label={`${k} (사업주)`} value={won(v)} />
                  ))}
                  <CostRow label="매장에서 실제 나가는 돈" value={won(c.total_cost)} strong accent />
                  <Text style={styles.note}>{c.disclaimer}</Text>

                  <PressableScale style={styles.deleteBtn} onPress={() => removeStaff(emp)} to={0.97}>
                    <Ionicons name="trash-outline" size={14} color="#B23B2E" />
                    <Text style={styles.deleteText}>이 직원 삭제</Text>
                  </PressableScale>

                  {saving === emp.id && (
                    <View style={styles.savingOverlay}>
                      <ActivityIndicator size="small" color={colors.mochaBrown} />
                    </View>
                  )}
                </View>
              )}
            </Card>
          );
        })}
      </Screen>

      <FormSheet
        visible={adding}
        title="직원 추가"
        onClose={() => setAdding(false)}
        onSubmit={submitNew}
        submitDisabled={nName.trim() === '' || nRate.trim() === ''}
      >
        <LabeledInput label="이름" value={nName} onChangeText={setNName} placeholder="예: 김바리" />
        <LabeledInput
          label="시급 (원)"
          value={nRate}
          onChangeText={setNRate}
          placeholder="예: 10320"
          keyboardType="number-pad"
        />
        <LabeledInput label="직책" value={nRole} onChangeText={setNRole} placeholder="예: 바리스타 / 매니저" />
      </FormSheet>
    </>
  );
}

function CostRow({
  label,
  value,
  sub,
  strong,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={styles.costRow}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.costRowLabel, strong && { fontWeight: '800', color: colors.espressoBrown }]}>
          {label}
        </Text>
        {sub ? <Text style={styles.costRowSub}>{sub}</Text> : null}
      </View>
      <Text
        style={[
          styles.costRowValue,
          strong && { fontWeight: '900' },
          accent && { color: colors.pointOrange, fontSize: 16 },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

// 입력하는 동안 매번 저장하면 요청이 폭주하므로, 편집을 끝냈을 때(blur) 한 번만 보낸다
function NumberField({
  label,
  suffix,
  initial,
  onCommit,
}: {
  label: string;
  suffix: string;
  initial: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.numBox}>
        <TextInput
          style={styles.numInput}
          value={text}
          onChangeText={(v) => setText(v.replace(/[^0-9.]/g, ''))}
          onBlur={() => {
            const v = Number(text) || 0;
            if (String(v) !== String(Number(initial) || 0)) onCommit(v);
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="0"
          placeholderTextColor="#C7C7CC"
        />
        <Text style={styles.numSuffix}>{suffix}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  totalLabel: { ...typography.L5, color: colors.mochaBrown },
  totalValue: { fontSize: 30, fontWeight: '900', color: colors.espressoBrown, marginTop: 4 },
  totalSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  scheduleNote: {
    ...typography.L5,
    color: colors.mochaBrown,
    lineHeight: 15,
    marginTop: 12,
    backgroundColor: colors.white,
    borderRadius: 10,
    padding: 10,
  },
  totalBreak: { flexDirection: 'row', alignItems: 'stretch', marginTop: 14 },
  totalCol: { flex: 1, alignItems: 'center', gap: 3 },
  colDivider: { width: 1, backgroundColor: colors.mutedSand, marginHorizontal: 6 },
  colLabel: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center' },
  colValue: { ...typography.L4, color: colors.espressoBrown },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(201,138,43,0.09)',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  warnText: { ...typography.L5, color: '#8A6320', flex: 1, lineHeight: 15 },

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHead: { ...typography.L3, color: colors.espressoBrown },
  weekTotal: { ...typography.L3, color: colors.pointOrange },
  weekRange: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, marginBottom: 8 },
  weekRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 8 },
  weekName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  weekHours: { ...typography.L5, color: colors.mochaBrown },
  weekPay: { ...typography.L4, color: colors.espressoBrown, minWidth: 76, textAlign: 'right' },
  note: { ...typography.L5, color: colors.mochaBrown, marginTop: 10, lineHeight: 15, opacity: 0.9 },

  row: { flexDirection: 'row', alignItems: 'center' },
  headerHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  name: { ...typography.L3, color: colors.espressoBrown },
  role: { ...typography.L5, color: colors.mochaBrown },
  sub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  costValue: { ...typography.L3, color: colors.espressoBrown },
  costLabel: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  dangerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#F7E7E3',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    marginTop: 10,
  },
  dangerText: { ...typography.L5, color: '#B23B2E', fontWeight: '700', flex: 1 },

  detail: { marginTop: 14, backgroundColor: colors.creamSand, borderRadius: 12, padding: 12 },
  fieldLabel: { ...typography.L4, color: colors.espressoBrown, marginBottom: 6 },
  optionWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  optionActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  optionText: { fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown },
  optionTextActive: { color: colors.white },
  optionNote: { ...typography.L5, color: colors.mochaBrown, marginTop: 7, lineHeight: 15 },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },

  numBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  numInput: {
    flex: 1,
    ...typography.L3,
    color: colors.espressoBrown,
    textAlign: 'right',
    padding: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  numSuffix: { ...typography.L5, color: colors.mochaBrown, marginLeft: 6 },

  costRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  costRowLabel: { ...typography.L5, color: colors.mochaBrown },
  costRowSub: { fontSize: 9.5, color: colors.mochaBrown, marginTop: 2, opacity: 0.85 },
  costRowValue: { ...typography.L4, color: colors.espressoBrown },

  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: 'rgba(178,59,46,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 14,
  },
  deleteText: { ...typography.L5, color: '#B23B2E', fontWeight: '800' },
  savingOverlay: { alignItems: 'center', paddingTop: 8 },

  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 12,
  },
  retryText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },
});
