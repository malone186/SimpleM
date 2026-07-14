// 서류 자동화 (ERP-12) — 문서 템플릿 → 초안 생성(draft_)
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '../../components/motion';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Template = { id: string; name: string; desc: string; icon: keyof typeof Ionicons.glyphMap };

const TEMPLATES: Template[] = [
  { id: 'invoice', name: '거래명세서', desc: '공급자·품목·수량·단가 자동 채움', icon: 'receipt-outline' },
  { id: 'order', name: '발주서', desc: '재고 부족 품목으로 초안 생성', icon: 'cart-outline' },
  { id: 'payslip', name: '급여명세서', desc: '스케줄·시급 기반 자동 계산', icon: 'cash-outline' },
  { id: 'contract', name: '근로계약서', desc: '표준 양식 + 매장 정보 채움', icon: 'document-text-outline' },
];

export default function DocumentScreen() {
  const [drafted, setDrafted] = useState<Record<string, boolean>>({});

  const make = (id: string) => setDrafted((d) => ({ ...d, [id]: true }));

  return (
    <Screen>
      <ScreenTitle title="서류 자동화" subtitle="템플릿을 고르면 초안을 만들어드려요" />

      <Card tone="cream">
        <View style={styles.noticeRow}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.mochaBrown} />
          <Text style={styles.noticeText}>
            모든 서류는 <Text style={{ fontWeight: '700' }}>초안(draft)</Text>으로 만들어지고,
            확인·수정 후 확정하세요.
          </Text>
        </View>
      </Card>

      {TEMPLATES.map((t) => {
        const done = drafted[t.id];
        return (
          <Card key={t.id}>
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name={t.icon} size={22} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{t.name}</Text>
                <Text style={styles.desc}>{t.desc}</Text>
              </View>
            </View>
            {done ? (
              <View style={styles.doneRow}>
                <Badge label="초안 생성됨" tone="green" />
                <Text style={styles.doneHint}>확인 후 확정하세요</Text>
              </View>
            ) : (
              <PressableScale style={styles.makeBtn} onPress={() => make(t.id)}>
                <Text style={styles.makeText}>초안 생성</Text>
              </PressableScale>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { ...typography.L3, color: colors.espressoBrown },
  desc: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  makeBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  makeText: { ...typography.L4, color: colors.white, fontWeight: '700' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  doneHint: { ...typography.L5, color: colors.mochaBrown },
});
