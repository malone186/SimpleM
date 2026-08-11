// 근무 체크리스트 — 매일 반복되는 오픈·마감·위생 루틴. 직원·사장이 같은 목록을 본다.
//
// 사장님 '할 일'과 다른 화면인 이유: 할 일은 일회성 경영 업무(발주·세무·급여)라 대부분
// 알바가 할 수 없다. 여기 담기는 건 매일 반복되는 근무 루틴이고, 날짜로 관리돼 다음 날
// 자동 초기화된다. 직원은 체크·추가(근무 중 발견한 할 일을 그 자리에서 올린다),
// 사장님은 수정·삭제까지 한다(같은 화면, isOwner로 분기 — 루틴 원본 관리는 사장님 몫).
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import {
  addChecklistItem, deleteChecklistItem, listChecklist, toggleChecklist, updateChecklistItem,
  type ChecklistItem,
} from '../../lib/api/checklist';
import { fetchStaffAccounts, type StaffAccount } from '../../lib/api/staffAccounts';
import { colors } from '../../theme';
import { s, useBottomInset } from '../../theme/responsive';

export default function ChecklistScreen() {
  const { token, user } = useAuth();
  const isOwner = !user?.isStaff;
  const bottomInset = useBottomInset();
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  // 사장님 전용 — 항목 편집(추가/이름수정) 모달
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ChecklistItem | null>(null); // null이면 새 항목
  const [labelText, setLabelText] = useState('');
  const [saving, setSaving] = useState(false);
  // 사장님 전용 — 새 항목의 담당 직원 지정 (null = 공용 루틴)
  const [staffList, setStaffList] = useState<StaffAccount[]>([]);
  const [assigneeId, setAssigneeId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setItems(await listChecklist(token));
    } catch (e) {
      toast('불러오기 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // 담당 지정용 직원 목록 — 사장님만 조회 권한이 있다. 실패해도 화면은 그대로 쓴다
  // (지정 칩만 안 보일 뿐, 공용 항목 추가는 된다).
  useEffect(() => {
    if (!token || !isOwner) return;
    fetchStaffAccounts(token)
      .then((rows) => setStaffList(rows.filter((r) => r.is_active)))
      .catch(() => {});
  }, [token, isOwner]);

  const toggle = async (it: ChecklistItem) => {
    if (!token || busyId) return;
    setBusyId(it.id);
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    try {
      const r = await toggleChecklist(token, it.id);
      setItems((prev) => prev.map((x) =>
        (x.id === it.id ? { ...x, done: r.done, done_by: r.done_by ?? null } : x)));
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: it.done } : x)));
      toast('처리 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyId(null);
    }
  };

  const openAdd = () => { setEditTarget(null); setLabelText(''); setAssigneeId(null); setEditOpen(true); };
  const openRename = (it: ChecklistItem) => { setEditTarget(it); setLabelText(it.label); setEditOpen(true); };

  const saveItem = async () => {
    const label = labelText.trim();
    if (!token || !label || saving) return;
    setSaving(true);
    try {
      if (editTarget) {
        const up = await updateChecklistItem(token, editTarget.id, { label });
        setItems((prev) => prev.map((x) => (x.id === up.id ? { ...x, label: up.label } : x)));
      } else {
        const created = await addChecklistItem(token, label, isOwner ? assigneeId : null);
        setItems((prev) => [...prev, created]);
      }
      setEditOpen(false);
    } catch (e) {
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (it: ChecklistItem) => {
    if (!token || busyId) return;
    setBusyId(it.id);
    const prev = items;
    setItems((cur) => cur.filter((x) => x.id !== it.id));
    try {
      await deleteChecklistItem(token, it.id);
    } catch (e) {
      setItems(prev);
      toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyId(null);
    }
  };

  const doneCount = items.filter((i) => i.done).length;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + s(90) }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }}
                          tintColor={colors.mochaBrown} />
        }
      >
        {items.length > 0 && (
          <View style={styles.summary}>
            <Text style={styles.summaryText}>
              오늘 <Text style={styles.summaryStrong}>{doneCount}</Text> / {items.length} 완료
            </Text>
            <Text style={styles.summaryHint}>매일 자정에 새로 시작돼요</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.pointOrange} style={{ marginTop: 40 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-outline" size={30} color={colors.mochaBrown} />
            <Text style={styles.emptyText}>
              {isOwner
                ? '오픈·마감·위생 루틴을 등록해 두면\n직원이 매일 체크할 수 있어요.'
                : '아직 등록된 체크리스트가 없어요.\n아래 추가 버튼으로 직접 올릴 수도 있어요.'}
            </Text>
          </View>
        ) : (
          items.map((it) => (
            <View key={it.id} style={[styles.row, it.done && styles.rowDone]}>
              {/* 줄 전체를 눌러 체크한다 — 계산대에서 작은 동그라미만 노리게 하면 불편하다.
                  편집·삭제(사장님)는 이 영역 바깥의 별도 버튼이라 토글과 겹치지 않는다. */}
              <Pressable onPress={() => toggle(it)} disabled={busyId === it.id}
                         style={styles.rowMain}>
                <Ionicons name={it.done ? 'checkmark-circle' : 'ellipse-outline'} size={26}
                          color={it.done ? '#3E9B4F' : colors.mochaBrown} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.label, it.done && styles.labelDone]}>{it.label}</Text>
                  {(!!it.assigned_staff_name || it.one_off) && (
                    <Text style={styles.assignee}>
                      {/* 일회성 = 사장님 할 일에서 넘어온 것 — 루틴과 달리 완료하면 사라진다는 걸 알린다 */}
                      {[it.assigned_staff_name && `담당 · ${it.assigned_staff_name}`, it.one_off && '오늘만']
                        .filter(Boolean)
                        .join('  ·  ')}
                    </Text>
                  )}
                  {it.done && !!it.done_by && (
                    <Text style={styles.doneBy}>✓ {it.done_by}</Text>
                  )}
                </View>
              </Pressable>
              {isOwner && (
                <View style={styles.manage}>
                  <Pressable onPress={() => openRename(it)} hitSlop={6} style={styles.iconBtn}>
                    <Ionicons name="pencil-outline" size={16} color={colors.mochaBrown} />
                  </Pressable>
                  <Pressable onPress={() => removeItem(it)} hitSlop={6} style={styles.iconBtn}>
                    <Ionicons name="trash-outline" size={16} color="#B0A79E" />
                  </Pressable>
                </View>
              )}
            </View>
          ))
        )}
      </ScrollView>

      {/* 추가는 직원에게도 열려 있다 — 근무 중 발견한 할 일을 그 자리에서 올리게.
          수정·삭제는 위 목록의 사장님 전용 버튼(isOwner) 그대로다. */}
      <PressableScale style={[styles.fab, { bottom: bottomInset + s(16) }]} onPress={openAdd} to={0.94}>
        <Ionicons name="add" size={20} color={colors.white} />
        <Text style={styles.fabText}>항목 추가</Text>
      </PressableScale>

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editTarget ? '항목 수정' : '체크리스트 항목 추가'}</Text>
            <TextInput
              style={styles.input}
              placeholder="예: 마감 · 기계 청소, 오픈 · 머신 예열"
              placeholderTextColor="#B0A79E"
              value={labelText}
              onChangeText={setLabelText}
              autoFocus
              onSubmitEditing={saveItem}
              returnKeyType="done"
            />
            {/* 담당 지정 — 사장님이 새 항목을 만들 때만. 기본은 공용(전체) 루틴이고,
                직원 칩을 고르면 그 직원 기기로 푸시가 간다. */}
            {isOwner && !editTarget && staffList.length > 0 && (
              <View style={styles.assignWrap}>
                <Text style={styles.assignLabel}>담당 지정</Text>
                <View style={styles.assignChips}>
                  <Pressable
                    style={[styles.chip, assigneeId === null && styles.chipOn]}
                    onPress={() => setAssigneeId(null)}
                  >
                    <Text style={[styles.chipText, assigneeId === null && styles.chipTextOn]}>공용</Text>
                  </Pressable>
                  {staffList.map((st) => (
                    <Pressable
                      key={st.id}
                      style={[styles.chip, assigneeId === st.id && styles.chipOn]}
                      onPress={() => setAssigneeId(assigneeId === st.id ? null : st.id)}
                    >
                      <Text style={[styles.chipText, assigneeId === st.id && styles.chipTextOn]}>{st.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable style={[styles.modalBtn, styles.cancelBtn]} onPress={() => setEditOpen(false)}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.saveBtn, (!labelText.trim() || saving) && { opacity: 0.5 }]}
                         onPress={saveItem} disabled={!labelText.trim() || saving}>
                <Text style={styles.saveText}>{editTarget ? '저장' : '추가'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  summary: { marginBottom: 14 },
  summaryText: { fontSize: 15, color: colors.espressoBrown, fontWeight: '600' },
  summaryStrong: { color: '#3E9B4F', fontWeight: '800' },
  summaryHint: { fontSize: 12, color: colors.mochaBrown, marginTop: 3 },
  empty: { alignItems: 'center', gap: 12, marginTop: 60 },
  emptyText: { fontSize: 13, color: colors.mochaBrown, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.white, borderRadius: 14, padding: 15, marginBottom: 8,
    borderWidth: 1, borderColor: colors.mutedSand,
  },
  rowDone: { backgroundColor: 'rgba(62,155,79,0.06)', borderColor: 'rgba(62,155,79,0.18)' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 15.5, fontWeight: '600', color: colors.espressoBrown },
  labelDone: { color: '#6E8A72' },
  assignee: { fontSize: 12, color: colors.pointOrange, marginTop: 3, fontWeight: '700' },
  doneBy: { fontSize: 12, color: '#3E9B4F', marginTop: 3, fontWeight: '600' },
  assignWrap: { gap: 8 },
  assignLabel: { fontSize: 12.5, color: colors.mochaBrown, fontWeight: '700' },
  assignChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
    backgroundColor: '#F2EFEC', borderWidth: 1, borderColor: 'transparent',
  },
  chipOn: { backgroundColor: 'rgba(224,122,58,0.12)', borderColor: colors.pointOrange },
  chipText: { fontSize: 13, color: '#7A6E65', fontWeight: '600' },
  chipTextOn: { color: colors.pointOrange, fontWeight: '700' },
  manage: { flexDirection: 'row', gap: 4 },
  iconBtn: { padding: 4 },
  fab: {
    position: 'absolute', right: 16, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.espressoBrown, paddingHorizontal: 18, paddingVertical: 13, borderRadius: 26,
    shadowColor: '#4E3629', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 10, elevation: 6,
  },
  fabText: { color: colors.white, fontSize: 14, fontWeight: '700' },
  modalBg: { flex: 1, backgroundColor: 'rgba(30,22,18,0.4)', justifyContent: 'center', padding: 28 },
  // 웹(넓은 창)에서 화면 폭만큼 늘어나지 않게 모바일 크기로 고정 — 다른 모달들과 같은 관례(340~360)
  modalCard: {
    backgroundColor: colors.white, borderRadius: 18, padding: 20, gap: 14,
    width: '100%', maxWidth: 360, alignSelf: 'center',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.espressoBrown },
  input: {
    borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.espressoBrown,
  },
  modalBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  cancelBtn: { backgroundColor: '#F2EFEC' },
  cancelText: { color: '#7A6E65', fontSize: 14, fontWeight: '600' },
  saveBtn: { backgroundColor: colors.espressoBrown },
  saveText: { color: colors.white, fontSize: 14, fontWeight: '700' },
});
