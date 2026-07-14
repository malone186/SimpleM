// 재고 (프론트 A) — PRD ERP-4/7, AI-2: 재고 조회 + 안전재고 알림 + OCR 입고 확인
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '../../components/motion';
import { Badge, Button, Card, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { confirmOcrDocument, listOcrDocuments, rejectOcrDocument, uploadOcrImage, OcrDocument } from '../../lib/api/ocr';
import { colors, typography } from '../../theme';

type Stock = {
  id: string;
  name: string;
  unit: string;
  current: number;
  safety: number;
  max: number;
};

const STOCKS: Stock[] = [
  { id: 'bean-yir', name: '에티오피아 예가체프', unit: 'kg', current: 1.2, safety: 3, max: 10 },
  { id: 'milk', name: '서울우유 1L', unit: '팩', current: 3, safety: 6, max: 24 },
  { id: 'syrup-va', name: '바닐라 시럽', unit: '병', current: 5, safety: 3, max: 12 },
  { id: 'cup-13', name: '13oz 테이크아웃 컵', unit: '개', current: 420, safety: 200, max: 1000 },
];

const TARGET_LABEL: Record<string, string> = {
  inventory_inbound: '재고 입고',
  expense: '지출',
  sales: '매출',
};

function notify(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n${message}`);
  else Alert.alert(title, message);
}

export default function InventoryScreen() {
  const [drafts, setDrafts] = useState<OcrDocument[]>([]);
  const [scanning, setScanning] = useState(false);

  // 확정 전(draft) 문서를 서버에서 불러온다 — 새로고침해도 유지 (DB 저장)
  const loadDrafts = () => listOcrDocuments('draft').then(setDrafts).catch(() => {});
  useEffect(() => {
    loadDrafts();
  }, []);

  const runOcr = async () => {
    // 촬영(네이티브) 또는 이미지 선택(웹) → OCR API → 입고 초안 (자동 확정 금지)
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

  const confirm = async (doc: OcrDocument) => {
    try {
      const res = await confirmOcrDocument(doc.id, doc.suggested_target ?? 'inventory_inbound');
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
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
          <Text style={styles.hint}>인식 결과를 확인하고 반영하세요 (자동 반영 안 됨)</Text>
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
                    <Text style={styles.confirmText}>확인했어요 · 반영</Text>
                  </PressableScale>
                </View>
              </View>
            ))}
          </View>
        </Card>
      )}

      {/* 재고 목록 */}
      <View style={{ gap: 12 }}>
        <SectionTitle>재고 현황</SectionTitle>
        {STOCKS.map((s) => {
          const ratio = s.current / s.max;
          const low = s.current < s.safety;
          return (
            <Card key={s.id}>
              <View style={styles.rowBetween}>
                <Text style={styles.stockName}>{s.name}</Text>
                {low ? <Badge label="안전재고 미달" tone="danger" /> : <Badge label="정상" tone="green" />}
              </View>
              <View style={styles.stockValueRow}>
                <Text style={styles.stockValue}>
                  {s.current}
                  <Text style={styles.stockUnit}> {s.unit}</Text>
                </Text>
                <Text style={styles.safetyText}>안전재고 {s.safety}{s.unit}</Text>
              </View>
              <ProgressBar ratio={ratio} tone={low ? 'danger' : 'mocha'} />
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  ocrHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
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
  stockName: { ...typography.L3, color: colors.espressoBrown },
  stockValueRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
  stockValue: { ...typography.L2, color: colors.espressoBrown },
  stockUnit: { ...typography.L4, color: colors.mochaBrown },
  safetyText: { ...typography.L5, color: colors.mochaBrown },
});
