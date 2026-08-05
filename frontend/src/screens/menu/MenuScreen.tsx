// 메뉴 관리 (ERP-3) — 메뉴 등록 + 레시피(재료 구성), 원가율
// 디저트도 여기서 같이 관리한다. 디저트는 별도 저장소가 아니라 '메뉴'로 등록되고(같은 API),
// 메뉴판이 다루지 않는 매입가·소비기한·폐기만 로컬(DessertContext)에 붙는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, type RouteProp } from '@react-navigation/native';

import type { RootStackParamList } from '../../navigation/RootNavigator';

import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import { PressableScale } from '../../components/motion';
import FormSheet, { LabeledInput } from '../../components/FormSheet';
import MenuBoardScan from '../../components/menu/MenuBoardScan';
import { Badge, Button, Card, Divider, Screen, ScreenTitle } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { colors, typography } from '../../theme';
import { API_BASE_URL, apiFetch } from '../../lib/api/client';
import { confirmDialog, toast } from '../../components/toast';
import { daysLeft, todayISO, useDesserts } from '../../dessert/DessertContext';
import { GRADE_TONE, categoryOfMenu, gradeOf } from '../../lib/costStandards';


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

type Tab = 'menu' | 'dessert';

const won = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');
const toNum = (s: string) => Number(s.replace(/[^\d]/g, '')) || 0;

// 날짜 관용 입력: "2026.8.1" "20260801" "2026-8-1" → "2026-08-01" (틀리면 null)
function normalizeDate(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  let y: number, m: number, d: number;
  const parts = raw.split(/\D+/).filter(Boolean);
  if (parts.length === 3 && parts[0].length === 4) {
    [y, m, d] = parts.map(Number);
  } else if (digits.length === 8) {
    [y, m, d] = [Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8))];
  } else return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 소비기한 상태 → 라벨/색
function expiryState(dl: number): { label: string; tone: 'danger' | 'orange' | 'neutral' | 'green' } {
  if (dl < 0) return { label: `${-dl}일 지남`, tone: 'danger' };
  if (dl === 0) return { label: '오늘까지', tone: 'danger' };
  if (dl === 1) return { label: '내일까지', tone: 'orange' };
  if (dl <= 3) return { label: `D-${dl}`, tone: 'orange' };
  return { label: `D-${dl}`, tone: 'green' };
}

// [재료 선택 드롭다운]
// 예전엔 HTML <select> 태그를 그대로 썼는데, 앱(React Native)에는 그런 태그가 없어서
// 이 화면을 열자마자 렌더링이 터지고 앱 전체가 흰 화면이 됐다(강제 재시작).
// 웹·앱 모두에서 동작하는 순수 RN 컴포넌트로 다시 만든다.
function IngredientSelect({
  items,
  value,
  onChange,
}: {
  items: Ingredient[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => String(i.id) === value);

  return (
    <View style={styles.selectWrap}>
      <TouchableOpacity
        activeOpacity={0.8}
        style={styles.selectInput}
        onPress={() => setOpen((v) => !v)}
      >
        <Text
          numberOfLines={1}
          style={[styles.selectText, !selected && styles.selectPlaceholder]}
        >
          {selected ? `${selected.name} (${selected.unit})` : '재료 선택'}
        </Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={15}
          color={colors.mochaBrown}
        />
      </TouchableOpacity>

      {open && (
        <View style={styles.selectList}>
          {items.length === 0 ? (
            <Text style={styles.selectEmpty}>등록된 재료가 없어요. 재료 관리에서 먼저 추가해 주세요.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 190 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {items.map((ing) => {
                const active = String(ing.id) === value;
                return (
                  <TouchableOpacity
                    key={ing.id}
                    activeOpacity={0.7}
                    style={[styles.selectOption, active && styles.selectOptionActive]}
                    onPress={() => {
                      onChange(String(ing.id));
                      setOpen(false);
                    }}
                  >
                    <Text style={[styles.selectOptionText, active && styles.selectOptionTextActive]} numberOfLines={1}>
                      {ing.name} ({ing.unit})
                    </Text>
                    {active && <Ionicons name="checkmark" size={15} color={colors.pointOrange} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

export default function MenuScreen() {
  // [한글 주석: 전역 다국어 훅 연동]
  const { t, language } = useTranslation();
  const [tab, setTab] = useState<Tab>('menu');
  const [open, setOpen] = useState<number | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [allIngredients, setAllIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState(''); // 메뉴 이름 검색 (목록이 길어지면 스크롤로는 못 찾는다)

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [rows, setRows] = useState<NewRow[]>([{ ingredient_id: '', quantity: '' }]);

  // 매출 입력에서 방금 등록한 메뉴들 — 강조 표시 + 레시피 작성 유도
  const route = useRoute<RouteProp<RootStackParamList, 'Menu'>>();
  const focusMenuIds = useMemo(() => route.params?.focusMenuIds ?? [], [route.params]);
  const focusSet = useMemo(() => new Set(focusMenuIds), [focusMenuIds]);

  // 기존 메뉴의 레시피 편집(설정)용 — 새 메뉴 추가 폼과 상태를 분리한다
  const [editingMenu, setEditingMenu] = useState<Menu | null>(null);
  const [editRows, setEditRows] = useState<NewRow[]>([]);

  // 디저트 추가 폼 (메뉴 추가와 같은 바텀시트, 입력칸만 디저트용)
  const [dName, setDName] = useState('');
  const [dSell, setDSell] = useState('');
  const [dBuy, setDBuy] = useState('');
  const [dQty, setDQty] = useState('');
  const [dExpiry, setDExpiry] = useState('');

  // 입고 폼 (디저트 카드에서 진입)
  const [stockFor, setStockFor] = useState<Menu | null>(null);
  const [sQty, setSQty] = useState('');
  const [sExpiry, setSExpiry] = useState('');

  const {
    ready: dessertReady,
    batches,
    wastes,
    buyPriceOf,
    markDessert,
    unmarkDessert,
    addBatch,
    sell,
    waste,
    legacy,
    applyLegacy,
  } = useDesserts();

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

  // [1회 이관] 예전 '디저트 관리' 탭에 로컬로만 남아 있던 디저트를 메뉴로 옮겨 심는다.
  // 옮기고 나면 디저트도 메뉴와 똑같이 서버가 원본이 된다.
  const migrating = useRef(false);
  useEffect(() => {
    if (!dessertReady || !legacy || !token || loading || migrating.current) return;
    migrating.current = true;
    (async () => {
      const idMap: Record<string, number> = {};
      const buyPrices: Record<string, number> = {};
      try {
        const headers = await getAuthHeaders();
        for (const d of legacy.desserts) {
          try {
            const created = await apiFetch<{ id: number }>('/api/v1/inventory/menus', {
              method: 'POST',
              headers,
              body: JSON.stringify({ name: d.name, selling_price: d.sellPrice, recipes: [] }),
            });
            idMap[d.id] = created.id;
            buyPrices[d.id] = d.buyPrice;
          } catch (e) {
            console.error('디저트 → 메뉴 이관 실패:', d.name, e);
          }
        }
      } finally {
        const moved = Object.keys(idMap).length;
        if (moved > 0) {
          applyLegacy(idMap, buyPrices);
          await fetchData();
          toast('디저트 이동 완료', `기존 디저트 ${moved}개를 메뉴 관리로 옮겼어요.`);
        }
        migrating.current = false;
      }
    })();
  }, [dessertReady, legacy, token, loading]);

  const setRow = (i: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { ingredient_id: '', quantity: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  // ── 기존 메뉴 레시피 편집(설정) ──
  const openRecipeEditor = (m: Menu) => {
    setEditingMenu(m);
    setEditRows(
      (m.recipes ?? []).length
        ? m.recipes.map((r) => ({ ingredient_id: String(r.ingredient_id), quantity: String(r.quantity) }))
        : [{ ingredient_id: '', quantity: '' }],
    );
  };
  const setEditRow = (i: number, patch: Partial<NewRow>) =>
    setEditRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addEditRow = () => setEditRows((prev) => [...prev, { ingredient_id: '', quantity: '' }]);
  const removeEditRow = (i: number) => setEditRows((prev) => prev.filter((_, idx) => idx !== i));

  // 기존 메뉴에 레시피 설정/교체 → 저장부터 재고 차감이 켜진다
  const submitRecipe = async () => {
    if (!editingMenu) return;
    const recipeData = editRows
      .filter((r) => r.ingredient_id !== '' && r.quantity.trim() !== '')
      .map((r) => ({ ingredient_id: parseInt(r.ingredient_id, 10), quantity: parseFloat(r.quantity) }));

    const headers = await getAuthHeaders();
    if (!('Authorization' in headers)) {
      toast('로그인이 필요해요', '로그아웃 후 다시 로그인해 주세요.');
      return;
    }
    const label = editingMenu.name;
    try {
      await apiFetch(`/api/v1/inventory/menus/${editingMenu.id}/recipes`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ recipes: recipeData }),
      });
      setEditingMenu(null);
      setEditRows([]);
      await fetchData();
      toast(
        '레시피 저장 완료',
        recipeData.length
          ? `${label} 레시피를 저장했어요. 이제 판매하면 재고가 자동 차감돼요.`
          : `${label} 레시피를 비웠어요. (재고 차감 안 함)`,
      );
    } catch (e) {
      console.error('레시피 설정 실패:', e);
      toast('레시피 저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 매출 입력에서 넘어온 경우: 메뉴 탭으로 전환하고, 방금 등록한(레시피 없는) 첫 메뉴의
  // 레시피 편집기를 자동으로 열어 '레시피 작성'으로 바로 유도한다.
  const autoFocusedOnce = useRef(false);
  useEffect(() => {
    if (autoFocusedOnce.current || loading || focusMenuIds.length === 0 || menus.length === 0) return;
    autoFocusedOnce.current = true;
    setTab('menu');
    const first = menus.find((m) => focusSet.has(m.id));
    if (first) {
      setOpen(first.id);
      if ((first.recipes ?? []).length === 0) openRecipeEditor(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, menus, focusMenuIds]);

  const canSubmit = name.trim() !== '' && price.trim() !== '';
  const canSubmitDessert = dName.trim() !== '' && dSell.trim() !== '' && dBuy.trim() !== '';

  // 메뉴 삭제 (확인 후) — 204 응답이라 raw fetch 사용
  const remove = (m: Menu, isDessert: boolean) => {
    const message = isDessert
      ? `'${m.name}' 디저트를 삭제할까요? 재고(소비기한) 기록도 함께 제거됩니다. (폐기 집계는 유지)`
      : `'${m.name}' 메뉴를 삭제할까요? 레시피 구성도 함께 제거됩니다.`;
    confirmDialog(message, {
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
          if (isDessert) unmarkDessert(m.id);
          await fetchData();
          toast('삭제 완료', `${m.name} ${isDessert ? '디저트' : '메뉴'}를 삭제했어요.`);
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

  // 5-2. [디저트 추가] 메뉴 등록과 같은 API를 쓰고(레시피 없음), 매입가·첫 입고만 로컬에 붙인다.
  const submitDessert = async () => {
    const s = toNum(dSell);
    const b = toNum(dBuy);
    if (s <= 0 || b <= 0) {
      toast('추가 실패', '판매가와 매입가를 입력해 주세요.');
      return;
    }
    const q = toNum(dQty);
    let iso: string | null = null;
    if (q > 0 || dExpiry.trim() !== '') {
      iso = normalizeDate(dExpiry);
      if (q <= 0 || !iso) {
        toast('추가 실패', '첫 입고를 넣으려면 수량과 소비기한을 모두 올바르게 입력해 주세요.');
        return;
      }
    }

    const headers = await getAuthHeaders();
    if (!('Authorization' in headers)) {
      toast('로그인이 필요해요', '로그아웃 후 다시 로그인해 주세요.');
      return;
    }
    try {
      const created = await apiFetch<{ id: number }>('/api/v1/inventory/menus', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: dName.trim(), selling_price: s, recipes: [] }),
      });
      markDessert(created.id, b);
      if (iso && q > 0) addBatch(created.id, q, iso);
      const label = dName.trim();
      setDName('');
      setDSell('');
      setDBuy('');
      setDQty('');
      setDExpiry('');
      setAdding(false);
      await fetchData();
      toast('추가 완료', `${label} 디저트를 등록했어요. (마진 ${won(s - b)})`);
    } catch (e) {
      console.error('디저트 등록 실패:', e);
      toast('추가 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 5-3. [디저트 입고] 수량 + 소비기한 배치 추가
  const submitStock = () => {
    if (!stockFor) return;
    const q = toNum(sQty);
    if (q <= 0) return toast('입고', '수량을 입력해 주세요.');
    const iso = normalizeDate(sExpiry);
    if (!iso) return toast('입고', '소비기한을 올바르게 입력해 주세요. (예: 2026-07-25)');
    addBatch(stockFor.id, q, iso);
    toast('입고 완료', `${stockFor.name} ${q}개 · 소비기한 ${iso}`);
    setStockFor(null);
    setSQty('');
    setSExpiry('');
  };

  // 재료 조회는 레시피 줄마다 일어난다 — 배열 find(O(n))를 매번 돌면 메뉴·재료가 늘수록
  // 렌더가 눈에 띄게 느려진다. id → 재료 맵을 한 번만 만들어 O(1) 조회로 바꾼다.
  const ingredientById = useMemo(
    () => new Map(allIngredients.map((i) => [i.id, i])),
    [allIngredients],
  );

  // 6. [실시간 단가 계산 공식]
  // 단재료의 단위(unit)가 kg이나 L인 대용량 벌크 제품이면, 그람(g)/밀리리터(ml) 환산을 위해 단가를 1,000으로 나눈 뒤 소요량을 곱합니다.
  const getIngredientCost = (ingId: number, qty: number) => {
    const ing = ingredientById.get(ingId);
    if (!ing) return 0;
    const unitLower = (ing.unit ?? '').toLowerCase();

    if (unitLower === 'kg' || unitLower === 'l' || unitLower === '팩' || unitLower === '병') {
      return Math.round((ing.current_price / 1000) * qty);
    }
    return Math.round(ing.current_price * qty);
  };

  // 디저트로 표시된 메뉴는 디저트 탭에서만 보여 준다 (메뉴 탭은 음료·일반 메뉴)
  const allPlainMenus = useMemo(() => menus.filter((m) => buyPriceOf(m.id) == null), [menus, buyPriceOf]);
  // 메뉴가 수십 개인 매장에서 스크롤로 찾는 건 고역이다 — 이름 검색으로 바로 좁힌다
  const plainMenus = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? allPlainMenus.filter((m) => m.name.toLowerCase().includes(q)) : allPlainMenus;
    if (focusSet.size === 0) return list;
    // 방금 등록한 메뉴를 맨 위로 — 스크롤 없이 바로 눈에 띄게 (원래 순서는 유지)
    return [...list].sort((a, b) => Number(focusSet.has(b.id)) - Number(focusSet.has(a.id)));
  }, [allPlainMenus, query, focusSet]);
  const dessertMenus = useMemo(() => menus.filter((m) => buyPriceOf(m.id) != null), [menus, buyPriceOf]);

  const ym = todayISO().slice(0, 7);

  // 이번 달 폐기 손실 (금액·수량·메뉴별)
  const monthWaste = useMemo(() => {
    const rows = wastes.filter((w) => w.date.startsWith(ym));
    return {
      total: rows.reduce((s, w) => s + w.qty * w.unitCost, 0),
      count: rows.reduce((s, w) => s + w.qty, 0),
      qtyByMenu: rows.reduce<Record<number, number>>((acc, w) => {
        acc[w.menuId] = (acc[w.menuId] ?? 0) + w.qty;
        return acc;
      }, {}),
      amountByName: rows.reduce<Record<string, number>>((acc, w) => {
        acc[w.name] = (acc[w.name] ?? 0) + w.qty * w.unitCost;
        return acc;
      }, {}),
    };
  }, [wastes, ym]);
  const topWasteName = Object.entries(monthWaste.amountByName).sort((a, b) => b[1] - a[1])[0]?.[0];

  // 디저트 카드 데이터 — 마진 큰 순(= 예전 '마진 순위')으로 정렬
  const dessertRows = useMemo(() => {
    return dessertMenus
      .map((m) => {
        const buyPrice = buyPriceOf(m.id) ?? 0;
        const sellPrice = m.selling_price ?? 0;
        const margin = sellPrice - buyPrice;
        const rate = sellPrice > 0 ? Math.round((margin / sellPrice) * 100) : 0;
        const bs = batches
          .filter((b) => b.menuId === m.id)
          .sort((a, b) => daysLeft(a.expiry) - daysLeft(b.expiry));
        const stock = bs.reduce((s, b) => s + b.qty, 0);
        const wasteCnt = monthWaste.qtyByMenu[m.id] ?? 0;
        return {
          menu: m,
          buyPrice,
          sellPrice,
          margin,
          rate,
          batches: bs,
          stock,
          nearest: bs.length ? daysLeft(bs[0].expiry) : null,
          wasteCnt,
          drop: rate < 35 && wasteCnt >= 3, // 마진 낮고 폐기 잦음 → 뺄지 고민 신호
        };
      })
      .sort((a, b) => b.margin - a.margin);
  }, [dessertMenus, batches, buyPriceOf, monthWaste]);

  // 소비기한 임박(오늘/내일/지남) 배치 — 오래된 순
  const urgent = useMemo(() => {
    const nameById = Object.fromEntries(menus.map((m) => [m.id, m.name]));
    return batches
      .filter((b) => buyPriceOf(b.menuId) != null)
      .map((b) => ({ ...b, dl: daysLeft(b.expiry), name: nameById[b.menuId] ?? '(삭제됨)' }))
      .filter((b) => b.dl <= 1)
      .sort((a, b) => a.dl - b.dl);
  }, [batches, menus, buyPriceOf]);

  const isDessertTab = tab === 'dessert';
  const addLabel = isDessertTab
    ? language === 'en' ? '+ Add Dessert' : '+ 디저트 추가'
    : language === 'en' ? '+ Add Menu' : '+ 메뉴 추가';

  return (
    <>
      <Screen>
        <ScreenTitle title={t('menuMgmtTitle')} subtitle={t('menuMgmtSub')} />

        {/* 메뉴 / 디저트 — 같은 화면, 같은 방식 */}
        <Segmented<Tab>
          options={[
            { value: 'menu', label: language === 'en' ? `Menu ${allPlainMenus.length}` : `메뉴 ${allPlainMenus.length}` },
            { value: 'dessert', label: language === 'en' ? `Dessert ${dessertMenus.length}` : `디저트 ${dessertMenus.length}` },
          ]}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setOpen(null);
          }}
        />

        {/* 메뉴판 사진으로 일괄 등록 — 메뉴 탭에서만.
            한 개씩 손으로 넣기 전에 이 방법이 있다는 걸 먼저 보여준다 */}
        {!isDessertTab && <MenuBoardScan onDone={fetchData} />}

        <Button label={addLabel} variant="secondary" onPress={() => setAdding(true)} />

        {/* 메뉴 검색 — 메뉴 탭에서 항목이 8개를 넘을 때만 (적으면 오히려 방해) */}
        {!isDessertTab && allPlainMenus.length > 8 && (
          <View style={styles.searchBox}>
            <Ionicons name="search" size={15} color={colors.mochaBrown} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="메뉴 이름으로 찾기"
              placeholderTextColor={colors.mochaBrown}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.mochaBrown} />
              </TouchableOpacity>
            )}
          </View>
        )}

        {loading ? (
          <View style={{ paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.espressoBrown} />
            <Text style={{ textAlign: 'center', marginTop: 10, color: colors.mochaBrown }}>
              {language === 'en' ? 'Syncing data...' : '데이터를 동기화하고 있어요...'}
            </Text>
          </View>
        ) : isDessertTab ? (
          <>
            {/* 소비기한 임박 알림 + 이번 달 폐기 손실 — 디저트에만 있는 두 가지 */}
            <Card tone="cream">
              <View style={styles.rowBetween}>
                <Text style={styles.cardHead}>{language === 'en' ? 'Expiring soon' : '소비기한 임박'}</Text>
                <Badge label={`${urgent.length}${language === 'en' ? '' : '건'}`} tone={urgent.length ? 'danger' : 'neutral'} />
              </View>
              {urgent.length === 0 ? (
                <Text style={styles.empty}>
                  {language === 'en' ? 'Nothing near its expiry date ☕' : '임박한 디저트가 없어요. 여유롭게 판매하세요 ☕'}
                </Text>
              ) : (
                <View style={{ marginTop: 10, gap: 10 }}>
                  {urgent.map((b) => {
                    const st = expiryState(b.dl);
                    return (
                      <View key={b.id} style={styles.urgentRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.urgentText}>
                            {st.label} 팔아야 할 <Text style={styles.urgentName}>{b.name} {b.qty}개</Text>
                          </Text>
                          <Text style={styles.urgentSub}>소비기한 {b.expiry}</Text>
                        </View>
                        <PressableScale style={[styles.miniBtn, styles.sellBtn]} onPress={() => sell(b.id, 1)} to={0.9}>
                          <Text style={styles.sellBtnText}>판매 −1</Text>
                        </PressableScale>
                        <PressableScale
                          style={[styles.miniBtn, styles.wasteBtn]}
                          onPress={() =>
                            confirmDialog(`${b.name} 1개를 폐기로 기록할까요? (손실에 반영)`, {
                              confirmLabel: '폐기',
                              destructive: true,
                              onConfirm: () => waste(b.id, 1, b.name),
                            })
                          }
                          to={0.9}
                        >
                          <Text style={styles.wasteBtnText}>폐기</Text>
                        </PressableScale>
                      </View>
                    );
                  })}
                </View>
              )}
              <Divider style={{ marginTop: 12 }} />
              <View style={[styles.rowBetween, { marginTop: 10 }]}>
                <Text style={styles.wasteLabel}>이번 달 폐기로 나간 돈</Text>
                <Text style={styles.wasteMoney}>{won(monthWaste.total)}</Text>
              </View>
              <Text style={styles.wasteSub}>
                폐기 {monthWaste.count}개{topWasteName ? ` · 가장 많이 버린 건 ‘${topWasteName}’` : ''}
              </Text>
            </Card>

            {dessertRows.length === 0 ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Ionicons name="ice-cream-outline" size={48} color={colors.mutedSand} />
                <Text style={{ marginTop: 10, color: colors.mochaBrown, ...typography.L4, textAlign: 'center' }}>
                  {language === 'en'
                    ? 'No registered desserts. Please add a new dessert.'
                    : '등록된 디저트가 없습니다. 새 디저트를 추가해 주세요.'}
                </Text>
              </View>
            ) : (
              dessertRows.map((d, i) => {
                const expanded = open === d.menu.id;
                const near = d.nearest != null ? expiryState(d.nearest) : null;
                return (
                  <Card key={d.menu.id}>
                    <View style={styles.row}>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => setOpen(expanded ? null : d.menu.id)}
                        style={styles.headerHit}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.name}>
                            <Text style={styles.rankNum}>{i + 1}. </Text>
                            {d.menu.name}
                          </Text>
                          <Text style={styles.sub}>
                            판매가 {won(d.sellPrice)} · 매입가 {won(d.buyPrice)} · 마진 {won(d.margin)}
                          </Text>
                          <View style={styles.chipRow}>
                            <Badge label={`재고 ${d.stock}개`} tone="neutral" />
                            {near ? <Badge label={near.label} tone={near.tone === 'green' ? 'neutral' : near.tone} /> : null}
                            {d.wasteCnt > 0 ? <Badge label={`이번 달 폐기 ${d.wasteCnt}개`} tone="danger" /> : null}
                          </View>
                        </View>
                        <Badge label={`마진율 ${d.rate}%`} tone={d.rate < 35 ? 'danger' : 'green'} />
                        <Ionicons
                          name={expanded ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={colors.mochaBrown}
                          style={{ marginLeft: 6 }}
                        />
                      </TouchableOpacity>
                      <PressableScale style={styles.delBtn} onPress={() => remove(d.menu, true)} to={0.88}>
                        <Ionicons name="trash-outline" size={18} color="#B23B2E" />
                      </PressableScale>
                    </View>

                    {d.drop ? (
                      <View style={styles.dropFlag}>
                        <Ionicons name="alert-circle" size={13} color="#B23B2E" />
                        <Text style={styles.dropText}>마진 낮고 폐기 많음 — 메뉴에서 빼는 것 고려</Text>
                      </View>
                    ) : null}

                    {expanded && (
                      <View style={styles.recipe}>
                        <Text style={styles.recipeTitle}>재고 · 소비기한</Text>
                        {d.batches.length === 0 ? (
                          <Text style={styles.empty}>입고된 수량이 없어요. 아래 ‘입고’로 소비기한을 등록하세요.</Text>
                        ) : (
                          d.batches.map((b) => {
                            const st = expiryState(daysLeft(b.expiry));
                            return (
                              <View key={b.id} style={styles.stockRow}>
                                <Badge label={st.label} tone={st.tone === 'green' ? 'neutral' : st.tone} />
                                <Text style={styles.stockQty}>{b.qty}개</Text>
                                <Text style={styles.stockExp}>~{b.expiry}</Text>
                                <View style={{ flex: 1 }} />
                                <PressableScale style={[styles.miniBtn, styles.sellBtn]} onPress={() => sell(b.id, 1)} to={0.9}>
                                  <Text style={styles.sellBtnText}>판매</Text>
                                </PressableScale>
                                <PressableScale
                                  style={[styles.miniBtn, styles.wasteBtn]}
                                  onPress={() =>
                                    confirmDialog(`${d.menu.name} 1개를 폐기로 기록할까요? (손실에 반영)`, {
                                      confirmLabel: '폐기',
                                      destructive: true,
                                      onConfirm: () => waste(b.id, 1, d.menu.name),
                                    })
                                  }
                                  to={0.9}
                                >
                                  <Text style={styles.wasteBtnText}>폐기</Text>
                                </PressableScale>
                              </View>
                            );
                          })
                        )}
                        <Divider />
                        <View style={styles.recipeRow}>
                          <Text style={[styles.recipeName, { fontWeight: '700' }]}>개당 마진</Text>
                          <Text style={styles.recipeCost}>{won(d.margin)}</Text>
                        </View>
                        <TouchableOpacity
                          style={styles.addRow}
                          onPress={() => {
                            setStockFor(d.menu);
                            setSQty('');
                            setSExpiry('');
                          }}
                        >
                          <Ionicons name="add" size={16} color={colors.pointOrange} />
                          <Text style={styles.addRowText}>입고 (수량 · 소비기한)</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </Card>
                );
              })
            )}
          </>
        ) : plainMenus.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <Ionicons name="cafe-outline" size={48} color={colors.mutedSand} />
            <Text style={{ marginTop: 10, color: colors.mochaBrown, ...typography.L4 }}>
              {language === 'en' ? 'No registered menus. Please add a new menu.' : '등록된 메뉴가 없습니다. 새 메뉴를 추가해 주세요.'}
            </Text>
          </View>
        ) : (
          plainMenus.map((m) => {
            // [방어] 특정 메뉴의 recipes/selling_price가 누락/null이면 렌더 중 크래시(앱 종료)로 이어진다.
            // 참조가 깨진(재료 삭제 등) 데이터에도 화면이 죽지 않도록 안전한 기본값으로 정규화한다.
            const recipes = m.recipes ?? [];
            const sellingPrice = m.selling_price ?? 0;
            // 백엔드가 실시간 계산해 준 원가와 원가율을 최우선 매핑하고, 없으면 로컬 폴백 연산합니다.
            const cost = m.cost_price != null ? m.cost_price : recipes.reduce((s, r) => s + getIngredientCost(r.ingredient_id, r.quantity), 0);
            const rate = m.cost_ratio != null ? m.cost_ratio : (sellingPrice ? Math.round((cost / sellingPrice) * 100) : 0);
            const expanded = open === m.id;
            const isFocused = focusSet.has(m.id);   // 매출 입력에서 방금 등록한 메뉴
            const noRecipe = recipes.length === 0;
            return (
              <Card key={m.id} style={isFocused ? styles.focusCard : undefined}>
                <View style={styles.row}>
                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={() => setOpen(expanded ? null : m.id)}
                    style={styles.headerHit}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
                        {isFocused && <Badge label="방금 추가됨" tone="orange" />}
                      </View>
                      <Text style={styles.sub}>
                        판매가 ₩{sellingPrice.toLocaleString()} · 원가 ₩{cost.toLocaleString()}
                      </Text>
                      {noRecipe && (
                        <Text style={styles.noRecipeHint}>
                          레시피 없음 — 판매해도 재고가 안 빠져요. 아래 ‘레시피 추가’로 연결하세요.
                        </Text>
                      )}
                    </View>
                    {/* 원가율 색은 원가 분석 화면과 같은 기준(음료 22% / 디저트 35%)을 쓴다 */}
                    <Badge label={`원가율 ${rate}%`} tone={GRADE_TONE[gradeOf(rate, categoryOfMenu(m.name))]} />
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={colors.mochaBrown}
                      style={{ marginLeft: 6 }}
                    />
                  </TouchableOpacity>
                  <PressableScale style={styles.delBtn} onPress={() => remove(m, false)} to={0.88}>
                    <Ionicons name="trash-outline" size={18} color="#B23B2E" />
                  </PressableScale>
                </View>

                {expanded && (
                  <View style={styles.recipe}>
                    <Text style={styles.recipeTitle}>레시피 구성 재료</Text>
                    {noRecipe ? (
                      <Text style={styles.empty}>아직 레시피가 없어요. 아래 ‘레시피 추가’로 재료를 연결하면 판매 시 재고가 자동 차감돼요.</Text>
                    ) : (
                      recipes.map((r, i) => {
                        const itemCost = getIngredientCost(r.ingredient_id, r.quantity);
                        return (
                          <View key={i} style={styles.recipeRow}>
                            <Text style={styles.recipeName}>{r.ingredient_name}</Text>
                            <Text style={styles.recipeAmount}>{r.quantity}{r.unit}</Text>
                            <Text style={styles.recipeCost}>₩{itemCost.toLocaleString()}</Text>
                          </View>
                        );
                      })
                    )}
                    {!noRecipe && (
                      <>
                        <Divider />
                        <View style={styles.recipeRow}>
                          <Text style={[styles.recipeName, { fontWeight: '700' }]}>원가 합계</Text>
                          <Text style={styles.recipeCost}>₩{cost.toLocaleString()}</Text>
                        </View>
                      </>
                    )}
                    <TouchableOpacity style={styles.addRow} onPress={() => openRecipeEditor(m)}>
                      <Ionicons name="create-outline" size={16} color={colors.pointOrange} />
                      <Text style={styles.addRowText}>{noRecipe ? '레시피 추가' : '레시피 편집'}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Card>
            );
          })
        )}
      </Screen>

      {/* 메뉴 추가 — 이름·판매가·레시피 */}
      <FormSheet
        visible={adding && !isDessertTab}
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
            {/* 웹·앱 공용 재료 드롭다운 (HTML select 대신 RN 컴포넌트) */}
            <IngredientSelect
              items={allIngredients}
              value={r.ingredient_id}
              onChange={(id) => setRow(i, { ingredient_id: id })}
            />

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

      {/* 기존 메뉴 레시피 설정/편집 — 매출 파일에서 이름만 등록된 메뉴에 레시피를 붙여 재고 차감을 켠다 */}
      <FormSheet
        visible={editingMenu != null}
        title={editingMenu ? `${editingMenu.name} 레시피` : '레시피'}
        onClose={() => setEditingMenu(null)}
        onSubmit={submitRecipe}
        submitLabel="레시피 저장"
      >
        <Text style={styles.formLabel}>이 메뉴 1잔에 들어가는 재료와 소요량</Text>
        {editRows.map((r, i) => (
          <View key={i} style={styles.formRow}>
            <IngredientSelect
              items={allIngredients}
              value={r.ingredient_id}
              onChange={(id) => setEditRow(i, { ingredient_id: id })}
            />
            <TextInput
              style={[styles.formInput, { flex: 1 }]}
              value={r.quantity}
              onChangeText={(t) => setEditRow(i, { quantity: t })}
              placeholder="소요량"
              placeholderTextColor={colors.mochaBrown}
              keyboardType="numeric"
            />
            {editRows.length > 1 && (
              <TouchableOpacity onPress={() => removeEditRow(i)} hitSlop={6}>
                <Ionicons name="close-circle" size={20} color={colors.mochaBrown} />
              </TouchableOpacity>
            )}
          </View>
        ))}
        <TouchableOpacity style={styles.addRow} onPress={addEditRow}>
          <Ionicons name="add" size={16} color={colors.pointOrange} />
          <Text style={styles.addRowText}>재료 추가</Text>
        </TouchableOpacity>
      </FormSheet>

      {/* 디저트 추가 — 완제품 사입이라 레시피 대신 매입가·소비기한 */}
      <FormSheet
        visible={adding && isDessertTab}
        title="디저트 추가"
        onClose={() => setAdding(false)}
        onSubmit={submitDessert}
        submitDisabled={!canSubmitDessert}
      >
        <LabeledInput label="디저트명" value={dName} onChangeText={setDName} placeholder="예: 티라미수" />
        <LabeledInput
          label="판매가 (원)"
          value={dSell}
          onChangeText={setDSell}
          placeholder="예: 6500"
          keyboardType="number-pad"
        />
        <LabeledInput
          label="매입가 (원)"
          value={dBuy}
          onChangeText={setDBuy}
          placeholder="예: 3200"
          keyboardType="number-pad"
        />

        <Text style={styles.formLabel}>첫 입고 (선택 — 나중에 카드에서 추가해도 돼요)</Text>
        <LabeledInput label="수량" value={dQty} onChangeText={setDQty} placeholder="예: 5" keyboardType="number-pad" />
        <LabeledInput label="소비기한" value={dExpiry} onChangeText={setDExpiry} placeholder="예: 2026-07-25" />
      </FormSheet>

      {/* 디저트 입고 */}
      <FormSheet
        visible={stockFor != null}
        title={stockFor ? `${stockFor.name} 입고` : '입고'}
        onClose={() => setStockFor(null)}
        onSubmit={submitStock}
        submitLabel="입고하기"
        submitDisabled={sQty.trim() === '' || sExpiry.trim() === ''}
      >
        <LabeledInput label="수량" value={sQty} onChangeText={setSQty} placeholder="예: 5" keyboardType="number-pad" />
        <LabeledInput label="소비기한" value={sExpiry} onChangeText={setSExpiry} placeholder="예: 2026-07-25" />
      </FormSheet>
    </>
  );
}



const styles = StyleSheet.create({
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchInput: { flex: 1, ...typography.L4, color: colors.espressoBrown, padding: 0 },
  selectWrap: { flex: 2 },
  selectInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  selectText: { flex: 1, ...typography.L5, color: colors.espressoBrown },
  selectPlaceholder: { color: colors.mochaBrown },
  selectList: {
    marginTop: 4,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    overflow: 'hidden',
  },
  selectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.creamSand,
  },
  selectOptionActive: { backgroundColor: colors.creamSand },
  selectOptionText: { flex: 1, ...typography.L5, color: colors.espressoBrown },
  selectOptionTextActive: { color: colors.pointOrange, fontWeight: '700' },
  selectEmpty: { ...typography.L5, color: colors.mochaBrown, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerHit: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  delBtn: { padding: 8, borderRadius: 10, backgroundColor: 'rgba(178,59,46,0.08)' },

  // 매출 입력에서 방금 등록한 메뉴 강조
  focusCard: { borderWidth: 1.5, borderColor: colors.pointOrange, backgroundColor: '#FFF7EE' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  noRecipeHint: { ...typography.L5, color: colors.pointOrange, fontWeight: '600', marginTop: 4 },

  name: { ...typography.L3, color: colors.espressoBrown },
  sub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  recipe: { marginTop: 14, backgroundColor: colors.creamSand, borderRadius: 12, padding: 12, gap: 8 },
  recipeTitle: { ...typography.L5, color: colors.mochaBrown, marginBottom: 2 },
  recipeRow: { flexDirection: 'row', alignItems: 'center' },
  recipeName: { ...typography.L5, color: colors.espressoBrown, flex: 1 },
  recipeAmount: { ...typography.L5, color: colors.mochaBrown, width: 60, textAlign: 'right' },
  recipeCost: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', width: 70, textAlign: 'right' },
  formLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 8, marginTop: 4 },
  // 드롭다운이 펼쳐지면 세로로 길어지므로 위쪽 기준 정렬 (소요량 칸이 아래로 딸려가지 않게)
  formRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 8 },
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

  // ── 디저트 전용 ──────────────────────────────
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHead: { ...typography.L3, color: colors.espressoBrown },
  empty: { ...typography.L5, color: colors.mochaBrown, marginTop: 10, lineHeight: 17 },
  rankNum: { color: colors.mochaBrown },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },

  urgentRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  urgentText: { ...typography.L4, color: colors.espressoBrown },
  urgentName: { fontWeight: '900', color: '#B23B2E' },
  urgentSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  wasteLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  wasteMoney: { ...typography.L3, color: '#B23B2E', fontWeight: '900' },
  wasteSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },

  stockRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stockQty: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  stockExp: { ...typography.L5, color: colors.mochaBrown },

  miniBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9 },
  sellBtn: { backgroundColor: colors.espressoBrown },
  sellBtnText: { ...typography.L5, color: colors.white, fontWeight: '800' },
  wasteBtn: { backgroundColor: '#F6DED8' },
  wasteBtnText: { ...typography.L5, color: '#B23B2E', fontWeight: '800' },

  dropFlag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F7E7E3', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, marginTop: 8, alignSelf: 'flex-start',
  },
  dropText: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },
});
