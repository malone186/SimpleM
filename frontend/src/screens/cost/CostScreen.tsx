// 원가 분석 (ERP-6) — 메뉴별 원가·원가율. 정확한 숫자 화면 → 브루 미노출(금지구역)
// 데이터: GET /api/v1/inventory/menus (백엔드가 레시피×재료 단가로 원가·원가율을 실시간 계산)
import { useEffect, useState, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, Pressable, ScrollView, Linking, Animated, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// [한글 주석: Android 기기에서 레이아웃 애니메이션(LayoutAnimation)이 부드럽게 동작하도록 허용하는 설정]
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useAuth } from '../../auth/AuthContext';
import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle, Badge } from '../../components/ui';
import { PressableScale } from '../../components/motion'; // [한글 주석: 터치 이벤트가 씹히지 않는 최적화 모션 프레스 컴포넌트 추가]
import { apiFetch } from '../../lib/api/client';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import MenuOptimizationCard from '../../components/dashboard/MenuOptimizationCard'; // [한글 주석: AI 메뉴 최적화 진단 카드 컴포넌트 이관 임포트]

// /inventory/menus 응답 중 원가 분석에 쓰는 필드만
type MenuRow = {
  id: number;
  name: string;
  selling_price: number;
  cost_price?: number; // 백엔드가 실시간 계산해 준 총 원재료비 (KRW)
  cost_ratio?: number; // 백엔드가 실시간 계산해 준 최종 원가율 (%)
};

// [한글 주석: 메뉴 이름을 분석하여 카테고리별로 자동 매칭해주는 헬퍼 함수]
const getCategoryOfMenu = (name: string): string => {
  const lowerName = name.toLowerCase();
  
  if (lowerName.includes('디카페인') || lowerName.includes('decaf')) {
    return '디카페인';
  }
  
  const isLatte = lowerName.includes('라떼') || lowerName.includes('latte');
  
  // 커피가 함유된 라떼인지 판별 (카페라떼, 바닐라라떼, 돌체라떼 등)
  const isCoffeeLatte = isLatte && (
    lowerName.includes('카페') || 
    lowerName.includes('바닐라') || 
    lowerName.includes('돌체') || 
    lowerName.includes('카라멜') || 
    lowerName.includes('시그니처') ||
    lowerName.includes('아몬드') ||
    lowerName.includes('헤이즐넛') ||
    lowerName.includes('에스프레소') ||
    lowerName.includes('블랙') ||
    (!lowerName.includes('녹차') && !lowerName.includes('초코') && !lowerName.includes('딸기') && !lowerName.includes('고구마') && !lowerName.includes('말차') && !lowerName.includes('티') && !lowerName.includes('홍차') && !lowerName.includes('밀크티'))
  );
  
  if (isCoffeeLatte) {
    return '라떼';
  }
  
  if (isLatte) {
    return '논커피 라떼';
  }
  
  const isCoffee = 
    lowerName.includes('아메리카노') || 
    lowerName.includes('에스프레소') || 
    lowerName.includes('콜드브루') || 
    lowerName.includes('콜드 브루') || 
    lowerName.includes('카푸치노') || 
    lowerName.includes('마키아토') || 
    lowerName.includes('마끼아또') || 
    lowerName.includes('비엔나') || 
    lowerName.includes('플랫화이트') || 
    lowerName.includes('아인슈페너') || 
    lowerName.includes('더치') || 
    lowerName.includes('드립');
    
  if (isCoffee) {
    return '커피';
  }
  
  return '기타 음료';
};

export default function CostScreen() {
  const { token } = useAuth();
  const [menus, setMenus] = useState<MenuRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  // [한글 주석: 사용자가 선택한 조회용 카테고리 필터 상태]
  const [selectedCategory, setSelectedCategory] = useState<string>('전체');
  // [한글 주석: 카테고리 드롭다운 리스트의 노출 여부 상태]
  const [showCategoryDropdown, setShowCategoryDropdown] = useState<boolean>(false);

  // [한글 주석: AI 원가 절감 추천 팝업 관리를 위한 상태값 정의]
  const [selectedMenuName, setSelectedMenuName] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<any | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // [한글 주석: 슬라이드 모션을 위한 애니메이션 Y축 오프셋 상태 정의]
  const slideAnim = useRef(new Animated.Value(800)).current;

  // [한글 주석: 팝업을 열 때 Y축 오프셋을 0으로 슥 당겨 올리는 애니메이션을 실행합니다]
  const openModal = (menuId: number, menuName: string) => {
    setSelectedMenuName(menuName);
    setModalVisible(true);
    slideAnim.setValue(800);
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
    fetchRecommendations(menuId, menuName);
  };

  // [한글 주석: 팝업을 닫을 때 먼저 Y축 오프셋을 800으로 내린 뒤, 애니메이션이 끝나면 팝업을 안 보이게 처리합니다]
  const closeModal = () => {
    Animated.timing(slideAnim, {
      toValue: 800,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      setModalVisible(false);
    });
  };

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

  // [한글 주석: 선택한 카테고리에 해당하는 메뉴들만 실시간 필터링]
  const filteredRows = rows.filter((m) => {
    if (selectedCategory === '전체') return true;
    return getCategoryOfMenu(m.name) === selectedCategory;
  });

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
    try {
      const data = await apiFetch<any>(`/api/v1/inventory/menus/${menuId}/cost-reduction-recommendations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRecommendations(data);
      console.log('AI 원가 추천 데이터 연산 조회 완료:', data);
    } catch (e) {
      console.error('원가 절감 추천 로드 실패:', e);
      toast('추천 로드 실패', '대체재 가격 정보 데이터를 가져오지 못했습니다.');
      closeModal();
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

        {/* [한글 주석] 대시보드에서 이관 배치한 AI 메뉴 최적화 아코디언 카드 */}
        <MenuOptimizationCard />

        <SectionTitle>메뉴별 원가율</SectionTitle>

        {/* [한글 주석] 공간 효율성과 확장성을 극대화한 부드러운 드롭다운 필터 버튼 */}
        {menus !== null && rows.length > 0 && (
          <View style={{ zIndex: 50, marginBottom: 12 }}>
            <PressableScale
              style={styles.dropdownButton}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowCategoryDropdown(!showCategoryDropdown);
              }}
            >
              <Text style={styles.dropdownButtonText}>
                카테고리 필터: {selectedCategory}
              </Text>
              <Ionicons 
                name={showCategoryDropdown ? 'chevron-up' : 'chevron-down'} 
                size={16} 
                color={colors.espressoBrown} 
              />
            </PressableScale>

            {/* 드롭다운 카테고리 펼침 목록 */}
            {showCategoryDropdown && (
              <View style={styles.dropdownContent}>
                {['전체', '커피', '디카페인', '라떼', '논커피 라떼', '기타 음료'].map((cat) => {
                  const active = selectedCategory === cat;
                  return (
                    <PressableScale
                      key={cat}
                      style={[styles.dropdownItem, active && styles.dropdownItemActive]}
                      onPress={() => {
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setSelectedCategory(cat);
                        setShowCategoryDropdown(false); // 선택 후 자동으로 접어줌
                      }}
                    >
                      <Text style={[styles.dropdownItemText, active && styles.dropdownItemTextActive]}>
                        {cat}
                      </Text>
                      {active && <Ionicons name="checkmark" size={16} color={colors.espressoBrown} />}
                    </PressableScale>
                  );
                })}
              </View>
            )}
          </View>
        )}

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

        {/* [한글 주석] 필터링된 결과가 없을 경우 보여줄 빈 상태 카드 */}
        {menus !== null && rows.length > 0 && filteredRows.length === 0 && (
          <Card>
            <Text style={styles.stateText}>해당 카테고리에 해당하는 메뉴가 없습니다.</Text>
          </Card>
        )}

        {filteredRows.map((m) => {
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
              <Divider />
              
              {/* [한글 주석: 꾹 눌리는 감각 피드백과 확실한 터치 감지를 위해 PressableScale 컴포넌트로 개조] */}
              <PressableScale
                style={styles.recommendBtn}
                onPress={() => openModal(m.id, m.name)}
              >
                <Ionicons name="sparkles" size={13} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.recommendBtnText}>AI 원가 절감 추천</Text>
              </PressableScale>
            </Card>
          );
        })}
      </Screen>

      {/* [한글 주석: 팝업의 정돈된 반투명 배경 레이아웃을 백퍼센트 유지하며, 카드만 아래에서 위로 부드럽게 솟구치도록 애니메이션 뷰를 얹습니다] */}
      {modalVisible && (
        <View style={styles.modalOverlay}>
          <Animated.View 
            style={[
              styles.modalContent, 
              { transform: [{ translateY: slideAnim }] }
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>✨ AI 원가 절감 추천</Text>
              <Pressable onPress={closeModal} style={styles.closeBtn}>
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
          </Animated.View>
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
  // [한글 주석: 세련되고 확장성 높은 카테고리 필터용 드롭다운 버튼 스타일]
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 8,
    shadowColor: 'rgba(140, 111, 86, 0.25)',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 2,
  },
  dropdownButtonText: {
    ...typography.L4,
    fontSize: 13.5,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  // [한글 주석: 드롭다운 활성화 시 노출되는 옵션 선택 박스 컨테이너]
  dropdownContent: {
    backgroundColor: colors.white,
    borderRadius: 16,
    marginTop: 6,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 5,
    overflow: 'hidden', // 둥근 모서리에 맞춰 내부 아이템 잘림 방지
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(140, 111, 86, 0.04)',
  },
  dropdownItemActive: {
    backgroundColor: 'rgba(140, 111, 86, 0.07)', // 부드러운 틴트 배경색
  },
  dropdownItemText: {
    ...typography.L5,
    fontSize: 12.5,
    color: colors.mochaBrown,
    fontWeight: '600',
  },
  dropdownItemTextActive: {
    color: colors.espressoBrown,
    fontWeight: '900',
  },
});

