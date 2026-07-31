// 근무 달력 · 교대 — "이 날 누가 일하지? 못 나온다는데 누구로 바꾸지?"에 답하는 화면.
//
// 직원 등록에서 받아 둔 '근무 가능 시간'이 여기서 쓰인다:
//   · 날짜를 고르면 그 요일에 가능하다고 한 직원이 먼저 뜬다 (직원 목록을 뒤질 필요 없음)
//   · 가능 시간 밖에 잡힌 근무는 배지로 표시한다 — 막지는 않는다. 급할 땐 부탁해서 넣으니까.
//   · 교대는 근무를 지웠다 다시 만들지 않고 담당자만 바꾼다 (실제 출퇴근 기록이 남아 있다)
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import {
  addShift,
  deleteShift,
  getStaffCalendar,
  updateShift,
  WEEKDAY_LABELS,
  type CalendarDay,
  type Shift,
  type StaffCalendar,
} from '../../lib/api/staff';
import { colors, typography } from '../../theme';

// 달력 헤더는 일요일부터 (사장님이 보는 종이 달력과 같게).
// 서버 요일은 0=월 기준이라, 요일 이름은 응답의 weekday_label을 그대로 쓴다.
const HEADER_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** 직원마다 고정된 파스텔 색 — 달력 점과 목록 아바타가 같은 색이어야 눈으로 이어진다 */
const DOT_COLORS = ['#C9A227', '#7FA98B', '#B07C6B', '#8A9BC4', '#C48A9E', '#8FA6A0', '#C6A38A'];
const colorOf = (id: number) => DOT_COLORS[id % DOT_COLORS.length];

export default function StaffCalendarScreen() {
  const { token } = useAuth();
  const isFocused = useIsFocused();
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState<StaffCalendar | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [busy, setBusy] = useState(false);

  // 근무 추가 / 교대 시트
  const [sheet, setSheet] = useState<null | { mode: 'add' } | { mode: 'swap'; shift: Shift }>(null);
  const [pickEmp, setPickEmp] = useState<number | null>(null);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);

  const month = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setData(await getStaffCalendar(token, month));
      setFailed(null);
    } catch (e) {
      console.error('근무 달력 조회 실패:', e);
      const msg = e instanceof Error ? e.message : String(e);
      setFailed(
        msg.startsWith('404')
          ? '서버에 근무 달력 기능이 아직 없어요 (404). 백엔드를 최신 버전으로 배포하면 바로 보입니다.'
          : `근무 달력을 가져오지 못했어요. (${msg})`,
      );
    }
  }, [token, month]);

  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  const dayMap = useMemo(() => {
    const map: Record<string, CalendarDay> = {};
    (data?.days ?? []).forEach((d) => {
      map[d.date] = d;
    });
    return map;
  }, [data]);

  const day = dayMap[selected];

  // 달력 칸 배열 (앞쪽 빈칸 + 날짜)
  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const mon = cursor.getMonth();
    const first = new Date(year, mon, 1);
    const total = new Date(year, mon + 1, 0).getDate();
    const out: ({ empty: true } | { empty: false; date: string; num: number })[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push({ empty: true });
    for (let n = 1; n <= total; n++) {
      out.push({ empty: false, date: ymd(new Date(year, mon, n)), num: n });
    }
    return out;
  }, [cursor]);

  const moveMonth = (delta: number) => {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
    setCursor(next);
    // 달을 옮기면 그 달 1일을 고른다 — 지난달 날짜가 선택된 채 남으면 아래 패널이 빈다
    setSelected(ymd(next));
  };

  const openAdd = () => {
    // 아직 배정 안 된 '가능한 사람'을 먼저 고른 상태로 연다
    const candidates = day?.available.filter((a) => !a.already_assigned) ?? [];
    const first = candidates[0] ?? day?.available[0];
    setPickEmp(first?.employee_id ?? data?.staff[0]?.id ?? null);
    const w = first?.windows[0];
    setStartHour(w?.start_hour ?? 9);
    setEndHour(w?.end_hour ?? 18);
    setSheet({ mode: 'add' });
  };

  const openSwap = (shift: Shift) => {
    setPickEmp(shift.employee_id);
    setStartHour(Number(shift.start.slice(0, 2)) || 9);
    setEndHour(Number(shift.end.slice(0, 2)) || 18);
    setSheet({ mode: 'swap', shift });
  };

  const submitSheet = async () => {
    if (!token || !sheet || busy) return;
    // 종료가 시작보다 이르면 자정을 넘긴 마감 근무로 저장된다(서버가 다음 날로 본다).
    // 다만 같은 시각이면 0시간이라 저장할 게 없다.
    if (endHour === startHour) {
      toast('시간을 확인해 주세요', '시작과 종료 시각이 같아요.');
      return;
    }
    setBusy(true);
    try {
      if (sheet.mode === 'add') {
        if (!pickEmp) {
          toast('추가 실패', '근무할 직원을 골라 주세요.');
          return;
        }
        const s = await addShift(token, {
          employee_id: pickEmp,
          date: selected,
          start: hhmm(startHour),
          end: hhmm(endHour),
        });
        toast('근무를 넣었어요', `${s.name} · ${s.start}~${s.end}`);
      } else {
        const s = await updateShift(token, sheet.shift.id, {
          employee_id: pickEmp ?? undefined,
          start: hhmm(startHour),
          end: hhmm(endHour),
        });
        const swapped = pickEmp !== sheet.shift.employee_id;
        toast(swapped ? '교대했어요' : '근무를 고쳤어요', `${s.name} · ${s.start}~${s.end}`);
      }
      setSheet(null);
      await load();
    } catch (e) {
      console.error('근무 저장 실패:', e);
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const removeShift = (shift: Shift) =>
    confirmDialog(`${shift.name} 직원의 ${shift.start}~${shift.end} 근무를 지울까요?`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return;
        try {
          await deleteShift(token, shift.id);
          await load();
          toast('삭제했어요', `${shift.date} ${shift.name} 근무를 지웠어요.`);
        } catch (e) {
          toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });

  const staffOptions = useMemo(() => {
    // 그날 가능한 사람이 위로 — 교대 상대를 고를 때 매번 전체 목록을 훑지 않게
    const availIds = new Set((day?.available ?? []).map((a) => a.employee_id));
    return (data?.staff ?? []).slice().sort((a, b) => {
      const av = (availIds.has(b.id) ? 1 : 0) - (availIds.has(a.id) ? 1 : 0);
      return av || a.name.localeCompare(b.name);
    });
  }, [data, day]);

  const availableIds = useMemo(
    () => new Set((day?.available ?? []).map((a) => a.employee_id)),
    [day],
  );

  return (
    <>
      <Screen>
        <ScreenTitle
          title="근무 달력 · 교대"
          subtitle="등록해 둔 근무 가능 시간에 맞춰 배정하고, 못 나오는 날은 교대로 바꿔요"
        />

        <Card>
          <View style={styles.monthRow}>
            <TouchableOpacity activeOpacity={0.7} style={styles.monthBtn} onPress={() => moveMonth(-1)}>
              <Ionicons name="chevron-back" size={16} color={colors.espressoBrown} />
            </TouchableOpacity>
            <Text style={styles.monthLabel}>
              {cursor.getFullYear()}년 {cursor.getMonth() + 1}월
            </Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.monthBtn} onPress={() => moveMonth(1)}>
              <Ionicons name="chevron-forward" size={16} color={colors.espressoBrown} />
            </TouchableOpacity>
          </View>

          <View style={styles.weekHeader}>
            {HEADER_DAYS.map((d, i) => (
              <Text key={d} style={[styles.weekHeaderText, i === 0 && { color: '#B23B2E' }]}>
                {d}
              </Text>
            ))}
          </View>

          <View style={styles.grid}>
            {cells.map((cell, i) => {
              if (cell.empty) return <View key={`e${i}`} style={styles.cell} />;
              const info = dayMap[cell.date];
              const isSel = selected === cell.date;
              const isToday = cell.date === ymd(new Date());
              const shifts = info?.shifts ?? [];
              const canWork = info?.available.length ?? 0;
              return (
                <TouchableOpacity
                  key={cell.date}
                  activeOpacity={0.7}
                  style={[styles.cell, isSel && styles.cellSelected]}
                  onPress={() => setSelected(cell.date)}
                >
                  <Text style={[styles.cellNum, isSel && styles.cellNumSel, isToday && styles.cellToday]}>
                    {cell.num}
                  </Text>
                  <View style={styles.dotRow}>
                    {shifts.slice(0, 3).map((s) => (
                      <View
                        key={s.id}
                        style={[
                          styles.dot,
                          { backgroundColor: colorOf(s.employee_id) },
                          s.fits_availability === false && styles.dotWarn,
                        ]}
                      />
                    ))}
                    {shifts.length > 3 && <Text style={styles.dotMore}>+{shifts.length - 3}</Text>}
                  </View>
                  {shifts.length === 0 && canWork > 0 && (
                    <Text style={[styles.cellHint, isSel && { color: colors.white }]}>{canWork}명 가능</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: colors.mochaBrown }]} />
            <Text style={styles.legendText}>배정된 근무</Text>
            <View style={[styles.dot, styles.dotWarn, { backgroundColor: colors.mochaBrown }]} />
            <Text style={styles.legendText}>가능 시간 밖</Text>
          </View>
        </Card>

        {!data && !failed && (
          <Card>
            <View style={styles.stateWrap}>
              <ActivityIndicator color={colors.mochaBrown} />
              <Text style={styles.stateText}>근무 달력을 불러오는 중…</Text>
            </View>
          </Card>
        )}

        {failed && (
          <Card>
            <Text style={[styles.stateText, { textAlign: 'left' }]}>{failed}</Text>
            <PressableScale style={styles.retryBtn} onPress={load} to={0.97}>
              <Ionicons name="refresh" size={14} color={colors.espressoBrown} />
              <Text style={styles.retryText}>다시 시도</Text>
            </PressableScale>
          </Card>
        )}

        {data && (
          <Card>
            <View style={styles.rowBetween}>
              <Text style={styles.dayTitle}>
                {selected.slice(5).replace('-', '월 ')}일 ({day?.weekday_label ?? ''})
              </Text>
              <PressableScale style={styles.addBtn} onPress={openAdd} to={0.96}>
                <Ionicons name="add" size={14} color={colors.white} />
                <Text style={styles.addBtnText}>근무 추가</Text>
              </PressableScale>
            </View>
            <Text style={styles.daySub}>
              배정 {day?.shifts.length ?? 0}명 · 합계 {day?.hours ?? 0}시간
            </Text>

            {(day?.shifts.length ?? 0) === 0 ? (
              <Text style={styles.stateText}>
                이 날은 아직 근무가 없어요.{' '}
                {(day?.available.length ?? 0) > 0
                  ? '아래 ‘이 날 가능한 직원’에서 골라 바로 넣을 수 있어요.'
                  : '이 요일에 가능하다고 등록한 직원이 없어요.'}
              </Text>
            ) : (
              day!.shifts.map((s) => (
                <View key={s.id} style={styles.shiftRow}>
                  <View style={[styles.avatar, { backgroundColor: colorOf(s.employee_id) }]}>
                    <Text style={styles.avatarText}>{s.name.charAt(0)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.shiftName}>
                      {s.name} <Text style={styles.shiftRole}>· {s.role || '알바'}</Text>
                    </Text>
                    <Text style={styles.shiftTime}>
                      {s.start} ~ {s.end} · {s.hours}시간
                    </Text>
                    {s.fits_availability === false && (
                      <View style={{ marginTop: 4, alignSelf: 'flex-start' }}>
                        <Badge label="가능 시간 밖" tone="orange" />
                      </View>
                    )}
                  </View>
                  <PressableScale style={styles.swapBtn} onPress={() => openSwap(s)} to={0.96}>
                    <Ionicons name="swap-horizontal" size={13} color={colors.espressoBrown} />
                    <Text style={styles.swapText}>교대</Text>
                  </PressableScale>
                  <TouchableOpacity activeOpacity={0.7} style={styles.trashBtn} onPress={() => removeShift(s)}>
                    <Ionicons name="trash-outline" size={16} color="#B23B2E" />
                  </TouchableOpacity>
                </View>
              ))
            )}
          </Card>
        )}

        {data && (day?.available.length ?? 0) > 0 && (
          <Card tone="cream">
            <Text style={styles.cardHead}>이 날 가능한 직원</Text>
            <Text style={styles.daySub}>
              등록해 둔 근무 가능 시간 기준이에요. 눌러서 바로 근무를 넣을 수 있어요.
            </Text>
            {day!.available.map((a) => (
              <TouchableOpacity
                key={a.employee_id}
                activeOpacity={0.7}
                style={styles.availRow}
                onPress={() => {
                  setPickEmp(a.employee_id);
                  setStartHour(a.windows[0]?.start_hour ?? 9);
                  setEndHour(a.windows[0]?.end_hour ?? 18);
                  setSheet({ mode: 'add' });
                }}
              >
                <View style={[styles.avatarSmall, { backgroundColor: colorOf(a.employee_id) }]}>
                  <Text style={styles.avatarText}>{a.name.charAt(0)}</Text>
                </View>
                <Text style={styles.availName}>{a.name}</Text>
                <Text style={styles.availWindow}>
                  {a.windows
                    .map((w) => `${String(w.start_hour).padStart(2, '0')}~${String(w.end_hour).padStart(2, '0')}시`)
                    .join(', ')}
                </Text>
                {a.already_assigned ? (
                  <Badge label="배정됨" tone="green" />
                ) : (
                  <Ionicons name="add-circle-outline" size={18} color={colors.espressoBrown} />
                )}
              </TouchableOpacity>
            ))}
          </Card>
        )}

        {data && data.staff.length > 0 && (
          <Card>
            <Text style={styles.cardHead}>직원별 근무 가능 시간</Text>
            {data.staff.map((s) => (
              <View key={s.id} style={styles.staffRow}>
                <View style={[styles.avatarSmall, { backgroundColor: colorOf(s.id) }]}>
                  <Text style={styles.avatarText}>{s.name.charAt(0)}</Text>
                </View>
                <Text style={styles.availName}>{s.name}</Text>
                <Text
                  style={[
                    styles.availWindow,
                    s.availability.length === 0 && { color: colors.pointOrange },
                  ]}
                >
                  {s.availability_text}
                </Text>
              </View>
            ))}
            <Text style={styles.note}>
              가능 시간은 ‘직원 · 인건비’ 화면에서 직원을 펼치면 고칠 수 있어요.
            </Text>
          </Card>
        )}
      </Screen>

      {/* 근무 추가 · 교대 시트 */}
      <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheet(null)} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>
              {sheet?.mode === 'swap' ? '교대 · 시간 변경' : '근무 추가'}
            </Text>
            <Text style={styles.sheetSub}>
              {selected} ({day?.weekday_label})
              {sheet?.mode === 'swap' ? ` · 현재 ${sheet.shift.name}` : ''}
            </Text>

            <Text style={styles.sheetLabel}>
              {sheet?.mode === 'swap' ? '누구로 바꿀까요?' : '누가 근무하나요?'}
            </Text>
            <View style={styles.pickWrap}>
              {staffOptions.map((s) => {
                const on = pickEmp === s.id;
                const can = availableIds.has(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    activeOpacity={0.7}
                    style={[styles.pick, on && styles.pickOn]}
                    onPress={() => {
                      setPickEmp(s.id);
                      const w = day?.available.find((a) => a.employee_id === s.id)?.windows[0];
                      if (w) {
                        setStartHour(w.start_hour);
                        setEndHour(w.end_hour);
                      }
                    }}
                  >
                    <View style={[styles.pickDot, { backgroundColor: colorOf(s.id) }]} />
                    <Text style={[styles.pickText, on && styles.pickTextOn]}>{s.name}</Text>
                    <Text style={[styles.pickTag, on && { color: 'rgba(255,255,255,0.75)' }]}>
                      {can ? '가능' : s.availability.length === 0 ? '미입력' : '가능 시간 밖'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>근무 시간</Text>
            <View style={styles.hourRow}>
              <SheetStepper label="시작" value={startHour} min={0} max={23} onChange={setStartHour} />
              <SheetStepper label="종료" value={endHour} min={1} max={24} onChange={setEndHour} />
            </View>
            <Text style={styles.sheetNote}>
              {endHour > startHour
                ? `${endHour - startHour}시간 근무`
                : '종료가 시작보다 이르면 다음 날 새벽 마감으로 저장돼요.'}
            </Text>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
              <PressableScale style={[styles.sheetBtn, styles.sheetCancel]} onPress={() => setSheet(null)}>
                <Text style={styles.sheetCancelText}>취소</Text>
              </PressableScale>
              <PressableScale style={[styles.sheetBtn, styles.sheetSubmit]} onPress={submitSheet}>
                <Text style={styles.sheetSubmitText}>
                  {busy ? '저장 중…' : sheet?.mode === 'swap' ? '이 사람으로 바꾸기' : '근무 넣기'}
                </Text>
              </PressableScale>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function SheetStepper({
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
        <Ionicons name="remove" size={15} color={colors.espressoBrown} />
      </TouchableOpacity>
      <View style={{ alignItems: 'center' }}>
        <Text style={styles.stepLabel}>{label}</Text>
        <Text style={styles.stepValue}>{String(value).padStart(2, '0')}:00</Text>
      </View>
      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.stepBtn}
        onPress={() => onChange(Math.min(max, value + 1))}
      >
        <Ionicons name="add" size={15} color={colors.espressoBrown} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.creamSand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: { ...typography.L2, color: colors.espressoBrown },

  weekHeader: { flexDirection: 'row', marginTop: 12, marginBottom: 4 },
  weekHeaderText: { flex: 1, textAlign: 'center', ...typography.L5, color: colors.mochaBrown, fontWeight: '800' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 0.92,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 5,
    borderRadius: 10,
  },
  cellSelected: { backgroundColor: colors.espressoBrown },
  cellNum: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  cellNumSel: { color: colors.white },
  cellToday: { textDecorationLine: 'underline' },
  dotRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 4, minHeight: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotWarn: { borderWidth: 1.5, borderColor: colors.pointOrange, width: 8, height: 8, borderRadius: 4 },
  dotMore: { fontSize: 8, color: colors.mochaBrown, marginLeft: 1 },
  cellHint: { fontSize: 8, color: colors.mochaBrown, marginTop: 2 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 },
  legendText: { fontSize: 10, color: colors.mochaBrown, marginRight: 8 },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardHead: { ...typography.L3, color: colors.espressoBrown },
  dayTitle: { ...typography.L2, color: colors.espressoBrown },
  daySub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, marginBottom: 8, lineHeight: 15 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  addBtnText: { ...typography.L5, color: colors.white, fontWeight: '800' },

  shiftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarSmall: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '900', color: '#2C1D17' },
  shiftName: { ...typography.L4, color: colors.espressoBrown },
  shiftRole: { ...typography.L5, color: colors.mochaBrown },
  shiftTime: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  swapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.white,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  swapText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  trashBtn: { padding: 6 },

  availRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  staffRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  availName: { ...typography.L4, color: colors.espressoBrown, minWidth: 58 },
  availWindow: { ...typography.L5, color: colors.mochaBrown, flex: 1 },
  note: { ...typography.L5, color: colors.mochaBrown, marginTop: 10, lineHeight: 15, opacity: 0.9 },

  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },
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

  modalRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.black40, width: '100%', maxWidth: 420, alignSelf: 'center' },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 18,
    paddingBottom: 28,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.mutedSand, marginBottom: 14 },
  sheetTitle: { ...typography.L1, color: colors.espressoBrown },
  sheetSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, marginBottom: 12 },
  sheetLabel: { ...typography.L4, color: colors.espressoBrown, marginTop: 8, marginBottom: 6 },
  pickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  pickOn: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  pickDot: { width: 7, height: 7, borderRadius: 4 },
  pickText: { fontSize: 11.5, fontWeight: '800', color: colors.espressoBrown },
  pickTextOn: { color: colors.white },
  pickTag: { fontSize: 9.5, color: colors.mochaBrown },

  hourRow: { flexDirection: 'row', gap: 10 },
  stepper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 6,
  },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.creamSand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { fontSize: 9.5, color: colors.mochaBrown },
  stepValue: { ...typography.L3, color: colors.espressoBrown },
  sheetNote: { ...typography.L5, color: colors.mochaBrown, marginTop: 8 },
  sheetBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  sheetCancel: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.mutedSand },
  sheetCancelText: { ...typography.L4, color: colors.espressoBrown },
  sheetSubmit: { backgroundColor: colors.pointOrange },
  sheetSubmitText: { ...typography.L4, color: colors.white },
});
