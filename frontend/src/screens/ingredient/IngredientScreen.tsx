// 재료 관리 (ERP-2) — 재료 등록, 단위·단가, 단가 이력
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { Badge, Button, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';
import { apiFetch } from '../../lib/api/client';

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
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');

  // 2. [인증 정보 가져오기] 로컬 세션 보관소에서 암호화 출입증(Token)을 획득합니다.
  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const raw = await AsyncStorage.getItem('simplem:session');
    if (raw) {
      const session = JSON.parse(raw);
      if (session?.token) {
        return { 'Authorization': `Bearer ${session.token}` };
      }
    }
    return {};
  };

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

  // 4. [재료 추가 요청 발송] 입력한 내용을 백엔드 창구에 던집니다.
  const submit = async () => {
    const p = parseInt(price.replace(/[^0-9]/g, ''), 10) || 0;
    try {
      const headers = await getAuthHeaders();
      await apiFetch('/api/v1/inventory/ingredients', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: name.trim(),
          unit: unit.trim() || '개',
          current_price: p,
        })
      });
      
      // 입력란을 초기화하고 창을 닫은 뒤, 실시간 DB 리스트로 목록을 다시 갱신합니다.
      setName('');
      setUnit('');
      setPrice('');
      setAdding(false);
      await fetchIngredients();
    } catch (e) {
      console.error('재료 등록 실패:', e);
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
        <LabeledInput label="단위" value={unit} onChangeText={setUnit} placeholder="예: kg / 개 / 팩" />
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
  row: { flexDirection: 'row', alignItems: 'flex-start' },
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
