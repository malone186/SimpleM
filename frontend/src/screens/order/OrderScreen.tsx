// [한글 주석: 원두 탐색 마켓 화면]
// 기존 발주 추천·AI 예측 UI를 완전히 걷어내고,
// 로스터리에서 입고받은 원두 상품 목록을 카드 형태로 보여줍니다.
// 카드를 누르면 해당 스마트스토어 상품 페이지로 이동합니다.
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { Screen, ScreenTitle } from '../../components/ui';
import { colors, shadows, spacing, typography } from '../../theme';
import { listRoasteryBeans, RoasteryBean } from '../../lib/api/inventory';
import BeanDetailModal from '../../components/order/BeanDetailModal';
import BeanNotepad from '../../components/order/BeanNotepad';

// [한글 주석: 부족한 부자재 및 원두 재고 발주 추천 목록 데이터 정의]
const DEFICIENT_ITEMS = [
  { id: 'milk', name: '서울우유 1L', status: '잔여 3팩 (안전재고 8팩)', query: '서울우유 1L', is_bean: false },
  { 
    id: 'bean_gadello', 
    name: '가델로 에스프레소 블렌드 원두 500g', 
    status: '잔여 1봉 (안전재고 5봉)', 
    query: '가델로 에스프레소 블렌드', 
    is_bean: true, 
    product_url: 'https://mungmung.site/?q=%EA%B0%80%EB%8D%B8%EB%A1%9C%20%EC%97%90%EC%8A%A4%ED%94%84%EB%A0%88%EC%86%8C%20%EB%B8%94%EB%A0%8C%EB%93%9C' 
  },
  { id: 'cup', name: '종이컵 14oz', status: '잔여 150개 (안전재고 500개)', query: '카페 종이컵 14oz', is_bean: false },
  { id: 'holder', name: '컵 홀더 (크라프트)', status: '잔여 80개 (안전재고 300개)', query: '카페 컵홀더 크라프트', is_bean: false },
  { id: 'straw', name: '종이 빨대', status: '소진 임박 (안전재고 미달)', query: '카페 종이 빨대', is_bean: false },
];

export default function OrderScreen() {

  // [상태] 원두 목록, 로딩 중 여부, 오류 여부, 상세 모달 대상 원두
  const [beans, setBeans] = useState<RoasteryBean[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedBean, setSelectedBean] = useState<RoasteryBean | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

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

  // 백엔드에서 원두 목록 데이터 로드
  const loadBeans = async () => {
    try {
      setLoading(true);
      setError(false);
      const token = await getAuthToken();
      if (!token) return;
      const data = await listRoasteryBeans(token, 10);
      setBeans(data);
    } catch (e) {
      console.error('[원두 탐색] 원두 목록 로드 실패:', e);
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBeans();
  }, []);

  // [한글 주석: 만료된 네이버 스마트스토어 대신 mungmung.site 의 검색 쿼리를 결합해 상세 페이지 링크를 구성합니다]
  const getNoLoginProductUrl = (bean: RoasteryBean): string => {
    const keyword = bean.name;
    return `https://mungmung.site/?q=${encodeURIComponent(keyword)}`;
  };

  // 로그인 창 없이 원두 상품 구매 상세 페이지로 직행
  const handleBeanPress = (bean: RoasteryBean) => {
    const targetUrl = getNoLoginProductUrl(bean);
    Linking.openURL(targetUrl);
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
        <ScreenTitle title="원두 탐색" />
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.espressoBrown} />
          <Text style={styles.loadingText}>로스터리 원두 정보를 불러오는 중...</Text>
        </View>
      </Screen>
    );
  }

  // ----- 오류 화면 -----
  if (error) {
    return (
      <Screen>
        <ScreenTitle title="발주" />
        <View style={styles.centerBox}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.mochaBrown} />
          <Text style={styles.errorTitle}>데이터를 불러오지 못했어요</Text>
          <Text style={styles.errorDesc}>잠시 후 다시 시도해 주세요.</Text>
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
        {/* [한글 주석: 부족한 일반 부자재 재고 발주 추천 섹션을 렌더링합니다] */}
        <View style={styles.defSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="warning-outline" size={16} color={colors.pointOrange} />
            <Text style={styles.defSectionTitle}>부족한 재고 발주 추천</Text>
          </View>
          <View style={styles.defList}>
            {DEFICIENT_ITEMS.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.defCard}
                onPress={() => {
                  // [한글 주석: 원두 상품은 데이터베이스(DB)에 지정된 오리지널 mungmung.site 검색 링크로 연결하고, 그 외 일반 부자재는 네이버 쇼핑에서 검색합니다]
                  if (item.is_bean && item.product_url) {
                    Linking.openURL(item.product_url);
                  } else {
                    Linking.openURL(`https://search.shopping.naver.com/search/all?query=${encodeURIComponent(item.query)}`);
                  }
                }}
                activeOpacity={0.8}
              >
                <View style={styles.defInfo}>
                  <Text style={styles.defName}>{item.name}</Text>
                  <Text style={styles.defStatus}>{item.status}</Text>
                </View>
                <View style={styles.defBuyBtn}>
                  <Ionicons name="cart-outline" size={13} color={colors.white} />
                  <Text style={styles.defBuyText}>구매</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>


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
