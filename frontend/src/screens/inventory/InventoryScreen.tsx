// 재고 (프론트 A) — PRD ERP-4/7, AI-2: 재고 조회 + 안전재고 알림 + OCR 입고 확인
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '../../components/motion';
import { Badge, Button, Card, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
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

// OCR 인식 초안 (PRD AI-2: 자동 확정 금지, 사람이 확인 후 반영)
type OcrDraft = { id: string; name: string; unitPrice: number; qty: number; confidence: number };
const OCR_DRAFTS: OcrDraft[] = [
  { id: 'o1', name: '에티오피아 예가체프 1kg', unitPrice: 28000, qty: 5, confidence: 0.97 },
  { id: 'o2', name: '서울우유 1L', unitPrice: 2400, qty: 24, confidence: 0.92 },
  { id: 'o3', name: '바닐라 시럽 750ml', unitPrice: 9800, qty: 6, confidence: 0.88 },
];

export default function InventoryScreen() {
  const [drafts, setDrafts] = useState<OcrDraft[]>(OCR_DRAFTS);
  const [scanning, setScanning] = useState(false);

  const runOcr = () => {
    // 실제로는 카메라/갤러리 → OCR API. 여기선 데모로 초안 리스트 리셋
    setScanning(true);
    setTimeout(() => {
      setDrafts(OCR_DRAFTS);
      setScanning(false);
    }, 700);
  };

  const confirm = (id: string) => setDrafts((prev) => prev.filter((d) => d.id !== id));

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
          label={scanning ? '인식 중…' : '명세서 / 영수증 촬영'}
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
          <Text style={styles.hint}>인식 결과를 확인하고 재고에 반영하세요 (자동 반영 안 됨)</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            {drafts.map((d) => (
              <View key={d.id} style={styles.draftRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.draftName}>{d.name}</Text>
                  <Text style={styles.draftMeta}>
                    {d.qty}개 · ₩{d.unitPrice.toLocaleString()}
                    {d.confidence < 0.9 ? '  · 인식 확인 필요' : ''}
                  </Text>
                </View>
                <PressableScale style={styles.confirmBtn} onPress={() => confirm(d.id)} to={0.9}>
                  <Ionicons name="checkmark" size={16} color={colors.white} />
                  <Text style={styles.confirmText}>반영</Text>
                </PressableScale>
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
  draftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 12,
  },
  draftName: { ...typography.L4, color: colors.espressoBrown },
  draftMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
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
  stockName: { ...typography.L3, color: colors.espressoBrown },
  stockValueRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
  stockValue: { ...typography.L2, color: colors.espressoBrown },
  stockUnit: { ...typography.L4, color: colors.mochaBrown },
  safetyText: { ...typography.L5, color: colors.mochaBrown },
});
