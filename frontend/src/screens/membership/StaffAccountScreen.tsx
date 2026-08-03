// 직원 계정 관리 (사장님용)
//
// [한글 주석] 이 화면이 푸는 문제:
//   계산대에 서는 알바생에게 사장님 계정을 줄 수는 없다(매출·정산·급여가 다 보인다).
//   여기서 만든 계정으로 로그인하면 단골 차감만 되고 나머지는 서버가 막는다.
//
//   비밀번호는 만들 때 한 번만 보여준다. 서버는 해시만 저장하므로
//   잊으면 재발급해야 한다 — 이 사실을 화면에서 분명히 알린다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
    Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  activateStaffAccount,
  createStaffAccount,
  deactivateStaffAccount,
  fetchStaffAccounts,
  resetStaffPassword,
  type StaffAccount,
} from '../../lib/api/staffAccounts';
import { showAlert } from '../../lib/ui/alert';
import { useAuth } from '../../auth/AuthContext';
import { colors } from '../../theme';

export default function StaffAccountScreen() {
  const { token } = useAuth();
  const [list, setList] = useState<StaffAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [loginId, setLoginId] = useState('');
  const [busy, setBusy] = useState(false);

  // 발급 직후 비밀번호를 보여주는 화면 (한 번만 보인다)
  const [issued, setIssued] = useState<{ name: string; loginId: string; password: string } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      setList(await fetchStaffAccounts(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async () => {
    if (!name.trim() || !loginId.trim()) return;
    setBusy(true);
    try {
      const r = await createStaffAccount(token!, { name: name.trim(), login_id: loginId.trim() });
      setAddOpen(false);
      setName('');
      setLoginId('');
      setIssued({ name: r.name, loginId: r.login_id, password: r.initial_password });
      await load();
    } catch (e) {
      showAlert('계정 생성 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onReset = (acc: StaffAccount) => {
    showAlert(
      '비밀번호 재발급',
      `${acc.name}님의 비밀번호를 새로 만듭니다.\n지금 쓰던 비밀번호는 즉시 사용할 수 없게 됩니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '재발급',
          onPress: async () => {
            try {
              const r = await resetStaffPassword(token!, acc.id);
              setIssued({ name: acc.name, loginId: acc.login_id, password: r.password });
            } catch (e) {
              showAlert('실패', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]
    );
  };

  const onToggle = (acc: StaffAccount) => {
    const off = acc.is_active;
    showAlert(
      off ? '계정 사용 중지' : '계정 다시 사용',
      off
        ? `${acc.name}님이 더 이상 로그인할 수 없게 됩니다.\n지난 처리 기록은 그대로 남습니다.`
        : `${acc.name}님이 다시 로그인할 수 있게 됩니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: off ? '중지' : '사용',
          style: off ? 'destructive' : 'default',
          onPress: async () => {
            try {
              if (off) await deactivateStaffAccount(token!, acc.id);
              else await activateStaffAccount(token!, acc.id);
              await load();
            } catch (e) {
              showAlert('실패', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.espressoBrown} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={{ padding: 16, gap: 14 }}>
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.infoCard}>
        <Ionicons name="information-circle-outline" size={16} color={colors.mochaBrown} />
        <Text style={styles.infoText}>
          직원 계정으로 로그인하면 단골 결제만 할 수 있습니다.
          매출·정산·급여·환불은 보이지 않습니다.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="people-outline" size={16} color={colors.mochaBrown} />
          <Text style={styles.cardTitle}>직원 계정 {list.length}개</Text>
          <Pressable style={styles.addBtn} onPress={() => setAddOpen(true)}>
            <Ionicons name="add" size={13} color="#FFF" />
            <Text style={styles.addBtnText}>계정 만들기</Text>
          </Pressable>
        </View>

        {list.length === 0 ? (
          <Text style={styles.dim}>
            아직 없습니다. 계산대에 서는 직원의 계정을 만들어 주세요.
          </Text>
        ) : (
          <View style={{ gap: 6 }}>
            {list.map((a) => (
              <View key={a.id} style={[styles.row, !a.is_active && styles.rowOff]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>
                    {a.name}
                    {!a.is_active && <Text style={styles.offTag}>  사용 중지</Text>}
                  </Text>
                  <Text style={styles.sub}>
                    아이디 {a.login_id}
                    {a.last_login_at
                      ? ` · 최근 로그인 ${new Date(a.last_login_at).toLocaleDateString('ko-KR')}`
                      : ' · 로그인 기록 없음'}
                  </Text>
                </View>
                <Pressable style={styles.smallBtn} onPress={() => onReset(a)}>
                  <Text style={styles.smallBtnText}>비번 재발급</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => onToggle(a)}>
                  <Ionicons
                    name={a.is_active ? 'lock-open-outline' : 'lock-closed-outline'}
                    size={16}
                    color={a.is_active ? '#B0A79E' : '#B23B2E'}
                  />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 계정 만들기 */}
      <Modal visible={addOpen} transparent animationType="fade"
             onRequestClose={() => setAddOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>직원 계정 만들기</Text>
            <Text style={styles.fieldLabel}>이름</Text>
            <TextInput style={styles.input} placeholder="박알바"
                       placeholderTextColor="#B0A79E" value={name} onChangeText={setName} />
            <Text style={styles.fieldLabel}>로그인 아이디</Text>
            <TextInput style={styles.input} placeholder="영문·숫자 3~20자"
                       placeholderTextColor="#B0A79E" value={loginId}
                       onChangeText={setLoginId} autoCapitalize="none" />
            <Text style={styles.dim}>
              비밀번호는 자동으로 만들어지며, 만든 직후 한 번만 보입니다.
            </Text>
            <View style={styles.sheetBtns}>
              <Pressable style={styles.cancelBtn} onPress={() => setAddOpen(false)}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
                         onPress={onCreate} disabled={busy}>
                <Text style={styles.primaryText}>만들기</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 발급된 비밀번호 — 한 번만 보인다 */}
      <Modal visible={!!issued} transparent animationType="fade"
             onRequestClose={() => setIssued(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{issued?.name}님 계정</Text>
            <View style={styles.credBox}>
              <Text style={styles.credLabel}>아이디</Text>
              <Text style={styles.credValue} selectable>{issued?.loginId}</Text>
              <Text style={[styles.credLabel, { marginTop: 10 }]}>비밀번호</Text>
              <Text style={styles.credValue} selectable>{issued?.password}</Text>
            </View>
            <Text style={styles.warnText}>
              이 비밀번호는 지금만 보입니다. 직원에게 전달해 주세요.
              잊으면 재발급해야 합니다.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={() => setIssued(null)}>
              <Text style={styles.primaryText}>확인했습니다</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.creamSand },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.creamSand },
  dim: { fontSize: 11.5, color: '#9A8F86', lineHeight: 17 },

  errorBox: { backgroundColor: '#FDECEA', borderRadius: 10, padding: 12 },
  errorText: { fontSize: 12, color: '#B23B2E' },

  infoCard: { flexDirection: 'row', gap: 8, backgroundColor: '#F4F1EE',
              borderRadius: 12, padding: 12, alignItems: 'flex-start' },
  infoText: { flex: 1, fontSize: 11.5, color: '#7A6E65', lineHeight: 17 },

  card: { backgroundColor: '#FFF', borderRadius: 14, padding: 14, gap: 10,
          borderWidth: 1, borderColor: colors.mutedSand },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: 'bold', color: colors.espressoBrown },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto',
            backgroundColor: colors.pointOrange, paddingHorizontal: 9,
            paddingVertical: 6, borderRadius: 8 },
  addBtnText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 8,
         backgroundColor: '#FAF8F6', borderRadius: 10, padding: 11 },
  rowOff: { opacity: 0.5 },
  name: { fontSize: 13, fontWeight: '700', color: colors.espressoBrown },
  offTag: { fontSize: 11, color: '#B23B2E', fontWeight: '600' },
  sub: { fontSize: 11, color: '#7A6E65', marginTop: 2 },
  smallBtn: { borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 7,
              paddingHorizontal: 9, paddingVertical: 6 },
  smallBtnText: { fontSize: 11, color: colors.espressoBrown, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: colors.black40, justifyContent: 'center',
              alignItems: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 420, backgroundColor: '#FFF',
           borderRadius: 16, padding: 16, gap: 8 },
  sheetTitle: { fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown },
  fieldLabel: { fontSize: 11.5, color: '#7A6E65', marginBottom: 3 },
  input: { borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 8,
           paddingHorizontal: 11, paddingVertical: 9, fontSize: 13,
           color: colors.espressoBrown, marginBottom: 6 },

  credBox: { backgroundColor: '#FAF8F6', borderRadius: 10, padding: 14 },
  credLabel: { fontSize: 11, color: '#9A8F86' },
  credValue: { fontSize: 20, fontWeight: '800', color: colors.espressoBrown,
               letterSpacing: 1, marginTop: 2 },
  warnText: { fontSize: 11.5, color: '#B23B2E', lineHeight: 17 },

  sheetBtns: { flexDirection: 'row', gap: 8, marginTop: 4 },
  cancelBtn: { flex: 1, paddingVertical: 10, borderRadius: 8,
               alignItems: 'center', backgroundColor: '#F2EFEC' },
  cancelText: { fontSize: 12.5, fontWeight: '700', color: '#7A6E65' },
  primaryBtn: { flex: 1, paddingVertical: 11, borderRadius: 8, alignItems: 'center',
                backgroundColor: colors.pointOrange, justifyContent: 'center' },
  primaryText: { fontSize: 12.5, fontWeight: 'bold', color: '#FFF' },
});
