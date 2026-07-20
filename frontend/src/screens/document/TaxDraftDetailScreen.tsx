// 세금 신고 초안 상세 (ERP-12) — DocumentScreen '세금' 탭의 '초안 상세 보기'에서 진입한다.
// 자동 계산된 부가세·종합소득세·원천징수의 세목별 금액과 산출 근거를 한 화면에서 검토한다.
// (자동 신고 안 됨 — 검토 후 세무사 확인·확정 절차는 별도)
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import { Badge, Button, Card, Divider, Screen, SectionTitle } from '../../components/ui';
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { colors, typography } from '../../theme';

const wonFmt = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');

// 과세유형 코드 → 한글 표기
const TAX_TYPE_LABELS: Record<string, string> = {
  general: '일반과세',
  simplified: '간이과세',
  exempt: '면세',
};

export default function TaxDraftDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'TaxDraftDetail'>>();
  const tax = route.params?.tax;

  // 방어: 파라미터 없이 진입한 경우 (딥링크 등)
  if (!tax) {
    return (
      <Screen>
        <Card>
          <Text style={styles.err}>⚠ 세금 초안 데이터를 불러오지 못했어요.</Text>
          <Button
            label="돌아가기"
            variant="secondary"
            style={{ marginTop: 12 }}
            onPress={() => navigation.goBack()}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {/* 총 예상 세액 요약 */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>세금 신고 초안</SectionTitle>
          <Badge label="확정 전" tone="orange" />
        </View>
        <Text style={styles.hint}>
          {tax.period} · {TAX_TYPE_LABELS[tax.tax_type] ?? tax.tax_type}
        </Text>

        <Text style={styles.totalLabel}>예상 총 세액</Text>
        <Text style={styles.totalVal}>{wonFmt(tax.total_tax)}</Text>

        <Divider />
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>부가가치세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.vat)}</Text>
        </View>
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>종합소득세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.income_tax)}</Text>
        </View>
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>원천징수세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.withholding_tax)}</Text>
        </View>
        <Text style={[styles.hint, { marginTop: 8 }]}>
          과세표준 {wonFmt(tax.taxable_base)} · 매출 {wonFmt(tax.total_revenue)} · 비용 {wonFmt(tax.total_expense)}
        </Text>
      </Card>

      {/* 세목별 상세 산출 근거 */}
      <Card>
        <SectionTitle>세목별 산출 근거</SectionTitle>
        <View style={{ marginTop: 10, gap: 12 }}>
          {tax.lines.map((line, i) => (
            <View key={line.name}>
              {i > 0 ? <Divider /> : null}
              <View style={[styles.rowBetween, { marginTop: i > 0 ? 12 : 0 }]}>
                <Text style={styles.lineName}>{line.name}</Text>
                <Text style={styles.lineAmount}>{wonFmt(line.amount)}</Text>
              </View>
              {line.basis ? (
                <View style={styles.basisBox}>
                  <Ionicons name="calculator-outline" size={14} color={colors.mochaBrown} />
                  <Text style={styles.basisText}>{line.basis}</Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      </Card>

      {/* 요약 */}
      {tax.summary ? (
        <Card tone="cream">
          <SectionTitle>요약</SectionTitle>
          <Text style={[styles.hint, { marginTop: 6, lineHeight: 18 }]}>{tax.summary}</Text>
        </Card>
      ) : null}

      {/* 안내 문구 (자동 신고 안 됨 고지) */}
      {tax.disclaimer ? (
        <View style={styles.noteBox}>
          <Ionicons name="information-circle-outline" size={15} color={colors.mochaBrown} />
          <Text style={styles.noteBoxText}>{tax.disclaimer}</Text>
        </View>
      ) : null}

      <Button label="돌아가기" variant="secondary" onPress={() => navigation.goBack()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  err: { ...typography.L4, color: '#B23B2E', fontWeight: '600' },

  totalLabel: { ...typography.L5, color: colors.mochaBrown, marginTop: 12 },
  totalVal: { ...typography.L2, color: colors.espressoBrown, marginTop: 2, marginBottom: 10 },

  taxLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  taxLabel: { ...typography.L4, color: colors.mochaBrown },
  taxVal: { ...typography.L4, color: colors.espressoBrown },

  lineName: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  lineAmount: { ...typography.L4, color: colors.espressoBrown, fontWeight: '800' },
  basisBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: colors.coffeeCream, borderRadius: 10, padding: 10, marginTop: 8,
  },
  basisText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 17 },

  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: colors.coffeeCream, borderRadius: 10, padding: 10,
  },
  noteBoxText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 17 },
});
