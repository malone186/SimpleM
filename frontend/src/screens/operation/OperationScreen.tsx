// 운영 (프론트 B) — PRD ERP-9(스케줄·급여·정산), ERP-10(세금), AI-4(스케줄 추천)
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle, DayOfWeekPicker, IosTimePicker } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';

const notify = (title: string, message: string) => toast(title, message);

const STAFF = [
  { name: '김바리', role: '바리스타', hours: 32, wage: 11000 },
  { name: '이알바', role: '홀', hours: 20, wage: 10030 },
  { name: '박주말', role: '주말', hours: 16, wage: 10500 },
];

const INITIAL_SHIFTS = [
  { day: '월, 수, 금', slot: '09–15', who: '김바리', peak: false },
  { day: '화, 목', slot: '09–15', who: '김바리', peak: false },
  { day: '금', slot: '13–21', who: '이알바', peak: true },
  { day: '토, 일', slot: '11–20', who: '박주말', peak: true },
];

export default function OperationScreen() {
  return (
    <Screen>
      {/* [한글 주석] 세금 기능이 서류 자동화 탭으로 통합됨에 따라, 본 화면은 스케줄·급여 전용 화면으로 간소화합니다. */}
      <ScreenTitle title="스케줄·급여" subtitle="알바 스케줄과 급여 정산을 한 곳에서" />
      <ScheduleTab />
    </Screen>
  );
}

function ScheduleTab() {
  const [shifts, setShifts] = useState(INITIAL_SHIFTS);
  const [editingShift, setEditingShift] = useState<{
    index: number;
    day: string;
    slot: string;
    who: string;
    peak: boolean;
  } | null>(null);

  // [한글 주석] 스케줄 편집 버튼 클릭 시 모달창 상태를 초기화합니다.
  const handleEditPress = (index: number) => {
    const s = shifts[index];
    setEditingShift({ index, ...s });
  };

  // [한글 주석] 추가 버튼 누를 때 신규 가상 스케줄 인덱스(-1)와 디폴트 시간(09–18)으로 모달을 오픈합니다.
  const handleAddPress = () => {
    setEditingShift({ index: -1, day: '', slot: '09–18', who: '', peak: false });
  };

  // [한글 주석] 선택된 특정 근무자 스케줄을 삭제 처리하는 기능
  const handleDelete = (index: number) => {
    const targetName = shifts[index]?.who || '근무자';
    if (Platform.OS === 'web') {
      const confirmDelete = window.confirm(`정말 ${targetName}님의 근무 스케줄을 삭제하시겠습니까?`);
      if (!confirmDelete) return;
    }
    const updated = shifts.filter((_, i) => i !== index);
    setShifts(updated);
    setEditingShift(null); // 모달이 켜져있다면 닫아줍니다.
  };

  // [한글 주석] 모달에서 수정한 데이터를 확정하여 리스트 및 급여 항목에 연동합니다.
  const handleSave = () => {
    if (!editingShift) return;
    const { index, day, slot, who, peak } = editingShift;

    if (!day.trim() || !slot.trim() || !who.trim()) {
      if (Platform.OS === 'web') {
        window.alert('요일, 근무자명, 시간을 모두 올바르게 입력해 주세요!');
      }
      return;
    }

    if (index === -1) {
      setShifts([...shifts, { day, slot, who, peak }]);
    } else {
      const updated = shifts.map((s, i) =>
        i === index ? { day, slot, who, peak } : s
      );
      setShifts(updated);
    }
    setEditingShift(null);
  };

  return (
    <>
      {/* AI 스케줄 추천 (AI-4) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>AI 스케줄 추천</SectionTitle>
          <Badge label="초안" tone="orange" />
        </View>
        <Text style={styles.hint}>
          금·토 14–15시가 피크예요. 주말 오후에 1명 추가 배치를 추천해요.
        </Text>
        <View style={styles.actions}>
          <Button
            label="추천 반영"
            style={{ flex: 1 }}
            onPress={() => notify('스케줄 반영', '주말 오후 1명 추가 배치를 이번 주 스케줄 초안에 반영했어요.')}
          />
          <Button
            label="나중에"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => notify('보류', '이 추천은 다음에 다시 알려드릴게요.')}
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
        {shifts.map((s, i) => {
          const firstChar = s.who ? s.who.charAt(0) : '👤';
          const dayLabel = s.day.includes('요일') || s.day.includes('주말') ? s.day : `${s.day}요일`;

          return (
            <Card key={i} style={styles.scheduleCard}>
              <View style={styles.shiftRow}>
                {/* [한글 주석] 이니셜 타이포그래피 아바타 적용으로 고급화 */}
                <View style={styles.initialAvatar}>
                  <Text style={styles.avatarText}>{firstChar}</Text>
                </View>
                
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.shiftWho}>{s.who}</Text>
                    {s.peak && <Badge label="피크" tone="green" />}
                  </View>
                  
                  {/* [한글 주석] 촌스러운 요일 배지를 제거하고, 미니멀한 타임라인 태그로 디자인 통합 */}
                  <View style={styles.timeTag}>
                    <Ionicons name="time-outline" size={13} color={colors.mochaBrown} />
                    <Text style={styles.timeTagText}>{dayLabel} · {s.slot}</Text>
                  </View>
                </View>

                {/* [한글 주석] 터치 영역 확대 및 조형 대칭을 위해 둥근 링으로 감싼 수정 버튼 */}
                <PressableScale onPress={() => handleEditPress(i)} to={0.88} style={styles.editBtnCircle}>
                  <Ionicons name="create-outline" size={16} color={colors.mochaBrown} />
                </PressableScale>
              </View>
            </Card>
          );
        })}
      </View>

      {/* [한글 주석] 스케줄 목록과 급여 요약 박스가 서로 충돌하지 않도록 상단 마진(marginTop: 24) 반영 */}
      <Card style={{ marginTop: 24 }}>
        <SectionTitle>이번 달 급여</SectionTitle>
        <View style={{ marginTop: 12, gap: 10 }}>
          {STAFF.map((p) => {
            // [한글 주석] 스케줄 상태에서 해당 직원이 근무하는 스케줄을 카운트해 근무 시간을 유동적으로 반영
            const staffShifts = shifts.filter((s) => s.who === p.name);
            const calculatedHours = staffShifts.length > 0 ? staffShifts.length * 6 : p.hours; // 1일 6시간 기준
            
            return (
              <View key={p.name} style={styles.payRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.payName}>{p.name}</Text>
                  <Text style={styles.paySub}>{p.role} · {calculatedHours}h · ₩{p.wage.toLocaleString()}/h</Text>
                </View>
                <Text style={styles.payAmount}>₩{(calculatedHours * p.wage * 4).toLocaleString()}</Text>
              </View>
            );
          })}
          <Divider />
          <View style={styles.payRow}>
            <Text style={styles.payTotalLabel}>합계 (예상)</Text>
            <Text style={styles.payTotal}>
              ₩{STAFF.reduce((s, p) => {
                const staffShifts = shifts.filter((sh) => sh.who === p.name);
                const calculatedHours = staffShifts.length > 0 ? staffShifts.length * 6 : p.hours;
                return s + calculatedHours * p.wage * 4;
              }, 0).toLocaleString()}
            </Text>
          </View>
        </View>
      </Card>

      {/* [한글 주석] 요일, 근무자명, 시간을 입력받는 스케줄 수정/등록 모달 */}
      <Modal visible={editingShift !== null} transparent animationType="slide" onRequestClose={() => setEditingShift(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setEditingShift(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>
              {editingShift?.index === -1 ? '근무 스케줄 추가' : '근무 스케줄 수정'}
            </Text>

            {editingShift && (
              <View style={{ gap: 14, marginBottom: 20 }}>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>근무자 이름</Text>
                  <TextInput
                    style={styles.input}
                    value={editingShift.who}
                    onChangeText={(text) => setEditingShift({ ...editingShift, who: text })}
                    placeholder="예: 김바리"
                    placeholderTextColor={colors.mochaBrown + '80'}
                  />
                </View>

                {/* [한글 주석] 요일 칩 선택기: 직접 타이핑하지 않고 탭하여 다중 선택 */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>요일 선택</Text>
                  <DayOfWeekPicker
                    selectedDays={editingShift.day ? editingShift.day.split(',').map((d) => d.trim()).filter(Boolean) : []}
                    onChange={(days) => setEditingShift({ ...editingShift, day: days.join(', ') })}
                  />
                </View>

                {/* [한글 주석] iOS 스타일 휠 시간 선택기: 스크롤 드래그를 통해 스무스하게 작동 */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>근무 시간 설정</Text>
                  <IosTimePicker
                    value={editingShift.slot}
                    onChange={(slot) => setEditingShift({ ...editingShift, slot })}
                  />
                </View>

                {/* [한글 주석: 근무 시간대 설정 2분할 세그먼트]
                    일반과 피크를 50%씩 양분하여 나란히 노출해 조작감을 대폭 높였습니다. */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>근무 시간대 종류</Text>
                  <View style={styles.peakSegmentContainer}>
                    <PressableScale
                      style={[
                        styles.peakSegmentBtn,
                        !editingShift.peak && styles.segmentBtnActiveNormal,
                      ]}
                      onPress={() => setEditingShift({ ...editingShift, peak: false })}
                      to={0.94} // 누를 때 텐션 있는 입체 반응
                    >
                      <Text
                        style={[
                          styles.peakSegmentText,
                          !editingShift.peak && styles.segmentTextActiveNormal,
                        ]}
                      >
                        일반 시간대
                      </Text>
                    </PressableScale>

                    <PressableScale
                      style={[
                        styles.peakSegmentBtn,
                        editingShift.peak && styles.segmentBtnActivePeak,
                      ]}
                      onPress={() => setEditingShift({ ...editingShift, peak: true })}
                      to={0.94}
                    >
                      <Text
                        style={[
                          styles.peakSegmentText,
                          editingShift.peak && styles.segmentTextActivePeak,
                        ]}
                      >
                        🔥 피크 시간대
                      </Text>
                    </PressableScale>
                  </View>
                </View>
              </View>
            )}

            <View style={styles.rowActions}>
              <PressableScale style={styles.btnCancel} onPress={() => setEditingShift(null)}>
                <Text style={styles.btnCancelText}>취소</Text>
              </PressableScale>

              <PressableScale style={styles.btnSave} onPress={handleSave}>
                <Text style={styles.btnSaveText}>저장</Text>
              </PressableScale>

              {/* [한글 주석] 기존 스케줄 수정 시에만 삭제 버튼을 맨 오른쪽 구석에 노출 */}
              {editingShift?.index !== -1 && (
                <PressableScale style={styles.btnDelete} onPress={() => editingShift && handleDelete(editingShift.index)}>
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
