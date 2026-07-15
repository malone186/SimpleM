// 재료 관리 (ERP-2) — 재료 등록, 단위·단가, 단가 이력
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { PressableScale } from '../../components/motion';
import { Badge, Button, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';
import { API_BASE_URL, apiFetch } from '../../lib/api/client';
import { confirmDialog, toast } from '../../components/toast';

// 1. 진짜 DB에서 가져올 재재료 규격 정의
type Ingredient = {
  id: number;
  name: string;
  unit: string;
  current_price: number;
  created_at: string;
};

export default function IngredientScreen() {
  const [items, setItems] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  // 2. [인증 정보] 자동 로그인 여부와 무관하게 항상 유효한 in-memory 토큰 사용
  const { token } = useAuth();
  const getAuthHeaders = async (): Promise<Record<string, string>> =>
    token ? { Authorization: `Bearer ${token}` } : {};

  // 3. [재료 가져오기 함수] 백엔드 공장에서 진짜 재료 데이터를 들고 옵니다.
  const fetchIngredients = async () => {
    try {
      setLoading(true);
      const headers = await getAuthHeaders();
      const data = await apiFetch<Ingredient[]>('/api/v1/inventory/ingredients', {
        headers
      });
      setItems(data);
    } catch (e) {
      console.error('재료 목록 조회 실패:', e);
    } finally {
      setLoading(false);
    }
  };

  // 화면이 켜지자마자 재료 리스트를 자동으로 한 번 쓸어옵니다.
  useEffect(() => {
    fetchIngredients();
  }, []);

  const canSubmit = name.trim() !== '' && price.trim() !== '';

  // 재료 삭제 (확인 후) — 204 응답이라 raw fetch 사용
  const remove = (it: Ingredient) => {
    confirmDialog(`'${it.name}' 재료를 삭제할까요? 재고·레시피에서도 함께 제거됩니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return toast('로그인이 필요해요', '다시 로그인해 주세요.');
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/inventory/ingredients/${it.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
          await fetchIngredients();
          toast('삭제 완료', `${it.name} 재료를 삭제했어요.`);
        } catch (e) {
          toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });
  };

  // 4. [재료 추가 요청 발송] 입력한 내용을 백엔드 창구에 던집니다.
  const submit = async () => {
    const p = parseInt(price.replace(/[^0-9]/g, ''), 10) || 0;
    const headers = await getAuthHeaders();
    if (!('Authorization' in headers)) {
      toast('로그인이 필요해요', '로그아웃 후 다시 로그인해 주세요.');
      return;
    }
    try {
      await apiFetch('/api/v1/inventory/ingredients', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: name.trim(),
          unit: '개', // 단위 입력 제거 — 기본값으로 저장 (영수증에 단위가 안 나오는 경우 대비)
          current_price: p,
        })
      });
      setName('');
      setPrice('');
      setAdding(false);
      await fetchIngredients();
      toast('추가 완료', `${name.trim()} 재료를 등록했어요.`);
    } catch (e) {
      console.error('재료 등록 실패:', e);
      toast('추가 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  return (
    <>
      <Screen>
        <ScreenTitle title="재료 관리" subtitle="재료 단가와 변동 이력" />

        <Button label="+ 재료 추가" variant="secondary" onPress={() => setAdding(true)} />

        {loading ? (
          <View style={{ paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.espressoBrown} />
            <Text style={{ textAlign: 'center', marginTop: 10, color: colors.mochaBrown }}>
              데이터를 동기화하고 있어요...
            </Text>
          </View>
        ) : items.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <Ionicons name="cube-outline" size={48} color={colors.mutedSand} />
            <Text style={{ marginTop: 10, color: colors.mochaBrown, ...typography.L4 }}>
              등록된 재료가 없습니다. 새 재료를 추가해 주세요.
            </Text>
          </View>
        ) : (
          items.map((it) => (
            <Card key={it.id}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{it.name}</Text>
                  <Text style={styles.unit}>단위: {it.unit}</Text>
                </View>
                <View style={styles.priceCol}>
                  <Text style={styles.price}>₩{it.current_price.toLocaleString()}</Text>
                  <Badge label="정상 연동" tone="green" />
                </View>
                <PressableScale style={styles.delBtn} onPress={() => remove(it)} to={0.88}>
                  <Ionicons name="trash-outline" size={18} color="#B23B2E" />
                </PressableScale>
              </View>
            </Card>
          ))
        )}
      </Screen>

      <FormSheet
        visible={adding}
        title="재료 추가"
        onClose={() => setAdding(false)}
        onSubmit={submit}
        submitDisabled={!canSubmit}
      >
        <LabeledInput label="재료명" value={name} onChangeText={setName} placeholder="예: 에티오피아 예가체프" />
        <LabeledInput
          label="단가 (원)"
          value={price}
          onChangeText={setPrice}
          placeholder="예: 28000"
          keyboardType="number-pad"
        />
      </FormSheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  delBtn: { padding: 8, borderRadius: 10, backgroundColor: 'rgba(178,59,46,0.08)' },
  name: { ...typography.L3, color: colors.espressoBrown },
  unit: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  priceCol: { alignItems: 'flex-end', gap: 6 },
  price: { ...typography.L3, color: colors.espressoBrown },
  history: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 10,
  },
  historyText: { ...typography.L5, color: colors.mochaBrown },
});
