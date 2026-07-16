// AI 경영 리포트 카드 — 홈에서 일간/주간/월간을 눌러 바로 확인 (모달·편지 연출 없음)
// 데이터: GET /chatbot/reports/management (매출·매입·지출·인건비·재고·발주·갱신 통합 집계)
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import {
  getManagementReport,
  type GeneratedDocument,
  type ReportPeriodType,
} from '../../lib/api/documents';
import { colors, spacing, typography } from '../../theme';
import { PressableScale } from '../motion';
import { Segmented } from '../ui/Segmented';

const PERIODS: { value: ReportPeriodType; label: string }[] = [
  { value: 'daily', label: '일간' },
  { value: 'weekly', label: '주간' },
  { value: 'monthly', label: '월간' },
];

const PERIOD_WORD: Record<ReportPeriodType, string> = {
  daily: '오늘',
  weekly: '이번 주',
  monthly: '이번 달',
};

const won = (n: number) => `${n < 0 ? '-' : ''}₩${Math.abs(n).toLocaleString('ko-KR')}`;

export default function ManagementReportCard() {
  const { token } = useAuth();
  const [period, setPeriod] = useState<ReportPeriodType>('daily');
  // 기간별 응답 캐시 — 탭을 오가도 다시 로딩하지 않는다 (카드 리마운트 시 초기화 = 당겨서 새로고침)
  const [reports, setReports] = useState<Partial<Record<ReportPeriodType, GeneratedDocument>>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const report = reports[period];

  useEffect(() => {
    if (!token || reports[period]) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getManagementReport(token, period)
      .then((doc) => {
        if (!cancelled) setReports((prev) => ({ ...prev, [period]: doc }));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, period, reports, retryKey]);

  // content 스키마: backend report_service.py의 management_report 구조
  const c = (report?.content ?? {}) as any;
  const salesTotal: number = c.sales?.total ?? 0;
  const salesDelta: number | null = c.sales?.change_pct ?? null;
  const deltaUp = salesDelta !== null && salesDelta >= 0;
  const highlights: string[] = Array.isArray(c.highlights) ? c.highlights : [];

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.title}>AI 경영 리포트</Text>
        {report && <Text style={styles.periodText}>{c.period}</Text>}
      </View>

      <Segmented options={PERIODS} value={period} onChange={setPeriod} />

      {!report && loading && (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={colors.mochaBrown} />
          <Text style={styles.stateText}>{PERIOD_WORD[period]} 데이터를 모으는 중…</Text>
        </View>
      )}

      {!report && failed && !loading && (
        <View style={styles.stateWrap}>
          <Text style={styles.stateText}>리포트를 가져오지 못했어요. 로그인과 서버를 확인해 주세요.</Text>
          <PressableScale style={styles.retryBtn} onPress={() => setRetryKey((k) => k + 1)}>
            <Text style={styles.retryText}>다시 시도</Text>
          </PressableScale>
        </View>
      )}

      {report && (
        <>
          {/* 히어로 숫자 — 기간 매출 + 이전 기간 대비 증감 (화살표 + 퍼센트) */}
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroLabel}>{PERIOD_WORD[period]} 매출</Text>
              <Text style={styles.heroValue}>{won(salesTotal)}</Text>
            </View>
            {salesDelta !== null ? (
              <View style={[styles.deltaBadge, !deltaUp && styles.deltaBadgeDown]}>
                <Text style={[styles.deltaText, !deltaUp && styles.deltaTextDown]}>
                  {deltaUp ? '▲' : '▼'} {Math.abs(salesDelta)}%
                </Text>
              </View>
            ) : (
              <View style={styles.deltaBadgeNeutral}>
                <Text style={styles.deltaTextNeutral}>비교 데이터 없음</Text>
              </View>
            )}
          </View>

          {/* 스탯 타일 3개 — 수익·비용·판매량 */}
          <View style={styles.tileRow}>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>추정 수익</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {won(c.profit?.estimated_profit ?? 0)}
              </Text>
              <Text style={styles.tileSub}>
                {c.profit?.margin_pct != null ? `마진 ${c.profit.margin_pct}%` : '—'}
              </Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>비용 합계</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {won(c.profit?.total_cost ?? 0)}
              </Text>
              <Text style={styles.tileSub}>인건비 {won(c.labor?.estimated_cost ?? 0)}</Text>
            </View>
            <View style={styles.tile}>
              <Text style={styles.tileLabel}>판매 잔</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {(c.sales?.cups ?? 0).toLocaleString('ko-KR')}잔
              </Text>
              <Text style={styles.tileSub}>
                {c.sales?.top_menus?.[0] ? `1위 ${c.sales.top_menus[0].menu}` : '—'}
              </Text>
            </View>
          </View>

          {/* 핵심 요약 — 집계에서 바로 읽어낸 사실들 */}
          {highlights.length > 0 && (
            <View style={styles.highlightWrap}>
              {highlights.map((h, i) => (
                <Text key={i} style={styles.highlight}>
                  <Text style={styles.highlightDot}>✦ </Text>
                  {h}
                </Text>
              ))}
            </View>
          )}

          {/* 운영 체크 + 상세 안내 */}
          <Text style={styles.opsLine}>
            재고 경고 {c.inventory?.low_stock?.length ?? 0}건 · 진행 중 발주{' '}
            {c.orders?.open_count ?? 0}건 · 갱신 임박 서류 {c.compliance_alerts?.length ?? 0}건
          </Text>
          <Text style={styles.chatHint}>
            품목별 상세 표는 챗봇에서 “{PERIODS.find((p) => p.value === period)?.label} 리포트
            보여줘”라고 물어보세요
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)', // SalesCard와 동일한 카드 테두리 톤
    padding: spacing.globalPadding,
    gap: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.L1, color: colors.espressoBrown },
  periodText: { ...typography.L5, color: colors.mochaBrown },
  stateWrap: { alignItems: 'center', paddingVertical: 22, gap: 10 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 15 },
  retryBtn: {
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  retryText: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 3 },
  heroValue: { ...typography.L2, color: colors.espressoBrown },
  deltaBadge: {
    backgroundColor: colors.trendGreenBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  deltaBadgeDown: { backgroundColor: '#FBEAE2' }, // pointOrange 계열의 옅은 배경
  deltaText: { ...typography.L5, fontWeight: '700', color: colors.trendGreenText },
  deltaTextDown: { color: colors.pointOrange },
  deltaBadgeNeutral: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  deltaTextNeutral: { ...typography.L5, color: colors.mochaBrown },
  tileRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    paddingTop: 12,
    gap: 8,
  },
  tile: { flex: 1, alignItems: 'center', gap: 2 },
  tileLabel: { ...typography.L5, color: colors.mochaBrown },
  tileValue: { ...typography.L3, color: colors.espressoBrown },
  tileSub: { ...typography.L5, fontSize: 9, color: colors.mochaBrown },
  highlightWrap: {
    backgroundColor: colors.creamSand,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 12,
    gap: 7,
  },
  highlight: { ...typography.L5, fontSize: 11, fontWeight: '500', color: colors.espressoBrown, lineHeight: 16 },
  highlightDot: { color: colors.pointOrange, fontWeight: '700' },
  opsLine: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center' },
  chatHint: { ...typography.L5, fontSize: 9, color: colors.mochaBrown, textAlign: 'center', marginTop: -8 },
});
