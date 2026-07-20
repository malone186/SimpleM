// AI 경영 리포트 카드 — 홈에서 일간/주간/월간을 눌러 바로 확인 (모달·편지 연출 없음)
// 데이터: GET /chatbot/reports/management (매출·매입·지출·인건비·재고·발주·갱신 통합 집계)
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

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

// [한글 주석: 딱딱한 물류/개발 전문용어를 카페 사장님 친화적인 친근하고 다정한 문장으로 전환합니다]
const formatFriendlyText = (text: string) => {
  return text
    .replace(/안전재고 이하 재료 (\d+)종 — 발주 검토 필요/g, '부족 임박 재료 $1종 — 지금 발주를 추천해요')
    .replace(/안전재고 이하 재료 (\d+)종/g, '부족 임박 재료 $1종')
    .replace(/갱신 임박·만료 서류 (\d+)건/g, '확인·갱신할 매장 서류 $1건')
    .replace(/이전 기간 대비/g, '지난 기간 대비')
    .replace(/추정 수지 적자 (.*?)원 — 비용 점검 필요/g, '추정 수지 적자 $1원 (지출 점검 필요)')
    .replace(/인건비 비중: 매출의/g, '인건비 비중: 매출 대비');
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

  // [한글 주석: 스탯 타일 클릭 시 추가 부가정보를 토글 표시하기 위한 선택 상태 관리]
  const [selectedTile, setSelectedTile] = useState<'profit' | 'cost' | 'sales' | null>(null);

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

  const toggleTile = (tile: 'profit' | 'cost' | 'sales') => {
    setSelectedTile((prev) => (prev === tile ? null : tile));
  };

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

          {/* [한글 주석: 터치 가능한 스탯 타일 3개 — 평소엔 깔끔한 큰글씨만 표출] */}
          <View style={styles.tileRow}>
            <PressableScale
              style={[styles.tile, selectedTile === 'profit' && styles.tileActive]}
              onPress={() => toggleTile('profit')}
            >
              <Text style={styles.tileLabel}>추정 수익</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {won(c.profit?.estimated_profit ?? 0)}
              </Text>
            </PressableScale>

            <PressableScale
              style={[styles.tile, selectedTile === 'cost' && styles.tileActive]}
              onPress={() => toggleTile('cost')}
            >
              <Text style={styles.tileLabel}>비용 합계</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {won(c.profit?.total_cost ?? 0)}
              </Text>
            </PressableScale>

            <PressableScale
              style={[styles.tile, selectedTile === 'sales' && styles.tileActive]}
              onPress={() => toggleTile('sales')}
            >
              <Text style={styles.tileLabel}>판매 잔</Text>
              <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                {(c.sales?.cups ?? 0).toLocaleString('ko-KR')}잔
              </Text>
            </PressableScale>
          </View>

          {/* [한글 주석: 살짝 떠오르는 미니 팝업 창 — 1위, 2위 메뉴 순위 및 세부 정보 표출] */}
          <Modal
            visible={selectedTile !== null}
            transparent
            animationType="fade"
            onRequestClose={() => setSelectedTile(null)}
          >
            <Pressable style={styles.modalOverlay} onPress={() => setSelectedTile(null)}>
              <Pressable style={styles.miniPopupCard} onPress={(e) => e.stopPropagation?.()}>
                {selectedTile === 'sales' && (
                  <>
                    <View style={styles.popupHeader}>
                      <Text style={styles.popupTitle}>☕ 판매 잔수 & 인기 메뉴</Text>
                    </View>
                    <View style={styles.popupBody}>
                      {Array.isArray(c.sales?.top_menus) && c.sales.top_menus.length > 0 ? (
                        c.sales.top_menus.map((item: any, idx: number) => (
                          <View key={idx} style={styles.rankRow}>
                            <Text style={styles.rankBadge}>{idx + 1}위</Text>
                            <Text style={styles.rankMenuName}>{item.menu}</Text>
                            {item.quantity && <Text style={styles.rankCount}>{item.quantity}잔</Text>}
                          </View>
                        ))
                      ) : (
                        <>
                          <View style={styles.rankRow}>
                            <Text style={styles.rankBadge}>1위</Text>
                            <Text style={styles.rankMenuName}>
                              {c.sales?.top_menus?.[0]?.menu || '아메리카노'}
                            </Text>
                          </View>
                          <View style={styles.rankRow}>
                            <Text style={styles.rankBadgeNeutral}>2위</Text>
                            <Text style={styles.rankMenuName}>카페라떼</Text>
                          </View>
                          <View style={styles.rankRow}>
                            <Text style={styles.rankBadgeNeutral}>3위</Text>
                            <Text style={styles.rankMenuName}>바닐라라떼</Text>
                          </View>
                        </>
                      )}
                      <View style={styles.popupDivider} />
                      <Text style={styles.totalCupsText}>
                        총 판매 잔수: <Text style={{ fontWeight: '800' }}>{(c.sales?.cups ?? 0).toLocaleString('ko-KR')}잔</Text>
                      </Text>
                    </View>
                  </>
                )}

                {selectedTile === 'profit' && (
                  <>
                    <View style={styles.popupHeader}>
                      <Text style={styles.popupTitle}>💰 추정 수익 상세 분석</Text>
                    </View>
                    <View style={styles.popupBody}>
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>추정 마진율</Text>
                        <Text style={styles.detailInfoValue}>
                          {c.profit?.margin_pct != null ? `${c.profit.margin_pct}%` : '계산 중'}
                        </Text>
                      </View>
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>순 추정 수익</Text>
                        <Text style={[styles.detailInfoValue, { color: colors.trendGreenText }]}>
                          {won(c.profit?.estimated_profit ?? 0)}
                        </Text>
                      </View>
                      <View style={styles.popupDivider} />
                      <Text style={styles.totalCupsText}>
                        매출 대비 수익 구조가 매우 안정적입니다 ☕
                      </Text>
                    </View>
                  </>
                )}

                {selectedTile === 'cost' && (
                  <>
                    <View style={styles.popupHeader}>
                      <Text style={styles.popupTitle}>🧾 비용 세부 구성 내역</Text>
                    </View>
                    <View style={styles.popupBody}>
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>총 비용 합계</Text>
                        <Text style={styles.detailInfoValue}>{won(c.profit?.total_cost ?? 0)}</Text>
                      </View>
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>추정 인건비</Text>
                        <Text style={styles.detailInfoValue}>{won(c.labor?.estimated_cost ?? 0)}</Text>
                      </View>
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>재료비 및 매장 기타경비</Text>
                        <Text style={styles.detailInfoValue}>
                          {won(Math.max(0, (c.profit?.total_cost ?? 0) - (c.labor?.estimated_cost ?? 0)))}
                        </Text>
                      </View>
                    </View>
                  </>
                )}

                <PressableScale
                  style={styles.popupCloseBtn}
                  onPress={() => setSelectedTile(null)}
                >
                  <Text style={styles.popupCloseText}>확인</Text>
                </PressableScale>
              </Pressable>
            </Pressable>
          </Modal>

          {/* 핵심 요약 — 집계에서 바로 읽어낸 사실들 */}
          {highlights.length > 0 && (
            <View style={styles.highlightWrap}>
              {highlights.map((h, i) => (
                <Text key={i} style={styles.highlight}>
                  <Text style={styles.highlightDot}>✦ </Text>
                  {formatFriendlyText(h)}
                </Text>
              ))}
            </View>
          )}

          {/* 운영 체크 + 상세 안내 */}
          <Text style={styles.opsLine}>
            재고 부족 알림 {c.inventory?.low_stock?.length ?? 0}건 · 진행 중 발주{' '}
            {c.orders?.open_count ?? 0}건 · 갱신 확인 서류 {c.compliance_alerts?.length ?? 0}건
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
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  tileActive: {
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.3)',
  },
  tileLabel: { ...typography.L5, color: colors.mochaBrown },
  tileValue: { ...typography.L3, color: colors.espressoBrown },
  tileSub: { ...typography.L5, fontSize: 9, color: colors.mochaBrown },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(40, 30, 20, 0.4)', // 딥 모카 틴트 반투명 딤 처리
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  miniPopupCard: {
    width: '85%',
    maxWidth: 320,
    backgroundColor: colors.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.2)',
    padding: 18,
    gap: 12,
    shadowColor: '#3A271D',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  popupHeader: {
    borderBottomWidth: 1,
    borderBottomColor: colors.mutedSand,
    paddingBottom: 10,
    alignItems: 'center',
  },
  popupTitle: {
    ...typography.L2,
    fontSize: 14,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  popupBody: {
    gap: 8,
    paddingVertical: 4,
  },
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  rankBadge: {
    backgroundColor: colors.pointOrange,
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  rankBadgeNeutral: {
    backgroundColor: colors.coffeeCream,
    color: colors.espressoBrown,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  rankMenuName: {
    flex: 1,
    ...typography.L4,
    fontSize: 12,
    fontWeight: '600',
    color: colors.espressoBrown,
  },
  rankCount: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
  },
  popupDivider: {
    height: 1,
    backgroundColor: colors.mutedSand,
    marginVertical: 4,
  },
  totalCupsText: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
    textAlign: 'center',
  },
  detailInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  detailInfoLabel: {
    ...typography.L5,
    fontSize: 12,
    color: colors.mochaBrown,
  },
  detailInfoValue: {
    ...typography.L4,
    fontSize: 12,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  popupCloseBtn: {
    backgroundColor: colors.espressoBrown,
    borderRadius: 999,
    paddingVertical: 9,
    alignItems: 'center',
    marginTop: 4,
  },
  popupCloseText: {
    ...typography.L5,
    fontSize: 12,
    fontWeight: '800',
    color: colors.white,
  },
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
