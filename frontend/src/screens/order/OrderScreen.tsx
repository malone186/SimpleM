// [한글 주석: 원두 탐색 마켓 화면]
// 기존 발주 추천·AI 예측 UI를 완전히 걷어내고,
// 로스터리에서 입고받은 원두 상품 목록을 카드 형태로 보여줍니다.
// 카드를 누르면 해당 스마트스토어 상품 페이지로 이동합니다.
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { Screen, ScreenTitle } from '../../components/ui';
import { useTranslation } from '../../i18n/translations';
import { colors, shadows, spacing, typography } from '../../theme';
import { listRoasteryBeans, listStocks, RoasteryBean, StockItem } from '../../lib/api/inventory';
import BeanDetailModal from '../../components/order/BeanDetailModal';
import BeanNotepad from '../../components/order/BeanNotepad';

// 안전재고를 따로 설정하지 않은 재료에 적용할 기본 부족 기준 (개/단위)
const DEFAULT_LOW_STOCK = 3;

export default function OrderScreen() {
  // [한글 주석: 전역 다국어 훅 호출]
  const { t, language } = useTranslation();

  // [상태] 원두 목록, 로딩 중 여부, 오류 여부, 상세 모달 대상 원두
  const [beans, setBeans] = useState<RoasteryBean[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedBean, setSelectedBean] = useState<RoasteryBean | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  // 실제 재고 API 기준 안전재고 미달 품목 (더미 데이터 대체)
  const [lowStocks, setLowStocks] = useState<StockItem[]>([]);

  // 상세 정보 모달 열기
  const openDetail = (bean: RoasteryBean) => {
    setSelectedBean(bean);
    setModalVisible(true);
  };

  // 상세 정보 모달 닫기
  const closeDetail = () => {
    setModalVisible(false);
  };

  // 로컬 저장소에서 로그인 토큰 획득
  const getAuthToken = async (): Promise<string | null> => {
    const raw = await AsyncStorage.getItem('simplem:session');
    if (raw) {
      const session = JSON.parse(raw);
      return session?.token || null;
    }
    return null;
  };

  // 백엔드에서 원두 목록 데이터 로드.
  // 실패하면 빈 목록 + 에러 상태로 둔다 — 예전엔 지어낸 원두 5종을 대신 채워서,
  // 서버가 죽은 줄도 모르고 존재하지 않는 상품의 가격을 비교하게 됐다.
  const loadBeans = async () => {
    try {
      setLoading(true);
      setError(false);
      const token = await getAuthToken();
      const data = await listRoasteryBeans(token ?? undefined, 10);
      setBeans(data ?? []);
      if (token) {
        try {
          const stocks = await listStocks(token);
          // 안전재고를 따로 설정한 재료가 거의 없다 — 아무도 초기 세팅을 안 하기 때문이다.
          // 그래서 설정값이 0이면 '3개 미만'이라는 기본 기준으로 대신 잡아 준다.
          // (사장님 요청: 거창한 발주 예측 말고 3개 밑으로 떨어지면 알려주는 정도면 된다)
          setLowStocks(
            stocks.filter((st) =>
              st.current_quantity < (st.safety_quantity > 0 ? st.safety_quantity : DEFAULT_LOW_STOCK),
            ),
          );
        } catch {
          setLowStocks([]);
        }
      }
    } catch (e) {
      console.error('[원두 탐색] 원두 목록 로드 실패:', e);
      setBeans([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBeans();
  }, []);

  // 구매 링크 — DB에 수집해 둔 실제 상품 페이지(product_url)를 먼저 쓴다.
  // 예전엔 그 값을 버리고 무조건 검색 URL로 보냈다. 화면에 띄운 가격은 특정 상품의 것인데
  // 링크는 동명이인 상품이 잔뜩 나오는 검색 결과로 가서, 사장님이 본 가격을 다시 못 찾았다.
  // (원두 운영 화면 BeanOperationScreen은 처음부터 product_url을 우선 사용하고 있었다)
  const getProductUrl = (bean: RoasteryBean): string =>
    bean.product_url || `https://mungmung.site/?q=${encodeURIComponent(bean.name)}`;

  const handleBeanPress = (bean: RoasteryBean) => {
    const targetUrl = getProductUrl(bean);
    if (Platform.OS === 'web') {
      window.open(targetUrl, '_blank');
    } else {
      Linking.openURL(targetUrl);
    }
  };

  // 가격 포맷: 예) 32000 → "32,000원"
  const formatPrice = (price: number) => `${price.toLocaleString('ko-KR')}원`;

  // 배지 목록 구성 (best, new, decaf, blend, gesha, sold_out)
  const getBadges = (bean: RoasteryBean) => {
    const badges: { label: string; style: 'orange' | 'green' | 'gray' | 'blue' }[] = [];
    if (bean.best) badges.push({ label: 'BEST', style: 'orange' });
    if (bean.new) badges.push({ label: 'NEW', style: 'green' });
    if (bean.gesha) badges.push({ label: 'GESHA', style: 'blue' });
    if (bean.decaf) badges.push({ label: 'DECAF', style: 'gray' });
    if (bean.blend) badges.push({ label: 'BLEND', style: 'gray' });
    if (bean.sold_out) badges.push({ label: '품절', style: 'gray' });
    return badges;
  };

  // ----- 로딩 화면 -----
  if (loading) {
    return (
      <Screen>
        <ScreenTitle title={t('beanExplore')} />
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.espressoBrown} />
          <Text style={styles.loadingText}>{language === 'en' ? 'Loading roastery beans...' : '로스터리 원두 정보를 불러오는 중...'}</Text>
        </View>
      </Screen>
    );
  }

  // ----- 오류 화면 -----
  if (error) {
    return (
      <Screen>
        <ScreenTitle title={t('orderTitle')} />
        <View style={styles.centerBox}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.mochaBrown} />
          <Text style={styles.errorTitle}>{language === 'en' ? 'Failed to load data' : '데이터를 불러오지 못했어요'}</Text>
          <Text style={styles.errorDesc}>{language === 'en' ? 'Please try again later.' : '잠시 후 다시 시도해 주세요.'}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadBeans}>
            <Text style={styles.retryText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  // ----- 메인 화면: 원두 카드 목록 -----
  return (
    <Screen>
      {/* 상단 타이틀 */}
      <ScreenTitle
        title="발주"
        subtitle="부자재 부족 재고 쇼핑"
      />

      {/* 원두 메모장 — 현재 사용 원두 및 체험 노트 */}
      <BeanNotepad />

      {/* 원두 및 부자재 스크롤 목록 */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContainer}>
        {/* 실시간 재고 기준 안전재고 미달 품목 발주 추천 — 미달 품목이 없으면 섹션 자체를 감춘다 */}
        {lowStocks.length > 0 && (
          <View style={styles.defSection}>
            <View style={styles.sectionHeader}>
              <Ionicons name="warning-outline" size={16} color={colors.pointOrange} />
              <Text style={styles.defSectionTitle}>곧 떨어져요 — 채워 두세요</Text>
            </View>
            <Text style={styles.defSectionHint}>
              최소 보유량을 정한 재료는 그 기준으로, 안 정한 재료는 {DEFAULT_LOW_STOCK}개 미만일 때 알려드려요.
            </Text>
            <View style={styles.defList}>
              {lowStocks.map((item) => (
                <TouchableOpacity
                  key={item.ingredient_id}
                  style={styles.defCard}
                  onPress={() => {
                    Linking.openURL(`https://search.shopping.naver.com/search/all?query=${encodeURIComponent(item.name)}`);
                  }}
                  activeOpacity={0.8}
                >
                  <View style={styles.defInfo}>
                    <Text style={styles.defName}>{item.name}</Text>
                    <Text style={styles.defStatus}>
                      남은 수량 {item.current_quantity}{item.unit}
                      {item.safety_quantity > 0
                        ? ` · 최소 ${item.safety_quantity}${item.unit} 필요`
                        : ` · 기본 기준 ${DEFAULT_LOW_STOCK}${item.unit}`}
                    </Text>
                  </View>
                  <View style={styles.defBuyBtn}>
                    <Ionicons name="cart-outline" size={13} color={colors.white} />
                    <Text style={styles.defBuyText}>구매</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}


      </ScrollView>

      {/* 원두 상세 정보 모달 */}
      <BeanDetailModal
        bean={selectedBean}
        visible={modalVisible}
        onClose={closeDetail}
      />
    </Screen>
  );
}

// ----- 스타일 정의 -----
const BADGE_COLORS = {
  orange: { bg: 'rgba(212,120,50,0.12)', text: '#C07030' },
  green: { bg: 'rgba(78,125,58,0.12)', text: '#4E7D3A' },
  blue: { bg: 'rgba(60,100,180,0.10)', text: '#3C64B4' },
  gray: { bg: 'rgba(140,111,86,0.10)', text: '#8C6F56' },
};

const styles = StyleSheet.create({
  // 로딩 및 오류 중앙 정렬 박스
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 80,
  },
  loadingText: { ...typography.L4, color: colors.mochaBrown },
  errorTitle: { ...typography.L3, color: colors.espressoBrown },
  errorDesc: { ...typography.L5, color: colors.mochaBrown },
  retryBtn: {
    marginTop: 8,
    backgroundColor: colors.espressoBrown,
    borderRadius: 20,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { ...typography.L4, color: colors.white },

  // 리스트 컨테이너
  listContainer: {
    gap: spacing.gridGap,
    paddingBottom: 40,
  },

  // 섹션 구분선
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 4,
  },
  sectionLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.mutedSand,
  },
  sectionLabelText: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontWeight: '700',
    fontSize: 10,
  },

  // 원두 카드
  card: {
    backgroundColor: colors.white,
    borderRadius: 16,
    overflow: 'visible', // 우상단 아이콘이 카드 밖으로 다소 노출될 수 있도록 visible
    flexDirection: 'row',
    position: 'relative', // 정보 아이콘 절대위치 기준점
    ...shadows.soft,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  // 품절 카드는 살짝 흘리게
  cardSoldOut: {
    opacity: 0.65,
  },
  // 우상단 상세정보 아이콘 버튼
  infoBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 10,
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },

  // 썸네일 이미지 영역 (자체적으로 overflow hidden 처리 — 카드가 visible이어도 이미지는 깔끔하게 잘림)
  imageBox: {
    width: 100,
    height: 100,
    backgroundColor: colors.coffeeCream,
    position: 'relative',
    overflow: 'hidden',
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
  },
  thumbnail: {
    width: 100,
    height: 100,
  },
  noImageBox: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 품절 이미지 오버레이
  soldOutOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soldOutOverlayText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },

  // 정보 영역
  infoBox: {
    flex: 1,
    padding: 12,
    gap: 4,
    justifyContent: 'center',
  },
  roasteryName: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontSize: 10,
  },
  beanName: {
    ...typography.L4,
    color: colors.espressoBrown,
    lineHeight: 16,
  },

  // 원산지·가공방식 칩 줄
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  metaText: {
    ...typography.L5,
    fontSize: 9,
    color: colors.mochaBrown,
  },

  // 배지 줄
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badge_orange: { backgroundColor: BADGE_COLORS.orange.bg },
  badge_green: { backgroundColor: BADGE_COLORS.green.bg },
  badge_blue: { backgroundColor: BADGE_COLORS.blue.bg },
  badge_gray: { backgroundColor: BADGE_COLORS.gray.bg },
  badgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
  badgeText_orange: { color: BADGE_COLORS.orange.text },
  badgeText_green: { color: BADGE_COLORS.green.text },
  badgeText_blue: { color: BADGE_COLORS.blue.text },
  badgeText_gray: { color: BADGE_COLORS.gray.text },

  // 가격 줄
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  price: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '900',
  },
  priceSoldOut: {
    color: colors.mochaBrown,
    textDecorationLine: 'line-through',
  },
  perGram: {
    ...typography.L5,
    fontSize: 9,
    color: colors.mochaBrown,
  },
  linkIcon: {
    marginLeft: 'auto' as any,
  },

  // 하단 안내 문구
  footNote: {
    ...typography.L5,
    color: colors.mochaBrown,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 12,
    paddingHorizontal: 8,
  },

  // [한글 주석: 부족한 부자재 재고 발주 추천 UI 스타일 세트]
  defSection: {
    marginBottom: 20,
    backgroundColor: 'rgba(212,120,50,0.04)', // 오렌지-베이지 톤의 부드러운 틴트
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(212,120,50,0.15)',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  defSectionHint: { ...typography.L5, color: colors.mochaBrown, marginBottom: 8, lineHeight: 15 },
  defSectionTitle: {
    ...typography.L3,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  defList: {
    gap: 8,
  },
  defCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  defInfo: {
    flex: 1,
    gap: 3,
  },
  defName: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '700',
  },
  defStatus: {
    fontSize: 11.5,
    color: '#A06030', // 강하지만 정돈된 갈색 톤 경고 색상
    fontWeight: '600',
  },
  defBuyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.pointOrange,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  defBuyText: {
    fontSize: 11,
    color: colors.white,
    fontWeight: '700',
  },
});
