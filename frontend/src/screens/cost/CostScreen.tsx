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
import { useTranslation } from '../../i18n/translations';
import { Card, Divider, ProgressBar, Screen, ScreenTitle, SectionTitle, Badge } from '../../components/ui';
import { PressableScale } from '../../components/motion'; // [한글 주석: 터치 이벤트가 씹히지 않는 최적화 모션 프레스 컴포넌트 추가]
import { apiFetch } from '../../lib/api/client';
import { describeApiFailure, type ApiFailure } from '../../lib/api/errors';
import { getMenuContribution, type ContributionResult } from '../../lib/api/sales';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import {
  COST_STANDARDS,
  GRADE_COLOR,
  GRADE_LABEL,
  categoryOfMenu,
  gradeMessage,
  gradeOf,
  suggestedPrice,
} from '../../lib/costStandards';

// 메뉴 1개의 레시피 한 줄 — 어떤 재료가 몇 g/ml 들어가는지
type RecipeLine = {
  ingredient_id: number;
  ingredient_name: string;
  quantity: number; // 소요량 (재료 unit 기준, 예: 원두 20g의 20)
  unit: string;     // g, ml, 개 등
};

// /inventory/menus 응답 중 원가 분석에 쓰는 필드만
type MenuRow = {
  id: number;
  name: string;
  selling_price: number;
  cost_price?: number; // 백엔드가 실시간 계산해 준 총 원재료비 (KRW)
  cost_ratio?: number; // 백엔드가 실시간 계산해 준 최종 원가율 (%)
  recipes?: RecipeLine[]; // 재료별 소요량 내역 (백엔드가 함께 내려줌)
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
  // [한글 주석: 전역 다국어 훅 호출]
  const { t, language } = useTranslation();
  const { token } = useAuth();
  const [menus, setMenus] = useState<MenuRow[] | null>(null);
  // 실패 사유를 분류해 들고 있는다 — "로그인과 서버를 확인해 주세요"는 확인할 게
  // 없는 상황(네트워크 끊김·미배포)에도 떠서 엉뚱한 데를 붙잡게 만든다
  const [failure, setFailure] = useState<ApiFailure | null>(null);
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

  // 메뉴별 기여이익(잔당 마진 × 실제 판매량) — 원가율만으로는 안 보이는 '재료비 뺀 총액'
  const [contribution, setContribution] = useState<ContributionResult | null>(null);
  // 원가율 기준 설명 카드 펼침 여부 (원가율 개념이 없는 사장님·예비 창업자용)
  const [showGuide, setShowGuide] = useState(false);

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
    // 토큰이 없으면 조회 자체가 불가능하다 — 그냥 return하면 로딩 스피너가 영원히 돈다
    if (!token) {
      setFailure({
        kind: 'auth',
        message: '로그인이 만료됐어요. 로그아웃 후 다시 로그인해 주세요.',
        retryable: true,
      });
      return;
    }
    let cancelled = false;
    setFailure(null);
    apiFetch<MenuRow[]>('/api/v1/inventory/menus', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((rows) => {
        if (!cancelled) setMenus(rows);
      })
      .catch((e) => {
        console.error('메뉴 원가 조회 실패:', e);
        if (!cancelled) setFailure(describeApiFailure(e, '원가 정보'));
      });
    // 기여이익은 원가 목록과 독립 — 실패해도 원가율 화면은 그대로 보여야 한다
    getMenuContribution(token, 30)
      .then((c) => {
        if (!cancelled) setContribution(c);
      })
      .catch((e) => console.error('메뉴 기여이익 조회 실패:', e));
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
  // 평균 등급은 음료 기준으로 본다 — 카페 매출의 대부분이 음료라 그 기준이 체감에 맞다
  const avgGrade = avg !== null ? gradeOf(avg, 'drink') : null;
  // 위험 구간 메뉴 수 — 목록 위에 먼저 알려준다
  const riskyCount = rows.filter((m) => gradeOf(rateOf(m), categoryOfMenu(m.name)) === 'bad').length;
  // 판매량 정보를 메뉴 카드에 얹기 위한 조회용 맵
  const contribByMenu = new Map((contribution?.menus ?? []).map((c) => [c.menu_id, c]));

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
        <ScreenTitle title={t('costAnalysisTitle')} subtitle={t('costAnalysisSub')} />

        {/* 요약 — 숫자만 두면 좋은지 나쁜지 알 수 없어, 업종 기준선 대비 등급을 색으로 함께 준다 */}
        <Card>
          <Text style={styles.summaryLabel}>{language === 'en' ? 'Overall Avg. Cost Ratio' : '전체 평균 원가율'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <Text style={[styles.summaryValue, avgGrade && { color: GRADE_COLOR[avgGrade] }]}>
              {avg !== null ? `${avg}%` : '—'}
            </Text>
            {avgGrade && <Badge label={GRADE_LABEL[avgGrade]} tone={avgGrade === 'good' ? 'green' : avgGrade === 'warn' ? 'orange' : 'danger'} />}
          </View>
          {avg !== null && (
            <View style={styles.gaugeWrap}>
              <View style={styles.gaugeTrack}>
                <View style={[styles.gaugeSeg, { flex: COST_STANDARDS.drink.good, backgroundColor: GRADE_COLOR.good }]} />
                <View style={[styles.gaugeSeg, { flex: COST_STANDARDS.drink.warn - COST_STANDARDS.drink.good, backgroundColor: GRADE_COLOR.warn }]} />
                <View style={[styles.gaugeSeg, { flex: 50 - COST_STANDARDS.drink.warn, backgroundColor: GRADE_COLOR.bad }]} />
              </View>
              {/* 게이지는 0~50% 구간을 그린다 — 그 이상은 어차피 위험 구간 */}
              <View style={[styles.gaugeMarker, { left: `${Math.min(avg, 50) * 2}%` }]} />
              <View style={styles.gaugeLabels}>
                <Text style={styles.gaugeLabel}>0%</Text>
                <Text style={styles.gaugeLabel}>{COST_STANDARDS.drink.good}%</Text>
                <Text style={styles.gaugeLabel}>{COST_STANDARDS.drink.warn}%</Text>
                <Text style={styles.gaugeLabel}>50%+</Text>
              </View>
            </View>
          )}
          <Text style={styles.summaryHint}>{COST_STANDARDS.drink.note}</Text>

          {/* 접힌 안내에만 있던 문장을 밖으로 꺼낸다. 원가율 11%를 '많이 남는다'로 읽는 게
              이 화면에서 가장 위험한 오해인데, 그걸 막는 문장이 아무도 안 여는 토글 안에 있었다. */}
          <Text style={styles.summaryCaveat}>
            재료비만 계산한 값이에요. 임대료·인건비·카드수수료는 아직 안 빠졌습니다.
          </Text>

          <PressableScale style={styles.guideToggle} onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setShowGuide((v) => !v);
          }}>
            <Ionicons name="help-circle-outline" size={14} color={colors.pointOrange} />
            <Text style={styles.guideToggleText}>원가율이 뭔가요? 기준은 어떻게 보나요</Text>
            <Ionicons name={showGuide ? 'chevron-up' : 'chevron-down'} size={14} color={colors.pointOrange} />
          </PressableScale>

          {showGuide && (
            <View style={styles.guideBox}>
              <Text style={styles.guideBody}>
                원가율 = 재료비 ÷ 판매가 × 100. 아메리카노 4,000원에 원두·컵·얼음이 800원 들어가면 20%예요.{'\n\n'}
                여기 안 들어간 비용이 임대료·인건비·카드 수수료·공과금입니다. 그래서 재료 원가율이
                낮아 보여도 그 뒤 비용을 빼면 남는 게 얼마 없어요. 아래가 업종별 통상 기준선입니다.
              </Text>
              {(['drink', 'dessert', 'food'] as const).map((k) => {
                const s = COST_STANDARDS[k];
                return (
                  <View key={k} style={styles.guideRow}>
                    <Text style={styles.guideCat}>{s.label}</Text>
                    <View style={styles.guideBars}>
                      <View style={[styles.guideChip, { backgroundColor: 'rgba(78,125,58,0.12)' }]}>
                        <Text style={[styles.guideChipText, { color: GRADE_COLOR.good }]}>~{s.good}% 양호</Text>
                      </View>
                      <View style={[styles.guideChip, { backgroundColor: 'rgba(201,138,43,0.12)' }]}>
                        <Text style={[styles.guideChipText, { color: GRADE_COLOR.warn }]}>~{s.warn}% 주의</Text>
                      </View>
                      <View style={[styles.guideChip, { backgroundColor: 'rgba(178,59,46,0.12)' }]}>
                        <Text style={[styles.guideChipText, { color: GRADE_COLOR.bad }]}>{s.warn}%~ 위험</Text>
                      </View>
                    </View>
                  </View>
                );
              })}
              <Text style={styles.guideFoot}>
                매장 임대료·객단가에 따라 달라질 수 있는 가이드예요. 절대 기준은 아닙니다.
              </Text>
            </View>
          )}
        </Card>

        {/* 재료비 빼고 남은 돈 — 원가율이 낮아도 안 팔리면 의미가 없다.
            '실제로 번 돈'이라 부르던 자리다. 고정비를 빼기 전 금액이라 '번 돈'이 아니고,
            그렇게 읽으면 임대료·인건비만큼을 이익으로 착각하게 된다. */}
        {contribution && contribution.total_qty > 0 && (
          <Card tone="cream">
            <View style={styles.head}>
              <Text style={styles.contribTitle}>최근 30일, 재료비 빼고 남은 돈</Text>
              <Text style={styles.contribTotal}>₩{contribution.total_margin.toLocaleString()}</Text>
            </View>
            <Text style={styles.contribHint}>
              잔당 마진 × 실제 판매 잔 수. 원가율이 낮아도 안 팔리면 남는 돈은 적어요.
              {'\n'}여기서 임대료·인건비를 더 빼야 진짜 이익입니다.
            </Text>
            {contribution.menus
              .filter((m) => m.sold_qty > 0)
              .slice(0, 5)
              .map((m, index) => (
                <View key={m.menu_id} style={styles.contribCardItem}>
                  {/* [한글 주석: 메뉴명 + 판매 잔수 배지 + 마진 합계] */}
                  <View style={styles.contribMainRow}>
                    <View style={styles.contribLeftWrap}>
                      <View style={[styles.rankBadge, index === 0 && styles.rankBadgeTop]}>
                        <Text style={[styles.rankBadgeText, index === 0 && styles.rankBadgeTextTop]}>{index + 1}</Text>
                      </View>
                      <Text style={styles.contribName} numberOfLines={1}>{m.name}</Text>
                      <View style={styles.qtyBadge}>
                        <Text style={styles.qtyBadgeText}>{m.sold_qty.toLocaleString()}잔</Text>
                      </View>
                    </View>
                    <Text style={styles.contribAmount}>₩{m.total_margin.toLocaleString()}</Text>
                  </View>

                  {/* [한글 주석: 하단 세부 정보 - 전체 비중 및 잔당 마진 깔끔 수납] */}
                  <View style={styles.contribSubRow}>
                    <Text style={styles.contribSubDetail}>
                      전체 기여 <Text style={styles.contribSubBold}>{m.margin_share}%</Text>
                    </Text>
                    <Text style={styles.contribSubDot}>·</Text>
                    <Text style={styles.contribSubDetail}>
                      잔당 순익 <Text style={styles.contribSubBold}>₩{m.margin_per_cup.toLocaleString()}</Text>
                    </Text>
                  </View>
                </View>
              ))}
          </Card>
        )}

        {/* (삭제됨) AI 메뉴 재구성 카드 — 안에 든 메뉴·판매량·원가율이 전부 지어낸 상수였다.
            사장님이 등록한 적 없는 '아몬드 크림라떼 원가율 38.1%', '월 1,420잔' 같은 숫자와
            '월 +₩480,000 추가 순이익' 같은 단정이 본인 매장 분석인 것처럼 떠 있었다.
            그 카드가 흉내 내던 건 이 화면에 이미 진짜로 있다:
              · 위 '최근 30일, 재료비 빼고 남은 돈' — 실제 판매 잔수·마진 (/chatbot/sales/contribution)
              · 아래 '메뉴별 원가율' — 실제 등록 메뉴의 원가율, 탭하면 실제 대체재 추천
                (/inventory/menus/{id}/cost-reduction-recommendations) */}

        <SectionTitle>{language === 'en' ? 'Cost Ratio by Menu' : '메뉴별 원가율'}</SectionTitle>

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

        {menus === null && !failure && (
          <Card>
            <View style={styles.stateWrap}>
              <ActivityIndicator color={colors.mochaBrown} />
              <Text style={styles.stateText}>메뉴 원가를 계산하는 중…</Text>
            </View>
          </Card>
        )}

        {failure && (
          <Card>
            <Text style={styles.stateText}>{failure.message}</Text>
          </Card>
        )}

        {menus !== null && rows.length === 0 && !failure && (
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

        {/* 위험 메뉴가 있으면 목록을 훑기 전에 먼저 알린다 */}
        {riskyCount > 0 && (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="alert-circle" size={18} color={GRADE_COLOR.bad} />
              <Text style={styles.riskText}>
                원가율이 위험 구간인 메뉴가 <Text style={{ fontWeight: '900', color: GRADE_COLOR.bad }}>{riskyCount}개</Text> 있어요.
                판매가를 올리거나 재료 단가를 낮춰야 합니다.
              </Text>
            </View>
          </Card>
        )}

        {filteredRows.map((m) => {
          const cost = m.cost_price ?? 0;
          const rate = Math.round(rateOf(m) * 10) / 10;
          const margin = m.selling_price - cost;
          // 메뉴 종류에 따라 기준선이 다르다 — 디저트를 음료 기준(22%)으로 재면 전부 빨간불이 된다
          const cat = categoryOfMenu(m.name);
          const grade = gradeOf(rate, cat);
          const std = COST_STANDARDS[cat];
          const sold = contribByMenu.get(m.id);
          const target = suggestedPrice(cost, cat);
          return (
            <Card key={m.id}>
              {/* [한글 주석: 상단 헤더 - 메뉴명 + 권장선과 우측의 원가율 숫자는 옆으로 뱃지와 일렬 배치] */}
              <View style={styles.head}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.name}>{m.name}</Text>
                  <Text style={styles.catHint}>{std.label} 기준 {std.good}% 이하 권장</Text>
                </View>
                {/* [한글 주석: 원가율 숫자와 주의/위험 배지가 우측 상단에 나란히 일렬 수평 정렬] */}
                <View style={styles.rateRowRight}>
                  <Text style={[styles.rate, { color: GRADE_COLOR[grade] }]}>{rate}%</Text>
                  <Badge
                    label={GRADE_LABEL[grade]}
                    tone={grade === 'good' ? 'green' : grade === 'warn' ? 'orange' : 'danger'}
                  />
                </View>
              </View>

              {/* 게이지 바 */}
              <ProgressBar
                ratio={Math.min(rate / std.warn, 1)}
                tone={grade === 'good' ? 'green' : grade === 'warn' ? 'mocha' : 'danger'}
              />

              {/* [한글 주석: 주의/위험 알림 및 권장선 제안 문구를 정돈된 틴트 박스로 수납] */}
              {grade !== 'good' && (
                <View
                  style={[
                    styles.gradeAlertBox,
                    grade === 'warn' ? styles.gradeAlertBoxWarn : styles.gradeAlertBoxDanger,
                  ]}
                >
                  <View style={styles.gradeAlertTitleRow}>
                    <Ionicons
                      name={grade === 'warn' ? 'warning' : 'alert-circle'}
                      size={15}
                      color={GRADE_COLOR[grade]}
                    />
                    <Text style={[styles.gradeAlertTitle, { color: GRADE_COLOR[grade] }]}>
                      {gradeMessage(rate, cat)}
                    </Text>
                  </View>

                  {target > m.selling_price && (
                    <View style={styles.suggestBoxInner}>
                      <Text style={styles.suggestTextMain}>
                        💡 권장 원가율({std.good}%) 달성 제안:{' '}
                        <Text style={styles.suggestPriceHighlight}>
                          판매가 ₩{target.toLocaleString()}
                        </Text>
                        <Text style={styles.suggestDiffText}>
                          {' '}(+₩{(target - m.selling_price).toLocaleString()} 인상 권장)
                        </Text>
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* [한글 주석: 판매가/재료비/잔당 마진 정돈된 금융 지표 카운터 그리드]
                  '원가'가 아니라 '재료비'다 — 원가라고 쓰면 이 금액만 빼면 나머지가
                  다 남는 줄로 읽힌다. 실제로는 여기에 임대료·인건비가 더 붙는다. */}
              <View style={styles.detailBoxGrid}>
                <Detail label="판매가" value={`₩${m.selling_price.toLocaleString()}`} />
                <View style={styles.detailGridDivider} />
                <Detail label="재료비" value={`₩${cost.toLocaleString()}`} />
                <View style={styles.detailGridDivider} />
                <Detail label="재료비 뺀 값" value={`₩${margin.toLocaleString()}`} accent />
              </View>

              {/* [한글 주석: 재료 구성 목록] */}
              {(m.recipes?.length ?? 0) > 0 && (
                <View style={styles.recipeSection}>
                  <Text style={styles.recipeHeader}>재료 구성</Text>
                  {m.recipes!.map((r) => (
                    <View key={r.ingredient_id} style={styles.recipeRow}>
                      <Text style={styles.recipeName} numberOfLines={1}>
                        {r.ingredient_name}
                      </Text>
                      <View style={styles.recipeQtyBadge}>
                        <Text style={styles.recipeQtyText}>
                          {Number.isInteger(r.quantity) ? r.quantity : r.quantity.toFixed(1)}
                          {r.unit}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* [한글 주석: 최근 30일 재료비 뺀 금액 현황] — 고정비 차감 전이라 '번 돈'이 아니다 */}
              {sold && sold.sold_qty > 0 && (
                <View style={styles.soldRow}>
                  <Text style={styles.soldLabel}>최근 30일 {sold.sold_qty}잔 판매</Text>
                  <Text style={styles.soldValue}>
                    재료비 뺀 값 <Text style={styles.soldValueHighlight}>₩{sold.total_margin.toLocaleString()}</Text>
                  </Text>
                </View>
              )}

              {/* [한글 주석: AI 원가 절감 추천 버튼] */}
              <PressableScale
                style={styles.recommendBtn}
                onPress={() => openModal(m.id, m.name)}
                to={0.96}
              >
                <Ionicons name="sparkles" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
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
  summaryCaveat: { ...typography.L5, color: '#C07030', marginTop: 6, lineHeight: 16, fontWeight: '600' },
  stateWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  stateText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 18 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  name: {
    ...typography.L3,
    color: colors.espressoBrown,
    fontSize: 17,
    fontWeight: '800',
  },
  catHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  rateRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rate: {
    ...typography.L2,
    fontSize: 22,
    fontWeight: '900',
  },

  // 정돈된 경고/위험 박스
  gradeAlertBox: {
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 6,
    gap: 6,
  },
  gradeAlertBoxWarn: {
    backgroundColor: 'rgba(234, 88, 12, 0.07)',
    borderLeftWidth: 3,
    borderLeftColor: '#EA580C',
  },
  gradeAlertBoxDanger: {
    backgroundColor: 'rgba(220, 38, 38, 0.07)',
    borderLeftWidth: 3,
    borderLeftColor: '#DC2626',
  },
  gradeAlertTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  gradeAlertTitle: {
    fontSize: 12.5,
    fontWeight: '800',
    flex: 1,
    lineHeight: 17,
  },
  suggestBoxInner: {
    paddingTop: 4,
  },
  suggestTextMain: {
    fontSize: 11.5,
    color: colors.espressoBrown,
    lineHeight: 16,
  },
  suggestPriceHighlight: {
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  suggestDiffText: {
    fontWeight: '700',
    color: '#EA580C',
  },

  // 수치 3단 그리드 카운터 박스
  detailBoxGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FBF8F3',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.12)',
  },
  detailGridDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(140, 111, 86, 0.12)',
  },

  // 재료 구성
  recipeSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EFECE6',
  },
  recipeHeader: {
    fontSize: 12,
    color: colors.mochaBrown,
    fontWeight: '800',
    marginBottom: 6,
  },
  recipeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3.5,
  },
  recipeName: {
    fontSize: 12.5,
    color: colors.espressoBrown,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  recipeQtyBadge: {
    backgroundColor: '#F4F1EA',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  recipeQtyText: {
    fontSize: 11,
    color: colors.espressoBrown,
    fontWeight: '700',
  },

  // 최근 30일 실적
  soldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EFECE6',
  },
  soldLabel: { fontSize: 11.5, color: colors.mochaBrown, fontWeight: '600' },
  soldValue: { fontSize: 12, color: colors.mochaBrown, fontWeight: '600' },
  soldValueHighlight: { fontSize: 13, fontWeight: '900', color: colors.trendGreenText },

  recommendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    paddingVertical: 12,
    marginTop: 12,
    shadowColor: colors.espressoBrown,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  recommendBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.2,
  },

  // 평균 원가율 게이지 (양호/주의/위험 구간을 색으로 나눈 막대 + 현재 위치 마커)
  gaugeWrap: { marginTop: 12, marginBottom: 4 },
  gaugeTrack: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  gaugeSeg: { height: 8 },
  gaugeMarker: {
    position: 'absolute',
    top: -3,
    width: 3,
    height: 14,
    borderRadius: 2,
    backgroundColor: colors.espressoBrown,
    marginLeft: -1.5,
  },
  gaugeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  gaugeLabel: { fontSize: 9, fontWeight: '700', color: colors.mochaBrown },

  // 원가율 개념 설명 (예비 창업자용)
  guideToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  guideToggleText: { fontSize: 11.5, fontWeight: '700', color: colors.pointOrange, flex: 1 },
  guideBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    gap: 10,
  },
  guideBody: { fontSize: 11.5, color: colors.espressoBrown, lineHeight: 18 },
  guideRow: { gap: 5 },
  guideCat: { ...typography.L4, color: colors.espressoBrown },
  guideBars: { flexDirection: 'row', gap: 5, flexWrap: 'wrap' },
  guideChip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  guideChipText: { fontSize: 10, fontWeight: '800' },
  guideFoot: { ...typography.L5, color: colors.mochaBrown, fontStyle: 'italic' },

  // 재료비 뺀 값 (기여이익) 랭킹 리뉴얼
  contribTitle: { ...typography.L3, color: colors.espressoBrown },
  contribTotal: { fontSize: 18, fontWeight: '900', color: colors.trendGreenText },
  contribHint: { ...typography.L5, color: colors.mochaBrown, marginTop: -4, marginBottom: 12, lineHeight: 16 },

  contribCardItem: {
    backgroundColor: '#FFFDF9',
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#EFECE6',
  },
  contribMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  contribLeftWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
    marginRight: 8,
  },
  rankBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#EFECE6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankBadgeTop: {
    backgroundColor: colors.espressoBrown,
  },
  rankBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.mochaBrown,
  },
  rankBadgeTextTop: {
    color: '#FFFFFF',
  },
  contribName: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  qtyBadge: {
    backgroundColor: 'rgba(110, 85, 68, 0.08)',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
  },
  qtyBadgeText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  contribAmount: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.espressoBrown,
  },
  contribSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    marginTop: 6,
    paddingTop: 5,
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(140, 111, 86, 0.08)',
  },
  contribSubDetail: {
    fontSize: 11,
    color: colors.mochaBrown,
    fontWeight: '500',
  },
  contribSubBold: {
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  contribSubDot: {
    fontSize: 10,
    color: '#C4B5A5',
  },

  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  recipeQty: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  riskText: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 18 },
  detail: { flex: 1, alignItems: 'center' },
  detailLabel: { ...typography.L5, color: colors.mochaBrown },
  detailValue: { ...typography.L4, color: colors.espressoBrown, marginTop: 3 },

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

