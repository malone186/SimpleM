// 메뉴판 사진으로 메뉴 등록 (백엔드 B)
//
// 원가를 보려면 메뉴와 레시피가 있어야 한다. 그런데 손으로 넣으면 메뉴 30개 × 재료 3개 =
// 90번을 입력해야 해서, 사장님은 첫 원가를 보기도 전에 앱을 닫는다.
// 메뉴판은 어느 매장에나 이미 붙어 있으니 찍기만 하면 되게 했다.
//
// 흐름: 사진 고르기 → 인식(초안) → 확인·수정 → 등록
// 확인 단계를 건너뛰지 않는 이유: 레시피는 '업계 통상치 추정'이라 그대로 저장하면
// 원가가 틀린 줄도 모르고 쓰게 된다.
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { analyzeMenuBoard, confirmMenuBoard, type MenuBoardCandidate, type MenuBoardDraft, type MenuBoardMenu, type MenuBoardRecipe } from '../../lib/api/ocr';
import { showAlert } from '../../lib/ui/alert';
import { applyCandidate, applyPresetQuantity, buildPayload, countNeedQty, countPending, parseQty } from './menuBoardDraft';
import { colors, spacing, typography } from '../../theme';
import { Button, Card } from '../ui';
import { PressableScale } from '../motion';

const ACCENT = '#C07030'; // colors.pointOrange는 이름과 달리 지금 값이 거의 검정이라 강조가 안 된다

export default function MenuBoardScan({ onDone }: { onDone: () => void }) {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<MenuBoardDraft | null>(null);
  // 등록에서 제외할 메뉴 (이미 있는 메뉴는 처음부터 빠져 있다)
  const [skip, setSkip] = useState<Set<string>>(new Set());

  const pick = async (from: 'camera' | 'library') => {
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showAlert('카메라 권한이 필요해요', '설정에서 카메라 권한을 켜 주세요.');
          return;
        }
      }
      const picked =
        from === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (picked.canceled || !picked.assets?.[0]) return;

      setBusy(true);
      const a = picked.assets[0];
      const res = await analyzeMenuBoard(
        { uri: a.uri, mimeType: a.mimeType, fileName: a.fileName },
        token,
      );
      // 이미 등록된 메뉴는 기본으로 빼 둔다 — 두 번 찍어도 중복이 안 생긴다
      setSkip(new Set(res.menus.filter((m) => m.exists).map((m) => m.name)));
      setDraft(res);
    } catch (e: any) {
      showAlert('메뉴판을 읽지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  /** 레시피 한 줄을 고쳐 쓴다 (재료 선택 · 수량 수정) */
  const patchRecipe = (menuName: string, idx: number, patch: Partial<MenuBoardRecipe>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            menus: prev.menus.map((m) =>
              m.name !== menuName
                ? m
                : { ...m, recipes: m.recipes.map((r, i) => (i === idx ? { ...r, ...patch } : r)) },
            ),
          }
        : prev,
    );
  };

  /** 재료 후보를 고른다 — 고른 재료의 단위로 양도 함께 바꾼다.
   *  (원두를 kg으로 세는 매장과 g으로 세는 매장의 값이 다르다) */
  const chooseIngredient = (menuName: string, idx: number, c: MenuBoardCandidate) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            menus: prev.menus.map((m) =>
              m.name !== menuName
                ? m
                : { ...m, recipes: m.recipes.map((r, i) => (i === idx ? applyCandidate(r, c) : r)) },
            ),
          }
        : prev,
    );

  /** 사장님이 표준값을 고쳤다 (원두 18g → 20g).
   *  화면은 g·ml로 받고, 저장할 양은 매장 단위로 다시 환산한다. */
  const changePresetQty = (menuName: string, idx: number, q: number | null) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            menus: prev.menus.map((m) =>
              m.name !== menuName
                ? m
                : {
                    ...m,
                    recipes: m.recipes.map((r, i) => (i === idx ? applyPresetQuantity(r, q) : r)),
                  },
            ),
          }
        : prev,
    );

  const toggleSkip = (name: string) =>
    setSkip((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const targets = (draft?.menus ?? []).filter((m) => !skip.has(m.name));

  const submit = async () => {
    if (!targets.length) {
      showAlert('등록할 메뉴가 없어요', '등록할 메뉴를 하나 이상 선택해 주세요.');
      return;
    }
    setBusy(true);
    try {
      // 무엇을 거르는지는 buildPayload에 모아 두고 테스트로 고정했다
      const res = await confirmMenuBoard(buildPayload(draft?.menus ?? [], skip), token);
      // 경고는 반드시 보여준다 — 원가율 0%나 5000%가 말없이 저장되면 아무도 눈치채지 못한다
      const lines: string[] = [];
      if (res.skipped.length) lines.push(`이미 있던 ${res.skipped.length}개는 건너뛰었어요.`);
      if (res.warnings.length) lines.push('', '확인이 필요해요:', ...res.warnings.map((w) => `· ${w}`));
      if (!lines.length) lines.push('원가 분석에서 확인해 보세요.');

      showAlert(`메뉴 ${res.created.length}개를 등록했어요`, lines.join('\n'));
      setDraft(null);
      onDone();
    } catch (e: any) {
      showAlert('등록하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card tone="cream">
        <View style={styles.head}>
          <Ionicons name="scan-outline" size={18} color={colors.espressoBrown} />
          <Text style={styles.headText}>메뉴판 사진으로 한 번에 등록</Text>
        </View>
        <Text style={styles.desc}>
          메뉴판을 찍으면 메뉴·가격을 읽고 레시피까지 채워 둡니다. 확인하고 고치기만 하면 돼요.
        </Text>
        <View style={styles.btnRow}>
          <View style={styles.btnHalf}>
            <Button label="사진 찍기" variant="secondary" onPress={() => pick('camera')} disabled={busy} />
          </View>
          <View style={styles.btnHalf}>
            <Button label="앨범에서" variant="secondary" onPress={() => pick('library')} disabled={busy} />
          </View>
        </View>
        {busy && !draft && (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.espressoBrown} />
            <Text style={styles.busyText}>메뉴판을 읽고 있어요…</Text>
          </View>
        )}
      </Card>

      <Modal visible={!!draft} animationType="slide" transparent onRequestClose={() => setDraft(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>이렇게 읽었어요</Text>
              <Pressable onPress={() => setDraft(null)} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </Pressable>
            </View>

            <Text style={styles.notice}>
              레시피 양은 업계 통상치로 채운 <Text style={styles.noticeStrong}>추정값</Text>이에요.
              다르면 등록 후 메뉴 관리에서 고치면 됩니다.
            </Text>

            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: spacing.gridGap }}>
              {(draft?.menus ?? []).map((m) => (
                <MenuRow
                  key={m.name}
                  menu={m}
                  skipped={skip.has(m.name)}
                  onToggle={() => toggleSkip(m.name)}
                  onChoose={(idx, c) => chooseIngredient(m.name, idx, c)}
                  onQuantity={(idx, q) => patchRecipe(m.name, idx, { quantity: q })}
                  onPresetQty={(idx, q) => changePresetQty(m.name, idx, q)}
                />
              ))}
              {!!draft?.unknown_ingredients.length && (
                <Text style={styles.unknown}>
                  매장에 없는 재료: {draft.unknown_ingredients.join(', ')}
                  {'\n'}이 재료가 들어간 줄은 빠집니다. 재고에 먼저 등록하면 원가에 반영돼요.
                </Text>
              )}
            </ScrollView>

            <Button
              label={busy ? '등록 중…' : `메뉴 ${targets.length}개 등록`}
              onPress={submit}
              disabled={busy || !targets.length}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

/** 수량 입력칸. 지우고 다시 칠 수 있게 글자 상태를 안에서 따로 들고 있는다
 *  (숫자로만 들고 있으면 빈칸이 곧바로 0이 되어 지울 수가 없다). */
function QtyInput({
  value,
  unit,
  onChange,
}: {
  value: number | null;
  unit: string;
  onChange: (q: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));

  return (
    <View style={styles.qtyBox}>
      <TextInput
        style={[styles.qtyInput, value == null && styles.qtyEmpty]}
        value={text}
        onChangeText={(t) => {
          // 숫자와 소수점만 (원두 0.018kg처럼 소수가 필요하다)
          setText(t.replace(/[^0-9.]/g, ''));
          onChange(parseQty(t));
        }}
        keyboardType="decimal-pad"
        placeholder="양 입력"
        placeholderTextColor="#B9A896"
      />
      <Text style={styles.qtyUnit}>{unit}</Text>
    </View>
  );
}

function MenuRow({
  menu,
  skipped,
  onToggle,
  onChoose,
  onQuantity,
  onPresetQty,
}: {
  menu: MenuBoardMenu;
  skipped: boolean;
  onToggle: () => void;
  onChoose: (idx: number, c: MenuBoardCandidate) => void;
  onQuantity: (idx: number, q: number | null) => void;
  onPresetQty: (idx: number, q: number | null) => void;
}) {
  // 고를 게 남았는지 / 양을 넣어야 하는지 — 둘 다 원가에 안 들어가는 줄이다
  const pending = countPending(menu);
  const needQty = countNeedQty(menu);

  return (
    <View style={[styles.row, skipped && styles.rowOff]}>
      <PressableScale style={styles.rowHead} onPress={onToggle} to={0.98}>
        <Ionicons
          name={skipped ? 'square-outline' : 'checkbox'}
          size={20}
          color={skipped ? '#C4B5A5' : colors.espressoBrown}
        />
        <Text style={[styles.rowName, skipped && styles.strike]}>{menu.name}</Text>
        {menu.exists && <Text style={styles.tagExists}>이미 있음</Text>}
        {menu.recipe_source === 'ai' && <Text style={styles.tagAi}>AI 추정</Text>}
        <Text style={styles.rowPrice}>{menu.price ? `${menu.price.toLocaleString()}원` : '가격 없음'}</Text>
      </PressableScale>

      {!skipped &&
        menu.recipes.map((r, idx) => (
          <View key={`${r.ingredient}-${idx}`} style={styles.recipe}>
            {/* 양은 사장님이 아는 단위(g·ml)로 바로 고친다.
                재료를 고르기 전에도 고칠 수 있어야 한다 — '우리는 20g 써요'가 먼저 떠오른다. */}
            <View style={styles.recipeHead}>
              <Text style={styles.recipeName}>{r.ingredient}</Text>
              <QtyInput
                value={r.preset_quantity}
                unit={r.preset_unit}
                onChange={(q) => onPresetQty(idx, q)}
              />
            </View>

            {r.candidates.length ? (
              <>
                {/* 후보는 고른 뒤에도 계속 보여준다 — 잘못 골랐을 때 되돌릴 수 있어야 한다.
                    (후보가 하나뿐이라 자동으로 골라진 경우도 무엇에 연결됐는지 보인다) */}
                <View style={styles.chips}>
                  {r.candidates.map((c) => {
                    const on = c.id === r.ingredient_id;
                    return (
                      <PressableScale
                        key={c.id}
                        style={[styles.chip, on && styles.chipOn]}
                        onPress={() => onChoose(idx, c)}
                        to={0.94}
                      >
                        {on && <Ionicons name="checkmark" size={11} color={colors.white} />}
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.name}</Text>
                      </PressableScale>
                    );
                  })}
                </View>
                {/* 매장 단위로 얼마가 되는지 — 확인용으로만 보여준다.
                    '0.018kg'을 직접 치게 하면 자릿수를 틀리기 쉽다 */}
                {r.ingredient_id != null && (
                  <Text style={styles.converted}>
                    {r.quantity != null
                      ? `저장될 양 ${Number(r.quantity.toFixed(4))}${r.unit}`
                      : `이 재료는 1${r.unit}이 몇 ${r.preset_unit}인지 알 수 없어요 · 아래에 직접 넣어 주세요`}
                  </Text>
                )}
                {/* 환산이 안 되는 재료(팩·개인데 이름에 용량이 없음)만 매장 단위로 직접 입력 */}
                {r.ingredient_id != null && r.quantity == null && (
                  <View style={styles.qtyRow}>
                    <QtyInput
                      key={r.ingredient_id}
                      value={r.quantity}
                      unit={r.unit}
                      onChange={(q) => onQuantity(idx, q)}
                    />
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.missing}>매장에 없음 · 이 줄은 빠져요</Text>
            )}
          </View>
        ))}

      {!skipped && pending > 0 && (
        <Text style={styles.pending}>재료 {pending}개를 골라야 원가에 들어가요</Text>
      )}
      {!skipped && needQty > 0 && (
        <Text style={styles.pending}>양을 넣어야 하는 재료가 {needQty}개 있어요</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText: { ...typography.L3, fontWeight: '800', color: colors.espressoBrown },
  desc: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btnHalf: { flex: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'center' },
  busyText: { ...typography.L5, color: colors.mochaBrown },

  backdrop: { flex: 1, backgroundColor: colors.black40, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.globalPadding,
    maxHeight: '88%',
    gap: spacing.gridGap,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...typography.L2, fontWeight: '800', color: colors.espressoBrown },
  notice: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18 },
  noticeStrong: { fontWeight: '800', color: ACCENT },

  row: { backgroundColor: colors.white, borderRadius: 14, padding: 12, marginBottom: 8 },
  rowOff: { opacity: 0.5 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { ...typography.L4, fontWeight: '700', color: colors.espressoBrown, flexShrink: 1 },
  strike: { textDecorationLine: 'line-through' },
  rowPrice: { ...typography.L5, color: colors.espressoBrown, marginLeft: 'auto', fontWeight: '700' },
  tagExists: { ...typography.L5, color: colors.mochaBrown, backgroundColor: '#EFE9E1', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagAi: { ...typography.L5, color: ACCENT, backgroundColor: '#F7E9DC', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },

  recipe: { marginTop: 10, paddingLeft: 26 },
  recipeHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recipeName: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  presetHint: { color: '#A2917F' },
  // 매장 단위로 얼마가 되는지 — 확인용 (직접 치는 칸이 아니다)
  converted: { ...typography.L5, color: '#4E7D3A', marginTop: 3 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  qtyBox: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto',
    borderWidth: 1, borderColor: '#DCD2C6', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.white,
  },
  qtyInput: { ...typography.L5, color: colors.espressoBrown, minWidth: 54, padding: 0, textAlign: 'right' },
  qtyEmpty: { borderBottomWidth: 1, borderBottomColor: ACCENT },
  qtyUnit: { ...typography.L5, color: colors.mochaBrown },
  linked: { ...typography.L5, color: '#4E7D3A', marginTop: 2, flexShrink: 1 },
  missing: { ...typography.L5, color: '#B23B2E', marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderWidth: 1, borderColor: ACCENT, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  // 고른 재료 — 채워서 한눈에 구분되게 (다시 눌러 바꿀 수 있다)
  chipOn: { backgroundColor: ACCENT },
  chipText: { ...typography.L5, color: ACCENT, fontWeight: '700' },
  chipTextOn: { color: colors.white },
  pending: { ...typography.L5, color: ACCENT, marginTop: 8, fontWeight: '700' },

  unknown: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 4 },
});
