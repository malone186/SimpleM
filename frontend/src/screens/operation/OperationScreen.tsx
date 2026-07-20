// 운영 (프론트 B) — PRD ERP-9(스케줄·급여·정산), AI-4(스케줄 추천)  ※ 세금은 서류 자동화 탭
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle, DayOfWeekPicker, IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import { useAuth } from '../../auth/AuthContext';
import {
  getSettlement, listPayroll, forecastSales, createExpense,
  listSchedules, createSchedule, updateSchedule, deleteSchedule, recommendSchedule,
  createUnavailability, listUnavailabilities, deleteUnavailability, getScheduleRecommendation,
  type Settlement, type Payroll, type Forecast, type Schedule, type EmployeeUnavailability, type ScheduleRecommendation
} from '../../lib/api/operation';

const notify = (title: string, message: string) => toast(title, message);

// [백엔드 연동] 이번 달 기준 · 전체 매장 집계
const nowYM = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const won = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');


export default function OperationScreen() {
  return (
    <Screen>
      {/* [한글 주석] 세금 기능이 서류 자동화 탭으로 통합됨에 따라, 본 화면은 스케줄·급여·정산 전용 화면입니다. */}
      <ScreenTitle title="스케줄·급여" subtitle="알바 스케줄과 급여 정산, 기피 시간을 한 곳에서" />
      <LiveOperationCard />
      <UnavailabilityManagementCard />
      <ScheduleTab />
    </Screen>
  );
}


// [백엔드 실시간 연동] 손익정산 · 직원별 급여 · 판매예측 (세금 제외)
function LiveOperationCard() {
  const { token } = useAuth();
  const period = nowYM();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [payroll, setPayroll] = useState<Payroll[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [adding, setAdding] = useState(false);
  const [expAmount, setExpAmount] = useState('');
  const [expCategory, setExpCategory] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [s, p, f] = await Promise.all([
        getSettlement(period),
        listPayroll(period),
        forecastSales({ target_date: tomorrowISO(), engine: 'arima' }),
      ]);
      setSettlement(s);
      setPayroll(p);
      setForecast(f);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddExpense = async () => {
    if (!token) {
      notify('로그인 필요', '지출 등록은 로그인 후 이용할 수 있어요.');
      return;
    }
    const amt = parseInt(expAmount.replace(/[^0-9]/g, ''), 10);
    if (!amt || amt <= 0) {
      notify('입력 확인', '지출 금액을 숫자로 입력해 주세요.');
      return;
    }
    const cat = expCategory.trim() || '기타 지출';
    setAdding(true);
    try {
      await createExpense(token, { amount: amt, category: cat, expense_date: new Date().toISOString().slice(0, 10) });
      notify('지출 등록', `${cat} ${won(amt)}을 등록했어요. 정산에 자동 반영됩니다.`);
      setExpAmount('');
      setExpCategory('');
      await load();
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const payrollTotal = payroll.reduce((s, p) => s + p.estimated_salary, 0);

  return (
    <Card tone="cream" style={{ marginBottom: 24 }}>
      <View style={styles.rowBetween}>
        <SectionTitle>이번 달 정산 · 급여</SectionTitle>
        <Badge label={`${period} · 실시간`} tone="green" />
      </View>

      {loading ? (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}>
          <ActivityIndicator color={colors.pointOrange} />
          <Text style={[styles.hint, { marginTop: 8 }]}>백엔드에서 불러오는 중…</Text>
        </View>
      ) : err ? (
        <View style={{ paddingVertical: 12 }}>
          <Text style={liveStyles.errText}>⚠ {err}</Text>
          <Button label="다시 시도" variant="secondary" style={{ marginTop: 10 }} onPress={load} />
        </View>
      ) : (
        <>
          {/* 손익 정산 KPI */}
          <View style={liveStyles.kpiGrid}>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>총매출</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1}>{won(settlement?.total_sales ?? 0)}</Text>
            </View>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>총비용</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1}>{won(settlement?.total_expense ?? 0)}</Text>
            </View>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>인건비</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1}>{won(settlement?.total_payroll ?? 0)}</Text>
            </View>
            <View style={[liveStyles.kpi, liveStyles.kpiProfit]}>
              <Text style={liveStyles.kpiLabel}>순이익</Text>
              <Text
                style={[liveStyles.kpiValue, { color: (settlement?.net_profit ?? 0) >= 0 ? '#3E8E5A' : colors.pointOrange }]}
                numberOfLines={1}              >
                {won(settlement?.net_profit ?? 0)}
              </Text>
            </View>
          </View>

          {/* 판매 예측 */}
          {forecast && (
            <View style={liveStyles.forecastRow}>
              <Ionicons name="trending-up-outline" size={16} color={colors.pointOrange} />
              <Text style={liveStyles.forecastText} numberOfLines={1}>내일 예측 매출 {won(forecast.predicted_sales)}</Text>
              <Badge label={forecast.engine.toUpperCase()} tone="orange" />
            </View>
          )}

          {/* 직원별 급여 */}
          <Text style={liveStyles.subHead}>직원별 예상 급여</Text>
          {payroll.length === 0 ? (
            <Text style={styles.hint}>등록된 직원이 없어요.</Text>
          ) : (
            payroll.map((p) => (
              <View key={p.employee_id} style={liveStyles.payRow}>
                <View style={{ flex: 1 }}>
                  <Text style={liveStyles.payName}>{p.employee_name} <Text style={liveStyles.payRole}>{p.role}</Text></Text>
                  <Text style={liveStyles.paySub}>
                    {p.total_work_hours.toFixed(0)}h · ₩{p.hourly_rate.toLocaleString()}/h
                    {p.weekly_holiday_allowance > 0 ? ` · 주휴 ${won(p.weekly_holiday_allowance)}` : ''}
                  </Text>
                </View>
                <Text style={liveStyles.payAmount}>{won(p.estimated_salary)}</Text>
              </View>
            ))
          )}
          {payroll.length > 0 && (
            <>
              <Divider />
              <View style={liveStyles.payRow}>
                <Text style={liveStyles.payTotalLabel}>인건비 합계</Text>
                <Text style={liveStyles.payTotal}>{won(payrollTotal)}</Text>
              </View>
            </>
          )}

          {/* 지출 추가 — 내용·금액 직접 입력 (카드 폭 안에 정렬) */}
          <Text style={liveStyles.subHead}>지출 추가</Text>
          <TextInput
            style={liveStyles.input}
            placeholder="내용 (예: 원두매입, 임대료)"
            placeholderTextColor={colors.mochaBrown + '80'}
            value={expCategory}
            onChangeText={setExpCategory}
          />
          <View style={liveStyles.expenseRow}>
            <TextInput
              style={[liveStyles.input, { flex: 1 }]}
              placeholder="금액"
              placeholderTextColor={colors.mochaBrown + '80'}
              keyboardType="numeric"
              value={expAmount}
              onChangeText={setExpAmount}
            />
            <Button label={adding ? '등록 중…' : '등록'} onPress={handleAddExpense} style={liveStyles.addBtn} />
          </View>

          <View style={[styles.actions, { marginTop: 10 }]}>
            <Button label="새로고침" variant="secondary" style={{ flex: 1 }} onPress={load} />
          </View>
          <Text style={liveStyles.disc}>실 출퇴근 기록이 없으면 계획된 근무시간 기준의 참고용 예상 급여입니다.</Text>
        </>
      )}
    </Card>
  );
}

const liveStyles = StyleSheet.create({
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  kpi: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 0,
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.10)',
  },
  kpiProfit: { backgroundColor: '#F1F6EE', borderColor: 'rgba(62,142,90,0.22)' },
  kpiLabel: { ...typography.L5, color: colors.mochaBrown },
  kpiValue: { fontSize: 21, fontWeight: '800', color: colors.espressoBrown, marginTop: 5 },
  forecastRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    backgroundColor: colors.white, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: 'rgba(140,111,86,0.10)',
  },
  forecastText: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700', flex: 1 },
  subHead: { ...typography.L4, color: colors.espressoBrown, fontWeight: '800', marginTop: 18, marginBottom: 6 },
  payRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  payName: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  payRole: { ...typography.L5, color: colors.mochaBrown, fontWeight: '600' },
  paySub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  payAmount: { ...typography.L3, color: colors.espressoBrown, fontWeight: '800' },
  payTotalLabel: { ...typography.L4, color: colors.mochaBrown, flex: 1, fontWeight: '700' },
  payTotal: { ...typography.L2, color: colors.pointOrange, fontWeight: '800' },
  errText: { ...typography.L4, color: '#B23B2E', fontWeight: '600' },
  disc: { ...typography.L5, color: colors.mochaBrown, fontStyle: 'italic', marginTop: 10, opacity: 0.8 },
  expenseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  addBtn: { minWidth: 76 },
  input: {
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.white,
    ...typography.L4,
    color: colors.espressoBrown,
  },
});

// ----------------------------------------------------
// 챗봇 / ERP 신규: 알바생 기피/불가 시간 관리 카드 컴포넌트
// ----------------------------------------------------
function UnavailabilityManagementCard() {
  const { token } = useAuth();
  const [list, setList] = useState<EmployeeUnavailability[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // 폼 입력 상태
  const [employeeId, setEmployeeId] = useState('1');
  const [unavType, setUnavType] = useState<'weekly_recurring' | 'specific_date'>('weekly_recurring');
  const [dayOfWeek, setDayOfWeek] = useState('0'); // 0=월
  const [specificDate, setSpecificDate] = useState(tomorrowISO());
  const [startHour, setStartHour] = useState('9');
  const [endHour, setEndHour] = useState('12');
  const [restrictionLevel, setRestrictionLevel] = useState<'hard' | 'soft'>('hard');
  const [reason, setReason] = useState('');

  const loadUnavailabilities = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await listUnavailabilities(token);
      setList(data);
    } catch (e) {
      console.warn('기피시간 조회 실패:', e);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadUnavailabilities();
  }, [loadUnavailabilities]);

  const handleCreate = async () => {
    if (!token) {
      notify('로그인 필요', '기피시간 등록은 로그인 후 사용할 수 있습니다.');
      return;
    }
    const empId = parseInt(employeeId, 10);
    const sH = parseInt(startHour, 10);
    const eH = parseInt(endHour, 10);
    if (!empId || sH >= eH) {
      notify('입력 확인', '직원 ID와 올바른 시작/종료 시각을 입력해 주세요.');
      return;
    }

    try {
      await createUnavailability(token, {
        employee_id: empId,
        unavailability_type: unavType,
        day_of_week: unavType === 'weekly_recurring' ? parseInt(dayOfWeek, 10) : undefined,
        specific_date: unavType === 'specific_date' ? specificDate : undefined,
        start_hour: sH,
        end_hour: eH,
        restriction_level: restrictionLevel,
        reason: reason.trim() || undefined,
      });
      notify('기피시간 등록 완료', '직원의 기피/불가 시간이 안전하게 등록되었습니다.');
      setModalVisible(false);
      setReason('');
      await loadUnavailabilities();
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!token) return;
    try {
      await deleteUnavailability(token, id);
      notify('삭제 완료', '해당 기피시간 설정이 지워졌습니다.');
      await loadUnavailabilities();
    } catch (e) {
      notify('삭제 실패', e instanceof Error ? e.message : String(e));
    }
  };

  const dayNames = ['월', '화', '수', '목', '금', '토', '일'];

  return (
    <Card tone="cream" style={{ marginBottom: 24 }}>
      <View style={styles.rowBetween}>
        <SectionTitle>알바 기피/불가 시간 관리</SectionTitle>
        <PressableScale style={styles.addBtn} onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={16} color={colors.white} />
          <Text style={styles.addBtnText}>기피시간 등록</Text>
        </PressableScale>
      </View>
      <Text style={styles.hint}>
        Hard(절대 불가) 및 Soft(가급적 회피) 제약을 설정하면 AI 스케줄 추천 시 자동으로 피해서 배정합니다.
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.pointOrange} style={{ marginVertical: 14 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.hint, { marginTop: 10, fontStyle: 'italic' }]}>등록된 알바생 기피 시간이 없습니다.</Text>
      ) : (
        <View style={{ gap: 8, marginTop: 12 }}>
          {list.map((u) => {
            const isHard = u.restriction_level === 'hard';
            const typeLabel = u.unavailability_type === 'weekly_recurring'
              ? `매주 ${dayNames[u.day_of_week ?? 0]}요일`
              : `${u.specific_date}`;
            return (
              <View key={u.id} style={unavStyles.itemRow}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={unavStyles.itemTitle}>직원(ID:{u.employee_id})</Text>
                    <Badge label={isHard ? 'Hard 절대불가' : 'Soft 가급적회피'} tone={isHard ? 'orange' : 'neutral'} />
                  </View>
                  <Text style={unavStyles.itemSub}>
                    {typeLabel} · {u.start_hour}:00 ~ {u.end_hour}:00 {u.reason ? `(${u.reason})` : ''}
                  </Text>
                </View>
                <PressableScale onPress={() => handleDelete(u.id)} style={styles.deleteBtnCircle}>
                  <Ionicons name="trash-outline" size={16} color="#B23B2E" />
                </PressableScale>
              </View>
            );
          })}
        </View>
      )}

      {/* 등록 모달 */}
      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setModalVisible(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>알바 기피/불가 시간 등록</Text>
            
            <View style={{ gap: 14 }}>
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>직원 ID</Text>
                <TextInput style={styles.input} keyboardType="numeric" value={employeeId} onChangeText={setEmployeeId} />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>기피 유형</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    label="매주 요일 반복"
                    variant={unavType === 'weekly_recurring' ? 'primary' : 'secondary'}
                    style={{ flex: 1 }}
                    onPress={() => setUnavType('weekly_recurring')}
                  />
                  <Button
                    label="특정 날짜 지정"
                    variant={unavType === 'specific_date' ? 'primary' : 'secondary'}
                    style={{ flex: 1 }}
                    onPress={() => setUnavType('specific_date')}
                  />
                </View>
              </View>

              {unavType === 'weekly_recurring' ? (
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>요일 선택 (0=월 ~ 6=일)</Text>
                  <TextInput style={styles.input} keyboardType="numeric" value={dayOfWeek} onChangeText={setDayOfWeek} placeholder="0~6" />
                </View>
              ) : (
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>날짜 지정 (YYYY-MM-DD)</Text>
                  <TextInput style={styles.input} value={specificDate} onChangeText={setSpecificDate} />
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={[styles.formGroup, { flex: 1 }]}>
                  <Text style={styles.formLabel}>시작 시각 (0~23)</Text>
                  <TextInput style={styles.input} keyboardType="numeric" value={startHour} onChangeText={setStartHour} />
                </View>

                <View style={[styles.formGroup, { flex: 1 }]}>
                  <Text style={styles.formLabel}>종료 시각 (1~24)</Text>
                  <TextInput style={styles.input} keyboardType="numeric" value={endHour} onChangeText={setEndHour} />
                </View>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>제약 강도</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    label="Hard (절대 불가)"
                    variant={restrictionLevel === 'hard' ? 'primary' : 'secondary'}
                    style={{ flex: 1 }}
                    onPress={() => setRestrictionLevel('hard')}
                  />
                  <Button
                    label="Soft (가급적 회피)"
                    variant={restrictionLevel === 'soft' ? 'primary' : 'secondary'}
                    style={{ flex: 1 }}
                    onPress={() => setRestrictionLevel('soft')}
                  />
                </View>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>사유 (선택)</Text>
                <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="예: 대학 수업, 병원 진료" />
              </View>

              <View style={[styles.rowActions, { marginTop: 10 }]}>
                <Pressable style={styles.btnCancel} onPress={() => setModalVisible(false)}>
                  <Text style={styles.btnCancelText}>취소</Text>
                </Pressable>
                <Pressable style={styles.btnSave} onPress={handleCreate}>
                  <Text style={styles.btnSaveText}>저장</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </Card>
  );
}

const unavStyles = StyleSheet.create({
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.12)',
  },
  itemTitle: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  itemSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  warnCard: {
    backgroundColor: '#F6DED8',
    borderColor: '#B23B2E',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
  },
  warnText: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },
});

function ScheduleTab() {
  const { token, user } = useAuth();
  const [shifts, setShifts] = useState<any[]>([]); // FIX(머지): INITIAL_SHIFTS 미정의 참조 → 빈 배열로 대체
  const [recommendation, setRecommendation] = useState<ScheduleRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [recommend, setRecommend] = useState<ScheduleRecommendation | null>(null);
  const [recommendFailed, setRecommendFailed] = useState(false);
  const [editingShift, setEditingShift] = useState<{
    id: number | null;
    employeeId: number | null;
    date: string | null;
    days: string[];
    slot: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // [한글 주석] 스케줄 추천 백엔드 API 연동 함수
  const fetchRecommendation = async () => {
    if (!token) {
      notify('로그인 필요', '스케줄 추천은 로그인 후 이용해 주세요.');
      return;
    }
    setRecLoading(true);
    try {
      const res = await getScheduleRecommendation(token, tomorrowISO());
      setRecommendation(res);
      notify('추천 완료', '직원 기피 시간이 반영된 알바 추천 스케줄이 계산되었습니다.');
    } catch (e) {
      notify('추천 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setRecLoading(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, payroll] = await Promise.all([
        listSchedules(),
        listPayroll(nowYM()).catch(() => [] as Payroll[]),
      ]);
      const map: Record<number, string> = {};
      payroll.forEach((p) => {
        map[p.employee_id] = p.employee_name;
      });
      setNames(map);
      setSchedules(rows);
    } catch (e) {
      notify('스케줄 조회 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // AI 스케줄 추천 — 내일 매출 시간대 분석 (백엔드 실데이터, 하드코딩 문구 없음)
  useEffect(() => {
    if (!user?.email) return;
    recommendSchedule({ target_date: tomorrowISO(), store_id: user.email })
      .then(setRecommend)
      .catch((e) => {
        console.error('스케줄 추천 실패:', e);
        setRecommendFailed(true);
      });
  }, [user?.email]);

  // 이번 주 월요일~일요일 범위 계산
  const WEEK_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const isoDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const weekRows = schedules
    .filter((s) => s.date >= isoDate(monday) && s.date <= isoDate(sunday))
    .sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)));

  const hourOf = (iso: string) => Number(iso.slice(11, 13));
  const slotOf = (s: Schedule) =>
    `${String(hourOf(s.start_time)).padStart(2, '0')}–${String(hourOf(s.end_time)).padStart(2, '0')}`;
  const nameOf = (id: number) => names[id] ?? `직원 ${id}`;
  // 피크 여부는 입력이 아니라 시간대에서 판정 — 14시대(점심~오후 피크)를 커버하면 피크 근무
  const isPeak = (s: Schedule) => hourOf(s.start_time) <= 14 && hourOf(s.end_time) > 14;
  const dayLabelOf = (s: Schedule) => {
    const [, m, d] = s.date.split('-').map(Number);
    const wd = WEEK_KO[new Date(s.date + 'T00:00:00').getDay()];
    return `${wd}요일 (${m}/${d})`;
  };

  const employeeEntries = Object.entries(names).map(([id, name]) => ({ id: Number(id), name }));

  const handleAddPress = () => {
    if (employeeEntries.length === 0) {
      notify('직원 정보 없음', '등록된 직원이 없어 스케줄을 추가할 수 없어요. 급여 관리에서 직원을 먼저 등록해 주세요.');
      return;
    }
    setEditingShift({ id: null, employeeId: employeeEntries[0].id, date: null, days: [], slot: '09–18' });
  };

  const handleEditPress = (s: Schedule) => {
    setEditingShift({ id: s.id, employeeId: s.employee_id, date: s.date, days: [], slot: slotOf(s) });
  };

  const handleDelete = async (id: number) => {
    if (Platform.OS === 'web') {
      const ok = window.confirm('정말 이 근무 스케줄을 삭제하시겠습니까?');
      if (!ok) return;
    }
    try {
      await deleteSchedule(id);
      setEditingShift(null);
      await load();
    } catch (e) {
      notify('삭제 실패', e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = async () => {
    if (!editingShift || saving) return;
    const m = editingShift.slot.match(/(\d+)\D+(\d+)/);
    const sh = m ? Number(m[1]) : NaN;
    const eh = m ? Number(m[2]) : NaN;
    if (!m || Number.isNaN(sh) || Number.isNaN(eh) || sh >= eh) {
      notify('입력 확인', '근무 시작 시간은 종료 시간보다 빨라야 해요.');
      return;
    }
    const hh = (h: number) => String(h).padStart(2, '0');
    setSaving(true);
    try {
      if (editingShift.id !== null && editingShift.date) {
        // 기존 스케줄: 시간만 수정
        await updateSchedule(editingShift.id, {
          start_time: `${editingShift.date}T${hh(sh)}:00:00`,
          end_time: `${editingShift.date}T${hh(eh)}:00:00`,
        });
      } else {
        // 신규: 선택한 요일마다 이번 주 해당 날짜로 등록
        if (!editingShift.employeeId || editingShift.days.length === 0) {
          notify('입력 확인', '근무자와 요일을 선택해 주세요.');
          setSaving(false);
          return;
        }
        const offsets: Record<string, number> = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
        for (const day of editingShift.days) {
          const d = new Date(monday);
          d.setDate(d.getDate() + (offsets[day] ?? 0));
          const dateStr = isoDate(d);
          await createSchedule({
            employee_id: editingShift.employeeId,
            start_time: `${dateStr}T${hh(sh)}:00:00`,
            end_time: `${dateStr}T${hh(eh)}:00:00`,
          });
        }
      }
      setEditingShift(null);
      await load();
    } catch (e) {
      notify('저장 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* AI 스케줄 추천 (AI-4 + 기피시간 반영) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>AI 추천 스케줄 (기피시간 반영)</SectionTitle>
          <Badge label="추천안" tone="orange" />
        </View>
        <Text style={styles.hint}>
          {recommendation?.summary || recommend?.summary || '버튼을 누르면 과거 매출과 알바생 기피시간(Hard/Soft)을 종합 분석해 최적의 추천 스케줄을 계산합니다.'}
        </Text>

        {/* ⚠️ 인원 부족 충돌 경고 메시지 표시 영역 */}
        {recommendation?.warnings && recommendation.warnings.length > 0 && (
          <View style={{ gap: 6, marginTop: 10 }}>
            {recommendation.warnings.map((w, idx) => (
              <View key={idx} style={unavStyles.warnCard}>
                <Text style={unavStyles.warnText}>⚠️ {w}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.actions}>
          <Button
            label={recLoading ? '연산 중…' : 'AI 스케줄 추천 실행'}
            style={{ flex: 1 }}
            onPress={fetchRecommendation}
          />
        </View>
      </Card>


      {/* [한글 주석] 위쪽 박스(추천 스케줄)와의 조화로운 여백 조율을 위해 marginTop: 24 추가 */}
      <View style={{ gap: 10, marginTop: 24 }}>
        <View style={styles.sectionHeaderRow}>
          <SectionTitle>이번 주 스케줄</SectionTitle>
          {/* [한글 주석] 스케줄 추가 모달창을 즉시 호출해주는 UI 버튼 */}
          <PressableScale style={styles.addBtn} onPress={handleAddPress}>
            <Ionicons name="add" size={16} color={colors.white} />
            <Text style={styles.addBtnText}>추가</Text>
          </PressableScale>
        </View>

        {loading && (
          <Card style={styles.scheduleCard}>
            <View style={{ paddingVertical: 12, alignItems: 'center' }}>
              <ActivityIndicator color={colors.mochaBrown} />
            </View>
          </Card>
        )}

        {!loading && weekRows.length === 0 && (
          <Card style={styles.scheduleCard}>
            <Text style={styles.hint}>이번 주에 등록된 근무 스케줄이 없어요. 추가 버튼으로 등록해 보세요.</Text>
          </Card>
        )}

        {weekRows.map((s) => {
          const who = nameOf(s.employee_id);
          const firstChar = who.charAt(0) || '👤';
          return (
            <Card key={s.id} style={styles.scheduleCard}>
              <View style={styles.shiftRow}>
                {/* [한글 주석] 이니셜 타이포그래피 아바타 적용으로 고급화 */}
                <View style={styles.initialAvatar}>
                  <Text style={styles.avatarText}>{firstChar}</Text>
                </View>

                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.shiftWho}>{who}</Text>
                    {isPeak(s) && <Badge label="피크" tone="green" />}
                  </View>

                  {/* [한글 주석] 미니멀한 타임라인 태그로 근무 일시 표시 */}
                  <View style={styles.timeTag}>
                    <Ionicons name="time-outline" size={13} color={colors.mochaBrown} />
                    <Text style={styles.timeTagText}>{dayLabelOf(s)} · {slotOf(s)}</Text>
                  </View>
                </View>

                {/* [한글 주석] 터치 영역 확대 및 조형 대칭을 위해 둥근 링으로 감싼 수정 버튼 */}
                <PressableScale onPress={() => handleEditPress(s)} to={0.88} style={styles.editBtnCircle}>
                  <Ionicons name="create-outline" size={16} color={colors.mochaBrown} />
                </PressableScale>
              </View>
            </Card>
          );
        })}
      </View>

      {/* [한글 주석] 이번 달 급여는 상단 "이번 달 정산·급여" 카드에서 백엔드 실데이터로 표시합니다. */}

      {/* [한글 주석] 근무자·요일·시간을 입력받는 스케줄 수정/등록 모달 */}
      <Modal visible={editingShift !== null} transparent animationType="slide" onRequestClose={() => setEditingShift(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setEditingShift(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>
              {editingShift?.id === null ? '근무 스케줄 추가' : '근무 스케줄 수정'}
            </Text>

            {editingShift && (
              <View style={{ gap: 14, marginBottom: 20 }}>
                {editingShift.id === null ? (
                  <>
                    {/* 근무자 선택 — 급여 명부에 등록된 실제 직원 중에서 */}
                    <View style={styles.formGroup}>
                      <Text style={styles.formLabel}>근무자 선택</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {employeeEntries.map((emp) => {
                          const active = editingShift.employeeId === emp.id;
                          return (
                            <PressableScale
                              key={emp.id}
                              style={[styles.peakSegmentBtn, { flex: 0, paddingHorizontal: 14 }, active && styles.segmentBtnActiveNormal]}
                              onPress={() => setEditingShift({ ...editingShift, employeeId: emp.id })}
                              to={0.94}
                            >
                              <Text style={[styles.peakSegmentText, active && styles.segmentTextActiveNormal]}>{emp.name}</Text>
                            </PressableScale>
                          );
                        })}
                      </View>
                    </View>

                    {/* [한글 주석] 요일 칩 선택기: 이번 주의 해당 요일마다 스케줄이 생성됩니다 */}
                    <View style={styles.formGroup}>
                      <Text style={styles.formLabel}>요일 선택 (이번 주)</Text>
                      <DayOfWeekPicker
                        selectedDays={editingShift.days}
                        onChange={(days) => setEditingShift({ ...editingShift, days })}
                      />
                    </View>
                  </>
                ) : (
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>근무자 · 일자</Text>
                    <Text style={{ ...typography.L4, color: colors.espressoBrown }}>
                      {editingShift.employeeId !== null ? nameOf(editingShift.employeeId) : ''} · {editingShift.date}
                    </Text>
                  </View>
                )}

                {/* [한글 주석] iOS 스타일 휠 시간 선택기: 스크롤 드래그를 통해 스무스하게 작동 */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>근무 시간 설정</Text>
                  <IosTimePicker
                    value={editingShift.slot}
                    onChange={(slot) => setEditingShift({ ...editingShift, slot })}
                  />
                </View>
              </View>
            )}

            <View style={styles.rowActions}>
              <PressableScale style={styles.btnCancel} onPress={() => setEditingShift(null)}>
                <Text style={styles.btnCancelText}>취소</Text>
              </PressableScale>

              <PressableScale style={[styles.btnSave, saving && { opacity: 0.6 }]} onPress={handleSave}>
                <Text style={styles.btnSaveText}>{saving ? '저장 중…' : '저장'}</Text>
              </PressableScale>

              {/* [한글 주석] 기존 스케줄 수정 시에만 삭제 버튼을 맨 오른쪽 구석에 노출 */}
              {editingShift !== null && editingShift.id !== null && (
                <PressableScale style={styles.btnDelete} onPress={() => handleDelete(editingShift.id as number)}>
                  <Text style={styles.btnDeleteText}>삭제</Text>
                </PressableScale>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}



const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 15 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scheduleCard: {
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.12)',
  },
  initialAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#EFEAE2',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.08)',
  },
  avatarText: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  timeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.coffeeCream,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  timeTagText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  editBtnCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F5F2EC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // [삭제용 레드 둥근 버튼 및 모달 하단 버튼 스타일]
  deleteBtnCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F6DED8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDelete: {
    flex: 0.8, // [중요] 주 행동 흐름(취소/저장) 방해를 줄이기 위해 크기를 작게 조율
    backgroundColor: '#F6DED8',
    borderColor: '#B23B2E',
    borderWidth: 1.2,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDeleteText: {
    ...typography.L3,
    color: '#B23B2E',
    fontWeight: '800',
  },
  shiftWho: { ...typography.L3, color: colors.espressoBrown, fontWeight: '700' },
  shiftSlot: { ...typography.L5, color: colors.mochaBrown },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  payName: { ...typography.L4, color: colors.espressoBrown },
  paySub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  payAmount: { ...typography.L3, color: colors.espressoBrown },
  payTotalLabel: { ...typography.L4, color: colors.mochaBrown, flex: 1 },
  payTotal: { ...typography.L3, color: colors.pointOrange },


  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addBtnText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    ...(Platform.OS === 'web' ? {
      position: 'absolute' as const,
      maxWidth: 420,
      maxHeight: 850,
      width: '100%',
      height: '100%',
      alignSelf: 'center',
      left: '50%',
      top: '50%',
      marginLeft: -210, // 가로 너비(420)의 절반만큼 왼쪽 보정
      marginTop: -425, // 세로 높이(850)의 절반만큼 위쪽 보정
      borderRadius: 42, // 아이폰의 둥근 모서리 맞춤 조형 비율
      overflow: 'hidden',
    } : {}),
  },
  modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.black40 },
  modalSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 36,
  },
  modalHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.mutedSand,
    marginBottom: 16,
  },
  modalTitle: { ...typography.L1, color: colors.espressoBrown, marginBottom: 20 },
  formGroup: { gap: 6 },
  formLabel: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.white,
    ...typography.L4,
    color: colors.espressoBrown,
  },
  // [근무 시간대 2분할 세그먼트 스타일]
  peakSegmentContainer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  peakSegmentBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  segmentBtnActiveNormal: {
    backgroundColor: colors.coffeeCream,
    borderColor: colors.mochaBrown,
  },
  segmentBtnActivePeak: {
    backgroundColor: '#F6DED8', // 연한 오렌지 배경색
    borderColor: colors.pointOrange,
  },
  peakSegmentText: {
    ...typography.L3,
    fontSize: 13,
    color: colors.mochaBrown + '80', // 비활성 글자는 부드럽게 톤다운
    fontWeight: '700',
  },
  segmentTextActiveNormal: {
    color: colors.espressoBrown,
  },
  segmentTextActivePeak: {
    color: '#B23B2E', // 활성화된 피크 텍스트는 붉은 계열 포인트 컬러
  },
  rowActions: { flexDirection: 'row', gap: 10 },
  btnCancel: {
    flex: 1,
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCancelText: { ...typography.L3, color: colors.espressoBrown },
  btnSave: {
    flex: 1.6,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSaveText: { ...typography.L3, color: colors.white },
});
