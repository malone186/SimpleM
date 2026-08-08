// 운영 (프론트 B) — PRD ERP-9(스케줄·급여·정산), AI-4(스케줄 추천)  ※ 세금은 서류 자동화 탭
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle, WeekdayButtonGroup, IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { supplyPriceOf, type VatMode } from '../../components/PriceInput';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import { useAuth } from '../../auth/AuthContext';
import { peekCache, saveCache } from '../../lib/cache';
import { getMonthlyPayroll, getMonthSettlement, listStaff, updateShift } from '../../lib/api/staff';
import { useTranslation } from '../../i18n/translations';
import {
  getSettlement, listPayroll, forecastSales, createExpense,
  listSchedules, createSchedule, updateSchedule, deleteSchedule, recommendSchedule,
  createUnavailability, listUnavailabilities, deleteUnavailability, getScheduleRecommendation,
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  type Settlement, type Payroll, type Forecast, type Schedule, type EmployeeUnavailability, type ScheduleRecommendation, type Employee
} from '../../lib/api/operation';

const notify = (title: string, message: string) => toast(title, message);

// [백엔드 연동] 이번 달 기준 · 전체 매장 집계
const nowYM = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// 기기 로컬(=KST) 기준 날짜 문자열 — toISOString()은 UTC라 오전 9시 전엔 하루 이르게 나온다
const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localISO(d);
};
const won = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');


export default function OperationScreen() {
  // [한글 주석: 다국어 번역 훅 호출 — 사장님이 선택한 언어(ko/en) 텍스트 반환]
  const { t } = useTranslation();
  const { token } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [employeeColorMap, setEmployeeColorMap] = useState<Record<number, string>>({});
  const [loadingSchedules, setLoadingSchedules] = useState(true);

  // 전역 스케줄 로드 — 토큰을 넘겨야 서버가 내 매장 근무만 걸러서 준다
  const reloadSchedules = useCallback(async () => {
    setLoadingSchedules(true);
    try {
      const list = await listSchedules(token ?? undefined);
      setSchedules(list);
    } catch (e) {
      console.error('전역 스케줄 로드 오류:', e);
    } finally {
      setLoadingSchedules(false);
    }
  }, [token]);

  useEffect(() => {
    reloadSchedules();
  }, [reloadSchedules]);

  return (
    <Screen>
      {/* [한글 주석] 전체 알바생(근무자) 통합 관리 UI 카드 (신규 알바생 등록, 정보 수정, 퇴사/삭제 처리) */}
      <EmployeeManagementCard
        schedules={schedules}
        employeeColorMap={employeeColorMap}
        setEmployeeColorMap={setEmployeeColorMap}
        reloadSchedules={reloadSchedules}
      />
      <ScheduleCalendarCard
        schedules={schedules}
        employeeColorMap={employeeColorMap}
        reloadSchedules={reloadSchedules}
      />
      <LiveOperationCard />
      <UnavailabilityManagementCard />
    </Screen>
  );
}

// [한글 주석] 🎨 알바생 구별용 10가지 파스텔 톤 고유 테마 팔레트 (한 줄 배치용)
const EMPLOYEE_COLORS = [
  '#FFE082', // 1. 버터 옐로우
  '#A8E6CF', // 2. 파스텔 민트
  '#FFC3A0', // 3. 파스텔 피치
  '#B3E5FC', // 4. 파스텔 스카이블루
  '#F8BBD0', // 5. 파스텔 핑크
  '#E1BEE7', // 6. 파스텔 라벤더
  '#C8E6C9', // 7. 파스텔 세이지
  '#FFE0B2', // 8. 파스텔 살구
  '#D1C4E9', // 9. 파스텔 바이올렛
  '#CFD8DC', // 10. 파스텔 그레이스
];

const getEmployeeColor = (empId: number, colorMap?: Record<number, string>) => {
  if (colorMap && colorMap[empId]) return colorMap[empId];
  return EMPLOYEE_COLORS[(Math.abs(empId) - 1) % EMPLOYEE_COLORS.length] || '#FFE082';
};

const WEEK_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

// [한글 주석] 📅 상단 알바 근무 달력 스케줄표 카드 (월별 그리드 & 일자별 알바 출근 관리)
function ScheduleCalendarCard({
  schedules,
  employeeColorMap,
  reloadSchedules,
}: {
  schedules: Schedule[];
  employeeColorMap: Record<number, string>;
  reloadSchedules: () => Promise<void>;
}) {
  const { token } = useAuth();
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [payrollEmployees, setPayrollEmployees] = useState<Payroll[]>([]);
  const [dbEmployees, setDbEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);

  // 달력 전환 부드러운 애니메이션
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // 근무 등록 모달 상태
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState<number | null>(null);
  const [startTimeStr, setStartTimeStr] = useState('09:00');
  const [endTimeStr, setEndTimeStr] = useState('18:00');
  const [adding, setAdding] = useState(false);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-11

  // 직원 데이터 로드
  const loadCalendarData = useCallback(async () => {
    setLoading(true);
    try {
      // 토큰을 안 넘기면 백엔드가 매장 구분 없이 전 직원·전 급여를 돌려준다
      // (다른 매장 직원이 달력·모달에 섞여 나오던 경로). 반드시 함께 보낸다.
      const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
      // 직원 목록(/operation/employees)에는 대표 색·근무 요일이 없다. 그 값들은 '직원·인건비'
      // 쪽(/api/v1/staff)의 프로필에 있고, 근무 요일은 거기 등록한 '근무 가능 시간'에서
      // 파생된다. 달력 선·색이 그 데이터를 따라가도록 여기서 합쳐 준다.
      // 급여는 배치 API(/staff/monthly-payroll, 왕복 2번)를 먼저 쓴다 — 기존
      // /operation/payroll/all은 직원마다 왕복 5번이라 직원 5명이면 5초씩 걸렸다.
      // 스케줄도 순서상 기다릴 이유가 없어 같은 병렬 묶음에 넣는다.
      const [payrollList, empList, staffList] = await Promise.all([
        (token
          ? getMonthlyPayroll(token, ym).catch(() => listPayroll(ym, token))
          : listPayroll(ym)
        ).catch(() => [] as Payroll[]),
        listEmployees(token ?? undefined).catch(() => [] as Employee[]),
        token ? listStaff(token).catch(() => null) : Promise.resolve(null),
        reloadSchedules(),
      ]);
      const profileMap = new Map(
        (staffList?.staff ?? []).map((m) => [m.id, m.profile] as const),
      );
      setPayrollEmployees(payrollList);
      setDbEmployees(
        empList.map((e) => {
          const profile = profileMap.get(e.id);
          return profile ? ({ ...e, profile } as Employee) : e;
        }),
      );

      // 알바생을 안 고르고 [등록]만 눌러도 되게 첫 번째 사람을 미리 선택해 둔다.
      // 다만 직원이 하나도 없으면 예전처럼 ID 1로 넘기지 않는다 — 존재하지 않는 직원의
      // 근무가 저장돼 달력에 유령이 생기던 원인이었다.
      if (empList.length > 0) {
        setSelectedEmpId((prev) => prev ?? empList[0].id);
      } else if (payrollList.length > 0) {
        setSelectedEmpId((prev) => prev ?? payrollList[0].employee_id);
      } else {
        setSelectedEmpId(null);
      }
    } catch (e) {
      console.error('달력 데이터 조회 오류:', e);
    } finally {
      setLoading(false);
    }
  }, [year, month, reloadSchedules]);

  useEffect(() => {
    loadCalendarData();
  }, [loadCalendarData]);

  // 직원 ID -> 이름 매핑 맵
  const empNameMap = useMemo(() => {
    const map: Record<number, string> = {};
    dbEmployees.forEach((e) => {
      map[e.id] = e.name;
    });
    payrollEmployees.forEach((p) => {
      if (!map[p.employee_id]) {
        map[p.employee_id] = p.employee_name;
      }
    });
    return map;
  }, [dbEmployees, payrollEmployees]);

  // [한글 주석: 알바생별 시그니처 대표 색상 매핑 (팔레트 선택 색상 최우선 적용)]
  const dynamicColorMap = useMemo(() => {
    const map: Record<number, string> = { ...employeeColorMap };
    dbEmployees.forEach((emp: any) => {
      if (emp.profile?.color) {
        map[emp.id] = emp.profile.color;
      }
    });
    return map;
  }, [employeeColorMap, dbEmployees]);

  // 달력 일자 계산
  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = firstDay.getDay(); // [한글 주석] 일요일=0 기준 (달력 헤더 [일, 월, 화, 수, 목, 금, 토]와 1:1 정확 일치)
    const daysInMonth = lastDay.getDate();

    const days: ({ type: 'empty' } | { type: 'day'; dateStr: string; dayNum: number; isToday: boolean })[] = [];
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push({ type: 'empty' });
    }

    // [한글 주석: UTC 파싱 오차 없는 100% 정확한 로컬 ISO 날짜 생성]
    const nowD = new Date();
    const todayStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;

    for (let d = 1; d <= daysInMonth; d++) {
      const mStr = String(month + 1).padStart(2, '0');
      const dStr = String(d).padStart(2, '0');
      const dateStr = `${year}-${mStr}-${dStr}`;
      days.push({
        type: 'day',
        dateStr,
        dayNum: d,
        isToday: dateStr === todayStr,
      });
    }
    return days;
  }, [year, month]);

  // 날짜별 스케줄 맵 (안전한 YYYY-MM-DD 키 추출 + 알바생 존재 시 스케줄 100% 보장 폴백)
  const schedulesByDate = useMemo(() => {
    const map: Record<string, Schedule[]> = {};
    schedules.forEach((s) => {
      let dateKey = s.date ? String(s.date).slice(0, 10) : '';
      if (!dateKey && s.start_time) {
        dateKey = String(s.start_time).slice(0, 10);
      }
      if (dateKey) {
        if (!map[dateKey]) map[dateKey] = [];
        map[dateKey].push(s);
      }
    });

    return map;
  }, [schedules]);

  // 등록된 직원만 남기는 필터.
  //
  // 예전엔 여기서 "요일 패턴"을 추정해 스케줄이 없는 날에도 알바생을 채워 넣었고,
  // 후보 목록에 하드코딩 ID [1,2,3]까지 섞어 넣었다. 그래서 달력 아무 평일이나 눌러도
  // 전 직원 + 존재하지 않는 유령 알바생이 전부 떴다. 사장님이 보고 싶은 건 '추정'이
  // 아니라 '그날 실제로 등록된 근무'이므로, 지금은 등록된 스케줄만 그대로 보여준다.
  const knownEmpIds = useMemo(() => {
    const ids = new Set<number>();
    dbEmployees.forEach((e) => ids.add(e.id));
    payrollEmployees.forEach((p) => ids.add(p.employee_id));
    return ids;
  }, [dbEmployees, payrollEmployees]);

  // 직원 목록을 아직 못 불러왔으면(로딩·조회 실패) 필터를 걸지 않는다 — 걸면 근무가
  // 통째로 빈 화면이 돼 "스케줄이 사라졌다"로 보인다.
  const isKnownEmp = useCallback(
    (empId: number) => knownEmpIds.size === 0 || knownEmpIds.has(empId),
    [knownEmpIds],
  );

  // "이 날짜에 이 직원 근무가 등록돼 있나?" — 달력의 연속 바를 그릴 때 옆 날짜를 확인한다
  const workKeySet = useMemo(() => {
    const set = new Set<string>();
    schedules.forEach((s) => {
      const dateStr = s.date ? String(s.date).slice(0, 10) : s.start_time ? String(s.start_time).slice(0, 10) : '';
      if (dateStr) set.add(`${dateStr}|${s.employee_id}`);
    });
    return set;
  }, [schedules]);
  const worksOn = useCallback(
    (dateStr: string, empId: number) => {
      if (workKeySet.has(`${dateStr}|${empId}`)) return true;
      const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const dObj = new Date(dateStr);
      const dayCode = DAY_CODES[dObj.getDay()];
      const emp = dbEmployees.find((e: any) => e.id === empId) as any;
      const profileWorkDays = (emp?.profile?.work_days ?? []) as string[];
      return profileWorkDays.includes(dayCode);
    },
    [workKeySet, dbEmployees],
  );

  // 부드러운 월 전환 애니메이션 트랜지션
  const animateTransition = (callback: () => void) => {
    Animated.sequence([
      Animated.timing(fadeAnim, {
        toValue: 0.2,
        duration: 110,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
    setTimeout(callback, 110);
  };

  // 이전/다음 월 이동
  const handlePrevMonth = () => {
    animateTransition(() => {
      setCurrentDate(new Date(year, month - 1, 1));
    });
  };
  const handleNextMonth = () => {
    animateTransition(() => {
      setCurrentDate(new Date(year, month + 1, 1));
    });
  };

  // 근무 등록 핸들러 (로컬 우선 반영)
  const handleAddSchedule = async () => {
    if (!selectedEmpId) {
      notify('알바생 선택', '근무할 알바생을 선택해 주세요.');
      return;
    }
    setAdding(true);
    try {
      const formatTime = (tStr: string) => {
        const h = parseInt(tStr.split(':')[0] || '0', 10);
        if (h >= 24) return '23:59:59';
        return `${tStr.length === 5 ? tStr : tStr.padStart(5, '0')}:00`;
      };

      const startIso = `${selectedDate}T${formatTime(startTimeStr)}`;
      const endIso = `${selectedDate}T${formatTime(endTimeStr)}`;

      // [한글 주석: 백엔드 상태와 상관없이 화면에 즉시 등록 반영]
      // 예전엔 API를 부르기 전에 '등록 완료'를 띄우고 실패는 콘솔로만 삼켰다.
      // 저장이 안 돼도 성공 문구가 뜨니, 달력에 아무것도 안 생기면 앱이 고장 난 걸로 보였다.
      await createSchedule(
        { employee_id: selectedEmpId, start_time: startIso, end_time: endIso },
        token ?? undefined,
      );
      setModalVisible(false);
      await reloadSchedules();
      notify('등록 완료', '새로운 알바 근무 스케줄이 등록되었습니다.');
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  // 근무 삭제 — 결과를 확인한 뒤에 알린다 (실패를 성공으로 알리지 않도록)
  const handleDeleteSchedule = async (id: number) => {
    try {
      await deleteSchedule(id, token ?? undefined);
      await reloadSchedules();
      notify('삭제 완료', '알바 근무 스케줄이 삭제되었습니다.');
    } catch (e) {
      notify('삭제 실패', e instanceof Error ? e.message : String(e));
      await reloadSchedules();
    }
  };

  // 선택한 날짜에 '실제로 등록된' 근무만. 추정·보정·가짜 스케줄 생성 없음.
  // 같은 직원이 하루에 두 번(오전·저녁) 들어갈 수 있으므로 중복 제거도 하지 않는다.
  const selectedDateSchedules = useMemo(() => {
    const rawScheds = schedulesByDate[selectedDate] || [];
    return rawScheds
      .filter((s) => isKnownEmp(s.employee_id)) // 퇴사·삭제된 직원의 잔여 스케줄은 숨긴다
      .sort((a, b) => String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
  }, [selectedDate, schedulesByDate, isKnownEmp]);

  // 근무 시간(자정 넘김 보정) — 목록에 '몇 시간'을 같이 보여주려고
  const shiftHours = (s: Schedule) => {
    const st = new Date(String(s.start_time));
    const et = new Date(String(s.end_time));
    if (Number.isNaN(st.getTime()) || Number.isNaN(et.getTime())) return 0;
    let h = (et.getTime() - st.getTime()) / 3600000;
    if (h < 0) h += 24;
    return Math.round(h * 10) / 10;
  };

  const selectedDayHours = useMemo(
    () => Math.round(selectedDateSchedules.reduce((a, s) => a + shiftHours(s), 0) * 10) / 10,
    [selectedDateSchedules],
  );

  // 이 요일에 '가능'으로 등록된 직원 (직원·인건비 화면의 근무 가능 시간에서 파생)
  const availableToday = useMemo(() => {
    const code = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(selectedDate).getDay()];
    return dbEmployees.filter((e: any) => ((e.profile?.work_days ?? []) as string[]).includes(code));
  }, [dbEmployees, selectedDate]);

  // 교대 — 근무를 지우고 다시 만들지 않고 담당자만 바꾼다 (실제 출퇴근 기록이 남는다)
  const [swapTarget, setSwapTarget] = useState<Schedule | null>(null);
  const [swapEmpId, setSwapEmpId] = useState<number | null>(null);
  const [swapping, setSwapping] = useState(false);

  const swapCandidates = useMemo(() => {
    const canIds = new Set(availableToday.map((e: any) => e.id));
    return dbEmployees.slice().sort((a: any, b: any) => {
      const av = (canIds.has(b.id) ? 1 : 0) - (canIds.has(a.id) ? 1 : 0);
      return av || String(a.name).localeCompare(String(b.name));
    });
  }, [dbEmployees, availableToday]);

  const openSwap = (s: Schedule) => {
    setSwapTarget(s);
    setSwapEmpId(s.employee_id);
  };

  const submitSwap = async () => {
    if (!swapTarget || !swapEmpId || !token || swapping) return;
    if (swapEmpId === swapTarget.employee_id) {
      setSwapTarget(null);
      return;
    }
    setSwapping(true);
    try {
      const updated = await updateShift(token, swapTarget.id, { employee_id: swapEmpId });
      setSwapTarget(null);
      await reloadSchedules();
      notify('교대 완료', `${updated.name} 직원이 이 근무를 맡습니다.`);
    } catch (e) {
      notify('교대 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setSwapping(false);
    }
  };

  return (
    <Card style={{ marginBottom: 16, backgroundColor: colors.creamSand }}>
      {/* 헤더 바 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="calendar-outline" size={22} color={colors.espressoBrown} />
          <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.espressoBrown }}>알바 근무 달력 스케줄표</Text>
        </View>
      </View>

      {/* 미니멀 월 컨트롤러 (요청사항: '오늘' 버튼 지움, 중앙 연월 정렬) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginBottom: 8, position: 'relative' }}>
        <PressableScale onPress={handlePrevMonth} style={{ position: 'absolute', left: 4, padding: 6 }} to={0.85}>
          <Ionicons name="chevron-back" size={20} color="#222" />
        </PressableScale>
        <Text style={{ fontSize: 18, fontWeight: '800', color: '#111', letterSpacing: -0.5 }}>
          {year}년 {month + 1}월
        </Text>
        <PressableScale onPress={handleNextMonth} style={{ position: 'absolute', right: 4, padding: 6 }} to={0.85}>
          <Ionicons name="chevron-forward" size={20} color="#222" />
        </PressableScale>
      </View>

      {/* 요일 헤더 (일 월 화 수 목 금 토) */}
      <View style={{ flexDirection: 'row', marginBottom: 10, paddingHorizontal: 4 }}>
        {['일', '월', '화', '수', '목', '금', '토'].map((day, idx) => (
          <View key={day} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: idx === 0 ? '#E53E3E' : idx === 6 ? '#2B6CB0' : '#8C7E74' }}>
              {day}
            </Text>
          </View>
        ))}
      </View>

      {/* 달력 날짜 그리드 (일 숫자 투명 미니멀 + 텍스트 없는 끊김 없는 파스텔 연속 선) */}
      <Animated.View style={{ opacity: fadeAnim, flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#FFF', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 0, borderWidth: 1, borderColor: '#EFEAE6' }}>
        {(calendarDays as any[]).map((item, index) => {
          if (item.type === 'empty') {
            return <View key={`empty-${index}`} style={{ width: '14.28%', height: 64 }} />;
          }

          const isSelected = item.dateStr === selectedDate;
          const dayScheds = schedulesByDate[item.dateStr] || [];

          // [한글 주석: 실제 등록된 스케줄 + 직원의 설정된 주 근무 요일(work_days)에 맞춘 달력 색상 선 그리기]
          const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
          const dateObj = new Date(item.dateStr);
          const currentDayCode = DAY_CODES[dateObj.getDay()];

          // 실제로 등록된 근무와 '가능 요일'을 구분한다 — 둘을 같은 굵기로 그리면
          // 아직 아무도 안 넣은 날이 이미 다 짜인 날처럼 보인다.
          const scheduledIds: number[] = [];
          dayScheds.forEach((s: Schedule) => {
            if (isKnownEmp(s.employee_id) && !scheduledIds.includes(s.employee_id)) {
              scheduledIds.push(s.employee_id);
            }
          });
          const availableOnlyIds = dbEmployees
            .filter((emp: any) => ((emp.profile?.work_days ?? []) as string[]).includes(currentDayCode))
            .map((emp: any) => emp.id as number)
            .filter((id: number) => !scheduledIds.includes(id));

          const uniqueEmpIds = [...scheduledIds, ...availableOnlyIds];
          const hasSched = uniqueEmpIds.length > 0;

          const prevItem = index > 0 ? (calendarDays[index - 1] as any) : null;
          const nextItem = index < calendarDays.length - 1 ? (calendarDays[index + 1] as any) : null;

          const isSunday = index % 7 === 0;
          const isSaturday = (index + 1) % 7 === 0;

          return (
            <PressableScale
              key={item.dateStr}
              onPress={() => setSelectedDate(item.dateStr)}
              style={{
                width: '14.28%',
                height: 64,
                alignItems: 'center',
                justifyContent: 'flex-start',
                paddingTop: 3,
              }}
              to={0.92}
            >
              {/* [한글 주석: 안 튀고 은은한 소프트 미니멀 일자 뱃지 — 차분한 크림 베이지 틴트 & 미니 점 포인터] */}
              {(() => {
                let badgeBgColor = 'transparent';
                let badgeBorderWidth = 0;
                let badgeBorderColor = 'transparent';
                let textColor = '#333333';
                let fontWeight: '600' | '800' = '600';

                if (item.isToday && isSelected) {
                  badgeBgColor = '#EFE6DD';
                  badgeBorderWidth = 1.5;
                  badgeBorderColor = colors.espressoBrown;
                  textColor = colors.espressoBrown;
                  fontWeight = '800';
                } else if (item.isToday) {
                  badgeBgColor = '#F2ECE5';
                  textColor = colors.espressoBrown;
                  fontWeight = '800';
                } else if (isSelected) {
                  badgeBgColor = '#F8F4F0';
                  badgeBorderWidth = 1.2;
                  badgeBorderColor = colors.mochaBrown;
                  textColor = colors.espressoBrown;
                  fontWeight = '800';
                }

                return (
                  <View
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: badgeBgColor,
                      borderWidth: badgeBorderWidth,
                      borderColor: badgeBorderColor,
                      marginBottom: 3,
                      position: 'relative',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight,
                        color: textColor,
                      }}
                    >
                      {item.dayNum}
                    </Text>

                    {item.isToday && (
                      <View
                        style={{
                          position: 'absolute',
                          bottom: 2,
                          width: 3,
                          height: 3,
                          borderRadius: 1.5,
                          backgroundColor: '#C05A24',
                        }}
                      />
                    )}
                  </View>
                );
              })()}

              {/* 2. 일 숫자 밑 파스텔 색상 선(바) — 출근 알바생 전체(3명 이상 포함)의 요일 스케줄이 달력 전체에 100% 이어진 직선 바 */}
              {scheduledIds.length > 0 && (
                <Text style={{ fontSize: 9, color: '#8C7E74', marginBottom: 2 }}>{scheduledIds.length}명</Text>
              )}

              {hasSched && (
                <View style={{ width: '100%', gap: 2 }}>
                  {uniqueEmpIds.map((empId) => {
                    const empColor = getEmployeeColor(empId, dynamicColorMap);

                    // 좌우로 이어진 바를 그릴지 판단 — '요일 추정'이 아니라 옆 날짜에
                    // 그 직원의 근무가 실제로 등록돼 있는지로 본다
                    const isPrevSame =
                      !!prevItem && prevItem.type === 'day' && !isSunday &&
                      worksOn(prevItem.dateStr, empId);
                    const isNextSame =
                      !!nextItem && nextItem.type === 'day' && !isSaturday &&
                      worksOn(nextItem.dateStr, empId);

                    // 주 단위로 뚝뚝 끊기지 않고 100% 매끄럽게 연결되는 주차 스트립 바 스타일
                    const lineBorderStyle = isPrevSame && isNextSame
                      ? { borderRadius: 0 }
                      : isPrevSame && !isNextSame
                      ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderTopRightRadius: 2.5, borderBottomRightRadius: 2.5 }
                      : !isPrevSame && isNextSame
                      ? { borderTopLeftRadius: 2.5, borderBottomLeftRadius: 2.5, borderTopRightRadius: 0, borderBottomRightRadius: 0 }
                      : { borderRadius: 2.5 };

                    return (
                      <View
                        key={empId}
                        style={[
                          {
                            width: '100%',
                            height: 4.5,
                            backgroundColor: empColor,
                            // 가능 요일만인 사람은 흐리게 — '넣을 수 있다'와 '넣었다'는 다르다
                            opacity: scheduledIds.includes(empId) ? 1 : 0.28,
                          },
                          lineBorderStyle,
                        ]}
                      />
                    );
                  })}
                </View>
              )}
            </PressableScale>
          );
        })}
      </Animated.View>

      {/* 직원 색 범례 — 달력의 선이 누구인지 알 수 있어야 색이 의미가 있다 */}
      {dbEmployees.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {dbEmployees.map((emp: any) => (
            <View key={emp.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: getEmployeeColor(emp.id, dynamicColorMap) }} />
              <Text style={{ fontSize: 11.5, color: '#6B5D54', fontWeight: '600' }}>{emp.name}</Text>
            </View>
          ))}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 14, height: 4.5, borderRadius: 2, backgroundColor: '#8C7E74', opacity: 0.28 }} />
            <Text style={{ fontSize: 11.5, color: '#8C7E74' }}>가능 요일(미배정)</Text>
          </View>
        </View>
      )}

      {/* ── 선택한 날짜의 근무 ── */}
      <View style={{ marginTop: 14, backgroundColor: '#FFF', borderRadius: 16, borderWidth: 1, borderColor: '#EFEAE6', padding: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* minWidth 0 + 한 줄 고정 — 안 그러면 설명이 접히면서 버튼을 밀어낸다 */}
          <View style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '800', color: colors.espressoBrown }}>
              {Number(selectedDate.slice(5, 7))}월 {Number(selectedDate.slice(8, 10))}일 ({WEEK_LABEL[new Date(selectedDate).getDay()]})
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 12.5, color: '#8C7E74', marginTop: 3 }}>
              근무 {selectedDateSchedules.length}명 · 합계 {selectedDayHours}시간
            </Text>
          </View>
          <PressableScale
            onPress={() => setModalVisible(true)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0, backgroundColor: colors.espressoBrown, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 }}
            to={0.95}
          >
            <Ionicons name="add" size={15} color="#FFF" />
            <Text style={{ fontSize: 12.5, fontWeight: '800', color: '#FFF' }}>근무 추가</Text>
          </PressableScale>
        </View>

        {selectedDateSchedules.length === 0 ? (
          <View style={{ paddingVertical: 16 }}>
            <Text style={{ fontSize: 13, color: '#8C7E74', textAlign: 'center', lineHeight: 19 }}>
              이 날은 등록된 근무가 없어요.
            </Text>
            {availableToday.length > 0 && (
              <Text style={{ fontSize: 12.5, color: colors.espressoBrown, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                이 요일에 가능한 직원: {availableToday.map((e: any) => e.name).join(' · ')}
              </Text>
            )}
          </View>
        ) : (
          <View style={{ gap: 10, marginTop: 12 }}>
            <Text style={{ fontSize: 11, color: '#A2938A' }}>
              ⇄ 다른 직원으로 교대 · 휴지통 근무 삭제
            </Text>
            {selectedDateSchedules.map((s: Schedule) => {
              const empColor = getEmployeeColor(s.employee_id, dynamicColorMap);
              const matched = dbEmployees.find((e) => e.id === s.employee_id);
              const name = s.employee_name || matched?.name || '(이름 미상)';
              const role = s.employee_role || matched?.role || '알바';
              const startStr = String(s.start_time ?? '').slice(11, 16);
              const endStr = String(s.end_time ?? '').slice(11, 16);
              const hours = shiftHours(s);
              return (
                <View
                  key={s.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 9,
                    backgroundColor: '#FBF9F7',
                    paddingVertical: 11,
                    paddingHorizontal: 11,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: '#EFEAE6',
                  }}
                >
                  <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: empColor, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 15, fontWeight: '900', color: '#FFF' }}>{name.charAt(0)}</Text>
                  </View>
                  {/* minWidth 0이 없으면 이름·시간이 버튼을 밀어내고 '(5
시간)'처럼 잘려 접힌다 */}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '800', color: colors.espressoBrown }}>
                      {name} <Text style={{ fontSize: 11.5, fontWeight: '600', color: '#8C7E74' }}>· {role}</Text>
                    </Text>
                    <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: '700', color: '#4A3B32', marginTop: 3 }}>
                      {startStr} ~ {endStr}
                      <Text style={{ fontSize: 12, fontWeight: '600', color: '#8C7E74' }}>{hours ? ` · ${hours}시간` : ''}</Text>
                    </Text>
                  </View>
                  {/* 아이콘 버튼 두 개 — 글자 버튼은 좁은 화면에서 이름 칸을 잡아먹는다 */}
                  <PressableScale
                    onPress={() => openSwap(s)}
                    style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E3DAD2', alignItems: 'center', justifyContent: 'center' }}
                    to={0.92}
                  >
                    <Ionicons name="swap-horizontal" size={17} color={colors.espressoBrown} />
                  </PressableScale>
                  <PressableScale
                    onPress={() => handleDeleteSchedule(s.id)}
                    style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(178,59,46,0.07)', alignItems: 'center', justifyContent: 'center' }}
                    to={0.92}
                  >
                    <Ionicons name="trash-outline" size={17} color="#B23B2E" />
                  </PressableScale>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* 교대 시트 — 그 날 가능한 직원이 위로 온다 */}
      <Modal visible={swapTarget !== null} transparent animationType="slide" onRequestClose={() => setSwapTarget(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setSwapTarget(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>근무 교대</Text>
            {swapTarget && (
              <Text style={{ fontSize: 13, color: '#8C7E74', marginTop: -6, marginBottom: 12 }}>
                {selectedDate} {String(swapTarget.start_time ?? '').slice(11, 16)}~
                {String(swapTarget.end_time ?? '').slice(11, 16)} · 현재{' '}
                {swapTarget.employee_name || dbEmployees.find((e) => e.id === swapTarget.employee_id)?.name || ''}
              </Text>
            )}

            <Text style={styles.formLabel}>누구로 바꿀까요?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {swapCandidates.map((emp: any) => {
                const active = swapEmpId === emp.id;
                const can = availableToday.some((a: any) => a.id === emp.id);
                return (
                  <PressableScale
                    key={emp.id}
                    style={[
                      styles.peakSegmentBtn,
                      active && styles.segmentBtnActiveNormal,
                      { flexDirection: 'row', alignItems: 'center' },
                    ]}
                    onPress={() => setSwapEmpId(emp.id)}
                  >
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: getEmployeeColor(emp.id, dynamicColorMap), marginRight: 6 }} />
                    <Text style={[styles.peakSegmentText, active && styles.segmentTextActiveNormal]}>
                      {emp.name}
                    </Text>
                    <Text style={{ fontSize: 10, marginLeft: 5, color: active ? 'rgba(255,255,255,0.75)' : '#A2938A' }}>
                      {can ? '가능' : '가능 요일 아님'}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 18 }}>
              <Button label="취소" variant="secondary" style={{ flex: 1 }} onPress={() => setSwapTarget(null)} />
              <Button label={swapping ? '바꾸는 중…' : '이 사람으로 교대'} style={{ flex: 1 }} onPress={submitSwap} />
            </View>
          </View>
        </View>
      </Modal>

      {/* 근무 추가 모달 */}
      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setModalVisible(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{selectedDate} 알바 근무 등록</Text>

            <View style={{ gap: 14 }}>
              {/* 알바생 선택 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>알바생 선택 (고유 색상 뱃지)</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {dbEmployees.length === 0 && payrollEmployees.length === 0 ? (
                    // 예전엔 여기서 '기본 알바 (ID:1)'를 눌러 없는 직원의 근무를 만들 수 있었다.
                    // 그렇게 저장된 스케줄이 달력에 이름 없는 유령으로 남았다.
                    <Text style={{ ...typography.L5, color: colors.mochaBrown, lineHeight: 16 }}>
                      등록된 직원이 없어요. ‘직원 · 인건비’에서 직원을 먼저 추가해 주세요.
                    </Text>
                  ) : dbEmployees.length > 0 ? (
                    dbEmployees.map((emp) => {
                      const empColor = getEmployeeColor(emp.id);
                      const active = selectedEmpId === emp.id;
                      return (
                        <PressableScale
                          key={emp.id}
                          style={[styles.peakSegmentBtn, active && styles.segmentBtnActiveNormal, { flexDirection: 'row', alignItems: 'center' }]}
                          onPress={() => setSelectedEmpId(emp.id)}
                        >
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: empColor, marginRight: 6 }} />
                          <Text style={[styles.peakSegmentText, active && styles.segmentTextActiveNormal]}>
                            {emp.name} ({emp.role || '알바'})
                          </Text>
                        </PressableScale>
                      );
                    })
                  ) : (
                    payrollEmployees.map((p) => {
                      const empColor = getEmployeeColor(p.employee_id);
                      const active = selectedEmpId === p.employee_id;
                      return (
                        <PressableScale
                          key={p.employee_id}
                          style={[styles.peakSegmentBtn, active && styles.segmentBtnActiveNormal, { flexDirection: 'row', alignItems: 'center' }]}
                          onPress={() => setSelectedEmpId(p.employee_id)}
                        >
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: empColor, marginRight: 6 }} />
                          <Text style={[styles.peakSegmentText, active && styles.segmentTextActiveNormal]}>
                            {p.employee_name} ({p.role})
                          </Text>
                        </PressableScale>
                      );
                    })
                  )}
                </View>
              </View>

              {/* 시간 입력 */}
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.formLabel}>시작 시간</Text>
                  <TextInput
                    style={styles.input}
                    value={startTimeStr}
                    onChangeText={setStartTimeStr}
                    placeholder="09:00"
                  />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.formLabel}>종료 시간</Text>
                  <TextInput
                    style={styles.input}
                    value={endTimeStr}
                    onChangeText={setEndTimeStr}
                    placeholder="18:00"
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Button label="취소" variant="secondary" style={{ flex: 1 }} onPress={() => setModalVisible(false)} />
                <Button label={adding ? '등록 중…' : '등록'} style={{ flex: 1 }} onPress={handleAddSchedule} />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </Card>
  );
}



// (삭제됨) BeanOperationCard — 어디에서도 렌더링되지 않는 죽은 카드였는데,
// 안에 원두 5종이 상수로 박혀 있고 'DB 599개 적재완료' 배지까지 달려 있었다.
// 실제로 동작하는 대체품은 BeanOperationScreen.tsx다 (GET /roastery/search로
// 진짜 수집 건수와 시세를 보여준다).





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
  // 영수증 금액을 그대로 치고 칩만 고르게 한다 — 사장님이 부가세를 직접 나눠 계산하지 않도록
  const [expVat, setExpVat] = useState<VatMode>('included');

  const load = useCallback(async () => {
    // 지난 방문 때 받아 둔 값이 있으면 그걸로 먼저 그린다 — 스피너 대신 숫자가 떠 있게.
    const cached = peekCache<{ settlement: Settlement; payroll: Payroll[] }>(`operation:live:${period}`);
    if (cached) {
      setSettlement(cached.data.settlement);
      setPayroll(cached.data.payroll);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setErr(null);
    try {
      // 정산+급여는 배치 API 요청 1번(왕복 4번)으로 함께 온다. 기존 경로는 정산이
      // 내부에서 직원별 급여 N+1을 재실행해 카드 하나에 10초 가까이 걸렸다.
      // 서버가 옛 버전이면(404 등) 기존 두 경로로 폴백한다.
      const combined = token
        ? getMonthSettlement(token, period).then(
            (r) => [r.settlement as Settlement, r.payroll as Payroll[]] as const,
          ).catch(async () => {
            const [s, p] = await Promise.allSettled([
              getSettlement(period, token),
              listPayroll(period, token),
            ]);
            return [
              s.status === 'fulfilled' ? s.value : null,
              p.status === 'fulfilled' ? p.value : null,
            ] as const;
          })
        : Promise.allSettled([
            getSettlement(period), listPayroll(period),
          ]).then(([s, p]) => [
            s.status === 'fulfilled' ? s.value : null,
            p.status === 'fulfilled' ? p.value : null,
          ] as const);

      const [[s, p], fRes] = await Promise.all([
        combined,
        forecastSales({ target_date: tomorrowISO(), engine: 'arima' }, token ?? undefined).catch(() => null),
      ]);

      if (s) setSettlement(s);
      if (p) setPayroll(p);
      setForecast(fRes);
      if (s && p) void saveCache(`operation:live:${period}`, { settlement: s, payroll: p });

      // 모든 API가 전멸했고 보여줄 캐시도 없는 경우에만 에러 표출
      if (!s && !p && !fRes && !cached) {
        setErr('정산·급여 정보를 불러오지 못했어요. 네트워크를 확인해 주세요.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [period, token]);

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
    // 손익에는 부가세를 뺀 공급가액이 들어가야 한다 — 매입세액은 부가세 신고 때 돌려받으므로
    // 결제액 전부를 비용으로 잡으면 이익이 실제보다 10% 적게 나온다.
    const supply = supplyPriceOf(amt, expVat);
    setAdding(true);
    try {
      await createExpense(token, { amount: supply, category: cat, expense_date: localISO(new Date()) });
      notify(
        '지출 등록',
        expVat === 'included' && supply !== amt
          ? `${cat} ${won(amt)} (공급가액 ${won(supply)})을 등록했어요. 정산에는 부가세를 뺀 금액이 반영됩니다.`
          : `${cat} ${won(supply)}을 등록했어요. 정산에 자동 반영됩니다.`,
      );
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
          {/* [한글 주석: 손익 정산 KPI - 금액이 억/천만원 단위일 때 텍스트 잘림을 방지하기 위해 adjustsFontSizeToFit 적용] */}
          <View style={liveStyles.kpiGrid}>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>총매출</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{won(settlement?.total_sales ?? 0)}</Text>
            </View>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>총비용</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{won(settlement?.total_expense ?? 0)}</Text>
            </View>
            <View style={liveStyles.kpi}>
              <Text style={liveStyles.kpiLabel}>인건비</Text>
              <Text style={liveStyles.kpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{won(settlement?.total_payroll ?? 0)}</Text>
            </View>
            <View style={[liveStyles.kpi, liveStyles.kpiProfit]}>
              {/* 임대료가 안 잡힌 매장에서 '순이익'이라 쓰면 월세만큼 더 번 것처럼 읽힌다 */}
              <Text style={liveStyles.kpiLabel}>{settlement?.fixed_cost_missing ? '고정비 전' : '순이익'}</Text>
              <Text
                style={[liveStyles.kpiValue, { color: (settlement?.net_profit ?? 0) >= 0 ? '#3E8E5A' : colors.pointOrange }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
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

          {/* 부가세 처리 — 칩 한 번으로 공급가액 환산 (직접 나눠 계산할 필요 없음) */}
          <View style={liveStyles.vatRow}>
            {([
              { code: 'included' as VatMode, label: '부가세 포함' },
              { code: 'excluded' as VatMode, label: '부가세 별도' },
              { code: 'exempt' as VatMode, label: '면세' },
            ]).map((m) => {
              const active = expVat === m.code;
              return (
                <TouchableOpacity
                  key={m.code}
                  style={[liveStyles.vatChip, active && liveStyles.vatChipActive]}
                  onPress={() => setExpVat(m.code)}
                >
                  <Text style={[liveStyles.vatChipText, active && liveStyles.vatChipTextActive]}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {(() => {
            const raw = parseInt(expAmount.replace(/[^0-9]/g, ''), 10) || 0;
            if (raw <= 0) return null;
            const supply = supplyPriceOf(raw, expVat);
            return (
              <Text style={liveStyles.vatHint}>
                손익에 반영: {won(supply)}
                {expVat !== 'exempt' ? ` · 부가세 ${won(expVat === 'included' ? raw - supply : Math.round(raw * 0.1))}` : ' (면세)'}
              </Text>
            );
          })()}

          <View style={[styles.actions, { marginTop: 10 }]}>
            <Button label="새로고침" variant="secondary" style={{ flex: 1 }} onPress={load} />
          </View>
          <Text style={liveStyles.disc}>실 출퇴근 기록이 없으면 계획된 근무시간 기준의 참고용 예상 급여입니다.</Text>
        </>
      )}
    </Card>
  );
}

// [한글 주석: 금액 숫자가 커져도 잘리지 않도록 폰트 크기(16.5px) 및 패딩(10px) 최적화]
const liveStyles = StyleSheet.create({
  vatRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  vatChip: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.18)',
    borderRadius: 999,
    paddingVertical: 7,
  },
  vatChipActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  vatChipText: { fontSize: 11, fontWeight: '700', color: colors.mochaBrown },
  vatChipTextActive: { color: colors.white },
  vatHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 7 },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  kpi: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 0,
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.10)',
  },
  kpiProfit: { backgroundColor: '#F1F6EE', borderColor: 'rgba(62,142,90,0.22)' },
  kpiLabel: { ...typography.L5, color: colors.mochaBrown },
  kpiValue: { fontSize: 16.5, fontWeight: '800', color: colors.espressoBrown, marginTop: 5 },
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
  // [한글 주석] 직원 명단을 저장하여 탭(칩) 선택 및 이름 표시를 처리하는 상태
  const [employees, setEmployees] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  // [한글 주석] 백엔드 연결 실패 시 에러 문구를 저장하기 위한 상태
  const [err, setErr] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  // 폼 입력 상태
  const [employeeId, setEmployeeId] = useState('1');
  const [unavType, setUnavType] = useState<'weekly_recurring' | 'specific_date'>('weekly_recurring');
  const [dayOfWeek, setDayOfWeek] = useState('0'); // 0=월, 1=화, ...
  const [specificDate, setSpecificDate] = useState(tomorrowISO());
  const [startHour, setStartHour] = useState('9');
  const [endHour, setEndHour] = useState('12');
  const [restrictionLevel, setRestrictionLevel] = useState<'hard' | 'soft'>('hard');
  const [reason, setReason] = useState('');

  const loadUnavailabilities = useCallback(async () => {
    if (!token) return;
    // 지난 방문 값이 있으면 즉시 그린다 — 서버 응답이 오면 조용히 갱신
    const cached = peekCache<{ list: EmployeeUnavailability[]; emps: { id: number; name: string }[] }>('operation:unavail');
    if (cached) {
      setList(cached.data.list);
      setEmployees(cached.data.emps);
    } else {
      setLoading(true);
    }
    setErr(null);
    try {
      // 직원 이름만 필요하므로 직원 목록(왕복 1번)을 쓴다. 예전엔 급여 API를 썼는데
      // 그 경로는 직원마다 왕복 5번이라 기피시간 카드가 몇 초씩 비어 있었고,
      // 그 달 스케줄이 없는 직원은 급여 목록에서 빠져 이름조차 안 나왔다.
      const [data, empList] = await Promise.all([
        listUnavailabilities(token),
        listEmployees(token).catch(() => [] as Employee[]),
      ]);
      setList(data);
      const emps = empList.map((e) => ({ id: e.id, name: e.name }));
      setEmployees(emps);
      void saveCache('operation:unavail', { list: data, emps });
      if (emps.length > 0) {
        // 폼의 선택 직원이 목록에 없으면 첫 직원으로 — 값 확인은 함수형 갱신으로 해서
        // 이 로더가 employeeId에 의존하지 않게 한다 (예전엔 폼에서 직원만 골라도
        // 목록 전체를 다시 불러오는 재조회 루프가 있었다).
        setEmployeeId((prev) => (emps.some((e) => String(e.id) === prev) ? prev : String(emps[0].id)));
      }
    } catch (e) {
      console.warn('기피시간 조회 실패:', e);
      // [한글 주석] 조회 실패 시 에러 메시지를 기록하여 화면에 명확히 표출함
      if (!cached) setErr(e instanceof Error ? e.message : String(e));
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
    // 등록된 직원 목록에 있는 id만 통과 — 기본값 '1'이 실재하는 직원이라는 보장이 없다
    if (!employees.some((e) => String(e.id) === employeeId)) {
      notify('입력 확인', '직원을 먼저 등록한 뒤 선택해 주세요.');
      return;
    }
    const empId = parseInt(employeeId, 10);
    const sH = parseInt(startHour, 10);
    const eH = parseInt(endHour, 10);
    if (!empId || sH >= eH) {
      notify('입력 확인', '올바른 직원 선택과 시작/종료 시각을 설정해 주세요.');
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
      ) : err ? (
        // [한글 주석] 백엔드 연동에 실패했을 때 에러 메시지와 다시 시도 버튼을 출력합니다.
        <View style={{ paddingVertical: 12 }}>
          <Text style={liveStyles.errText}>⚠ {err}</Text>
          <Button label="다시 시도" variant="secondary" style={{ marginTop: 10 }} onPress={loadUnavailabilities} />
        </View>
      ) : list.length === 0 ? (
        <Text style={[styles.hint, { marginTop: 10, fontStyle: 'italic' }]}>등록된 알바생 기피 시간이 없습니다.</Text>
      ) : (
        <View style={{ gap: 8, marginTop: 12 }}>
          {list.map((u) => {
            const isHard = u.restriction_level === 'hard';
            const typeLabel = u.unavailability_type === 'weekly_recurring'
              ? `매주 ${dayNames[u.day_of_week ?? 0]}요일`
              : `${u.specific_date}`;
            const empObj = employees.find((e) => e.id === u.employee_id);
            const empName = empObj ? empObj.name : `직원 ${u.employee_id}`;

            return (
              <View key={u.id} style={unavStyles.itemRow}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={unavStyles.itemTitle}>{empName} (ID:{u.employee_id})</Text>
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
              {/* [한글 주석] 기존 텍스트 입력창 대신, 직원 목록을 탭하여 선택할 수 있는 칩UI 지원 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>직원 선택</Text>
                {employees.length === 0 ? (
                  // 직원이 없으면 등록으로 안내한다 — 예전엔 'ID:1' 하드코딩 칩이 있어
                  // 존재하지 않는 직원 id로 기피 시간이 등록되는 유령 데이터가 생겼다
                  // (스케줄 추가 모달이 이미 같은 이유로 걷어낸 패턴).
                  <Text style={styles.formLabel}>
                    등록된 직원이 없어요. 먼저 직원 관리에서 직원을 등록해 주세요.
                  </Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {employees.map((emp) => {
                      const active = String(emp.id) === employeeId;
                      return (
                        <PressableScale
                          key={emp.id}
                          style={[
                            styles.peakSegmentBtn,
                            { flex: 0, paddingHorizontal: 14, paddingVertical: 10 },
                            active && styles.segmentBtnActiveNormal,
                          ]}
                          onPress={() => setEmployeeId(String(emp.id))}
                          to={0.94}
                        >
                          <Text style={[styles.peakSegmentText, active && styles.segmentTextActiveNormal]}>
                            {emp.name} (ID:{emp.id})
                          </Text>
                        </PressableScale>
                      );
                    })}
                  </View>
                )}
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
                /* [한글 주석] 숫자를 입력하던 기존 방식 대신 월~일 한글 요일 버튼 탭UI 적용 */
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>요일 선택</Text>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {dayNames.map((dayName, idx) => {
                      const active = dayOfWeek === String(idx);
                      return (
                        <PressableScale
                          key={idx}
                          style={[
                            styles.peakSegmentBtn,
                            { minWidth: 42, paddingHorizontal: 12, paddingVertical: 10 },
                            active && styles.segmentBtnActivePeak,
                          ]}
                          onPress={() => setDayOfWeek(String(idx))}
                          to={0.92}
                        >
                          <Text style={[styles.peakSegmentText, active && styles.segmentTextActivePeak]}>
                            {dayName}
                          </Text>
                        </PressableScale>
                      );
                    })}
                  </View>
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

// [한글 주석] 👥 전체 알바생(근무자) 통합 관리 UI 카드 (신규 알바생 등록, 정보 수정, 퇴사/삭제 처리 및 근무 스케줄 설정)
function EmployeeManagementCard({
  schedules,
  employeeColorMap,
  setEmployeeColorMap,
  reloadSchedules,
}: {
  schedules: Schedule[];
  employeeColorMap: Record<number, string>;
  setEmployeeColorMap: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  reloadSchedules: () => Promise<void>;
}) {
  // [한글 주석: 알바생 통합 관리 카드 내 다국어 번역 훅 호출]
  const { t } = useTranslation();
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);

  // AI 스케줄 추천 상태
  const [recommendation, setRecommendation] = useState<ScheduleRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);


  // 매장 직원 목록.
  // 예전엔 목록이 비면 '김알바·이매니저' 같은 샘플을 넣어 화면을 채웠는데, 사장님 눈에는
  // 등록한 적 없는 사람이 생긴 걸로 보였다. 없으면 없는 대로 비워 두는 게 맞다.
  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      setEmployees(await listEmployees(token ?? undefined));
    } catch (e) {
      console.error('알바생 목록 조회 오류:', e);
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  // AI 스케줄 추천 실행
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

  // 신규 알바생 추가 버튼 클릭 핸들러

  return (
    <>
      {/* 1순위: AI 스케줄 추천 (기피시간 반영) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>AI 추천 스케줄 (기피시간 반영)</SectionTitle>
          <Badge label="추천안" tone="orange" />
        </View>
        <Text style={styles.hint}>
          {recommendation?.summary || '버튼을 누르면 과거 매출과 알바생 기피시간(Hard/Soft)을 종합 분석해 최적의 추천 스케줄을 계산합니다.'}
        </Text>

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

      {/* 직원 명부는 '직원·인건비' 화면 하나로 합쳤다 — 관리 허브에는 카드를 두지 않으므로
          이 화면이 유일한 진입로다. AI 추천 바로 아래에 둔다(추천 결과에 나온 사람을
          바로 확인·수정하러 가는 흐름). 예전엔 여기(전체 알바생 관리)와 직원·인건비 두 곳에서
          같은 직원을 각각 등록·수정할 수 있어서, 어느 쪽이 진짜인지 알 수 없었다. */}
      <PressableScale style={staffLinkStyles.card} onPress={() => navigation.navigate('Staff')} to={0.98}>
        <View style={staffLinkStyles.icon}>
          <Ionicons name="people" size={19} color={colors.espressoBrown} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={staffLinkStyles.title}>
            직원 · 인건비 {employees.length > 0 ? `(${employees.length}명)` : ''}
          </Text>
          <Text style={staffLinkStyles.desc}>
            {employees.length > 0
              ? employees.slice(0, 4).map((e) => e.name).join(' · ') + (employees.length > 4 ? ` 외 ${employees.length - 4}명` : '')
              : '등록된 직원이 없어요. 여기서 추가해 주세요.'}
          </Text>
          <Text style={staffLinkStyles.hint}>
            직원 추가·수정·삭제 · 고용형태 · 4대/2대보험 · 주휴수당 · 월 인건비
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />
      </PressableScale>

    </>
  );
}



// 직원 명부로 넘어가는 링크 카드 (직원 관리는 '직원·인건비' 한 곳에서만 한다)
const staffLinkStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.14)',
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 12, // AI 추천 카드 바로 아래
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.L3, color: colors.espressoBrown },
  desc: { ...typography.L5, color: colors.espressoBrown, marginTop: 4, lineHeight: 15 },
  hint: { fontSize: 10, color: colors.mochaBrown, marginTop: 4, lineHeight: 14 },
});

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
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      position: 'absolute' as const,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 9999,
    } : {}),
  },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalSheet: {
    backgroundColor: colors.white,
    borderRadius: 24,
    width: '90%',
    maxWidth: 370,
    maxHeight: 630, // [한글 주석] 세로 높이를 짧고 아담하게 조율함
    padding: 14,
    paddingBottom: 16,
  },
  modalHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.mutedSand,
    marginBottom: 8,
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
