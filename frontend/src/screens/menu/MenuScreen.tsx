// 메뉴 관리 (ERP-3) — 메뉴 등록 + 레시피(재료 구성), 원가율
import { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { Badge, Button, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Recipe = { name: string; amount: string; cost: number };
type Menu = { id: string; name: string; price: number; recipe: Recipe[] };

const MENUS: Menu[] = [
  {
    id: 'latte',
    name: '카페라떼',
    price: 4500,
    recipe: [
      { name: '에스프레소(예가체프)', amount: '18g', cost: 504 },
      { name: '우유', amount: '250ml', cost: 600 },
      { name: '테이크아웃 컵', amount: '1개', cost: 95 },
    ],
  },
  {
    id: 'americano',
    name: '아메리카노',
    price: 4000,
    recipe: [
      { name: '에스프레소(예가체프)', amount: '18g', cost: 504 },
      { name: '테이크아웃 컵', amount: '1개', cost: 95 },
    ],
  },
  {
    id: 'mocha',
    name: '카페모카',
    price: 5000,
    recipe: [
      { name: '에스프레소(예가체프)', amount: '18g', cost: 504 },
      { name: '우유', amount: '250ml', cost: 600 },
      { name: '초콜릿 파우더', amount: '20g', cost: 300 },
      { name: '테이크아웃 컵', amount: '1개', cost: 95 },
    ],
  },
];

type NewRow = { name: string; amount: string; cost: string };

export default function MenuScreen() {
  const [open, setOpen] = useState<string | null>('latte');
  const [menus, setMenus] = useState<Menu[]>(MENUS);
  const [adding, setAdding] = useState(false);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [rows, setRows] = useState<NewRow[]>([{ name: '', amount: '', cost: '' }]);

  const setRow = (i: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { name: '', amount: '', cost: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const canSubmit = name.trim() !== '' && price.trim() !== '';

  const submit = () => {
    const p = parseInt(price.replace(/[^0-9]/g, ''), 10) || 0;
    const recipe: Recipe[] = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        amount: r.amount.trim() || '-',
        cost: parseInt(r.cost.replace(/[^0-9]/g, ''), 10) || 0,
      }));
    setMenus((prev) => [{ id: `new-${Date.now()}`, name: name.trim(), price: p, recipe }, ...prev]);
    setName('');
    setPrice('');
    setRows([{ name: '', amount: '', cost: '' }]);
    setAdding(false);
  };

  return (
    <>
      <Screen>
      <ScreenTitle title="메뉴 관리" subtitle="메뉴 · 레시피 · 원가율" />

      <Button label="+ 메뉴 추가" variant="secondary" onPress={() => setAdding(true)} />

      {menus.map((m) => {
        const cost = m.recipe.reduce((s, r) => s + r.cost, 0);
        const rate = Math.round((cost / m.price) * 100);
        const expanded = open === m.id;
        return (
          <Card key={m.id}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setOpen(expanded ? null : m.id)}
              style={styles.row}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.name}</Text>
                <Text style={styles.sub}>
                  판매가 ₩{m.price.toLocaleString()} · 원가 ₩{cost.toLocaleString()}
                </Text>
              </View>
              <Badge label={`원가율 ${rate}%`} tone={rate > 35 ? 'danger' : 'green'} />
              <Ionicons
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.mochaBrown}
                style={{ marginLeft: 6 }}
              />
            </TouchableOpacity>

            {expanded && (
              <View style={styles.recipe}>
                <Text style={styles.recipeTitle}>레시피</Text>
                {m.recipe.map((r, i) => (
                  <View key={i} style={styles.recipeRow}>
                    <Text style={styles.recipeName}>{r.name}</Text>
                    <Text style={styles.recipeAmount}>{r.amount}</Text>
                    <Text style={styles.recipeCost}>₩{r.cost.toLocaleString()}</Text>
                  </View>
                ))}
                <Divider />
                <View style={styles.recipeRow}>
                  <Text style={[styles.recipeName, { fontWeight: '700' }]}>원가 합계</Text>
                  <Text style={styles.recipeCost}>₩{cost.toLocaleString()}</Text>
                </View>
              </View>
            )}
          </Card>
        );
      })}
      </Screen>

      <FormSheet
        visible={adding}
        title="메뉴 추가"
        onClose={() => setAdding(false)}
        onSubmit={submit}
        submitDisabled={!canSubmit}
      >
        <LabeledInput label="메뉴명" value={name} onChangeText={setName} placeholder="예: 카페라떼" />
        <LabeledInput
          label="판매가 (원)"
          value={price}
          onChangeText={setPrice}
          placeholder="예: 4500"
          keyboardType="number-pad"
        />

        <Text style={styles.formLabel}>레시피 (재료 구성)</Text>
        {rows.map((r, i) => (
          <View key={i} style={styles.formRow}>
            <TextInput
              style={[styles.formInput, { flex: 2 }]}
              value={r.name}
              onChangeText={(t) => setRow(i, { name: t })}
              placeholder="재료"
              placeholderTextColor={colors.mochaBrown}
            />
            <TextInput
              style={[styles.formInput, { flex: 1 }]}
              value={r.amount}
              onChangeText={(t) => setRow(i, { amount: t })}
              placeholder="용량"
              placeholderTextColor={colors.mochaBrown}
            />
            <TextInput
              style={[styles.formInput, { flex: 1 }]}
              value={r.cost}
              onChangeText={(t) => setRow(i, { cost: t })}
              placeholder="원가"
              placeholderTextColor={colors.mochaBrown}
              keyboardType="number-pad"
            />
            {rows.length > 1 && (
              <TouchableOpacity onPress={() => removeRow(i)} hitSlop={6}>
                <Ionicons name="close-circle" size={20} color={colors.mochaBrown} />
              </TouchableOpacity>
            )}
          </View>
        ))}
        <TouchableOpacity style={styles.addRow} onPress={addRow}>
          <Ionicons name="add" size={16} color={colors.pointOrange} />
          <Text style={styles.addRowText}>재료 추가</Text>
        </TouchableOpacity>
      </FormSheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  name: { ...typography.L3, color: colors.espressoBrown },
  sub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  recipe: { marginTop: 14, backgroundColor: colors.creamSand, borderRadius: 12, padding: 12, gap: 8 },
  recipeTitle: { ...typography.L5, color: colors.mochaBrown, marginBottom: 2 },
  recipeRow: { flexDirection: 'row', alignItems: 'center' },
  recipeName: { ...typography.L5, color: colors.espressoBrown, flex: 1 },
  recipeAmount: { ...typography.L5, color: colors.mochaBrown, width: 60, textAlign: 'right' },
  recipeCost: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 70, textAlign: 'right' },
  formLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 8, marginTop: 4 },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  formInput: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, alignSelf: 'flex-start' },
  addRowText: { ...typography.L5, color: colors.pointOrange, fontWeight: '700' },
});
