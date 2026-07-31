// 직원 상세 · 인건비 — 이름과 시급만으로는 "얼마 나가는지" 알 수 없어서 만든 화면.
//
// 사장님이 실제로 구분해야 하는 것들(피드백 반영):
//   · 파트타이머냐 / 주 15시간 이상이냐 / 매니저냐
//   · 시급제냐 월급제냐
//   · 4대보험 / 2대보험(고용·산재) / 미가입
//   · 주휴수당이 얼마나 더 붙는지
// 이 네 가지를 고르면 월 인건비와 사업주 부담까지 즉시 계산해 준다.
//
// 등록 화면과 상세 화면은 같은 항목(StaffFields)을 쓴다. 예전엔 등록할 땐 이름·시급·직책만
// 받고 나머지는 나중에 상세에서 다시 고르게 했는데, 추가한 직원이 전부 '단시간 알바 · 2대보험
// · 월급 0원' 기본값으로 남아 인건비가 0원으로 보였다.
//
// 선택은 서버 응답을 기다리지 않고 화면에 먼저 반영한다(낙관적 갱신). 공유 DB 왕복이
// 0.5~2초라 예전엔 칩을 눌러도 한참 그대로여서 "선택이 안 된다"고 느껴졌다.
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useIsFocused } from '@react-navigation/native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useAuth } from '../../auth/AuthContext';
import FormSheet from '../../components/FormSheet';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { createEmployee, deleteEmployee } from '../../lib/api/operation';
import {
  applyAvailability,
  createStaff,
  EMPLOYMENT_TYPE_FALLBACK,
  getWeeklyPayroll,
  INSURANCE_TYPE_FALLBACK,
  listStaff,
  saveStaffProfile,
  WEEKDAY_LABELS,
  type AvailabilityWindow,
  type EmploymentType,
  type InsuranceType,
  type StaffEditable,
  type StaffList,
  type StaffMember,
  type WeeklyPayroll,
} from '../../lib/api/staff';
import { colors, typography } from '../../theme';

const won = (n: number) => `₩${Math.round(n || 0).toLocaleString('ko-KR')}`;
const toNum = (s: string) => Number(String(s).replace(/[^\d.]/g, '')) || 0;

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

// ── 등록·상세가 공유하는 입력값 ────────────────────────────────────────────────
// 숫자를 문자열로 들고 있는 이유: 입력 도중의 ''(빈칸)과 0을 구분해야 하기 때문이다.
type Draft = {
  name: string;
  role: string;
  hourly_rate: string;
  employment_type: EmploymentType;
  pay_type: 'hourly' | 'monthly';
  monthly_salary: string;
  weekly_hours: string;
  insurance: InsuranceType;
  weekly_holiday_pay: boolean;
  /** 근무 가능 시간 — 화면에서는 "요일 여러 개 + 시간대 하나"가 한 줄이다 */
  avail: AvailRow[];
  /** 직원 대표 색 — 근무 달력의 점·선과 아바타가 같은 색으로 묶인다 */
  color: string;
};

// 달력에서 서로 구분되는 색만 고른다 (직원·스케줄 화면의 팔레트와 같은 값)
const PALETTE = [
  { code: '#F59E0B', label: '오렌지' },
  { code: '#10B981', label: '에메랄드' },
  { code: '#3B82F6', label: '인디고' },
  { code: '#8B5CF6', label: '퍼플' },
  { code: '#EC4899', label: '핑크' },
  { code: '#8C6F56', label: '모카' },
];

/** '월·수 09~14시'를 한 줄로 편집하기 위한 모양. 저장할 땐 요일마다 한 칸으로 펼친다. */
type AvailRow = { days: number[]; start: number; end: number };

const rowsFromWindows = (ws: AvailabilityWindow[] = []): AvailRow[] => {
  const map = new Map<string, AvailRow>();
  ws.forEach((w) => {
    const key = `${w.start_hour}-${w.end_hour}`;
    const row = map.get(key) ?? { days: [], start: w.start_hour, end: w.end_hour };
    if (!row.days.includes(w.day_of_week)) row.days.push(w.day_of_week);
    map.set(key, row);
  });
  return [...map.values()]
    .map((r) => ({ ...r, days: [...r.days].sort((a, b) => a - b) }))
    .sort((a, b) => (a.days[0] ?? 0) - (b.days[0] ?? 0) || a.start - b.start);
};

const windowsFromRows = (rows: AvailRow[]): AvailabilityWindow[] =>
  rows
    .filter((r) => r.end > r.start)
    .flatMap((r) => r.days.map((d) => ({ day_of_week: d, start_hour: r.start, end_hour: r.end })));

/** 서버가 주는 요약 문장과 같은 규칙 — 저장 전(등록 시트)에도 같은 문장을 보여주려고 둔다 */
const describeRows = (rows: AvailRow[]): string => {
  const parts = rows
    .filter((r) => r.days.length > 0 && r.end > r.start)
    .map((r) => `${r.days.map((d) => WEEKDAY_LABELS[d]).join('·')} ${String(r.start).padStart(2, '0')}~${String(r.end).padStart(2, '0')}시`);
  return parts.length ? parts.join(', ') : '가능 시간 미입력';
};

const EMPTY_DRAFT: Draft = {
  name: '',
  role: '',
  hourly_rate: '',
  employment_type: 'part_time',
  pay_type: 'hourly',
  monthly_salary: '',
  weekly_hours: '',
  insurance: 'two',
  weekly_holiday_pay: true,
  avail: [],
  color: PALETTE[0].code,
};

const draftOf = (m: StaffMember): Draft => ({
  name: m.name,
  role: m.role,
  hourly_rate: String(m.hourly_rate || ''),
  employment_type: m.profile.employment_type,
  pay_type: m.profile.pay_type,
  monthly_salary: String(m.profile.monthly_salary || ''),
  weekly_hours: String(m.profile.weekly_hours || ''),
  insurance: m.profile.insurance,
  weekly_holiday_pay: m.profile.weekly_holiday_pay,
  avail: rowsFromWindows(m.availability),
  // 색을 아직 안 고른 직원은 id로 팔레트를 돌려 배정한다 (달력에서 서로 안 겹치게)
  color: m.profile.color || PALETTE[m.id % PALETTE.length].code,
});

/** 화면의 문자열 입력값을 서버가 받는 숫자/불리언으로 바꾼다 (보낸 키만 저장된다) */
function toApi(patch: Partial<Draft>): Partial<StaffEditable> {
  const body: Partial<StaffEditable> = {};
  if (patch.name !== undefined) body.name = patch.name.trim();
  if (patch.role !== undefined) body.role = patch.role.trim() || '알바';
  if (patch.hourly_rate !== undefined) body.hourly_rate = Math.round(toNum(patch.hourly_rate));
  if (patch.employment_type !== undefined) body.employment_type = patch.employment_type;
  if (patch.pay_type !== undefined) body.pay_type = patch.pay_type;
  if (patch.monthly_salary !== undefined) body.monthly_salary = Math.round(toNum(patch.monthly_salary));
  if (patch.weekly_hours !== undefined) body.weekly_hours = Math.min(80, toNum(patch.weekly_hours));
  if (patch.insurance !== undefined) body.insurance = patch.insurance;
  if (patch.weekly_holiday_pay !== undefined) body.weekly_holiday_pay = patch.weekly_holiday_pay;
  if (patch.avail !== undefined) body.availability = windowsFromRows(patch.avail);
  if (patch.color !== undefined) body.color = patch.color;
  return body;
}

/**
 * 고용형태를 고르면 같이 따라오는 통상값 — 등록과 상세가 똑같이 동작해야 해서 한 곳에 둔다.
 * 매니저는 대개 월급 계약이고, 정규직은 주 40시간이 기본이다.
 */
function presetFor(code: EmploymentType, current: Draft): Partial<Draft> {
  const weekly = toNum(current.weekly_hours);
  const patch: Partial<Draft> = { employment_type: code };
  if (code === 'manager') patch.pay_type = 'monthly';
  if (code === 'full_time' || code === 'manager') {
    if (weekly < 15) patch.weekly_hours = '40';
  } else if (code === 'part_time_15' && weekly < 15) {
    patch.weekly_hours = '20';
  }
  return patch;
}

/** 목록 합계는 직원 줄에서 그대로 유도된다 — 한 명을 고칠 때마다 목록을 다시 부르지 않게 */
function withTotals(list: StaffList, staff: StaffMember[]): StaffList {
  return {
    ...list,
    staff,
    total_gross: staff.reduce((a, s) => a + s.cost.gross_pay, 0),
    total_owner_burden: staff.reduce((a, s) => a + s.cost.owner_burden, 0),
    total_cost: staff.reduce((a, s) => a + s.cost.total_cost, 0),
    total_hours: Math.round(staff.reduce((a, s) => a + s.cost.monthly_hours, 0) * 10) / 10,
    unknown_hours_count: staff.filter((s) => s.cost.hours_source === 'none').length,
  };
}

export default function StaffScreen() {
  const { token } = useAuth();
  const isFocused = useIsFocused();
  const [data, setData] = useState<StaffList | null>(null);
  const [weekly, setWeekly] = useState<WeeklyPayroll | null>(null);
  // 실패 사유를 그대로 들고 있는다 — "가져오지 못했어요"만 띄우면 사장님도 나도
  // 무엇을 고쳐야 하는지 알 수 없다 (실제로 원인은 '서버에 이 기능이 아직 없음'이었다).
  const [failed, setFailed] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  // 화면에서 편집 중인 값 — 서버 응답을 기다리지 않고 여기부터 먼저 바뀐다
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});

  // 직원 추가 폼 (상세와 같은 항목을 처음부터 받는다)
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);

  const employmentTypes = data?.employment_types ?? EMPLOYMENT_TYPE_FALLBACK;
  const insuranceTypes = data?.insurance_types ?? INSURANCE_TYPE_FALLBACK;
  const minWage = data?.min_wage ?? 10320;

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [s, w] = await Promise.all([
        listStaff(token),
        getWeeklyPayroll(token).catch(() => null),
      ]);
      setData(s);
      setWeekly(w);
      setDrafts(Object.fromEntries(s.staff.map((m) => [m.id, draftOf(m)])));
      setFailed(null);
    } catch (e) {
      console.error('직원 목록 조회 실패:', e);
      setFailed(describeApiError(e));
    }
  }, [token]);

  // 근무 달력·스케줄은 옆 화면(직원·스케줄)에서 바뀐다. 그 화면에서 돌아왔을 때
  // 인건비가 옛날 시간으로 남아 있으면 두 화면이 서로 다른 말을 하게 된다.
  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  // 직원별 저장 순번 — 겹친 요청 중 마지막 것만 화면에 반영하기 위한 표식
  const saveSeq = useRef<Record<number, number>>({});

  // 주급 카드는 저장 때마다 같이 부르면 왕복이 두 배가 된다 — 마지막 저장 뒤 한 번만.
  const weeklyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshWeekly = useCallback(() => {
    if (!token) return;
    if (weeklyTimer.current) clearTimeout(weeklyTimer.current);
    weeklyTimer.current = setTimeout(() => {
      getWeeklyPayroll(token)
        .then(setWeekly)
        .catch(() => undefined);
    }, 700);
  }, [token]);

  const availTimer = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => () => {
    if (weeklyTimer.current) clearTimeout(weeklyTimer.current);
    Object.values(availTimer.current).forEach(clearTimeout);
  }, []);

  /** 편집 반영 — 화면부터 바꾸고(persist=false면 여기까지), 서버 저장은 뒤따른다 */
  const edit = useCallback(
    (emp: StaffMember, patch: Partial<Draft>, persist = true) => {
      setDrafts((d) => ({ ...d, [emp.id]: { ...(d[emp.id] ?? draftOf(emp)), ...patch } }));
      if (!persist || !token) return;
      // 칩을 연달아 누르면 저장 요청도 겹친다. 늦게 도착한 옛 응답이 방금 고른 값을
      // 되돌리지 않게, 마지막 요청의 응답만 화면에 반영한다.
      const seq = (saveSeq.current[emp.id] ?? 0) + 1;
      saveSeq.current[emp.id] = seq;
      setSaving(emp.id);
      saveStaffProfile(token, emp.id, toApi(patch))
        .then((updated) => {
          if (saveSeq.current[emp.id] !== seq) return; // 더 최신 저장이 진행 중
          // 구버전 서버는 프로필만 돌려준다(계산 결과 없음) — 그때는 목록을 다시 받는다
          if (!updated || !updated.id || !updated.cost) {
            load();
            return;
          }
          // 서버가 다시 계산한 그 직원 한 줄로 교체 → 인건비·합계가 즉시 맞춰진다
          setData((cur) =>
            cur ? withTotals(cur, cur.staff.map((s) => (s.id === updated.id ? updated : s))) : cur,
          );
          setDrafts((d) => ({ ...d, [updated.id]: draftOf(updated) }));
          refreshWeekly();
        })
        .catch((e) => {
          console.error('직원 상세 저장 실패:', e);
          toast('저장 실패', describeApiError(e));
          load(); // 서버 값으로 되돌린다 — 화면만 바뀐 채 남지 않게
        })
        .finally(() => {
          if (saveSeq.current[emp.id] === seq) setSaving((cur) => (cur === emp.id ? null : cur));
        });
    },
    [token, load, refreshWeekly],
  );

  // 디바운스된 저장이 옛 edit을 붙잡지 않도록 최신 함수를 참조로 들고 있는다
  const editRef = useRef(edit);
  useEffect(() => {
    editRef.current = edit;
  }, [edit]);

  // 가능 시간은 요일 칩·시간 화살표를 연달아 누르며 맞춘다 — 누를 때마다 저장하면
  // 요청이 줄줄이 나가므로, 손이 멈춘 뒤 한 번만 보낸다.
  const editAvail = useCallback((emp: StaffMember, rows: AvailRow[]) => {
    setDrafts((d) => ({ ...d, [emp.id]: { ...(d[emp.id] ?? draftOf(emp)), avail: rows } }));
    clearTimeout(availTimer.current[emp.id]);
    availTimer.current[emp.id] = setTimeout(() => editRef.current(emp, { avail: rows }, true), 900);
  }, []);

  const submitNew = async () => {
    if (!token || submitting) return;
    const d = newDraft;
    if (!d.name.trim()) {
      toast('추가 실패', '직원 이름을 입력해 주세요.');
      return;
    }
    if (d.pay_type === 'monthly' ? toNum(d.monthly_salary) <= 0 : toNum(d.hourly_rate) <= 0) {
      toast('추가 실패', d.pay_type === 'monthly' ? '월급을 입력해 주세요.' : '시급을 입력해 주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { ...toApi(d), name: d.name.trim() };
      // 서버가 아직 옛 버전이면(등록+상세 한 번에 저장이 없음) 예전 두 단계로 돌아간다 —
      // 배포 전에도 추가는 되게, 대신 고른 값이 버려지지 않게.
      const created = await createStaff(token, body).catch(async (e) => {
        if (!(e instanceof Error) || !e.message.startsWith('404')) throw e;
        const emp = await createEmployee(
          { name: body.name, hourly_rate: body.hourly_rate ?? 0, role: body.role || '알바' },
          token,
        );
        return saveStaffProfile(token, emp.id, body);
      });
      setNewDraft(EMPTY_DRAFT);
      setAdding(false);
      refreshWeekly();
      // 목록을 아직 못 받았거나 구버전 응답이면 목록을 다시 받아 채운다
      if (!data || !created?.id || !created.cost) {
        await load();
        toast('직원을 추가했어요', `${body.name} 직원이 목록에 들어갔어요.`);
        return;
      }
      setData((cur) => (cur ? withTotals(cur, [...cur.staff, created]) : cur));
      setDrafts((prev) => ({ ...prev, [created.id]: draftOf(created) }));
      setOpenId(created.id);

      // 가능 시간을 받아 놓고 달력이 비어 있으면 사장님이 31일치를 손으로 옮겨 적게 된다.
      // 등록하면서 바로 이번 달 근무까지 만들어 둔다 — 근무 달력에 그대로 나타난다.
      if ((body.availability?.length ?? 0) > 0) {
        try {
          const r = await applyAvailability(token, { employee_id: created.id });
          toast(
            '직원을 추가했어요',
            r.created > 0
              ? `${created.name} · 이번 달 근무 ${r.created}일을 달력에 넣었어요.`
              : `${created.name} · ${won(created.cost.total_cost)} (이번 달 예상 부담)`,
          );
          await load();
          return;
        } catch (e) {
          console.error('가능 시간 달력 반영 실패:', e);
        }
      }
      toast('직원을 추가했어요', `${created.name} · ${won(created.cost.total_cost)} (이번 달 예상 부담)`);
    } catch (e) {
      console.error('직원 등록 실패:', e);
      toast('추가 실패', describeApiError(e));
    } finally {
      setSubmitting(false);
    }
  };

  // 가능 시간을 그 달 근무로 만든다 — '직원·스케줄'의 알바 근무 달력에도 같은 데이터가 뜬다
  const [filling, setFilling] = useState<number | null>(null);
  const fillCalendar = async (emp: StaffMember) => {
    if (!token || filling) return;
    setFilling(emp.id);
    try {
      const r = await applyAvailability(token, { employee_id: emp.id });
      await load();
      toast(
        r.created > 0 ? '달력에 넣었어요' : '이미 다 들어가 있어요',
        r.created > 0
          ? `${emp.name} · 이번 달 ${r.created}일 (이미 있던 ${r.skipped}일은 그대로 뒀어요)`
          : `${emp.name}의 이번 달 남은 근무가 이미 달력에 있어요.`,
      );
    } catch (e) {
      console.error('가능 시간 달력 반영 실패:', e);
      toast('반영 실패', describeApiError(e));
    } finally {
      setFilling(null);
    }
  };

  const removeStaff = (emp: StaffMember) =>
    confirmDialog(`'${emp.name}' 직원을 삭제할까요? 스케줄 기록도 함께 지워집니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteEmployee(emp.id);
          setData((cur) => (cur ? withTotals(cur, cur.staff.filter((s) => s.id !== emp.id)) : cur));
          refreshWeekly();
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
              등록된 직원이 없어요. 위 ‘직원 추가’에서 이름·시급과 고용형태까지 한 번에 넣어 주세요.
            </Text>
          </Card>
        )}

        <SectionTitle>직원별 상세</SectionTitle>

        {(data?.staff ?? []).map((emp) => {
          const expanded = openId === emp.id;
          const d = drafts[emp.id] ?? draftOf(emp);
          const c = emp.cost;
          const typeLabel = employmentTypes.find((t) => t.code === d.employment_type)?.label ?? d.employment_type;
          const insLabel = insuranceTypes.find((t) => t.code === d.insurance)?.label ?? d.insurance;
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
                  <View style={[styles.avatar, { backgroundColor: d.color }]}>
                    <Ionicons name={TYPE_ICON[d.employment_type] ?? 'person-outline'} size={17} color={colors.white} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>
                      {d.name} <Text style={styles.role}>· {d.role}</Text>
                    </Text>
                    <Text style={styles.sub}>
                      {typeLabel} · {d.pay_type === 'monthly'
                        ? `월급 ${won(toNum(d.monthly_salary))}`
                        : `시급 ${won(toNum(d.hourly_rate))}`}
                    </Text>
                    <View style={styles.chipRow}>
                      <Badge label={insLabel} tone={d.insurance === 'none' ? 'orange' : 'neutral'} />
                      {c.hours_source === 'schedule' && (
                        <Badge label={`이번 달 ${c.monthly_hours}시간`} tone="green" />
                      )}
                      {c.hours_source === 'profile' && (
                        <Badge label={`주 ${c.weekly_hours}시간 (직접 입력)`} tone="neutral" />
                      )}
                      {c.hours_source === 'none' && <Badge label="근무 시간 미입력" tone="orange" />}
                      {d.avail.length > 0 && <Badge label={describeRows(d.avail)} tone="neutral" />}
                      {c.weekly_holiday_pay > 0 && <Badge label="주휴수당 발생" tone="green" />}
                      {c.below_min_wage && <Badge label="최저임금 미달" tone="danger" />}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.costValue}>
                      {c.hours_source === 'none' ? '—' : won(c.total_cost)}
                    </Text>
                    <Text style={styles.costLabel}>
                      {saving === emp.id ? '저장 중…' : c.hours_source === 'none' ? '시간 필요' : '이번 달 부담'}
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
                  <StaffFields
                    draft={d}
                    employmentTypes={employmentTypes}
                    insuranceTypes={insuranceTypes}
                    minWage={minWage}
                    // 상세에서는 고른 즉시 저장한다. 숫자는 입력이 끝났을 때(onCommit),
                    // 가능 시간은 연달아 누르므로 손이 멈춘 뒤(디바운스) 한 번만 보낸다.
                    onChange={(patch) =>
                      patch.avail !== undefined
                        ? editAvail(emp, patch.avail)
                        : edit(emp, patch, false)
                    }
                    onCommit={(patch) => edit(emp, patch)}
                    scheduleNote={
                      c.hours_source === 'schedule' && d.pay_type !== 'monthly'
                        ? `이번 달은 근무 달력에 등록된 ${c.monthly_hours}시간으로 계산했어요. 아래 주 소정근로시간은 스케줄이 없는 달에만 쓰입니다.`
                        : undefined
                    }
                  />

                  {d.avail.length > 0 && (
                    <PressableScale
                      style={styles.fillBtn}
                      to={0.97}
                      onPress={() => fillCalendar(emp)}
                    >
                      <Ionicons name="calendar-outline" size={14} color={colors.white} />
                      <Text style={styles.fillText}>
                        {filling === emp.id ? '넣는 중…' : '이 가능 시간대로 이번 달 달력 채우기'}
                      </Text>
                    </PressableScale>
                  )}

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
                </View>
              )}
            </Card>
          );
        })}
      </Screen>

      <FormSheet
        visible={adding}
        title="직원 추가"
        submitLabel={submitting ? '추가 중…' : '추가'}
        onClose={() => setAdding(false)}
        onSubmit={submitNew}
        submitDisabled={submitting || newDraft.name.trim() === ''}
      >
        {/* 상세와 완전히 같은 항목 — 추가하는 순간부터 인건비가 제대로 계산된다 */}
        <StaffFields
          draft={newDraft}
          employmentTypes={employmentTypes}
          insuranceTypes={insuranceTypes}
          minWage={minWage}
          onChange={(patch) => setNewDraft((d) => ({ ...d, ...patch }))}
        />
      </FormSheet>
    </>
  );
}

/**
 * 등록 시트와 상세 패널이 공유하는 고용 조건 입력부.
 *
 * onChange는 값이 바뀔 때마다(칩 선택·스위치·타이핑), onCommit은 숫자 입력이 끝났을 때
 * 호출된다. 등록 시트는 onCommit을 쓰지 않고 제출할 때 한 번에 보낸다.
 */
function StaffFields({
  draft,
  employmentTypes,
  insuranceTypes,
  minWage,
  onChange,
  onCommit,
  scheduleNote,
}: {
  draft: Draft;
  employmentTypes: { code: EmploymentType; label: string; note: string }[];
  insuranceTypes: { code: InsuranceType; label: string; note: string }[];
  minWage: number;
  onChange: (patch: Partial<Draft>) => void;
  onCommit?: (patch: Partial<Draft>) => void;
  scheduleNote?: string;
}) {
  const commit = onCommit ?? (() => undefined);
  const belowMin = draft.pay_type === 'hourly' && toNum(draft.hourly_rate) > 0 && toNum(draft.hourly_rate) < minWage;

  return (
    <View>
      {/* 이름·직책도 여기서 고친다 — 등록 화면과 상세 화면이 같은 항목을 다뤄야
          "이름을 잘못 넣었는데 어디서 고치지?"가 안 생긴다 */}
      <TextField
        label="이름"
        value={draft.name}
        placeholder="예: 김바리"
        onChangeText={(v) => onChange({ name: v })}
        onCommit={(v) => commit({ name: v })}
      />
      <TextField
        label="직책"
        value={draft.role}
        placeholder="예: 바리스타 / 매니저 (비우면 '알바')"
        onChangeText={(v) => onChange({ role: v })}
        onCommit={(v) => commit({ role: v })}
      />

      <Divider />

      {/* 고용형태 */}
      <Text style={styles.fieldLabel}>고용형태</Text>
      <View style={styles.optionWrap}>
        {employmentTypes.map((t) => {
          const active = draft.employment_type === t.code;
          return (
            <TouchableOpacity
              key={t.code}
              activeOpacity={0.7}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => {
                const patch = presetFor(t.code, draft);
                onChange(patch);
                commit(patch);
              }}
            >
              <Text style={[styles.optionText, active && styles.optionTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.optionNote}>
        {employmentTypes.find((t) => t.code === draft.employment_type)?.note}
      </Text>

      <Divider />

      {/* 급여형태 */}
      <Text style={styles.fieldLabel}>급여형태</Text>
      <View style={styles.optionWrap}>
        {(['hourly', 'monthly'] as const).map((k) => {
          const active = draft.pay_type === k;
          return (
            <TouchableOpacity
              key={k}
              activeOpacity={0.7}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => {
                onChange({ pay_type: k });
                commit({ pay_type: k });
              }}
            >
              <Text style={[styles.optionText, active && styles.optionTextActive]}>
                {k === 'hourly' ? '시급제' : '월급제'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {scheduleNote ? <Text style={styles.scheduleNote}>{scheduleNote}</Text> : null}

      {/* 시급은 월급제에서도 최저임금 환산 근거로 쓰이므로 항상 받는다 */}
      <NumberField
        label={draft.pay_type === 'monthly' ? '월급 (원)' : '시급 (원)'}
        suffix="원"
        value={draft.pay_type === 'monthly' ? draft.monthly_salary : draft.hourly_rate}
        onChangeText={(v) => onChange(draft.pay_type === 'monthly' ? { monthly_salary: v } : { hourly_rate: v })}
        onCommit={(v) => commit(draft.pay_type === 'monthly' ? { monthly_salary: v } : { hourly_rate: v })}
      />
      {belowMin && (
        <Text style={styles.minWageNote}>
          2026년 최저임금 {won(minWage)}보다 낮아요. 계약 전에 한 번 확인해 주세요.
        </Text>
      )}
      <NumberField
        label={draft.pay_type === 'monthly' ? '주 소정근로시간 (최저임금 확인용)' : '주 소정근로시간'}
        suffix="시간"
        value={draft.weekly_hours}
        onChangeText={(v) => onChange({ weekly_hours: v })}
        onCommit={(v) => commit({ weekly_hours: v })}
      />

      <Divider />

      {/* 보험 */}
      <Text style={styles.fieldLabel}>보험 가입</Text>
      <View style={styles.optionWrap}>
        {insuranceTypes.map((t) => {
          const active = draft.insurance === t.code;
          return (
            <TouchableOpacity
              key={t.code}
              activeOpacity={0.7}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => {
                onChange({ insurance: t.code });
                commit({ insurance: t.code });
              }}
            >
              <Text style={[styles.optionText, active && styles.optionTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.optionNote}>
        {insuranceTypes.find((t) => t.code === draft.insurance)?.note}
      </Text>

      <Divider />

      {/* 대표 색 — 근무 달력에서 이 사람의 점·선이 이 색으로 그려진다 */}
      <Text style={styles.fieldLabel}>달력 표시 색</Text>
      <View style={styles.optionWrap}>
        {PALETTE.map((c) => {
          const on = draft.color === c.code;
          return (
            <TouchableOpacity
              key={c.code}
              activeOpacity={0.7}
              style={[styles.colorChip, { backgroundColor: c.code }, on && styles.colorChipOn]}
              onPress={() => {
                onChange({ color: c.code });
                commit({ color: c.code });
              }}
            >
              {on && <Ionicons name="checkmark" size={14} color={colors.white} />}
            </TouchableOpacity>
          );
        })}
      </View>

      <Divider />

      {/* 근무 가능 시간 — 알바를 받을 때 실제로 가장 먼저 묻는 질문 */}
      <View style={styles.rowBetween}>
        <Text style={styles.fieldLabel}>근무 가능 시간</Text>
        <Text style={styles.availSummary}>{describeRows(draft.avail)}</Text>
      </View>
      <Text style={[styles.optionNote, { marginTop: 0, marginBottom: 8 }]}>
        요일을 고르고 시간대를 맞춰 주세요. 달력에서 이 시간에 맞춰 근무를 넣을 수 있어요.
      </Text>

      {draft.avail.map((row, i) => (
        <View key={i} style={styles.availRow}>
          <View style={styles.dayWrap}>
            {WEEKDAY_LABELS.map((label, dow) => {
              const on = row.days.includes(dow);
              return (
                <TouchableOpacity
                  key={label}
                  activeOpacity={0.7}
                  style={[styles.dayChip, on && styles.dayChipOn]}
                  onPress={() => {
                    const days = on ? row.days.filter((d) => d !== dow) : [...row.days, dow].sort((a, b) => a - b);
                    onChange({ avail: draft.avail.map((r, j) => (j === i ? { ...r, days } : r)) });
                  }}
                >
                  <Text style={[styles.dayChipText, on && styles.dayChipTextOn]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.hourRow}>
            <HourStepper
              label="시작"
              value={row.start}
              min={0}
              max={23}
              onChange={(v) =>
                onChange({
                  avail: draft.avail.map((r, j) =>
                    j === i ? { ...r, start: v, end: Math.max(r.end, v + 1) } : r,
                  ),
                })
              }
            />
            <HourStepper
              label="종료"
              value={row.end}
              min={1}
              max={24}
              onChange={(v) =>
                onChange({
                  avail: draft.avail.map((r, j) =>
                    j === i ? { ...r, end: v, start: Math.min(r.start, v - 1) } : r,
                  ),
                })
              }
            />
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.availDelete}
              onPress={() => onChange({ avail: draft.avail.filter((_, j) => j !== i) })}
            >
              <Ionicons name="close" size={14} color="#B23B2E" />
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.availAdd}
        onPress={() => onChange({ avail: [...draft.avail, { days: [], start: 9, end: 18 }] })}
      >
        <Ionicons name="add" size={14} color={colors.espressoBrown} />
        <Text style={styles.availAddText}>
          {draft.avail.length === 0 ? '가능 시간 추가' : '다른 시간대 추가 (주말은 따로 등)'}
        </Text>
      </TouchableOpacity>

      {/* 주휴수당 토글 */}
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>주휴수당 지급</Text>
          <Text style={styles.optionNote}>
            주 15시간 이상이면 법적으로 지급 대상이에요. 시급에 이미 포함해 계약했다면 꺼 두세요.
          </Text>
        </View>
        <Switch
          value={draft.weekly_holiday_pay}
          onValueChange={(v) => {
            onChange({ weekly_holiday_pay: v });
            commit({ weekly_holiday_pay: v });
          }}
          trackColor={{ true: colors.espressoBrown, false: colors.mutedSand }}
        />
      </View>
    </View>
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

// 시각 선택 — 키보드를 띄우지 않고 한 시간씩 —/+ (알바 시간은 대부분 정시 단위다)
function HourStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.stepper}>
      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.stepBtn}
        onPress={() => onChange(Math.max(min, value - 1))}
      >
        <Ionicons name="remove" size={13} color={colors.espressoBrown} />
      </TouchableOpacity>
      <View style={{ alignItems: 'center', minWidth: 42 }}>
        <Text style={styles.stepLabel}>{label}</Text>
        <Text style={styles.stepValue}>{String(value).padStart(2, '0')}시</Text>
      </View>
      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.stepBtn}
        onPress={() => onChange(Math.min(max, value + 1))}
      >
        <Ionicons name="add" size={13} color={colors.espressoBrown} />
      </TouchableOpacity>
    </View>
  );
}

// 글자 입력 — 숫자 칸과 같은 규칙(화면은 즉시, 저장은 blur에서 한 번)
function TextField({
  label,
  value,
  placeholder,
  onChangeText,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const start = useRef(value);
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.numBox}>
        <TextInput
          style={[styles.numInput, { textAlign: 'left' }]}
          value={value}
          onFocus={() => {
            start.current = value;
          }}
          onChangeText={onChangeText}
          onBlur={() => {
            if (value.trim() && value.trim() !== start.current.trim()) onCommit(value);
          }}
          placeholder={placeholder}
          placeholderTextColor="#C4B5A5"
        />
      </View>
    </View>
  );
}

// 값은 부모가 들고 있고(입력 즉시 화면 반영), 서버 저장은 편집이 끝났을 때(blur) 한 번만 —
// 글자마다 저장하면 공유 DB에 요청이 폭주한다.
function NumberField({
  label,
  suffix,
  value,
  onChangeText,
  onCommit,
}: {
  label: string;
  suffix: string;
  value: string;
  onChangeText: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const start = useRef(value);
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.numBox}>
        <TextInput
          style={styles.numInput}
          value={value}
          onFocus={() => {
            start.current = value;
          }}
          onChangeText={(v) => onChangeText(v.replace(/[^0-9.]/g, ''))}
          onBlur={() => {
            if (toNum(value) !== toNum(start.current)) onCommit(value);
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="0"
          placeholderTextColor="#C4B5A5"
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
  minWageNote: { ...typography.L5, color: '#B23B2E', marginTop: 6, lineHeight: 15 },
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

  colorChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorChipOn: { borderColor: colors.espressoBrown },
  availSummary: { ...typography.L5, color: colors.pointOrange, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
  availRow: {
    backgroundColor: colors.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 8,
    marginBottom: 8,
    gap: 8,
  },
  dayWrap: { flexDirection: 'row', gap: 4 },
  dayChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.creamSand,
  },
  dayChipOn: { backgroundColor: colors.espressoBrown },
  dayChipText: { fontSize: 11, fontWeight: '800', color: colors.mochaBrown },
  dayChipTextOn: { color: colors.white },
  hourRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.creamSand,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  stepBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { fontSize: 9, color: colors.mochaBrown },
  stepValue: { ...typography.L4, color: colors.espressoBrown },
  availDelete: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(178,59,46,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  availAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderStyle: 'dashed',
    paddingVertical: 10,
  },
  availAddText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

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

  fillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.espressoBrown,
    borderRadius: 10,
    paddingVertical: 11,
    marginTop: 14,
  },
  fillText: { ...typography.L5, color: colors.white, fontWeight: '800' },
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
