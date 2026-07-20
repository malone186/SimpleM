// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
// 데이터: GET /api/v1/inventory/menus (백엔드가 레시피×재료 단가로 원가·원가율을 실시간 계산)
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, Modal, Pressable, ScrollView, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle, Badge } from '../../components/ui';
import { PressableScale } from '../../components/motion'; // [한글 주석: 터치 이벤트가 씹히지 않는 최적화 모션 프레스 컴포넌트 추가]
import { apiFetch } from '../../lib/api/client';
import { toast } from '../../components/toast';
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

  // [한글 주석: AI 원가 절감 추천 팝업 관리를 위한 상태값 정의]
  const [selectedMenuName, setSelectedMenuName] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<any | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

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

  // [한글 주석: 특정 상품의 실시간 원가 절감 추천 정보를 백엔드에서 비동기 호출해 오는 함수입니다]
  const fetchRecommendations = async (menuId: number, menuName: string) => {
    console.log('AI 원가 추천 터치 이벤트 캡처 성공:', menuId, menuName);
    if (!token) {
      console.warn('사용자 토큰이 유실되어 API 요청을 중단합니다.');
      return;
    }
    setRecLoading(true);
    setSelectedMenuName(menuName);
    setModalVisible(true);
    try {
      const data = await apiFetch<any>(`/api/v1/inventory/menus/${menuId}/cost-reduction-recommendations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRecommendations(data);
      console.log('AI 원가 추천 데이터 연산 조회 완료:', data);
    } catch (e) {
      console.error('원가 절감 추천 로드 실패:', e);
      toast('추천 로드 실패', '대체재 가격 정보 데이터를 가져오지 못했습니다.');
      setModalVisible(false);
    } finally {
      setRecLoading(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
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
              <Divider style={{ marginVertical: 8 }} />
              
              {/* [한글 주석: 꾹 눌리는 감각 피드백과 확실한 터치 감지를 위해 PressableScale 컴포넌트로 개조] */}
              <PressableScale
                style={styles.recommendBtn}
                onPress={() => fetchRecommendations(m.id, m.name)}
              >
                <Ionicons name="sparkles" size={13} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.recommendBtnText}>AI 원가 절감 추천</Text>
              </PressableScale>
            </Card>
          );
        })}
      </Screen>

      {/* [한글 주석: 스크롤 뷰(Screen) 영향을 받지 않도록 스크롤 뷰의 바깥(형제 레벨)에 절대 배치 팝업을 얹습니다] */}
      {modalVisible && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>✨ AI 원가 절감 추천</Text>
              <Pressable onPress={() => setModalVisible(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={colors.espressoBrown} />
              </Pressable>
            </View>

            <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 30 }}>
              <Text style={styles.menuTitle}>{selectedMenuName} 레시피 분석</Text>
              
              {recLoading ? (
                <View style={styles.loadingBox}>
                  <ActivityIndicator size="large" color={colors.mochaBrown} />
                  <Text style={styles.loadingText}>대체 도매상품 매칭 및 시뮬레이션 중…</Text>
                </View>
              ) : recommendations ? (
                <View style={{ gap: 16 }}>
                  {/* 정산 시뮬레이션 요약 카드 */}
                  <View style={styles.simulationCard}>
                    <Text style={styles.simTitle}>📊 대체재 일괄 변경 시뮬레이션</Text>
                    <View style={styles.simGrid}>
                      <View style={styles.simItem}>
                        <Text style={styles.simLabel}>현재 원가</Text>
                        <Text style={styles.simValue}>₩{recommendations.current_cost?.toLocaleString()} ({recommendations.current_ratio}%)</Text>
                      </View>
                      <View style={styles.simItem}>
                        <Text style={styles.simLabel}>최대 절감액</Text>
                        <Text style={[styles.simValue, { color: colors.trendGreenText, fontWeight: '700' }]}>-₩{recommendations.total_savings?.toLocaleString()}</Text>
                      </View>
                      <View style={styles.simItem}>
                        <Text style={styles.simLabel}>예상 원가</Text>
                        <Text style={[styles.simValue, { color: colors.pointOrange, fontWeight: '700' }]}>₩{recommendations.potential_cost?.toLocaleString()} ({recommendations.potential_ratio}%)</Text>
                      </View>
                    </View>
                  </View>

                  <Text style={styles.sectionHeader}>💡 추천 대체재 및 납품 정보</Text>
                  {recommendations.recommendations?.length === 0 ? (
                    <Text style={styles.emptyText}>현재 등록된 원부자재 단가가 도매 최저가 수준이므로 추가적인 절감 대안이 없습니다. 아주 훌륭하게 관리 중입니다! 👍</Text>
                  ) : (
                    recommendations.recommendations.map((rec: any, idx: number) => (
                      <View key={idx} style={styles.recCard}>
                        <View style={styles.recHeader}>
                          <Text style={styles.recIngName}>{rec.ingredient_name}</Text>
                          <Badge label={rec.source} tone={rec.source.includes('도매') ? 'green' : 'neutral'} />
                        </View>
                        <Text style={styles.recAltName}>대체추천: {rec.alternative_name}</Text>
                        
                        <View style={styles.recPriceRow}>
                          <Text style={styles.priceCompare}>
                            ₩{rec.current_price_per_unit?.toLocaleString()} → <Text style={{fontWeight: 'bold', color: colors.pointOrange}}>₩{rec.alternative_price_per_unit?.toLocaleString()}</Text> (원/{rec.unit})
                          </Text>
                          <Text style={styles.recSaving}>잔당 -₩{rec.saving_per_serving}</Text>
                        </View>
                        <Text style={styles.recDesc}>{rec.description}</Text>
                        
                        {rec.link ? (
                          <Pressable
                            style={styles.linkBtn}
                            onPress={() => Linking.openURL(rec.link)}
                          >
                            <Ionicons name="link-outline" size={14} color={colors.mochaBrown} style={{ marginRight: 4 }} />
                            <Text style={styles.linkBtnText}>상세 판매처 링크 이동</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ))
                  )}
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
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
    alignItems: 'baseline',
    marginBottom: 12,
    paddingHorizontal: 2
  },
  name: {
    ...typography.L3,
    color: colors.espressoBrown,
    fontSize: 17,
    fontWeight: '800',
  },
  rate: { ...typography.L2, fontSize: 22 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  detail: { flex: 1, alignItems: 'center' },
  detailLabel: { ...typography.L5, color: colors.mochaBrown },
  detailValue: { ...typography.L4, color: colors.espressoBrown, marginTop: 3 },
  
  // [한글 주석: AI 원가 절감 추천용 신규 추가 버튼 스타일시트]
  recommendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6D4C41',
    borderRadius: 8,
    paddingVertical: 8,
    marginTop: 10,
  },
  recommendBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },

  // [한글 주석: 웹 컴파일 시 기기 스크린을 탈출하는 현상을 막기 위한 절대 좌표 스타일시트]
  modalOverlay: {
    position: 'absolute',    // position을 absolute로 선언하여 폰 액정 스크린 내에 절대 위치시킵니다.
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    alignItems: 'center',
    zIndex: 9999,            // 폰 안에서 최상단 레이어로 출력되게 처리합니다.
  },
  modalContent: {
    backgroundColor: '#FAF7F2',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '80%',           // 폰 화면 내에서 스크롤 공간을 넉넉히 확보하기 위해 높이 80% 지정
    paddingTop: 16,
    width: '100%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EFECE6',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  closeBtn: {
    padding: 4,
  },
  modalBody: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  menuTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: colors.espressoBrown,
    marginBottom: 16,
  },
  loadingBox: {
    paddingVertical: 50,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: colors.mochaBrown,
  },
  
  // 시뮬레이션 요약 카드
  simulationCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#EFECE6',
  },
  simTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.mochaBrown,
    marginBottom: 12,
  },
  simGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  simItem: {
    flex: 1,
    alignItems: 'center',
  },
  simLabel: {
    fontSize: 11,
    color: colors.mochaBrown,
    marginBottom: 4,
  },
  simValue: {
    fontSize: 13.5,
    color: colors.espressoBrown,
  },
  
  sectionHeader: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.espressoBrown,
    marginTop: 8,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 13,
    color: colors.mochaBrown,
    lineHeight: 18,
    textAlign: 'center',
    paddingVertical: 30,
  },
  
  // 추천 정보 카드
  recCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#EFECE6',
  },
  recHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  recIngName: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  recAltName: {
    fontSize: 13.5,
    color: colors.espressoBrown,
    fontWeight: '600',
    marginBottom: 8,
  },
  recPriceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  priceCompare: {
    fontSize: 12.5,
    color: colors.mochaBrown,
  },
  recSaving: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.trendGreenText,
  },
  recDesc: {
    fontSize: 12,
    color: colors.mochaBrown,
    lineHeight: 16,
    marginBottom: 10,
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.mochaBrown,
    borderRadius: 6,
    paddingVertical: 6,
  },
  linkBtnText: {
    fontSize: 12,
    color: colors.mochaBrown,
    fontWeight: '600',
  },
});

