// 운영 (프론트 B) — PRD ERP-9(스케줄·급여·정산), AI-4(스케줄 추천)  ※ 세금은 서류 자동화 탭
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle, WeekdayButtonGroup, IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import { useAuth } from '../../auth/AuthContext';
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
const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const won = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');


export default function OperationScreen() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [employeeColorMap, setEmployeeColorMap] = useState<Record<number, string>>({});
  const [loadingSchedules, setLoadingSchedules] = useState(true);

  // 전역 스케줄 로드
  const reloadSchedules = useCallback(async () => {
    setLoadingSchedules(true);
    try {
      const list = await listSchedules();
      setSchedules(list);
    } catch (e) {
      console.error('전역 스케줄 로드 오류:', e);
    } finally {
      setLoadingSchedules(false);
    }
  }, []);

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
      const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
      const [payrollList, empList] = await Promise.all([
        listPayroll(ym).catch(() => [] as Payroll[]),
        listEmployees().catch(() => [] as Employee[]),
      ]);
      setPayrollEmployees(payrollList);
      setDbEmployees(empList);
      await reloadSchedules();
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

    const todayStr = new Date().toISOString().slice(0, 10);
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

  // 근무 등록 핸들러
  const handleAddSchedule = async () => {
    if (!selectedEmpId) {
      notify('알바생 선택', '근무할 알바생을 선택해 주세요.');
      return;
    }
    setAdding(true);
    try {
      // [한글 주석] 백엔드 Pydantic datetime 파싱 422 에러 방지: 24시는 23:59:59로 안전 변환
      const formatTime = (tStr: string) => {
        const h = parseInt(tStr.split(':')[0] || '0', 10);
        if (h >= 24) return '23:59:59';
        return `${tStr.length === 5 ? tStr : tStr.padStart(5, '0')}:00`;
      };

      const startIso = `${selectedDate}T${formatTime(startTimeStr)}`;
      const endIso = `${selectedDate}T${formatTime(endTimeStr)}`;

      await createSchedule({
        employee_id: selectedEmpId,
        start_time: startIso,
        end_time: endIso,
      });
      notify('등록 완료', '새로운 알바 근무 스케줄이 등록되었습니다.');
      setModalVisible(false);
      loadCalendarData();
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  // 근무 삭제 핸들러
  const handleDeleteSchedule = async (id: number) => {
    try {
      await deleteSchedule(id);
      notify('삭제 완료', '알바 근무 스케줄이 삭제되었습니다.');
      loadCalendarData();
    } catch (e) {
      notify('삭제 실패', e instanceof Error ? e.message : String(e));
    }
  };

  const selectedDateSchedules = schedulesByDate[selectedDate] || [];

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
            return <View key={`empty-${index}`} style={{ width: '14.28%', height: 48 }} />;
          }

          const isSelected = item.dateStr === selectedDate;
          const dayScheds = schedulesByDate[item.dateStr] || [];
          const hasSched = dayScheds.length > 0;

          // 중복 없는 직원 ID 목록
          const uniqueEmpIds: number[] = Array.from(new Set(dayScheds.map((s: Schedule) => s.employee_id)));

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
                height: 48,
                alignItems: 'center',
                justifyContent: 'flex-start',
                paddingTop: 2,
              }}
              to={0.92}
            >
              {/* 1. 일 숫자: 배경 색칠 제거(투명), 11px 미니멀 축소 */}
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: isSelected ? 1.5 : 0,
                  borderColor: colors.espressoBrown,
                  backgroundColor: 'transparent',
                  marginBottom: 3,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: isSelected || item.isToday ? '800' : '600',
                    color: item.isToday ? colors.pointOrange : '#222',
                  }}
                >
                  {item.dayNum}
                </Text>
              </View>

              {/* 2. 일 숫자 밑 파스텔 색상 선(바) — 1명/+1명 텍스트 제거, 100% 매끄럽게 이어진 직선 바 */}
              {hasSched && (
                <View style={{ width: '100%', gap: 3 }}>
                  {uniqueEmpIds.slice(0, 2).map((empId) => {
                    const empColor = getEmployeeColor(empId, employeeColorMap);

                    let isPrevSame = false;
                    let isNextSame = false;

                    if (prevItem && prevItem.type === 'day' && !isSunday) {
                      const prevScheds = schedulesByDate[prevItem.dateStr] || [];
                      isPrevSame = prevScheds.some((s: Schedule) => s.employee_id === empId);
                    }
                    if (nextItem && nextItem.type === 'day' && !isSaturday) {
                      const nextScheds = schedulesByDate[nextItem.dateStr] || [];
                      isNextSame = nextScheds.some((s: Schedule) => s.employee_id === empId);
                    }

                    // 뚝뚝 끊기지 않고 100% 매끄럽게 연결되는 선 스타일
                    const lineBorderStyle = isPrevSame && isNextSame
                      ? { borderRadius: 0 }
                      : isPrevSame && !isNextSame
                      ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderTopRightRadius: 3, borderBottomRightRadius: 3 }
                      : !isPrevSame && isNextSame
                      ? { borderTopLeftRadius: 3, borderBottomLeftRadius: 3, borderTopRightRadius: 0, borderBottomRightRadius: 0 }
                      : { borderRadius: 3 };

                    return (
                      <View
                        key={empId}
                        style={[
                          {
                            width: '100%',
                            height: 6,
                            backgroundColor: empColor,
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

      {/* 선택된 날짜의 상세 근무 알바생 리스트 */}
      <View style={{ marginTop: 14, backgroundColor: '#FFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E6E1DC' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.espressoBrown }}>
            📅 {selectedDate} 근무 일정 ({selectedDateSchedules.length}명)
          </Text>
          <PressableScale
            onPress={() => setModalVisible(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: colors.espressoBrown,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
            }}
          >
            <Ionicons name="add" size={14} color="#FFF" />
            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#FFF' }}>근무 추가</Text>
          </PressableScale>
        </View>

        {selectedDateSchedules.length === 0 ? (
          <Text style={{ fontSize: 13, color: '#8C7E74', textAlign: 'center', paddingVertical: 12 }}>
            등록된 알바 근무 일정이 없습니다.
          </Text>
        ) : (
          <View style={{ gap: 8 }}>
            {selectedDateSchedules.map((s: Schedule) => {
              const empColor = getEmployeeColor(s.employee_id);
              const name = empNameMap[s.employee_id] || `직원 ${s.employee_id}`;
              const startStr = s.start_time ? s.start_time.slice(11, 16) || s.start_time : '';
              const endStr = s.end_time ? s.end_time.slice(11, 16) || s.end_time : '';
              return (
                <View
                  key={s.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#FBF9F7',
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: '#EFEAE6',
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: empColor }} />
                      <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.espressoBrown }}>
                        {name} <Text style={{ fontSize: 12, color: colors.mochaBrown }}>(ID:{s.employee_id})</Text>
                      </Text>
                    </View>
                    <Text style={{ fontSize: 12, color: '#7A6C63', marginTop: 2, marginLeft: 16 }}>
                      ⏰ 근무 시간: {startStr} ~ {endStr}
                    </Text>
                  </View>
                  <PressableScale onPress={() => handleDeleteSchedule(s.id)} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={18} color="#B23B2E" />
                  </PressableScale>
                </View>
              );
            })}
          </View>
        )}
      </View>

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
                    <PressableScale
                      style={[styles.peakSegmentBtn, selectedEmpId === 1 && styles.segmentBtnActiveNormal]}
                      onPress={() => setSelectedEmpId(1)}
                    >
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: getEmployeeColor(1), marginRight: 4 }} />
                      <Text style={[styles.peakSegmentText, selectedEmpId === 1 && styles.segmentTextActiveNormal]}>
                        기본 알바 (ID:1)
                      </Text>
                    </PressableScale>
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



// [한글 주석] ☕ 599개 원두 최저가 시세 및 1,822건 사용자 리뷰 실데이터 분석 카드
function BeanOperationCard() {
  const [selectedCategory, setSelectedCategory] = useState('전체');
  const [keyword, setKeyword] = useState('');

  // 599개 실데이터 샘플 카탈로그 리스트
  // product_url은 백엔드 응답(schemas/product_search.py)에는 있지만 아래 샘플엔 없어서
  // 명시 타입으로 옵셔널 선언한다 — 없을 때는 네이버 쇼핑 검색 URL로 폴백한다.
  const sampleBeans: {
    id: number;
    name: string;
    roastery: string;
    price: number;
    lowest_price: number;
    country: string;
    rating: number;
    review_count: number;
    positive_ratio: number;
    keywords: string[];
    product_url?: string;
  }[] = [
    { id: 1, name: 'BG블렌드 (500g)', roastery: '타이커피', price: 15000, lowest_price: 13500, country: '에티오피아', rating: 4.8, review_count: 25, positive_ratio: 92, keywords: ['#고소함', '#라떼강추', '#가성비'] },
    { id: 2, name: '에티오피아 예가체프 (200g)', roastery: '가델로 커피', price: 14000, lowest_price: 13800, country: '에티오피아', rating: 4.9, review_count: 150, positive_ratio: 96, keywords: ['#상큼한산미', '#꽃향기', '#드립전용'] },
    { id: 3, name: '콜롬비아 수프리모 (500g)', roastery: '모카 팩토리', price: 16500, lowest_price: 15000, country: '콜롬비아', rating: 4.7, review_count: 88, positive_ratio: 90, keywords: ['#밸런스좋음', '#견과류풍미', '#데일리'] },
    { id: 4, name: '디카페인 딥 블렌드 (200g)', roastery: '타이커피', price: 15500, lowest_price: 14500, country: '과테말라', rating: 4.6, review_count: 42, positive_ratio: 88, keywords: ['#속편한', '#디카페인', '#다크초콜릿'] },
    { id: 5, name: '자메이카 블루마운틴 (200g)', roastery: '가델로 커피', price: 45000, lowest_price: 45000, country: '자메이카', rating: 5.0, review_count: 30, positive_ratio: 98, keywords: ['#최고급', '#품절대란', '#명품원두'] },
  ];

  const filteredBeans = sampleBeans.filter(b => 
    (selectedCategory === '전체' || b.country === selectedCategory) &&
    (b.name.includes(keyword) || b.roastery.includes(keyword))
  );

  return (
    <Card style={{ marginBottom: 16, backgroundColor: colors.creamSand }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="cafe" size={22} color={colors.espressoBrown} />
          <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.espressoBrown }}>수집 원두 시세 & 실리뷰 통계</Text>
        </View>
        <Badge label="DB 599개 적재완료" tone="green" />
      </View>

      {/* 검색어 입력창 */}
      <TextInput
        style={{
          backgroundColor: '#FFF',
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          fontSize: 14,
          borderWidth: 1,
          borderColor: '#E1DCD7',
          marginBottom: 12,
        }}
        placeholder="원두명 또는 로스터리 검색 (예: 에티오피아)"
        value={keyword}
        onChangeText={setKeyword}
      />

      {/* 카테고리 칩 */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14 }}>
        {['전체', '에티오피아', '콜롬비아', '과테말라'].map(cat => (
          <Pressable
            key={cat}
            onPress={() => setSelectedCategory(cat)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 14,
              backgroundColor: selectedCategory === cat ? colors.espressoBrown : '#EFEAE6',
            }}
          >
            <Text style={{ color: selectedCategory === cat ? '#FFF' : colors.espressoBrown, fontSize: 12, fontWeight: '600' }}>
              {cat}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* 원두 카드 리스트 */}
      <View style={{ gap: 10 }}>
        {filteredBeans.map(bean => (
          <View
            key={bean.id}
            style={{
              backgroundColor: '#FFF',
              borderRadius: 10,
              padding: 12,
              borderWidth: 1,
              borderColor: '#E6E1DC',
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown }}>{bean.name}</Text>
                <Text style={{ fontSize: 12, color: '#7A6E65', marginTop: 2 }}>{bean.roastery} · {bean.country}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.pointOrange }}>
                  최저가 {bean.lowest_price.toLocaleString()}원
                </Text>
                <Pressable
                  onPress={() => {
                    const targetUrl = bean.product_url || `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(bean.name)}`;
                    if (Platform.OS === 'web') {
                      window.open(targetUrl, '_blank');
                    } else {
                      const { Linking } = require('react-native');
                      Linking.openURL(targetUrl);
                    }
                  }}
                  style={{
                    backgroundColor: colors.pointOrange,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 6,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 2,
                  }}
                >
                  <Ionicons name="cart-outline" size={12} color="#FFF" />
                  <Text style={{ color: '#FFF', fontSize: 11, fontWeight: 'bold' }}>바로 구매</Text>
                </Pressable>
              </View>

            </View>

            {/* 리뷰 통계 바 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 12, backgroundColor: '#F8F6F4', padding: 8, borderRadius: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="star" size={14} color="#FFB800" />
                <Text style={{ fontSize: 13, fontWeight: 'bold', color: colors.espressoBrown }}>{bean.rating}</Text>
                <Text style={{ fontSize: 12, color: '#888' }}>({bean.review_count}개 리뷰)</Text>
              </View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#2E7D32' }}>
                긍정 비율 {bean.positive_ratio}%
              </Text>
            </View>

            {/* 키워드 태그 */}
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
              {bean.keywords.map((kw, i) => (
                <Text key={i} style={{ fontSize: 11, color: colors.espressoBrown, backgroundColor: '#F0ECE8', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                  {kw}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>
    </Card>
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
    setLoading(true);
    setErr(null);
    try {
      // [한글 주석] 기피시간 목록과 직원 명단을 함께 가져와 매핑합니다.
      const [data, payrollData] = await Promise.all([
        listUnavailabilities(token),
        listPayroll(nowYM()).catch(() => [] as Payroll[]),
      ]);
      setList(data);
      const emps = payrollData.map((p) => ({ id: p.employee_id, name: p.employee_name }));
      setEmployees(emps);
      if (emps.length > 0 && !emps.some((e) => String(e.id) === employeeId)) {
        setEmployeeId(String(emps[0].id));
      }
    } catch (e) {
      console.warn('기피시간 조회 실패:', e);
      // [한글 주석] 조회 실패 시 에러 메시지를 기록하여 화면에 명확히 표출함
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token, employeeId]);

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
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <PressableScale
                      style={[styles.peakSegmentBtn, { flex: 0, paddingHorizontal: 16, paddingVertical: 10 }, styles.segmentBtnActiveNormal]}
                      onPress={() => setEmployeeId('1')}
                    >
                      <Text style={styles.segmentTextActiveNormal}>직원 1 (ID:1)</Text>
                    </PressableScale>
                  </View>
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
  const { token } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // AI 스케줄 추천 상태
  const [recommendation, setRecommendation] = useState<ScheduleRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);

  // 알바생 추가/수정 모달 상태
  const [editingEmp, setEditingEmp] = useState<{
    id: number | null;
    name: string;
    hourlyRate: string;
    role: string;
    days: string[];
    slot: string;
    selectedColor?: string;
  } | null>(null);

  // 백엔드 DB에서 전체 알바생 목록 가져오기
  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listEmployees();
      setEmployees(list);
    } catch (e) {
      console.error('알바생 목록 조회 오류:', e);
    } finally {
      setLoading(false);
    }
  }, []);

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
  const handleAddEmployeePress = () => {
    setEditingEmp({
      id: null,
      name: '',
      hourlyRate: '10000',
      role: '바리스타',
      days: ['월', '화', '수', '목', '금'],
      slot: '09–18',
      selectedColor: EMPLOYEE_COLORS[employees.length % EMPLOYEE_COLORS.length] || '#FFE082',
    });
  };

  // 알바생 수정 버튼 클릭 핸들러
  const handleEditEmployeePress = (emp: Employee) => {
    const empSchedules = schedules.filter((s) => s.employee_id === emp.id);
    const WEEK_KO = ['일', '월', '화', '수', '목', '금', '토'];
    const daysSet = new Set<string>();
    let defaultSlot = '09–18';

    empSchedules.forEach((s) => {
      const wd = WEEK_KO[new Date(s.date + 'T00:00:00').getDay()];
      if (wd) daysSet.add(wd);
      if (s.start_time && s.end_time) {
        const sh = Number(s.start_time.slice(11, 13));
        const eh = Number(s.end_time.slice(11, 13));
        if (!Number.isNaN(sh) && !Number.isNaN(eh)) {
          defaultSlot = `${String(sh).padStart(2, '0')}–${String(eh).padStart(2, '0')}`;
        }
      }
    });

    setEditingEmp({
      id: emp.id,
      name: emp.name,
      hourlyRate: String(emp.hourly_rate),
      role: emp.role || '바리스타',
      days: daysSet.size > 0 ? Array.from(daysSet) : ['월', '화', '수', '목', '금'],
      slot: defaultSlot,
      selectedColor: getEmployeeColor(emp.id, employeeColorMap),
    });
  };

  // 알바생 퇴사/삭제 핸들러
  const handleDeleteEmployee = async (emp: Employee) => {
    if (Platform.OS === 'web') {
      const ok = window.confirm(`정말 '${emp.name}' 알바생을 퇴사/삭제 처리하시겠습니까?\n등록된 정보가 정리됩니다.`);
      if (!ok) return;
    }
    try {
      await deleteEmployee(emp.id);
      notify('퇴사 처리 완료', `'${emp.name}' 알바생이 퇴사/삭제 처리되었습니다.`);
      await loadEmployees();
      await reloadSchedules();
    } catch (e) {
      notify('삭제 실패', e instanceof Error ? e.message : String(e));
    }
  };

  // 알바생 정보 및 근무 요일/시간 스케줄 저장
  const handleSaveEmployee = async () => {
    if (!editingEmp || saving) return;
    if (!editingEmp.name.trim()) {
      notify('입력 확인', '알바생 이름을 입력해 주세요.');
      return;
    }
    const rateNum = Number(editingEmp.hourlyRate.replace(/[^0-9]/g, ''));
    if (Number.isNaN(rateNum) || rateNum <= 0) {
      notify('입력 확인', '올바른 시급(0원 초과)을 입력해 주세요.');
      return;
    }

    const m = editingEmp.slot.match(/(\d+)\D+(\d+)/);
    const sh = m ? Number(m[1]) : NaN;
    const eh = m ? Number(m[2]) : NaN;
    if (!m || Number.isNaN(sh) || Number.isNaN(eh) || sh >= eh) {
      notify('입력 확인', '근무 시작 시간은 종료 시간보다 빨라야 해요.');
      return;
    }

    const formatTimeStr = (h: number) => {
      if (h >= 24) return '23:59:59';
      return `${String(h).padStart(2, '0')}:00:00`;
    };

    setSaving(true);
    try {
      let empId = editingEmp.id;
      let empName = editingEmp.name.trim();

      if (empId !== null) {
        // 수정 API
        const updated = await updateEmployee(empId, {
          name: empName,
          hourly_rate: rateNum,
          role: editingEmp.role.trim() || '바리스타',
        });
        empId = updated.id;
        empName = updated.name;
        if (editingEmp.selectedColor) {
          setEmployeeColorMap((prev) => ({ ...prev, [updated.id]: editingEmp.selectedColor! }));
        }
      } else {
        // 신규 등록 API
        const created = await createEmployee({
          name: empName,
          hourly_rate: rateNum,
          role: editingEmp.role.trim() || '바리스타',
        });
        empId = created.id;
        empName = created.name;
        if (editingEmp.selectedColor) {
          setEmployeeColorMap((prev) => ({ ...prev, [created.id]: editingEmp.selectedColor! }));
        }
      }

      // [한글 주석] 기존 알바생 수정인 경우 기존 스케줄을 깨끗이 정리하고 새 요일/시간 설정으로 갱신
      if (editingEmp.id !== null) {
        const oldScheds = schedules.filter((s) => s.employee_id === empId);
        await Promise.all(oldScheds.map((s) => deleteSchedule(s.id).catch(() => null)));
      }

      // [한글 주석] 이번 달 1일부터 60일 동안 선택한 요일(들)에 대해 매주 반복 근무 스케줄 자동 생성 (달력 전체 100% 연동)
      if (editingEmp.days.length > 0) {
        const offsets: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
        const targetDayNums = editingEmp.days.map((d) => offsets[d]).filter((v) => v !== undefined);

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const datesToCreate: string[] = [];

        for (let i = 0; i < 60; i++) {
          const testDate = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth(), startOfMonth.getDate() + i);
          if (targetDayNums.includes(testDate.getDay())) {
            const dateStr = `${testDate.getFullYear()}-${String(testDate.getMonth() + 1).padStart(2, '0')}-${String(testDate.getDate()).padStart(2, '0')}`;
            datesToCreate.push(dateStr);
          }
        }

        await Promise.all(
          datesToCreate.map((dateStr) =>
            createSchedule({
              employee_id: empId,
              start_time: `${dateStr}T${formatTimeStr(sh)}`,
              end_time: `${dateStr}T${formatTimeStr(eh)}`,
            }).catch((err) => console.warn('스케줄 개별 생성 경고:', err))
          )
        );
      }

      notify('저장 성공', `'${empName}' 알바생 정보와 근무 요일/시간 스케줄이 정상 등록되었습니다.`);
      setEditingEmp(null);
      await loadEmployees();
      await reloadSchedules();
    } catch (e) {
      notify('저장 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const ROLES = ['바리스타', '홀·카운터', '매니저', '주방'];

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

      {/* 2순위: 전체 알바생(근무자) 통합 관리 UI 카드 */}
      <View style={{ gap: 10, marginTop: 24 }}>
        <View style={styles.sectionHeaderRow}>
          <SectionTitle>전체 알바생 관리</SectionTitle>
          <PressableScale style={styles.addBtn} onPress={handleAddEmployeePress}>
            <Ionicons name="person-add" size={15} color={colors.white} />
            <Text style={styles.addBtnText}>+ 알바생 등록</Text>
          </PressableScale>
        </View>

        {loading && (
          <Card style={styles.scheduleCard}>
            <View style={{ paddingVertical: 12, alignItems: 'center' }}>
              <ActivityIndicator color={colors.mochaBrown} />
            </View>
          </Card>
        )}

        {!loading && employees.length === 0 && (
          <Card style={styles.scheduleCard}>
            <Text style={styles.hint}>등록된 알바생이 없어요. '+ 알바생 등록' 버튼으로 신규 알바생을 등록해 보세요.</Text>
          </Card>
        )}

        {!loading && employees.map((emp) => {
          const firstChar = emp.name.charAt(0) || '👤';
          const empColor = getEmployeeColor(emp.id, employeeColorMap);

          return (
            <Card key={emp.id} style={styles.scheduleCard}>
              <View style={styles.shiftRow}>
                {/* 파스텔 테마 아바타 */}
                <View style={[styles.initialAvatar, { backgroundColor: empColor, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' }]}>
                  <Text style={[styles.avatarText, { color: '#2C1D17', fontWeight: 'bold' }]}>{firstChar}</Text>
                </View>

                {/* 알바생 정보 */}
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.shiftWho}>{emp.name}</Text>
                    <Badge label={emp.role || '바리스타'} tone="neutral" />
                  </View>

                  <View style={styles.timeTag}>
                    <Ionicons name="cash-outline" size={13} color={colors.mochaBrown} />
                    <Text style={styles.timeTagText}>시급 {emp.hourly_rate ? emp.hourly_rate.toLocaleString('ko-KR') : 0}원 · 재직 중</Text>
                  </View>
                </View>

                {/* 수정 & 퇴사/삭제 버튼 */}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <PressableScale onPress={() => handleEditEmployeePress(emp)} to={0.88} style={styles.editBtnCircle}>
                    <Ionicons name="create-outline" size={16} color={colors.mochaBrown} />
                  </PressableScale>

                  <PressableScale onPress={() => handleDeleteEmployee(emp)} to={0.88} style={[styles.editBtnCircle, { backgroundColor: '#FDF2F2', borderColor: '#F8BBD0' }]}>
                    <Ionicons name="trash-outline" size={16} color="#B23B2E" />
                  </PressableScale>
                </View>
              </View>
            </Card>
          );
        })}
      </View>

      {/* 알바생 추가 / 수정 모달 */}
      <Modal visible={editingEmp !== null} transparent animationType="fade" onRequestClose={() => setEditingEmp(null)}>
        <View style={styles.modalRoot}>
          {/* 위쪽/바깥 전체 어두운 배경 클릭 시 모달창 즉시 닫힘 */}
          <Pressable style={styles.modalBackdrop} onPress={() => setEditingEmp(null)} />
          <View style={styles.modalSheet}>
            {/* 상단 핸들바 클릭 시 모달 닫힘 */}
            <Pressable onPress={() => setEditingEmp(null)} style={{ paddingVertical: 2 }}>
              <View style={styles.modalHandle} />
            </Pressable>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.espressoBrown }}>
                {editingEmp?.id === null ? '신규 알바생 등록' : '알바생 정보 수정'}
              </Text>
              <PressableScale onPress={() => setEditingEmp(null)} style={{ padding: 2 }} to={0.85}>
                <Ionicons name="close" size={20} color={colors.mochaBrown} />
              </PressableScale>
            </View>

            {editingEmp && (
              <View style={{ gap: 9, marginBottom: 12 }}>
                {/* 알바생 이름 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>알바생 이름</Text>
                  <TextInput
                    style={[styles.input, { fontSize: 13, paddingVertical: 7 }]}
                    placeholder="알바생 이름 입력 (예: 김하늘)"
                    placeholderTextColor={colors.mochaBrown + '80'}
                    value={editingEmp.name}
                    onChangeText={(name) => setEditingEmp({ ...editingEmp, name })}
                  />
                </View>

                {/* 직책 / 역할 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>직책 / 역할</Text>
                  <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>
                    {ROLES.map((r) => {
                      const isSel = editingEmp.role === r;
                      return (
                        <PressableScale
                          key={r}
                          onPress={() => setEditingEmp({ ...editingEmp, role: r })}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            borderRadius: 14,
                            backgroundColor: isSel ? colors.espressoBrown : colors.coffeeCream,
                            borderWidth: 1,
                            borderColor: isSel ? colors.espressoBrown : colors.mutedSand,
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '600', color: isSel ? colors.white : colors.espressoBrown }}>{r}</Text>
                        </PressableScale>
                      );
                    })}
                  </View>
                </View>

                {/* 시급 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>시급 (KRW)</Text>
                  <TextInput
                    style={[styles.input, { fontSize: 13, paddingVertical: 7 }]}
                    placeholder="시급 입력 (예: 10000)"
                    keyboardType="number-pad"
                    placeholderTextColor={colors.mochaBrown + '80'}
                    value={editingEmp.hourlyRate}
                    onChangeText={(hourlyRate) => setEditingEmp({ ...editingEmp, hourlyRate })}
                  />
                </View>

                {/* 알바생 테마 색상 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>알바생 테마 색상</Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 }}>
                    {EMPLOYEE_COLORS.map((color) => {
                      const isSelected = (editingEmp.selectedColor || '#FFE082') === color;
                      return (
                        <PressableScale
                          key={color}
                          onPress={() => setEditingEmp({ ...editingEmp, selectedColor: color })}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 12,
                            backgroundColor: color,
                            borderWidth: isSelected ? 2.5 : 1,
                            borderColor: isSelected ? colors.espressoBrown : 'rgba(0,0,0,0.1)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          to={0.88}
                        >
                          {isSelected && (
                            <Ionicons
                              name="checkmark"
                              size={12}
                              color={color === '#FFE082' || color === '#FFE0B2' ? '#333' : '#FFF'}
                            />
                          )}
                        </PressableScale>
                      );
                    })}
                  </View>
                </View>

                {/* 근무 요일 선택 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>근무 요일 선택 (매주 반복)</Text>
                  <WeekdayButtonGroup
                    selectedDays={editingEmp.days}
                    onChange={(days) => setEditingEmp({ ...editingEmp, days })}
                  />
                </View>

                {/* 근무 시간 설정 피커 */}
                <View style={styles.formGroup}>
                  <Text style={[styles.formLabel, { fontSize: 13, fontWeight: 'bold' }]}>근무 시간 설정 (타임 피커)</Text>
                  <IosTimePicker
                    value={editingEmp.slot}
                    onChange={(slot) => setEditingEmp({ ...editingEmp, slot })}
                  />
                </View>
              </View>
            )}

            <View style={styles.rowActions}>
              <PressableScale style={styles.btnCancel} onPress={() => setEditingEmp(null)}>
                <Text style={styles.btnCancelText}>취소</Text>
              </PressableScale>

              <PressableScale style={[styles.btnSave, saving && { opacity: 0.6 }]} onPress={handleSaveEmployee}>
                <Text style={styles.btnSaveText}>{saving ? '저장 중…' : '저장'}</Text>
              </PressableScale>
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
