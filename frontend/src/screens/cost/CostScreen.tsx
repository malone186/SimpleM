// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
// 데이터: GET /api/v1/inventory/menus (백엔드가 레시피×재료 단가로 원가·원가율을 실시간 계산)
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { apiFetch } from '../../lib/api/client';
import { colors, typography } from '../../theme';

// /inventory/menus 응답 중 원가 분석에 쓰는 필드만
type MenuRow = {
  id: number;
  name: string;
  selling_price: number;
  cost_price?: number; // 백엔드가 실시간 계산해 준 총 원재료비 (KRW)
  cost_ratio?: number; // 백엔드가 실시간 계산해 준 최종 원가율 (%)
};

export default function CostScreen() {
  const { token } = useAuth();
  const [menus, setMenus] = useState<MenuRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<MenuRow[]>('/api/v1/inventory/menus', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((rows) => {
        if (!cancelled) setMenus(rows);
      })
      .catch((e) => {
        console.error('메뉴 원가 조회 실패:', e);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const rows = (menus ?? []).filter((m) => m.selling_price > 0);

  // 평균 원가율 — 백엔드 계산값(cost_ratio) 우선, 없으면 cost_price/판매가로 산출
  const rateOf = (m: MenuRow) =>
    m.cost_ratio !== undefined ? m.cost_ratio : ((m.cost_price ?? 0) / m.selling_price) * 100;
  const avg = rows.length ? Math.round(rows.reduce((s, m) => s + rateOf(m), 0) / rows.length) : null;

  return (
    <Screen>
      <ScreenTitle title="원가 분석" subtitle="메뉴별 원가율 · 단가 변동 자동 반영" />

      {/* 요약 */}
      <Card>
        <Text style={styles.summaryLabel}>전체 평균 원가율</Text>
        <Text style={styles.summaryValue}>{avg !== null ? `${avg}%` : '—'}</Text>
        <Text style={styles.summaryHint}>일반적으로 30~35% 이하를 권장해요</Text>
      </Card>

      <SectionTitle>메뉴별 원가율</SectionTitle>

      {menus === null && !failed && (
        <Card>
          <View style={styles.stateWrap}>
            <ActivityIndicator color={colors.mochaBrown} />
            <Text style={styles.stateText}>메뉴 원가를 계산하는 중…</Text>
          </View>
        </Card>
      )}

      {failed && (
        <Card>
          <Text style={styles.stateText}>원가 정보를 가져오지 못했어요. 로그인과 서버를 확인해 주세요.</Text>
        </Card>
      )}

      {menus !== null && rows.length === 0 && !failed && (
        <Card>
          <Text style={styles.stateText}>등록된 메뉴가 없어요. 메뉴 관리에서 메뉴와 레시피를 등록하면 원가율이 자동 계산됩니다.</Text>
        </Card>
      )}

      {rows.map((m) => {
        const cost = m.cost_price ?? 0;
        const rate = Math.round(rateOf(m));
        const margin = m.selling_price - cost;
        const high = rate > 35;
        return (
          <Card key={m.id}>
            <View style={styles.head}>
              <Text style={styles.name}>{m.name}</Text>
              <Text style={[styles.rate, { color: high ? '#B23B2E' : colors.trendGreenText }]}>
                {rate}%
              </Text>
            </View>
            <ProgressBar ratio={Math.min(rate, 100) / 100} tone={high ? 'danger' : 'green'} />
            <Divider />
            <View style={styles.detailRow}>
              <Detail label="판매가" value={`₩${m.selling_price.toLocaleString()}`} />
              <Detail label="원가" value={`₩${cost.toLocaleString()}`} />
              <Detail label="마진" value={`₩${margin.toLocaleString()}`} accent />
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}

function Detail({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, accent && { color: colors.pointOrange }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryLabel: { ...typography.L5, color: colors.mochaBrown },
  summaryValue: { fontSize: 34, fontWeight: '900', color: colors.espressoBrown, marginTop: 4 },
  summaryHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline', // [한글 주석] center 대신 baseline 정렬을 주어 이름과 퍼센트 텍스트 수직 밸런스를 잡습니다.
    marginBottom: 12,
    paddingHorizontal: 2
  },
  name: {
    ...typography.L3,
    color: colors.espressoBrown,
    fontSize: 17,
    fontWeight: '800', // [한글 주석] 기존 L3 굵기보다 더 진하고 선명하게 조절하여 가독성을 극대화합니다.
  },
  rate: { ...typography.L2, fontSize: 22 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }, // [한글 주석] ProgressBar 아래 여백 보강
  detail: { flex: 1, alignItems: 'center' },
  detailLabel: { ...typography.L5, color: colors.mochaBrown },
  detailValue: { ...typography.L4, color: colors.espressoBrown, marginTop: 3 },
});
