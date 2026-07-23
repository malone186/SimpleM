// 메뉴 관리 (ERP-3) — 메뉴 등록 + 레시피(재료 구성), 원가율
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import { PressableScale } from '../../components/motion';
import FormSheet, { LabeledInput } from '../../components/FormSheet';
import { Badge, Button, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';
import { API_BASE_URL, apiFetch } from '../../lib/api/client';
import { confirmDialog, toast } from '../../components/toast';


// 1. 진짜 DB에서 불러올 재료 및 메뉴 레시피 규격 선언
type Ingredient = {
  id: number;
  name: string;
  unit: string;
  current_price: number;
};

type RecipeDetail = {
  ingredient_id: number;
  ingredient_name: string;
  quantity: number;
  unit: string;
};

type Menu = {
  id: number;
  name: string;
  selling_price: number;
  store_id: string;
  is_active: boolean;
  recipes: RecipeDetail[];
  cost_price?: number;                                               // 백엔드가 실시간 계산해 준 총 원재료비 (KRW)
  cost_ratio?: number;                                               // 백엔드가 실시간 계산해 준 최종 원가율 (%)
};

// 2. 새로운 메뉴를 만들 때 한 줄 한 줄의 레시피 입력칸 규격
type NewRow = { ingredient_id: string; quantity: string };

export default function MenuScreen() {
  // [한글 주석: 전역 다국어 훅 연동]
  const { t, language } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [allIngredients, setAllIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [rows, setRows] = useState<NewRow[]>([{ ingredient_id: '', quantity: '' }]);

  // 3. [인증 정보] 자동 로그인 여부와 무관하게 항상 유효한 in-memory 토큰 사용
  const { token } = useAuth();
  const getAuthHeaders = async (): Promise<Record<string, string>> =>
    token ? { Authorization: `Bearer ${token}` } : {};

  // 4. [기초 데이터 로딩] 재료와 메뉴 목록을 동시에 들고 와 싱크를 맞춥니다.
  const fetchData = async () => {
    try {
      setLoading(true);
      const headers = await getAuthHeaders();
      
      // 4-1. 드롭다운 선택에 띄워줄 전체 재재료 로드
      const ingredientsData = await apiFetch<Ingredient[]>('/api/v1/inventory/ingredients', { headers });
      setAllIngredients(ingredientsData);

      // 4-2. 레시피가 포함된 최종 메뉴판 리스트 로드
      const menusData = await apiFetch<Menu[]>('/api/v1/inventory/menus', { headers });
      setMenus(menusData);
    } catch (e) {
      console.error('메뉴/재료 데이터 동기화 실패:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const setRow = (i: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { ingredient_id: '', quantity: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const canSubmit = name.trim() !== '' && price.trim() !== '';

  // 메뉴 삭제 (확인 후) — 204 응답이라 raw fetch 사용
  const remove = (m: Menu) => {
    confirmDialog(`'${m.name}' 메뉴를 삭제할까요? 레시피 구성도 함께 제거됩니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return toast('로그인이 필요해요', '다시 로그인해 주세요.');
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/inventory/menus/${m.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
          await fetchData();
          toast('삭제 완료', `${m.name} 메뉴를 삭제했어요.`);
        } catch (e) {
          toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });
  };

  // 5. [메뉴 추가 API 발송] 메뉴 이름, 판매가, 조립식 레시피 리스트를 한 묶음으로 쏩니다.
  const submit = async () => {
    const p = parseInt(price.replace(/[^0-9]/g, ''), 10) || 0;
    
    // 유효한 재료가 골라진 행만 걸러내어 API용 데이터 구조로 치환합니다.
    const recipeData = rows
      .filter((r) => r.ingredient_id !== '' && r.quantity.trim() !== '')
      .map((r) => ({
        ingredient_id: parseInt(r.ingredient_id, 10),
        quantity: parseFloat(r.quantity),
      }));

    const headers = await getAuthHeaders();
    if (!('Authorization' in headers)) {
      toast('로그인이 필요해요', '로그아웃 후 다시 로그인해 주세요.');
      return;
    }
    try {
      await apiFetch('/api/v1/inventory/menus', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: name.trim(),
          selling_price: p,
          recipes: recipeData,
        })
      });
      setName('');
      setPrice('');
      setRows([{ ingredient_id: '', quantity: '' }]);
      setAdding(false);
      await fetchData();
      toast('추가 완료', `${name.trim()} 메뉴를 등록했어요.`);
    } catch (e) {
      console.error('메뉴 등록 실패:', e);
      toast('추가 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 6. [실시간 단가 계산 공식]
  // 단재료의 단위(unit)가 kg이나 L인 대용량 벌크 제품이면, 그람(g)/밀리리터(ml) 환산을 위해 단가를 1,000으로 나눈 뒤 소요량을 곱합니다.
  const getIngredientCost = (ingId: number, qty: number) => {
    const ing = allIngredients.find((i) => i.id === ingId);
    if (!ing) return 0;
    const unitLower = ing.unit.toLowerCase();
    
    if (unitLower === 'kg' || unitLower === 'l' || unitLower === '팩' || unitLower === '병') {
      return Math.round((ing.current_price / 1000) * qty);
    }
    return Math.round(ing.current_price * qty);
  };

  return (
    <>
      <Screen>
        <ScreenTitle title={t('menuMgmtTitle')} subtitle={t('menuMgmtSub')} />

        <Button label={language === 'en' ? '+ Add Menu' : '+ 메뉴 추가'} variant="secondary" onPress={() => setAdding(true)} />

        {loading ? (
          <View style={{ paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.espressoBrown} />
            <Text style={{ textAlign: 'center', marginTop: 10, color: colors.mochaBrown }}>
              {language === 'en' ? 'Syncing data...' : '데이터를 동기화하고 있어요...'}
            </Text>
          </View>
        ) : menus.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <Ionicons name="cafe-outline" size={48} color={colors.mutedSand} />
            <Text style={{ marginTop: 10, color: colors.mochaBrown, ...typography.L4 }}>
              {language === 'en' ? 'No registered menus. Please add a new menu.' : '등록된 메뉴가 없습니다. 새 메뉴를 추가해 주세요.'}
            </Text>
          </View>
        ) : (
          menus.map((m) => {
            // 백엔드가 실시간 계산해 준 원가와 원가율을 최우선 매핑하고, 없으면 로컬 폴백 연산합니다.
            const cost = m.cost_price !== undefined ? m.cost_price : m.recipes.reduce((s, r) => s + getIngredientCost(r.ingredient_id, r.quantity), 0);
            const rate = m.cost_ratio !== undefined ? m.cost_ratio : (m.selling_price ? Math.round((cost / m.selling_price) * 100) : 0);
            const expanded = open === m.id;
            return (
              <Card key={m.id}>
                <View style={styles.row}>
                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={() => setOpen(expanded ? null : m.id)}
                    style={styles.headerHit}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>{m.name}</Text>
                      <Text style={styles.sub}>
                        판매가 ₩{m.selling_price.toLocaleString()} · 원가 ₩{cost.toLocaleString()}
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
                  <PressableScale style={styles.delBtn} onPress={() => remove(m)} to={0.88}>
                    <Ionicons name="trash-outline" size={18} color="#B23B2E" />
                  </PressableScale>
                </View>

                {expanded && (
                  <View style={styles.recipe}>
                    <Text style={styles.recipeTitle}>레시피 구성 재료</Text>
                    {m.recipes.map((r, i) => {
                      const itemCost = getIngredientCost(r.ingredient_id, r.quantity);
                      return (
                        <View key={i} style={styles.recipeRow}>
                          <Text style={styles.recipeName}>{r.ingredient_name}</Text>
                          <Text style={styles.recipeAmount}>{r.quantity}{r.unit}</Text>
                          <Text style={styles.recipeCost}>₩{itemCost.toLocaleString()}</Text>
                        </View>
                      );
                    })}
                    <Divider />
                    <View style={styles.recipeRow}>
                      <Text style={[styles.recipeName, { fontWeight: '700' }]}>원가 합계</Text>
                      <Text style={styles.recipeCost}>₩{cost.toLocaleString()}</Text>
                    </View>
                  </View>
                )}
              </Card>
            );
          })
        )}
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
            {/* 웹 브라우저 호환 및 패키지 충돌 방지를 위해 표준 HTML select 태그를 스타일링하여 드롭다운을 제공합니다. */}
            <select
              style={styles.selectInput}
              value={r.ingredient_id}
              onChange={(e) => setRow(i, { ingredient_id: e.target.value })}
            >
              <option value="">-- 재료 선택 --</option>
              {allIngredients.map((ing) => (
                <option key={ing.id} value={ing.id}>
                  {ing.name} ({ing.unit})
                </option>
              ))}
            </select>
            
            <TextInput
              style={[styles.formInput, { flex: 1 }]}
              value={r.quantity}
              onChangeText={(t) => setRow(i, { quantity: t })}
              placeholder="소요량"
              placeholderTextColor={colors.mochaBrown}
              keyboardType="numeric"
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
  selectInput: {
    flex: 2,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerHit: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  delBtn: { padding: 8, borderRadius: 10, backgroundColor: 'rgba(178,59,46,0.08)' },

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
