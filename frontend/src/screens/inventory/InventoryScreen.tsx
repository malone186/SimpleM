// 재고 (프론트 A) — PRD ERP-4/7, AI-2: 재고 조회 + 직접 등록 + 안전재고 알림 + OCR 입고 확인
import { useCallback, useEffect, useState, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View, LayoutAnimation, UIManager } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Button, Card, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { API_BASE_URL } from '../../lib/api/client';
import { adjustStock, createIngredient, listStocks, StockItem } from '../../lib/api/inventory';
import { confirmOcrDocument, listOcrDocuments, rejectOcrDocument, uploadOcrImage, OcrDocument, updateOcrDocument, OcrItem } from '../../lib/api/ocr';
import { colors, typography } from '../../theme';

const TARGET_LABEL: Record<string, string> = {
  inventory_inbound: '재고 입고',
  expense: '지출',
  sales: '매출',
};

const notify = (title: string, message: string) => toast(title, message);

// [한글 주석] 재고 카테고리 정의
const CATEGORIES = [
  { id: 'all', label: '전체' },
  { id: 'bean', label: '☕ 원두·커피' },
  { id: 'milk', label: '🥛 우유·유제품' },
  { id: 'syrup', label: '🍯 시럽·파우더' },
  { id: 'cup', label: '🥤 컵·부자재' },
  { id: 'etc', label: '📦 기타' },
];

function getCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('원두') || n.includes('커피') || n.includes('에스프레소') || n.includes('콜롬비아') || n.includes('에티오피아') || n.includes('디카페인') || n.includes('예가체프')) return 'bean';
  if (n.includes('우유') || n.includes('유제품') || n.includes('크림') || n.includes('치즈') || n.includes('연유') || n.includes('버터') || n.includes('아이스크림')) return 'milk';
  if (n.includes('시럽') || n.includes('파우더') || n.includes('초코') || n.includes('카라멜') || n.includes('바닐라') || n.includes('소스') || n.includes('퓨레') || n.includes('녹차') || n.includes('홍차') || n.includes('베이스')) return 'syrup';
  if (n.includes('컵') || n.includes('종이컵') || n.includes('아이스컵') || n.includes('빨대') || n.includes('홀더') || n.includes('뚜껑') || n.includes('캐리어') || n.includes('휴지') || n.includes('비닐') || n.includes('포장') || n.includes('용기') || n.includes('소모품')) return 'cup';
  return 'etc';
}

// 초안 편집용 행 — 타이핑 중간 상태("1." 등)를 허용하려고 문자열로 들고 저장 시 숫자로 변환
type EditRow = { name: string; qty: string; unit: string; price: string };

export default function InventoryScreen() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all'); // [한글 주석] 카테고리 필터 상태
  const [drafts, setDrafts] = useState<OcrDocument[]>([]);
  const [scanning, setScanning] = useState(false);
  const [actingDocId, setActingDocId] = useState<string | null>(null); // 반려/확정 요청 진행 중인 초안 ID

  // [한글 주석] 영수증(명세서) 초안 수정 상태 관리 변수들
  const [editingDocId, setEditingDocId] = useState<string | null>(null); // 현재 수정 중인 영수증 초안의 ID
  const [editingRows, setEditingRows] = useState<EditRow[]>([]); // 편집 중인 품목들 (기존 품목도 값 수정 가능)
  const [isSavingDraft, setIsSavingDraft] = useState(false); // 수정 사항 저장 중 로딩 여부

  // [한글 주석: 카테고리 드롭다운 아코디언 창의 열림/닫힘 상태]
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);

  // [한글 주석: 드롭다운이 쫀득하게 톡 펼쳐지도록 도와주는 스프링 트랜지션]
  const springTransition = () => {
    LayoutAnimation.configureNext({
      duration: 320,
      create: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 },
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
      delete: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 }
    });
  };

  // [한글 주석] 새 품목 수동 추가를 위한 인풋 상태 관리 변수들
  const [newItemName, setNewItemName] = useState(''); // 추가할 품목명
  const [newItemQty, setNewItemQty] = useState(''); // 추가할 수량
  const [newItemUnit, setNewItemUnit] = useState('개'); // 추가할 단위
  const [newItemPrice, setNewItemPrice] = useState(''); // 추가할 단가

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
    if (actingDocId) return; // 처리 중 중복 탭 방지 (이중 재고 반영·409 예방)
    setActingDocId(doc.id);
    try {
      // 이 버튼의 의미가 '재고 반영'이므로 서버 추천값과 무관하게 항상 재고 입고로 확정한다
      // (expense/sales는 미구현이라 추천값을 따르면 보관만 되고 재고에 안 들어간다)
      const res = await confirmOcrDocument(doc.id, 'inventory_inbound', token);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
      loadStocks();
      notify('확정 완료', res.message);
    } catch (e) {
      notify('확정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setActingDocId(null);
    }
  };

  const reject = async (doc: OcrDocument) => {
    if (actingDocId) return; // 처리 중 중복 탭 방지
    setActingDocId(doc.id);
    try {
      await rejectOcrDocument(doc.id);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e) {
      notify('반려 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setActingDocId(null);
    }
  };

  // [한글 주석] 영수증 초안의 품목을 수정하기 위해 편집 모드를 활성화하고 데이터를 복사합니다.
  // 기존 품목도 값을 고칠 수 있도록 각 품목을 편집 가능한 행(문자열 입력값)으로 변환합니다.
  const startEditing = (doc: OcrDocument) => {
    setEditingDocId(doc.id);
    setEditingRows(doc.result.items.map((i) => ({
      name: i.name,
      qty: i.quantity != null ? String(i.quantity) : '',
      unit: i.unit ?? '개',
      price: i.unit_price != null ? String(i.unit_price) : '',
    })));
    setNewItemName('');
    setNewItemQty('');
    setNewItemUnit('개');
    setNewItemPrice('');
  };

  // [한글 주석] 영수증 수정을 취소하고 입력 중이던 임시 폼 값을 비웁니다.
  const cancelEditing = () => {
    setEditingDocId(null);
    setEditingRows([]);
  };

  // [한글 주석] 편집 중인 품목 한 줄의 특정 칸(이름/수량/단위/단가)을 갱신합니다.
  const updateRow = (index: number, patch: Partial<EditRow>) => {
    setEditingRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  // [한글 주석] 수정 화면에서 새 품목을 직접 적어 목록에 추가합니다.
  const handleAddItem = () => {
    if (!newItemName.trim()) {
      return notify('입력 확인', '추가할 재료명을 입력해 주세요.');
    }
    const qty = Number(newItemQty);
    if (isNaN(qty) || qty <= 0) {
      return notify('입력 확인', '올바른 수량을 입력해 주세요.');
    }

    setEditingRows((prev) => [...prev, {
      name: newItemName.trim(),
      qty: newItemQty,
      unit: newItemUnit.trim() || '개',
      price: newItemPrice,
    }]);

    // 입력창 초기화
    setNewItemName('');
    setNewItemQty('');
    setNewItemPrice('');
  };

  // [한글 주석] 영수증 품목 중 잘못 입력되었거나 인식 오류가 난 한 줄을 목록에서 제거합니다.
  const handleDeleteItem = (index: number) => {
    setEditingRows((prev) => prev.filter((_, i) => i !== index));
  };

  // [한글 주석] 수정한 영수증 품목들을 서버(DB)에 저장하여 영구 보존하고 연동 상태를 새로고침합니다.
  const saveEditing = async (docId: string) => {
    if (editingRows.some((r) => !r.name.trim())) {
      return notify('입력 확인', '품목명이 비어 있는 항목이 있어요. 채우거나 삭제해 주세요.');
    }
    // 문자열 입력값을 숫자로 변환 (빈칸은 '미인식'으로 저장, 합계는 수량×단가 자동 계산)
    const items: OcrItem[] = editingRows.map((r) => {
      const qty = r.qty.trim() === '' ? null : Number(r.qty);
      const price = r.price.trim() === '' ? null : Number(r.price);
      const validQty = qty != null && Number.isFinite(qty) ? qty : null;
      const validPrice = price != null && Number.isFinite(price) ? price : null;
      return {
        name: r.name.trim(),
        spec: null,
        quantity: validQty,
        unit: r.unit.trim() || '개',
        unit_price: validPrice,
        amount: validQty != null && validPrice != null ? validQty * validPrice : null,
        warnings: [],
      };
    });

    setIsSavingDraft(true);
    try {
      await updateOcrDocument(docId, { items });
      notify('저장 완료', '영수증 인식 내역이 정상적으로 업데이트되었습니다.');
      loadDrafts();
      setEditingDocId(null);
    } catch (e) {
      notify('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setIsSavingDraft(false);
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

  // 재고(재료) 삭제 — 확인 후 DELETE. 재고·레시피 cascade 정리
  const removeStock = (s: StockItem) => {
    confirmDialog(`'${s.name}'을(를) 삭제할까요? 재고·레시피에서도 함께 제거됩니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return notify('로그인 필요', '다시 로그인해 주세요.');
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/inventory/ingredients/${s.ingredient_id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
          loadStocks();
          notify('삭제 완료', `${s.name}을(를) 삭제했어요.`);
        } catch (e) {
          notify('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });
  };

  // [한글 주석] 선택된 카테고리에 해당하는 재고 항목만 필터링합니다.
  const filteredStocks = useMemo(() => {
    if (selectedCategory === 'all') return stocks;
    return stocks.filter((s) => getCategory(s.name) === selectedCategory);
  }, [stocks, selectedCategory]);

  return (
    <Screen>
      <ScreenTitle title="재고" subtitle="현재 재고와 안전재고 상태" />

      {/* 메뉴·레시피 관리 진입 */}
      <PressableScale style={styles.menuNav} onPress={() => navigation.navigate('Menu')} to={0.97}>
        <View style={styles.menuNavIcon}>
          <Ionicons name="cafe-outline" size={20} color={colors.espressoBrown} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.menuNavTitle}>메뉴 · 레시피 관리</Text>
          <Text style={styles.menuNavSub}>메뉴 등록 · 레시피 구성 · 원가율</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />
      </PressableScale>

      {/* OCR 입고 */}
      <Card>
        <View style={styles.ocrHead}>
          <View style={{ flex: 1 }}>
            <SectionTitle>명세서 촬영 입고</SectionTitle>
            {/* [한글 주석] 인식 중일 때는 텍스트를 변경하여 사용자에게 상태를 피드백합니다 */}
            <Text style={styles.hint}>
              {scanning ? '인식 중… (수 초 걸려요)' : '사진을 찍으면 상품·단가·수량을 인식해 입고 초안을 만들어요'}
            </Text>
          </View>
          {/* [한글 주석] 우측 상단의 카메라 아이콘에 터치 인터랙션과 촬영 기능(runOcr)을 부여합니다 */}
          <PressableScale onPress={runOcr} disabled={scanning} to={0.9}>
            <Ionicons name="camera" size={24} color={scanning ? colors.mutedSand : colors.pointOrange} />
          </PressableScale>
        </View>
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

                {/* [한글 주석] 현재 편집 중인 영수증 초안인 경우 임시 편집 배열(editingItems)을 보여주고, 그 외에는 기존 읽기전용 리스트를 보여줍니다 */}
                {editingDocId === doc.id ? (
                  <View style={{ gap: 8, marginVertical: 8 }}>
                    {/* [한글 주석] 기존 품목도 값(품목명·수량·단위·단가)을 그 자리에서 바로 고칠 수 있는 입력칸 */}
                    {editingRows.map((row, idx) => (
                      <View key={idx} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.mutedSand }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="품목명"
                              value={row.name}
                              onChangeText={(t) => updateRow(idx, { name: t })}
                            />
                          </View>
                          {/* [한글 주석] 품목 삭제 버튼 */}
                          <PressableScale onPress={() => handleDeleteItem(idx)} to={0.9}>
                            <Ionicons name="trash-outline" size={18} color={colors.pointOrange} />
                          </PressableScale>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="수량"
                              value={row.qty}
                              onChangeText={(t) => updateRow(idx, { qty: t })}
                              keyboardType="numeric"
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="단위"
                              value={row.unit}
                              onChangeText={(t) => updateRow(idx, { unit: t })}
                            />
                          </View>
                          <View style={{ flex: 1.2 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="단가 (원)"
                              value={row.price}
                              onChangeText={(t) => updateRow(idx, { price: t })}
                              keyboardType="numeric"
                            />
                          </View>
                        </View>
                      </View>
                    ))}

                    {/* [한글 주석] 품목 직접 추가를 위한 입력 폼 UI */}
                    <View style={{ backgroundColor: colors.coffeeCream, padding: 12, borderRadius: 8, marginTop: 8, gap: 8 }}>
                      <Text style={[styles.draftName, { fontSize: 13, color: colors.mochaBrown }]}>➕ 품목 직접 추가</Text>
                      <View style={styles.formRow}>
                        <View style={{ flex: 2 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="재료명 (예: 우유)" 
                            value={newItemName} 
                            onChangeText={setNewItemName} 
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="단위 (개/kg)" 
                            value={newItemUnit} 
                            onChangeText={setNewItemUnit} 
                          />
                        </View>
                      </View>
                      <View style={styles.formRow}>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="수량" 
                            value={newItemQty} 
                            onChangeText={setNewItemQty} 
                            keyboardType="numeric" 
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="단가 (원)" 
                            value={newItemPrice} 
                            onChangeText={setNewItemPrice} 
                            keyboardType="numeric" 
                          />
                        </View>
                      </View>
                      {/* [한글 주석] 버튼 내부 글씨가 버튼 상하 폭에 비해 비대해 보이는 현상을 막기 위해 폰트 크기를 13px로 조절 */}
                      <Button label="목록에 품목 추가" onPress={handleAddItem} style={{ height: 36, marginTop: 4 }} textStyle={{ fontSize: 13, fontWeight: '700' }} />
                    </View>
                  </View>
                ) : (
                  doc.result.items.map((item, idx) => (
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
                  ))
                )}

                <View style={styles.totalRow}>
                  <Text style={styles.draftMeta}>
                    {doc.result.discount != null ? `할인 −₩${doc.result.discount.toLocaleString()}   ` : ''}
                    합계 {doc.result.total != null ? `₩${doc.result.total.toLocaleString()}` : '미인식'}
                  </Text>
                </View>
                {doc.warnings.map((w, idx) => (
                  <Text key={idx} style={styles.warnText}>⚠ {w}</Text>
                ))}

                {/* [한글 주석] 현재 편집 모드인지 여부에 따라 하단 제어 버튼들을 다르게 구성합니다 */}
                {editingDocId === doc.id ? (
                  <View style={styles.actionRow}>
                    <PressableScale 
                      style={[styles.rejectBtn, { borderColor: colors.mutedSand }]} 
                      onPress={cancelEditing} 
                      disabled={isSavingDraft}
                      to={0.9}
                    >
                      <Ionicons name="close-circle-outline" size={16} color={colors.mochaBrown} />
                      <Text style={styles.rejectText}>취소</Text>
                    </PressableScale>
                    <PressableScale 
                      style={[styles.confirmBtn, { backgroundColor: colors.pointOrange }]} 
                      onPress={() => saveEditing(doc.id)} 
                      disabled={isSavingDraft}
                      to={0.9}
                    >
                      <Ionicons name="save-outline" size={16} color={colors.white} />
                      <Text style={styles.confirmText}>{isSavingDraft ? '저장 중…' : '저장 완료'}</Text>
                    </PressableScale>
                  </View>
                ) : (
                  <View style={{ gap: 8, marginTop: 12 }}>
                    {/* [한글 주석] 반려 / 확인 버튼 상단에 수정 진입용 버튼을 추가 배치합니다 */}
                    <PressableScale 
                      style={[styles.rejectBtn, { width: '100%', justifyContent: 'center', backgroundColor: colors.white }]} 
                      onPress={() => startEditing(doc)} 
                      to={0.92}
                    >
                      <Ionicons name="create-outline" size={16} color={colors.pointOrange} />
                      <Text style={[styles.rejectText, { color: colors.pointOrange }]}>인식 결과 직접 수정 / 품목 추가</Text>
                    </PressableScale>
                    
                    <View style={styles.actionRow}>
                      <PressableScale style={styles.rejectBtn} onPress={() => reject(doc)} disabled={actingDocId != null} to={0.9}>
                        <Ionicons name="close" size={16} color={colors.mochaBrown} />
                        <Text style={styles.rejectText}>{actingDocId === doc.id ? '처리 중…' : '반려'}</Text>
                      </PressableScale>
                      <PressableScale style={styles.confirmBtn} onPress={() => confirm(doc)} disabled={actingDocId != null} to={0.9}>
                        <Ionicons name="checkmark" size={16} color={colors.white} />
                        <Text style={styles.confirmText}>{actingDocId === doc.id ? '처리 중…' : '확인했어요 · 재고 반영'}</Text>
                      </PressableScale>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>
        </Card>
      )}

      {/* 재고 현황 (실데이터) */}
      <View style={{ gap: 12 }}>
        <View style={styles.rowBetween}>
          <SectionTitle>
            재고 현황 ({selectedCategory === 'all' ? stocks.length : `${filteredStocks.length}/${stocks.length}`})
          </SectionTitle>
          <PressableScale style={styles.addBtn} onPress={() => setFormOpen((v) => !v)} to={0.92}>
            <Ionicons name={formOpen ? 'remove' : 'add'} size={16} color={colors.white} />
            <Text style={styles.confirmText}>{formOpen ? '닫기' : '재료 직접 등록'}</Text>
          </PressableScale>
        </View>

        {/* [한글 주석: 가로 스크롤 대신 한눈에 들어오는 세련된 아코디언 드롭다운 카테고리 셀렉터] */}
        <View style={styles.dropdownContainer}>
          <PressableScale
            style={styles.dropdownTrigger}
            onPress={() => {
              springTransition();
              setIsCategoryOpen(!isCategoryOpen);
            }}
            to={0.97}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="filter-outline" size={15} color={colors.mochaBrown} />
              <Text style={styles.dropdownTriggerText}>
                카테고리: {CATEGORIES.find((c) => c.id === selectedCategory)?.label || '전체'}
              </Text>
            </View>
            <Ionicons 
              name={isCategoryOpen ? 'chevron-up' : 'chevron-down'} 
              size={16} 
              color={colors.mochaBrown} 
            />
          </PressableScale>

          {/* 드롭다운 리스트 (isCategoryOpen이 true일 때 부드럽게 하단으로 노출) */}
          {isCategoryOpen && (
            <View style={styles.dropdownList}>
              {CATEGORIES.map((cat) => {
                const active = selectedCategory === cat.id;
                return (
                  <PressableScale
                    key={cat.id}
                    style={[styles.dropdownItem, active && styles.dropdownItemActive]}
                    onPress={() => {
                      springTransition();
                      setSelectedCategory(cat.id);
                      setIsCategoryOpen(false);
                    }}
                    to={0.98}
                  >
                    <Text style={[styles.dropdownItemText, active && styles.dropdownItemTextActive]}>
                      {cat.label}
                    </Text>
                    {active && (
                      <Ionicons name="checkmark" size={16} color={colors.pointOrange} />
                    )}
                  </PressableScale>
                );
              })}
            </View>
          )}
        </View>

        {/* 직접 등록 폼 */}
        {formOpen && (
          <Card tone="cream">
            <SectionTitle>재료 직접 등록</SectionTitle>
            {/* 인풋 박스가 화면 밖으로 넘치지 않도록 감싸는 View + flex 적용 */}
            <View style={styles.formRow}>
              <View style={{ flex: 2 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="재료명 (예: 서울우유 1L)" value={fName} onChangeText={setFName} />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="단위 (팩, kg)" value={fUnit} onChangeText={setFUnit} />
              </View>
            </View>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="단가 (원)" value={fPrice} onChangeText={setFPrice} keyboardType="numeric" />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="초기 수량" value={fQty} onChangeText={setFQty} keyboardType="numeric" />
              </View>
            </View>
            <Button label={saving ? '등록 중…' : '등록'} onPress={registerIngredient} disabled={saving} style={{ marginTop: 12 }} />
          </Card>
        )}

        {!token ? (
          <Card>
            <Text style={styles.hint}>로그인하면 내 매장의 재고 현황이 표시됩니다.</Text>
          </Card>
        ) : filteredStocks.length === 0 ? (
          <Card>
            <Text style={styles.hint}>
              {selectedCategory === 'all'
                ? '아직 등록된 재고가 없어요. 영수증을 촬영해 입고하거나 "재료 직접 등록"으로 시작해 보세요.'
                : '해당 카테고리에 속하는 재고가 없어요.'}
            </Text>
          </Card>
        ) : (
          filteredStocks.map((s) => {
            const low = s.safety_quantity > 0 && s.current_quantity < s.safety_quantity;
            const denominator = Math.max(s.current_quantity, s.safety_quantity * 2, 1);
            return (
              <Card key={s.ingredient_id}>
                <View style={styles.rowBetween}>
                  <Text style={styles.stockName}>{s.name}</Text>
                  <View style={styles.headRight}>
                    {low ? <Badge label="안전재고 미달" tone="danger" /> : <Badge label="정상" tone="green" />}
                    <PressableScale style={styles.delBtn} onPress={() => removeStock(s)} to={0.88}>
                      <Ionicons name="trash-outline" size={16} color="#B23B2E" />
                    </PressableScale>
                  </View>
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
  menuNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 14,
  },
  menuNavIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuNavTitle: { ...typography.L3, color: colors.espressoBrown },
  menuNavSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  delBtn: { padding: 6, borderRadius: 9, backgroundColor: 'rgba(178,59,46,0.08)' },
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

  // [한글 주석] 재고 카테고리 필터 칩 바 스타일
  categoryBar: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 4,
    marginBottom: 4,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(242, 236, 224, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
  },
  categoryChipActive: {
    backgroundColor: colors.espressoBrown,
    borderColor: colors.espressoBrown,
  },
  categoryChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  categoryChipTextActive: {
    color: colors.white,
    fontWeight: '800',
  },

  // [한글 주석: 세련된 카테고리 드롭다운 스타일 리스트]
  dropdownContainer: {
    position: 'relative',
    zIndex: 50,
    width: '100%',
    marginBottom: 4,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.white,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.18)',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  dropdownTriggerText: {
    ...typography.L4,
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  dropdownList: {
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: colors.white,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.18)',
    padding: 6,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    gap: 2,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  dropdownItemActive: {
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
  },
  dropdownItemText: {
    ...typography.L4,
    fontSize: 13,
    color: colors.mochaBrown,
    fontWeight: '600',
  },
  dropdownItemTextActive: {
    color: colors.espressoBrown,
    fontWeight: '800',
  },
});
