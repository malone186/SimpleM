import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '../../i18n/translations';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors } from '../../theme';
import {
  fetchMarketSummary,
  searchBeans,
  type BeanItem,
  type MarketSummary,
} from '../../lib/api/beans';

// 1잔 추출 기준 원두량(g) — 잔당 원가 환산용 (에스프레소 더블샷 통용값)
const GRAMS_PER_SHOT = 20;

// [한글 주석] 실제 DB 응답(BeanItem)을 기존 화면이 쓰던 형태로 변환한다.
// UI는 그대로 두고 데이터만 진짜로 바꾸기 위한 어댑터.
type BeanRow = {
  id: number;
  name: string;
  roastery: string;
  price: number;
  lowest_price: number;
  country: string;
  rating: number;
  review_count: number;
  positive_ratio: number;
  keywords: string[];
  product_url: string;
  // ↓ 추가 정보
  process: string;          // 가공방식 (워시드/내추럴 등)
  price_per_gram: number | null;
  per_shot: number | null;  // 잔당 원가
  description: string;      // 컵노트/설명
  offer_count: number;      // 시세 비교 판매처 수
  sold_out: boolean;
};

function toRow(b: BeanItem): BeanRow {
  const ppg = b.price_per_gram;
  return {
    id: b.id,
    name: b.name,
    roastery: b.roastery_name ?? '',
    price: b.price,
    lowest_price: b.lowest_offer?.price ?? b.price,
    country: b.country ?? '',
    rating: b.review_summary?.avg_rating ?? 0,
    review_count: b.review_summary?.review_count ?? 0,
    positive_ratio: Math.round((b.review_summary?.positive_ratio ?? 0) * 100),
    keywords: (b.review_summary?.top_keywords ?? []).map((k) => (k.startsWith('#') ? k : `#${k}`)),
    product_url: b.lowest_offer?.product_url || b.product_url,
    process: (b.process ?? '').trim(),
    price_per_gram: ppg,
    per_shot: ppg != null ? Math.round(ppg * GRAMS_PER_SHOT) : null,
    description: (b.description ?? '').trim(),
    offer_count: b.all_offers?.length ?? 0,
    sold_out: !!b.sold_out,
  };
}

/** 시세 포지션 판정 결과 */
type Position = {
  label: string;   // 저렴 / 시세 수준 / 비쌈
  diffPct: number; // 중앙값 대비 %
  peer: string;    // 비교군 이름 (원산지)
  tone: 'cheap' | 'normal' | 'pricey';
};

/**
 * 이 원두가 같은 원산지 중 어느 가격대인지 판정한다.
 *
 * [한글 주석] 비교 기준은 평균이 아니라 '중앙값'이다.
 * g당 900원대(50g 고급 게이샤) 같은 극단값이 섞여 있어 평균은 크게 부풀고,
 * 그 평균으로 재면 평범한 원두도 전부 "저렴"으로 나온다.
 */
function getPosition(bean: BeanRow, market: MarketSummary | null): Position | null {
  if (!market || bean.price_per_gram == null) return null;

  const country = (bean.country || '').trim();
  const group = country ? market.by_country[country] : undefined;
  const stats = group ?? market.overall;
  if (!stats || !stats.median) return null;

  const diffPct = Math.round(((bean.price_per_gram - stats.median) / stats.median) * 100);

  // 5% 이내 차이는 '시세 수준'으로 본다 (미세한 차이를 과장하지 않기 위해)
  const tone: Position['tone'] = diffPct <= -5 ? 'cheap' : diffPct >= 5 ? 'pricey' : 'normal';
  const label = tone === 'cheap' ? '저렴' : tone === 'pricey' ? '비쌈' : '시세 수준';

  return { label, diffPct, peer: group ? country : '전체', tone };
}

export default function BeanOperationScreen() {
  // [한글 주석: 전역 다국어 번역 훅 연동]
  const { t, language } = useTranslation();
  const [selectedCategory, setSelectedCategory] = useState('전체');
  const [keyword, setKeyword] = useState('');

  const [beans, setBeans] = useState<BeanRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [market, setMarket] = useState<MarketSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 시세표는 실패해도 목록은 보여야 하므로 따로 처리한다.
      const [res, summary] = await Promise.all([
        searchBeans({ sortBy: 'reviews', limit: 50 }),
        fetchMarketSummary().catch(() => null),
      ]);
      setBeans(res.items.map(toRow));
      setTotalCount(res.total_count);
      setMarket(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBeans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filteredBeans = beans.filter(b =>
    (selectedCategory === '전체' || b.country === selectedCategory) &&
    (b.name.includes(keyword) || b.roastery.includes(keyword))
  );

  return (
    <Screen>
      <ScreenTitle
        title={t('beanOpsTitle')}
        subtitle={
          language === 'en'
            ? `${totalCount.toLocaleString()} Bean Prices & User Review Analytics`
            : `DB 적재 ${totalCount.toLocaleString()}개 원두 시세 및 사용자 리뷰 통계`
        }
      />

      <Card style={{ marginBottom: 16, backgroundColor: colors.creamSand }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="cafe" size={22} color={colors.espressoBrown} />
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.espressoBrown }}>
              {language === 'en' ? 'Collected Bean Catalog & Prices' : '수집 원두 카탈로그 & 시세'}
            </Text>
          </View>
          <Badge
            label={language === 'en' ? `${totalCount} Beans Loaded` : `DB ${totalCount}개 적재완료`}
            tone="green"
          />
        </View>

        {/* 검색어 입력창 */}
        <TextInput
          style={{
            backgroundColor: '#FFF',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            fontSize: 14,
            borderWidth: 1,
            borderColor: '#E1DCD7',
            marginBottom: 12,
          }}
          placeholder="원두명 또는 로스터리 검색 (예: 에티오피아)"
          value={keyword}
          onChangeText={setKeyword}
        />

        {/* 카테고리 칩 */}
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14 }}>
          {['전체', '에티오피아', '콜롬비아', '과테말라'].map(cat => (
            <Pressable
              key={cat}
              onPress={() => setSelectedCategory(cat)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 14,
                backgroundColor: selectedCategory === cat ? colors.espressoBrown : '#EFEAE6',
              }}
            >
              <Text style={{ color: selectedCategory === cat ? '#FFF' : colors.espressoBrown, fontSize: 12, fontWeight: '600' }}>
                {cat}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* 로딩 / 오류 / 빈 상태 */}
        {loading && (
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 24 }}>
            <ActivityIndicator color={colors.espressoBrown} />
            <Text style={{ fontSize: 12, color: '#7A6E65' }}>원두 시세를 불러오는 중…</Text>
          </View>
        )}

        {!loading && error && (
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 24 }}>
            <Text style={{ fontSize: 12, color: '#7A6E65', textAlign: 'center' }}>
              원두 정보를 불러오지 못했어요.{'\n'}{error}
            </Text>
            <Pressable
              onPress={load}
              style={{ backgroundColor: colors.espressoBrown, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 }}
            >
              <Text style={{ color: '#FFF', fontSize: 12, fontWeight: 'bold' }}>다시 시도</Text>
            </Pressable>
          </View>
        )}

        {!loading && !error && filteredBeans.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: 24 }}>
            <Text style={{ fontSize: 12, color: '#7A6E65' }}>조건에 맞는 원두가 없어요.</Text>
          </View>
        )}

        {/* 원두 카드 리스트 */}
        <View style={{ gap: 10 }}>
          {filteredBeans.map(bean => {
            const pos = getPosition(bean, market);
            return (
            <View
              key={bean.id}
              style={{
                backgroundColor: '#FFF',
                borderRadius: 10,
                padding: 12,
                borderWidth: 1,
                borderColor: '#E6E1DC',
              }}
            >
              {/* 원두 이름 — 가로 전체를 써서, 이름이 길어도 가격과 겹치지 않는다 */}
              <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown, lineHeight: 21 }}>
                {bean.name}
              </Text>
              {/* [추가] 가공방식(process)을 로스터리·원산지 줄에 덧붙임 */}
              <Text style={{ fontSize: 12, color: '#7A6E65', marginTop: 3 }}>
                {[bean.roastery, bean.country, bean.process].filter(Boolean).join(' · ')}
              </Text>

              {/* 가격 줄 — 이름과 분리해 한 줄에 모음 (최저가 · 잔당원가 · g당단가) */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginTop: 8,
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: '#F0ECE8',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.pointOrange }}>
                  최저가 {bean.lowest_price.toLocaleString()}원
                </Text>
                {bean.per_shot != null && (
                  <Text style={{ fontSize: 12, color: colors.espressoBrown, fontWeight: '700' }}>
                    잔당 약 {bean.per_shot.toLocaleString()}원
                    <Text style={{ fontSize: 10.5, color: '#A79E96', fontWeight: '400' }}> ({GRAMS_PER_SHOT}g)</Text>
                  </Text>
                )}
                {bean.price_per_gram != null && (
                  <Text style={{ fontSize: 12, color: '#7A6E65' }}>
                    g당 {bean.price_per_gram.toFixed(1)}원
                  </Text>
                )}
                {bean.offer_count > 1 && (
                  <Text style={{ fontSize: 11, color: '#7A6E65' }}>{bean.offer_count}곳 비교</Text>
                )}
                {bean.sold_out && (
                  <Text style={{ fontSize: 11, color: '#B23B2E', fontWeight: '700' }}>품절</Text>
                )}
              </View>

              {/* [추가] 시세 포지션 — 같은 원산지 원두들의 중앙값과 비교해 저렴/비쌈 판정 */}
              {pos && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 10,
                      backgroundColor:
                        pos.tone === 'cheap' ? '#E6F4EA' : pos.tone === 'pricey' ? '#FBE9E7' : '#F0ECE8',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '800',
                        color:
                          pos.tone === 'cheap' ? '#2E7D32' : pos.tone === 'pricey' ? '#B23B2E' : '#7A6E65',
                      }}
                    >
                      {pos.label}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: '#7A6E65' }}>
                    {pos.peer} 시세 대비 {pos.diffPct > 0 ? '+' : ''}{pos.diffPct}%
                  </Text>
                </View>
              )}

              {/* [추가] 컵노트 / 로스터리 설명 */}
              {!!bean.description && (
                <Text style={{ fontSize: 11.5, color: '#7A6E65', marginTop: 8, lineHeight: 17 }} numberOfLines={2}>
                  ☕ {bean.description}
                </Text>
              )}

              {/* 리뷰 통계 바 */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 12, backgroundColor: '#F8F6F4', padding: 8, borderRadius: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="star" size={14} color="#FFB800" />
                  <Text style={{ fontSize: 13, fontWeight: 'bold', color: colors.espressoBrown }}>{bean.rating.toFixed(1)}</Text>
                  <Text style={{ fontSize: 12, color: '#888' }}>({bean.review_count}개 리뷰)</Text>
                </View>
                <Text style={{ fontSize: 12, fontWeight: '600', color: bean.positive_ratio >= 80 ? '#2E7D32' : bean.positive_ratio >= 50 ? '#B8860B' : '#B23B2E' }}>
                  긍정 비율 {bean.positive_ratio}%
                </Text>
              </View>

              {/* 키워드 태그 */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {bean.keywords.map((kw, i) => (
                  <Text key={i} style={{ fontSize: 11, color: colors.espressoBrown, backgroundColor: '#F0ECE8', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    {kw}
                  </Text>
                ))}
              </View>

              {/* 바로 구매 — 카드 하단으로 이동 */}
              <Pressable
                onPress={() => {
                  const targetUrl = bean.product_url || `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(bean.name)}`;
                  if (Platform.OS === 'web') {
                    window.open(targetUrl, '_blank');
                  } else {
                    Linking.openURL(targetUrl);
                  }
                }}
                style={{
                  backgroundColor: colors.pointOrange,
                  paddingVertical: 9,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  marginTop: 10,
                }}
              >
                <Ionicons name="cart-outline" size={14} color="#FFF" />
                <Text style={{ color: '#FFF', fontSize: 12.5, fontWeight: 'bold' }}>바로 구매</Text>
              </Pressable>
            </View>
            );
          })}
        </View>
      </Card>
    </Screen>
  );
}
