// [한글 주석: 원두 메모장 컴포넌트 - 아코디언 토글 & 이모지 완전 제거 버전]
// 사장님이 현재 사용 중인 원두와 이전에 주문/발주해본 원두를 기록하는 깔끔한 대장 UI입니다.
// AsyncStorage에 로컬 저장되므로 백엔드 없이도 동작합니다.
import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
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
interface BeanNote {
  id: string;
  name: string;         // 원두 이름
  memo: string;         // 간단 메모
  date: string;         // 날짜 (YYYY-MM-DD)
  usageCount: number;   // 주문(사용) 횟수
  status?: string;      // 하위 호환성용
}

interface NotepadData {
  currentCaffeine: string;   // 현재 사용 카페인 원두명
  currentDecaf: string;      // 현재 사용 디카페인 원두명
  notes: BeanNote[];         // 체험 노트 목록
}

const STORAGE_KEY = 'simplem:bean_notepad';
const today = () => new Date().toISOString().split('T')[0];

export default function BeanNotepad() {
  const [data, setData] = useState<NotepadData>({
    currentCaffeine: '',
    currentDecaf: '',
    notes: [],
  });

  // 아코디언 상태: 현재 메모가 열린 원두의 ID를 저장합니다. (기본적으로 모두 접힌 상태)
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);

  // 모달 상태
  const [showCurrentEdit, setShowCurrentEdit] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [editingNote, setEditingNote] = useState<BeanNote | null>(null);

  // 현재 사용 원두 편집 임시값 (이모지 없이 텍스트만)
  const [tempCaffeine, setTempCaffeine] = useState('');
  const [tempDecaf, setTempDecaf] = useState('');

  // 노트 편집 임시값 (구분 status 제거, 이모지 없음)
  const [tempName, setTempName] = useState('');
  const [tempMemo, setTempMemo] = useState('');
  const [tempUsageCount, setTempUsageCount] = useState(1);

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
    setTempName(''); setTempMemo('');
    setTempUsageCount(1);
    setShowNoteModal(true);
  };

  const openEditNote = (note: BeanNote) => {
    setEditingNote(note);
    setTempName(note.name);
    setTempMemo(note.memo);
    setTempUsageCount(note.usageCount || 1);
    setShowNoteModal(true);
  };

  const saveNote = () => {
    if (!tempName.trim()) return;
    if (editingNote) {
      // 수정
      const updated = data.notes.map((n) =>
        n.id === editingNote.id
          ? {
              ...n,
              name: tempName.trim(),
              memo: tempMemo.trim(),
              usageCount: tempUsageCount,
            }
          : n
      );
      save({ ...data, notes: updated });
    } else {
      // 추가
      const newNote: BeanNote = {
        id: Date.now().toString(),
        name: tempName.trim(),
        memo: tempMemo.trim(),
        date: today(),
        usageCount: tempUsageCount,
      };
      save({ ...data, notes: [newNote, ...data.notes] });
    }
    setShowNoteModal(false);
  };

  const deleteNote = (id: string) => {
    const doDelete = () => {
      if (expandedNoteId === id) setExpandedNoteId(null);
      save({ ...data, notes: data.notes.filter((n) => n.id !== id) });
    };

    if (Platform.OS === 'web') {
      if (window.confirm('이 노트를 삭제하시겠습니까?')) {
        doDelete();
      }
    } else {
      Alert.alert('삭제', '이 노트를 삭제할까요?', [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  // ─── 렌더링 ────────────────────────────────────────────────────────────
  return (
    <View style={styles.wrapper}>

      {/* ━━━ 현재 사용 원두 카드 ━━━ */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
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
            {[...data.notes]
              .sort((a, b) => {
                const cntA = a.usageCount || 0;
                const cntB = b.usageCount || 0;
                if (cntB !== cntA) return cntB - cntA; // 사용 횟수 많은 순 정렬
                return b.id.localeCompare(a.id); // 2차: 등록 최신 순
              })
              .map((note) => {
                const isExpanded = expandedNoteId === note.id;
                return (
                  <View key={note.id} style={styles.noteItem}>
                    {/* 왼쪽 구분 바 */}
                    <View style={[styles.noteBar, { backgroundColor: colors.mochaBrown }]} />

                    <View style={styles.noteContent}>
                      {/* 상단 줄: 원두명 클릭 가능 영역 + 횟수 + 아이콘 */}
                      <View style={styles.noteTopRow}>
                        <TouchableOpacity
                          style={styles.noteNamePressable}
                          onPress={() => setExpandedNoteId(isExpanded ? null : note.id)}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.noteName} numberOfLines={1}>{note.name}</Text>
                          
                          {/* 사용 횟수 태그 (이모지 없음) */}
                          <View style={styles.countBadge}>
                            <Text style={styles.countBadgeText}>{note.usageCount || 1}회 주문</Text>
                          </View>

                          <Ionicons
                            name={isExpanded ? 'chevron-up' : 'chevron-down'}
                            size={12}
                            color={colors.stone300}
                          />
                        </TouchableOpacity>

                        {/* 조작 버튼그룹 */}
                        <View style={styles.actionGroup}>
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
                      </View>

                      {/* 메모 영역 (클릭 시 아코디언 토글 노출) */}
                      {isExpanded && (
                        <View style={styles.memoBox}>
                          {note.memo ? (
                            <Text style={styles.noteMemo}>{note.memo}</Text>
                          ) : (
                            <Text style={styles.noteMemoEmpty}>작성된 내용이 없습니다.</Text>
                          )}
                          <View style={styles.memoFooter}>
                            <Text style={styles.noteDate}>{note.date.replace(/-/g, '.')}</Text>
                          </View>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
          </View>
        )}
      </View>

      {/* ━━━ 현재 사용 원두 편집 모달 (이모지 없음) ━━━ */}
      <Modal visible={showCurrentEdit} transparent animationType="slide" onRequestClose={() => setShowCurrentEdit(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowCurrentEdit(false)} />
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>현재 사용 중인 원두 수정</Text>

            <Text style={modalStyles.label}>카페인 원두</Text>
            <TextInput
              style={modalStyles.input}
              value={tempCaffeine}
              onChangeText={setTempCaffeine}
              placeholder="예: 에티오피아 구지 내추럴"
              placeholderTextColor={colors.stone300}
            />

            <Text style={[modalStyles.label, { marginTop: 14 }]}>디카페인 원두</Text>
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

      {/* ━━━ 원두 노트 추가/수정 모달 (이모지 및 status 배지 완전 배제) ━━━ */}
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

            {/* 사용 횟수 카운터 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>주문 횟수</Text>
            <View style={modalStyles.counterRow}>
              <TouchableOpacity
                style={modalStyles.counterBtn}
                onPress={() => setTempUsageCount(Math.max(1, tempUsageCount - 1))}
              >
                <Ionicons name="remove" size={16} color={colors.espressoBrown} />
              </TouchableOpacity>
              <Text style={modalStyles.counterVal}>{tempUsageCount}회</Text>
              <TouchableOpacity
                style={modalStyles.counterBtn}
                onPress={() => setTempUsageCount(tempUsageCount + 1)}
              >
                <Ionicons name="add" size={16} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            {/* 간단 메모 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>간단 메모</Text>
            <TextInput
              style={[modalStyles.input, modalStyles.inputMulti]}
              value={tempMemo}
              onChangeText={setTempMemo}
              placeholder="특이사항이나 만족도를 자유롭게 메모하세요"
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

  noteTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  noteNamePressable: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  noteName: { ...typography.L4, color: colors.espressoBrown, maxWidth: '60%', fontWeight: '700' },

  countBadge: {
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.mochaBrown,
  },

  actionGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  noteDate: { ...typography.L5, fontSize: 9, color: colors.stone300 },

  memoBox: {
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(140, 111, 86, 0.08)',
  },
  memoFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  noteMemo: {
    ...typography.L5,
    color: colors.espressoBrown,
    lineHeight: 16,
  },
  noteMemoEmpty: {
    ...typography.L5,
    color: colors.stone300,
  },
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
  counterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  counterBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counterVal: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '800',
    minWidth: 32,
    textAlign: 'center',
  },
  saveBtn: {
    marginTop: 20,
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  saveBtnText: { ...typography.L3, color: colors.white },
});
