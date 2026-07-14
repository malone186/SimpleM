// 재료 관리 (ERP-2) — 재료 등록, 단위·단가, 단가 이력
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { Badge, Button, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Ingredient = {
  id: string;
  name: string;
  unit: string;
  price: number;
  prevPrice: number;
};

const INGREDIENTS: Ingredient[] = [
  { id: 'bean', name: '에티오피아 예가체프', unit: 'kg', price: 28000, prevPrice: 26000 },
  { id: 'milk', name: '서울우유 1L', unit: '팩', price: 2400, prevPrice: 2200 },
  { id: 'syrup', name: '바닐라 시럽', unit: '병', price: 9800, prevPrice: 9800 },
  { id: 'cup', name: '13oz 테이크아웃 컵', unit: '개', price: 95, prevPrice: 92 },
  { id: 'choco', name: '초콜릿 파우더', unit: 'kg', price: 15000, prevPrice: 16000 },
];

export default function IngredientScreen() {
  const [items, setItems] = useState<Ingredient[]>(INGREDIENTS);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');

  const canSubmit = name.trim() !== '' && price.trim() !== '';

  const submit = () => {
    const p = parseInt(price.replace(/[^0-9]/g, ''), 10) || 0;
    setItems((prev) => [
      { id: `new-${Date.now()}`, name: name.trim(), unit: unit.trim() || '개', price: p, prevPrice: p },
      ...prev,
    ]);
    setName('');
    setUnit('');
    setPrice('');
    setAdding(false);
  };

  return (
    <>
      <Screen>
      <ScreenTitle title="재료 관리" subtitle="재료 단가와 변동 이력" />

      <Button label="+ 재료 추가" variant="secondary" onPress={() => setAdding(true)} />

      {items.map((it) => {
        const diff = it.price - it.prevPrice;
        const pct = it.prevPrice ? Math.round((diff / it.prevPrice) * 100) : 0;
        return (
          <Card key={it.id}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{it.name}</Text>
                <Text style={styles.unit}>단위: {it.unit}</Text>
              </View>
              <View style={styles.priceCol}>
                <Text style={styles.price}>₩{it.price.toLocaleString()}</Text>
                {diff !== 0 ? (
                  <Badge
                    label={`${diff > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`}
                    tone={diff > 0 ? 'danger' : 'green'}
                  />
                ) : (
                  <Badge label="변동 없음" tone="neutral" />
                )}
              </View>
            </View>
            {diff !== 0 && (
              <View style={styles.history}>
                <Ionicons name="time-outline" size={13} color={colors.mochaBrown} />
                <Text style={styles.historyText}>
                  이전 ₩{it.prevPrice.toLocaleString()} → 현재 ₩{it.price.toLocaleString()}
                </Text>
              </View>
            )}
          </Card>
        );
      })}
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
