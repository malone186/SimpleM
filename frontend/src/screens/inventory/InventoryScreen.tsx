// 재고 (프론트 A) — PRD ERP-4/7, AI-2: 재고 조회 + 직접 등록 + 안전재고 알림 + OCR 입고 확인
import { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Button, Card, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { adjustStock, createIngredient, listStocks, StockItem } from '../../lib/api/inventory';
import { confirmOcrDocument, listOcrDocuments, rejectOcrDocument, uploadOcrImage, OcrDocument } from '../../lib/api/ocr';
import { colors, typography } from '../../theme';

const TARGET_LABEL: Record<string, string> = {
  inventory_inbound: '재고 입고',
  expense: '지출',
  sales: '매출',
};

const notify = (title: string, message: string) => toast(title, message);

export default function InventoryScreen() {
  const { token } = useAuth();
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [drafts, setDrafts] = useState<OcrDocument[]>([]);
  const [scanning, setScanning] = useState(false);

  // 직접 등록 폼
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState('');
  const [fUnit, setFUnit] = useState('');
  const [fPrice, setFPrice] = useState('');
  const [fQty, setFQty] = useState('');
  const [saving, setSaving] = useState(false);

  // 기존 재고 직접 입고/차감
  const [adjustId, setAdjustId] = useState<number | null>(null);
  const [adjustQty, setAdjustQty] = useState('');

  const loadStocks = useCallback(() => {
    if (!token) return;
    listStocks(token).then(setStocks).catch(() => {});
  }, [token]);

  const loadDrafts = useCallback(() => {
    listOcrDocuments('draft').then(setDrafts).catch(() => {});
  }, []);

  useEffect(() => {
    loadStocks();
    loadDrafts();
  }, [loadStocks, loadDrafts]);

  // 재료 직접 등록 → 같은 이름의 재료가 이미 있으면 새로 만들지 않고 기존 재고에 추가 입고
  const registerIngredient = async () => {
    if (!token) return notify('로그인 필요', '재료 등록은 로그인 후 가능합니다.');
    if (!fName.trim() || !fUnit.trim()) return notify('입력 확인', '재료명과 단위는 필수입니다.');
    setSaving(true);
    try {
      const name = fName.trim();
      const qty = Number(fQty) || 0;

      // 화면의 stocks는 오래됐을 수 있으므로 최신 목록으로 중복을 확인한다
      const latest = await listStocks(token).catch(() => stocks);
      const existing = latest.find((s) => s.name === name);

      if (existing && qty <= 0) {
        notify('이미 등록된 재료', `${existing.name}은(는) 이미 등록돼 있어요. 초기 수량을 입력하면 기존 재고에 추가 입고돼요.`);
        return;
      }

      if (existing) {
        await adjustStock(token, { ingredient_id: existing.ingredient_id, quantity_change: qty, description: '직접 등록 추가 입고' });
        notify('입고 완료', `이미 등록된 재료라 ${existing.name} 재고에 ${qty}${existing.unit}을(를) 추가했어요.`);
      } else {
        const ing = await createIngredient(token, {
          name,
          unit: fUnit.trim(),
          current_price: Number(fPrice) || 0,
        });
        if (qty > 0) {
          await adjustStock(token, { ingredient_id: ing.id, quantity_change: qty, description: '직접 등록 초기 수량' });
        }
        notify('등록 완료', `${ing.name} 재료가 등록됐어요.`);
      }

      setFName(''); setFUnit(''); setFPrice(''); setFQty('');
      setFormOpen(false);
      loadStocks();
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const runOcr = async () => {
    try {
      let picked: ImagePicker.ImagePickerResult;
      if (Platform.OS === 'web') {
        picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      } else {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        picked = perm.granted
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      }
      if (picked.canceled || !picked.assets?.length) return;

      setScanning(true);
      const doc = await uploadOcrImage(picked.assets[0]);
      setDrafts((prev) => [doc, ...prev]);
      const secs = doc.elapsed_sec != null ? ` (${doc.elapsed_sec}초)` : '';
      notify('인식 완료' + secs, `${doc.result.items.length}개 품목을 인식했어요. 내용을 확인하고 반영하세요.`);
    } catch (e) {
      notify('인식 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setScanning(false);
    }
  };

  // OCR 확정 → 재고 입고 → 재고 현황 즉시 갱신 (실시간 연동)
  const confirm = async (doc: OcrDocument) => {
    try {
      // 이 버튼의 의미가 '재고 반영'이므로 서버 추천값과 무관하게 항상 재고 입고로 확정한다
      // (expense/sales는 미구현이라 추천값을 따르면 보관만 되고 재고에 안 들어간다)
      const res = await confirmOcrDocument(doc.id, 'inventory_inbound', token);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
      loadStocks();
      notify('확정 완료', res.message);
    } catch (e) {
      notify('확정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const reject = async (doc: OcrDocument) => {
    try {
      await rejectOcrDocument(doc.id);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e) {
      notify('반려 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 기존 재고 수량 직접 조정 (입고=+, 차감=-)
  const applyAdjust = async (s: StockItem, sign: 1 | -1) => {
    if (!token) return notify('로그인 필요', '재고 조정은 로그인 후 가능합니다.');
    const qty = Number(adjustQty);
    if (!qty || qty <= 0) return notify('입력 확인', '0보다 큰 수량을 입력하세요.');
    try {
      await adjustStock(token, {
        ingredient_id: s.ingredient_id,
        quantity_change: sign * qty,
        description: sign > 0 ? '직접 입고' : '직접 차감',
      });
      setAdjustId(null);
      setAdjustQty('');
      loadStocks();
      notify('반영 완료', `${s.name} ${sign > 0 ? '+' : '−'}${qty}${s.unit} 반영했어요.`);
    } catch (e) {
      notify('조정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  return (
    <Screen>
      <ScreenTitle title="재고" subtitle="현재 재고와 안전재고 상태" />

      {/* OCR 입고 */}
      <Card>
        <View style={styles.ocrHead}>
          <View style={{ flex: 1 }}>
            <SectionTitle>명세서 촬영 입고</SectionTitle>
            <Text style={styles.hint}>사진을 찍으면 상품·단가·수량을 인식해 입고 초안을 만들어요</Text>
          </View>
          <Ionicons name="camera" size={22} color={colors.pointOrange} />
        </View>
        <Button
          label={scanning ? '인식 중… (수 초 걸려요)' : '명세서 / 영수증 촬영'}
          onPress={runOcr}
          disabled={scanning}
          style={{ marginTop: 14 }}
        />
      </Card>

      {/* OCR 인식 초안 확인 */}
      {drafts.length > 0 && (
        <Card tone="cream">
          <View style={styles.rowBetween}>
            <SectionTitle>입고 초안 확인 ({drafts.length})</SectionTitle>
            <Badge label="확정 전" tone="orange" />
          </View>
          <Text style={styles.hint}>인식 결과를 확인하고 반영하세요 — 반영하면 아래 재고 현황에 바로 더해집니다</Text>
          <View style={{ gap: 12, marginTop: 12 }}>
            {drafts.map((doc) => (
              <View key={doc.id} style={styles.docBox}>
                <View style={styles.rowBetween}>
                  <Text style={styles.docVendor}>
                    {doc.result.vendor?.name ?? '거래처 미상'}
                    {doc.result.issued_date ? `  ·  ${doc.result.issued_date}` : ''}
                  </Text>
                  <Badge label={TARGET_LABEL[doc.suggested_target ?? ''] ?? '대상 미정'} tone="orange" />
                </View>

                {doc.result.items.map((item, idx) => (
                  <View key={idx} style={styles.draftRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.draftName}>{item.name}</Text>
                      <Text style={styles.draftMeta}>
                        {item.quantity != null ? `${item.quantity}${item.unit ?? '개'}` : '수량 미인식'}
                        {item.unit_price != null ? ` · 단가 ₩${item.unit_price.toLocaleString()}` : ''}
                        {item.amount != null ? ` · ₩${item.amount.toLocaleString()}` : ''}
                      </Text>
                      {item.warnings.length > 0 && <Text style={styles.warnText}>⚠ {item.warnings[0]}</Text>}
                    </View>
                  </View>
                ))}

                <View style={styles.totalRow}>
                  <Text style={styles.draftMeta}>
                    {doc.result.discount != null ? `할인 −₩${doc.result.discount.toLocaleString()}   ` : ''}
                    합계 {doc.result.total != null ? `₩${doc.result.total.toLocaleString()}` : '미인식'}
                  </Text>
                </View>
                {doc.warnings.map((w, idx) => (
                  <Text key={idx} style={styles.warnText}>⚠ {w}</Text>
                ))}

                <View style={styles.actionRow}>
                  <PressableScale style={styles.rejectBtn} onPress={() => reject(doc)} to={0.9}>
                    <Ionicons name="close" size={16} color={colors.mochaBrown} />
                    <Text style={styles.rejectText}>반려</Text>
                  </PressableScale>
                  <PressableScale style={styles.confirmBtn} onPress={() => confirm(doc)} to={0.9}>
                    <Ionicons name="checkmark" size={16} color={colors.white} />
                    <Text style={styles.confirmText}>확인했어요 · 재고 반영</Text>
                  </PressableScale>
                </View>
              </View>
            ))}
          </View>
        </Card>
      )}

      {/* 재고 현황 (실데이터) */}
      <View style={{ gap: 12 }}>
        <View style={styles.rowBetween}>
          <SectionTitle>재고 현황 ({stocks.length})</SectionTitle>
          <PressableScale style={styles.addBtn} onPress={() => setFormOpen((v) => !v)} to={0.92}>
            <Ionicons name={formOpen ? 'remove' : 'add'} size={16} color={colors.white} />
            <Text style={styles.confirmText}>{formOpen ? '닫기' : '재료 직접 등록'}</Text>
          </PressableScale>
        </View>

        {/* 직접 등록 폼 */}
        {formOpen && (
          <Card tone="cream">
            <SectionTitle>재료 직접 등록</SectionTitle>
            {/* 재료명은 한 줄 전체 (긴 이름도 다 들어오게) */}
            <View style={styles.formRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="재료명 (예: 서울우유 1L)"
                placeholderTextColor={colors.mochaBrown}
                value={fName}
                onChangeText={setFName}
              />
            </View>
            {/* 단위 · 단가 · 수량 3칸 */}
            <View style={styles.formRow}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="단위" placeholderTextColor={colors.mochaBrown} value={fUnit} onChangeText={setFUnit} />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="단가(원)" placeholderTextColor={colors.mochaBrown} value={fPrice} onChangeText={setFPrice} keyboardType="numeric" />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="수량" placeholderTextColor={colors.mochaBrown} value={fQty} onChangeText={setFQty} keyboardType="numeric" />
            </View>
            <Button label={saving ? '등록 중…' : '등록'} onPress={registerIngredient} disabled={saving} style={{ marginTop: 12 }} />
          </Card>
        )}

        {!token ? (
          <Card>
            <Text style={styles.hint}>로그인하면 내 매장의 재고 현황이 표시됩니다.</Text>
          </Card>
        ) : stocks.length === 0 ? (
          <Card>
            <Text style={styles.hint}>
              아직 등록된 재고가 없어요. 영수증을 촬영해 입고하거나 "재료 직접 등록"으로 시작해 보세요.
            </Text>
          </Card>
        ) : (
          stocks.map((s) => {
            const low = s.safety_quantity > 0 && s.current_quantity < s.safety_quantity;
            const denominator = Math.max(s.current_quantity, s.safety_quantity * 2, 1);
            return (
              <Card key={s.ingredient_id}>
                <View style={styles.rowBetween}>
                  <Text style={styles.stockName}>{s.name}</Text>
                  {low ? <Badge label="안전재고 미달" tone="danger" /> : <Badge label="정상" tone="green" />}
                </View>
                <View style={styles.stockValueRow}>
                  <Text style={styles.stockValue}>
                    {s.current_quantity}
                    <Text style={styles.stockUnit}> {s.unit}</Text>
                  </Text>
                  <Text style={styles.safetyText}>
                    {s.current_price > 0 ? `단가 ₩${s.current_price.toLocaleString()} · ` : ''}
                    안전재고 {s.safety_quantity}{s.unit}
                  </Text>
                </View>
                <ProgressBar ratio={s.current_quantity / denominator} tone={low ? 'danger' : 'mocha'} />

                {/* 재고 직접 조정 */}
                {adjustId === s.ingredient_id ? (
                  <View style={styles.adjustRow}>
                    <TextInput
                      style={styles.adjustInput}
                      placeholder={`수량 (${s.unit})`}
                      placeholderTextColor={colors.mochaBrown}
                      value={adjustQty}
                      onChangeText={setAdjustQty}
                      keyboardType="numeric"
                      autoFocus
                    />
                    <PressableScale style={styles.inBtn} onPress={() => applyAdjust(s, 1)} to={0.92}>
                      <Text style={styles.inText}>입고 +</Text>
                    </PressableScale>
                    <PressableScale style={styles.outBtn} onPress={() => applyAdjust(s, -1)} to={0.92}>
                      <Text style={styles.outText}>차감 −</Text>
                    </PressableScale>
                    <PressableScale style={styles.cancelBtn} onPress={() => { setAdjustId(null); setAdjustQty(''); }} to={0.92}>
                      <Ionicons name="close" size={16} color={colors.mochaBrown} />
                    </PressableScale>
                  </View>
                ) : (
                  <PressableScale
                    style={styles.adjustOpen}
                    onPress={() => { setAdjustId(s.ingredient_id); setAdjustQty(''); }}
                    to={0.96}
                  >
                    <Ionicons name="swap-vertical" size={15} color={colors.pointOrange} />
                    <Text style={styles.adjustOpenText}>재고 직접 입력 (입고/차감)</Text>
                  </PressableScale>
                )}
              </Card>
            );
          })
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  ocrHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  adjustOpen: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 12, alignSelf: 'flex-start' },
  adjustOpenText: { ...typography.L5, color: colors.pointOrange, fontWeight: '700' },
  adjustRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  adjustInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.white,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  inBtn: { backgroundColor: colors.trendGreenText, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  inText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  outBtn: { backgroundColor: '#B23B2E', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  outText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  cancelBtn: { padding: 8 },
  docBox: {
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 12,
    gap: 8,
  },
  docVendor: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  draftRow: { flexDirection: 'row', alignItems: 'center' },
  draftName: { ...typography.L4, color: colors.espressoBrown },
  draftMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  warnText: { ...typography.L5, color: colors.pointOrange, marginTop: 3 },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.mutedSand, paddingTop: 8, alignItems: 'flex-end' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.trendGreenText,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  confirmText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  rejectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  rejectText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  formRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: {
    minWidth: 0, // 웹 flex 자식이 콘텐츠보다 작게 줄어들 수 있게 (넘침 방지)
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: colors.white,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  stockName: { ...typography.L3, color: colors.espressoBrown },
  stockValueRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
  stockValue: { ...typography.L2, color: colors.espressoBrown },
  stockUnit: { ...typography.L4, color: colors.mochaBrown },
  safetyText: { ...typography.L5, color: colors.mochaBrown },
});
