// [한글 주석: 원두 메모장 컴포넌트]
// 사장님이 현재 사용 중인 원두와 이전에 써본/발주해본 원두를 기록하는 UI입니다.
// AsyncStorage에 로컬 저장되므로 백엔드 없이도 동작합니다.
import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows, typography } from '../../theme';

// ─── 타입 정의 ───────────────────────────────────────────────────────────
type NoteStatus = 'trying' | 'ordered' | 'tried';

interface BeanNote {
  id: string;
  name: string;         // 원두 이름
  rating: number;       // 별점 (1~5)
  memo: string;         // 간단 메모
  date: string;         // 날짜 (YYYY-MM-DD)
  status: NoteStatus;   // trying: 현재 사용 중 | ordered: 발주해봄 | tried: 써봄
}

interface NotepadData {
  currentCaffeine: string;   // 현재 사용 카페인 원두명
  currentDecaf: string;      // 현재 사용 디카페인 원두명
  notes: BeanNote[];         // 체험 노트 목록
}

const STORAGE_KEY = 'simplem:bean_notepad';

const STATUS_LABEL: Record<NoteStatus, { label: string; color: string; bg: string }> = {
  trying:  { label: '현재 사용 중', color: '#4E7D3A', bg: 'rgba(78,125,58,0.12)' },
  ordered: { label: '발주해봄',     color: '#3C64B4', bg: 'rgba(60,100,180,0.12)' },
  tried:   { label: '써봄',         color: '#8C6F56', bg: 'rgba(140,111,86,0.12)' },
};

const today = () => new Date().toISOString().split('T')[0];

// ─── 별점 렌더링 ────────────────────────────────────────────────────────
function Stars({
  rating, size = 14, onPress,
}: { rating: number; size?: number; onPress?: (n: number) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity
          key={n}
          onPress={() => onPress?.(n)}
          disabled={!onPress}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
        >
          <Ionicons
            name={n <= rating ? 'star' : 'star-outline'}
            size={size}
            color={n <= rating ? '#E07050' : colors.stone300}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── 메인 컴포넌트 ───────────────────────────────────────────────────────
export default function BeanNotepad() {
  const [data, setData] = useState<NotepadData>({
    currentCaffeine: '',
    currentDecaf: '',
    notes: [],
  });

  // 모달 상태
  const [showCurrentEdit, setShowCurrentEdit] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [editingNote, setEditingNote] = useState<BeanNote | null>(null);

  // 현재 사용 원두 편집 임시값
  const [tempCaffeine, setTempCaffeine] = useState('');
  const [tempDecaf, setTempDecaf] = useState('');

  // 노트 편집 임시값
  const [tempName, setTempName] = useState('');
  const [tempRating, setTempRating] = useState(3);
  const [tempMemo, setTempMemo] = useState('');
  const [tempStatus, setTempStatus] = useState<NoteStatus>('tried');

  // AsyncStorage에서 불러오기
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try { setData(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  // AsyncStorage에 저장하는 헬퍼
  const save = (next: NotepadData) => {
    setData(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  // ── 현재 사용 원두 저장 ──
  const saveCurrentBeans = () => {
    save({ ...data, currentCaffeine: tempCaffeine.trim(), currentDecaf: tempDecaf.trim() });
    setShowCurrentEdit(false);
  };

  const openCurrentEdit = () => {
    setTempCaffeine(data.currentCaffeine);
    setTempDecaf(data.currentDecaf);
    setShowCurrentEdit(true);
  };

  // ── 노트 추가/수정 ──
  const openAddNote = () => {
    setEditingNote(null);
    setTempName(''); setTempRating(3); setTempMemo(''); setTempStatus('tried');
    setShowNoteModal(true);
  };

  const openEditNote = (note: BeanNote) => {
    setEditingNote(note);
    setTempName(note.name); setTempRating(note.rating);
    setTempMemo(note.memo); setTempStatus(note.status);
    setShowNoteModal(true);
  };

  const saveNote = () => {
    if (!tempName.trim()) return;
    if (editingNote) {
      // 수정
      const updated = data.notes.map((n) =>
        n.id === editingNote.id
          ? { ...n, name: tempName.trim(), rating: tempRating, memo: tempMemo.trim(), status: tempStatus }
          : n
      );
      save({ ...data, notes: updated });
    } else {
      // 추가
      const newNote: BeanNote = {
        id: Date.now().toString(),
        name: tempName.trim(),
        rating: tempRating,
        memo: tempMemo.trim(),
        date: today(),
        status: tempStatus,
      };
      save({ ...data, notes: [newNote, ...data.notes] });
    }
    setShowNoteModal(false);
  };

  const deleteNote = (id: string) => {
    Alert.alert('삭제', '이 노트를 삭제할까요?', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제', style: 'destructive',
        onPress: () => save({ ...data, notes: data.notes.filter((n) => n.id !== id) }),
      },
    ]);
  };

  // ─── 렌더링 ────────────────────────────────────────────────────────────
  return (
    <View style={styles.wrapper}>

      {/* ━━━ 현재 사용 원두 카드 ━━━ */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardEmoji}>☕</Text>
            <Text style={styles.cardTitle}>현재 사용 중인 원두</Text>
          </View>
          <TouchableOpacity style={styles.editBtn} onPress={openCurrentEdit}>
            <Ionicons name="pencil-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.editBtnText}>수정</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.currentRow}>
          <View style={styles.currentLabel}>
            <Ionicons name="cafe" size={14} color={colors.espressoBrown} />
            <Text style={styles.currentLabelText}>카페인</Text>
          </View>
          <Text style={[styles.currentValue, !data.currentCaffeine && styles.currentEmpty]}>
            {data.currentCaffeine || '아직 입력하지 않았어요'}
          </Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.currentRow}>
          <View style={styles.currentLabel}>
            <Ionicons name="cafe-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.currentLabelText}>디카페인</Text>
          </View>
          <Text style={[styles.currentValue, !data.currentDecaf && styles.currentEmpty]}>
            {data.currentDecaf || '아직 입력하지 않았어요'}
          </Text>
        </View>
      </View>

      {/* ━━━ 원두 체험 노트 카드 ━━━ */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardEmoji}>📝</Text>
            <Text style={styles.cardTitle}>원두 체험 노트</Text>
          </View>
          <TouchableOpacity style={styles.addBtn} onPress={openAddNote}>
            <Ionicons name="add" size={15} color={colors.white} />
            <Text style={styles.addBtnText}>추가</Text>
          </TouchableOpacity>
        </View>

        {data.notes.length === 0 ? (
          <View style={styles.emptyNote}>
            <Ionicons name="document-text-outline" size={28} color={colors.stone300} />
            <Text style={styles.emptyNoteText}>
              발주해본 원두나 써본 원두를 기록해 보세요
            </Text>
          </View>
        ) : (
          <View style={styles.noteList}>
            {data.notes.map((note) => {
              const st = STATUS_LABEL[note.status];
              return (
                <View key={note.id} style={styles.noteItem}>
                  {/* 왼쪽 상태 바 */}
                  <View style={[styles.noteBar, { backgroundColor: st.color }]} />

                  <View style={styles.noteContent}>
                    {/* 상단 줄: 원두명 + 상태 배지 + 버튼 */}
                    <View style={styles.noteTopRow}>
                      <Text style={styles.noteName} numberOfLines={1}>{note.name}</Text>
                      <View style={[styles.statusBadge, { backgroundColor: st.bg }]}>
                        <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => openEditNote(note)}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Ionicons name="create-outline" size={14} color={colors.mochaBrown} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => deleteNote(note.id)}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Ionicons name="trash-outline" size={14} color="#C07070" />
                      </TouchableOpacity>
                    </View>

                    {/* 별점 + 날짜 */}
                    <View style={styles.noteMetaRow}>
                      <Stars rating={note.rating} size={12} />
                      <Text style={styles.noteDate}>{note.date}</Text>
                    </View>

                    {/* 메모 */}
                    {note.memo ? (
                      <Text style={styles.noteMemo}>"{note.memo}"</Text>
                    ) : (
                      <Text style={styles.noteMemoEmpty}>메모 없음</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* ━━━ 현재 사용 원두 편집 모달 ━━━ */}
      <Modal visible={showCurrentEdit} transparent animationType="slide" onRequestClose={() => setShowCurrentEdit(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowCurrentEdit(false)} />
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>현재 사용 중인 원두 수정</Text>

            <Text style={modalStyles.label}>☕ 카페인 원두</Text>
            <TextInput
              style={modalStyles.input}
              value={tempCaffeine}
              onChangeText={setTempCaffeine}
              placeholder="예: 에티오피아 구지 내추럴"
              placeholderTextColor={colors.stone300}
            />

            <Text style={[modalStyles.label, { marginTop: 14 }]}>🍃 디카페인 원두</Text>
            <TextInput
              style={modalStyles.input}
              value={tempDecaf}
              onChangeText={setTempDecaf}
              placeholder="예: 콜롬비아 워시드 디카페인"
              placeholderTextColor={colors.stone300}
            />

            <TouchableOpacity
              style={[modalStyles.saveBtn, !tempCaffeine.trim() && !tempDecaf.trim() && { opacity: 0.5 }]}
              onPress={saveCurrentBeans}
            >
              <Text style={modalStyles.saveBtnText}>저장하기</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ━━━ 원두 노트 추가/수정 모달 ━━━ */}
      <Modal visible={showNoteModal} transparent animationType="slide" onRequestClose={() => setShowNoteModal(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowNoteModal(false)} />
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>{editingNote ? '노트 수정' : '원두 노트 추가'}</Text>

            <Text style={modalStyles.label}>원두 이름 *</Text>
            <TextInput
              style={modalStyles.input}
              value={tempName}
              onChangeText={setTempName}
              placeholder="예: 타팟 에티오피아 구지"
              placeholderTextColor={colors.stone300}
            />

            {/* 구분 상태 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>구분</Text>
            <View style={modalStyles.statusRow}>
              {(Object.keys(STATUS_LABEL) as NoteStatus[]).map((key) => {
                const st = STATUS_LABEL[key];
                const active = tempStatus === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      modalStyles.statusChip,
                      active && { backgroundColor: st.bg, borderColor: st.color },
                    ]}
                    onPress={() => setTempStatus(key)}
                  >
                    <Text style={[modalStyles.statusChipText, active && { color: st.color, fontWeight: '800' }]}>
                      {st.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 별점 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>별점</Text>
            <Stars rating={tempRating} size={22} onPress={setTempRating} />

            {/* 메모 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>간단 메모</Text>
            <TextInput
              style={[modalStyles.input, modalStyles.inputMulti]}
              value={tempMemo}
              onChangeText={setTempMemo}
              placeholder="산미가 강하고 꽃향이 남. 재발주 예정 등..."
              placeholderTextColor={colors.stone300}
              multiline
              numberOfLines={3}
            />

            <TouchableOpacity
              style={[modalStyles.saveBtn, !tempName.trim() && { opacity: 0.4 }]}
              onPress={saveNote}
              disabled={!tempName.trim()}
            >
              <Text style={modalStyles.saveBtnText}>{editingNote ? '수정 완료' : '노트 추가'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  wrapper: { gap: 10 },

  card: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    ...shadows.soft,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardEmoji: { fontSize: 16 },
  cardTitle: { ...typography.L3, color: colors.espressoBrown },

  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.coffeeCream,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
  },
  editBtnText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },

  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
  },
  addBtnText: { ...typography.L5, fontWeight: '700', color: colors.white },

  // 현재 사용 원두
  currentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  currentLabel: { flexDirection: 'row', alignItems: 'center', gap: 5, width: 64 },
  currentLabelText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },
  currentValue: { ...typography.L5, color: colors.espressoBrown, flex: 1, fontWeight: '600' },
  currentEmpty: { color: colors.stone300, fontWeight: '400', fontStyle: 'italic' },
  divider: { height: 1, backgroundColor: colors.coffeeCream, marginVertical: 2 },

  // 노트 목록
  emptyNote: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  emptyNoteText: { ...typography.L5, color: colors.stone300, textAlign: 'center', lineHeight: 18 },

  noteList: { gap: 10 },
  noteItem: {
    flexDirection: 'row',
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    overflow: 'hidden',
  },
  noteBar: { width: 4, flexShrink: 0 },
  noteContent: { flex: 1, padding: 12, gap: 5 },

  noteTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },

  statusBadge: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  statusText: { fontSize: 9, fontWeight: '800' },

  noteMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteDate: { ...typography.L5, fontSize: 9, color: colors.stone300 },

  noteMemo: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, fontStyle: 'italic' },
  noteMemoEmpty: { ...typography.L5, color: colors.stone300, fontStyle: 'italic' },
});

// 모달 스타일 (FormSheet 패턴)
const modalStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center' as const,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
    gap: 4,
  },
  handle: {
    width: 40, height: 4,
    borderRadius: 999,
    backgroundColor: colors.stone300,
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: { ...typography.L1, color: colors.espressoBrown, marginBottom: 16, fontSize: 18 },
  label: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown, marginBottom: 6 },
  input: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...typography.L4,
    color: colors.espressoBrown,
  },
  inputMulti: { height: 80, textAlignVertical: 'top' },
  statusRow: { flexDirection: 'row', gap: 8 },
  statusChip: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  statusChipText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '600' },
  saveBtn: {
    marginTop: 20,
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  saveBtnText: { ...typography.L3, color: colors.white },
});
