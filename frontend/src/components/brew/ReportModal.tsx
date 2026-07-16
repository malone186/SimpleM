// 브루 등장 지도 #3(로딩: 드립 내리는 브루) + #4(리포트 서명: "— 브루 드림")
// AI 경영 리포트(일간·주간·월간)를 "브루가 나에게 쓴 편지"로 보여준다.
// 데이터는 백엔드 /chatbot/reports/management — 매출·매입·지출·인건비·재고·발주·갱신 서류 통합 집계.
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import {
  getManagementReport,
  type GeneratedDocument,
  type ReportPeriodType,
} from '../../lib/api/documents';
import { colors, spacing, typography } from '../../theme';
import { PressableScale } from '../motion';
import Brew from './Brew';

const PERIOD_LABEL: Record<ReportPeriodType, string> = {
  daily: '오늘',
  weekly: '이번 주',
  monthly: '이번 달',
};

const MIN_BREWING_MS = 1200; // 드립 연출 최소 시간 — 응답이 빨라도 브루가 일은 해야 하니까

const won = (n: number) => `₩${Math.abs(n).toLocaleString('ko-KR')}`;

export default function ReportModal({
  visible,
  onClose,
  periodType = 'weekly',
}: {
  visible: boolean;
  onClose: () => void;
  periodType?: ReportPeriodType;
}) {
  const { token } = useAuth();
  const [phase, setPhase] = useState<'brewing' | 'done' | 'error'>('brewing');
  const [report, setReport] = useState<GeneratedDocument | null>(null);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      return;
    }
    setPhase('brewing');
    setReport(null);
    Animated.spring(slide, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }).start();

    let cancelled = false;
    const started = Date.now();
    (async () => {
      try {
        if (!token) throw new Error('no token');
        const doc = await getManagementReport(token, periodType);
        const wait = Math.max(0, MIN_BREWING_MS - (Date.now() - started));
        setTimeout(() => {
          if (cancelled) return;
          setReport(doc);
          setPhase('done');
        }, wait);
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, periodType, token, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [500, 0] });
  const backdrop = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const label = PERIOD_LABEL[periodType];

  // content 스키마는 report_service.py의 management_report 구조를 따른다
  const c = (report?.content ?? {}) as any;
  const highlights: string[] = Array.isArray(c.highlights) ? c.highlights : [];
  const salesDelta: number | null = c.sales?.change_pct ?? null;
  const lowStockCount: number = c.inventory?.low_stock?.length ?? 0;
  const complianceCount: number = c.compliance_alerts?.length ?? 0;
  const openOrders: number = c.orders?.open_count ?? 0;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheetWrap, { transform: [{ translateY }] }]}>
          <View style={styles.sheet}>
            <View style={styles.handle} />

            {phase === 'brewing' && (
              <View style={styles.brewing}>
                <Brew mood="pouring" size={180} />
                <Text style={styles.brewingText}>브루가 {label} 리포트를 내리는 중…</Text>
              </View>
            )}

            {phase === 'error' && (
              <View style={styles.brewing}>
                <Brew mood="resting" size={140} />
                <Text style={styles.brewingText}>
                  리포트를 가져오지 못했어요.{'\n'}로그인 상태와 서버를 확인해 주세요.
                </Text>
                <PressableScale style={styles.closeBtn} onPress={onClose}>
                  <Text style={styles.closeText}>닫기</Text>
                </PressableScale>
              </View>
            )}

            {phase === 'done' && report && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.reportHead}>
                  <Brew mood="clipboard" size={72} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reportTitle}>{label} 경영 리포트</Text>
                    <Text style={styles.reportDate}>{c.period} · 사장님께</Text>
                  </View>
                </View>

                {/* 핵심 요약 — 숫자에서 바로 읽어낸 사실들 */}
                {highlights.length > 0 ? (
                  <View style={styles.letterWrap}>
                    {highlights.map((h, i) => (
                      <Text key={i} style={styles.letter}>
                        <Text style={styles.hl}>✦ </Text>
                        {h}
                      </Text>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.letter}>이 기간에는 아직 기록된 데이터가 없어요.</Text>
                )}

                {/* 근거 숫자 (검증 가능하게) */}
                <View style={styles.evidence}>
                  <Ev
                    label={`${label} 매출`}
                    value={won(c.sales?.total ?? 0)}
                    delta={
                      salesDelta === null
                        ? '비교 없음'
                        : `${salesDelta >= 0 ? '+' : ''}${salesDelta}%`
                    }
                    up={salesDelta !== null && salesDelta >= 0}
                  />
                  <Ev
                    label="추정 수익"
                    value={`${(c.profit?.estimated_profit ?? 0) < 0 ? '-' : ''}${won(c.profit?.estimated_profit ?? 0)}`}
                    delta={c.profit?.margin_pct != null ? `마진 ${c.profit.margin_pct}%` : '—'}
                    up={(c.profit?.estimated_profit ?? 0) >= 0}
                  />
                  <Ev
                    label="비용 합계"
                    value={won(c.profit?.total_cost ?? 0)}
                    delta={`인건비 ${won(c.labor?.estimated_cost ?? 0)}`}
                  />
                </View>

                {/* 운영 체크 한 줄 */}
                <Text style={styles.opsLine}>
                  재고 경고 {lowStockCount}건 · 진행 중 발주 {openOrders}건 · 갱신 임박 서류{' '}
                  {complianceCount}건
                </Text>

                <Text style={styles.chatHint}>
                  품목별 상세 표가 궁금하면 챗봇에서 “{label} 리포트 보여줘”라고 물어보세요 ☕
                </Text>

                <Text style={styles.sign}>— 브루 드림 ☕</Text>

                <PressableScale style={styles.closeBtn} onPress={onClose}>
                  <Text style={styles.closeText}>고마워요 브루</Text>
                </PressableScale>
              </ScrollView>
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function Ev({ label, value, delta, up }: { label: string; value: string; delta: string; up?: boolean }) {
  return (
    <View style={styles.ev}>
      <Text style={styles.evLabel}>{label}</Text>
      <Text style={styles.evValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={[styles.evDelta, up && { color: colors.trendGreenText }]}>{delta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheetWrap: { width: '100%' },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: spacing.globalPadding,
    paddingBottom: 32,
    maxHeight: 620,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.mutedSand, marginBottom: 16 },
  brewing: { alignItems: 'center', paddingVertical: 30 },
  brewingText: { ...typography.L4, color: colors.mochaBrown, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  reportHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  reportTitle: { ...typography.L1, color: colors.espressoBrown },
  reportDate: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  letterWrap: { gap: 10 },
  letter: { ...typography.L4, fontWeight: '500', color: colors.espressoBrown, lineHeight: 22 },
  hl: { color: colors.pointOrange, fontWeight: '700' },
  evidence: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 20,
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 14,
  },
  ev: { flex: 1, alignItems: 'center' },
  evLabel: { ...typography.L5, color: colors.mochaBrown },
  evValue: { ...typography.L3, color: colors.espressoBrown, marginTop: 4 },
  evDelta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  opsLine: { ...typography.L5, color: colors.mochaBrown, marginTop: 12, textAlign: 'center' },
  chatHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, textAlign: 'center' },
  sign: { ...typography.L3, color: colors.espressoBrown, textAlign: 'right', marginTop: 20, fontStyle: 'italic' },
  closeBtn: { backgroundColor: colors.pointOrange, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  closeText: { ...typography.L3, color: colors.white },
});
