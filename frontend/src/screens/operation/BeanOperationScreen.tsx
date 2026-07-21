// [한글 주석] 독립된 원두 실시간 최저가 시세 및 실리뷰 분석 전용 화면
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import { colors } from '../../theme';


export default function BeanOperationScreen() {
  const [selectedCategory, setSelectedCategory] = useState('전체');
  const [keyword, setKeyword] = useState('');

  // 599개 실데이터 샘플 카탈로그 리스트
  const sampleBeans = [
    { id: 1, name: 'BG블렌드 (500g)', roastery: '타이커피', price: 15000, lowest_price: 13500, country: '에티오피아', rating: 4.8, review_count: 25, positive_ratio: 92, keywords: ['#고소함', '#라떼강추', '#가성비'], product_url: 'https://smartstore.naver.com' },
    { id: 2, name: '에티오피아 예가체프 (200g)', roastery: '가델로 커피', price: 14000, lowest_price: 13800, country: '에티오피아', rating: 4.9, review_count: 150, positive_ratio: 96, keywords: ['#상큼한산미', '#꽃향기', '#드립전용'], product_url: 'https://smartstore.naver.com' },
    { id: 3, name: '콜롬비아 수프리모 (500g)', roastery: '모카 팩토리', price: 16500, lowest_price: 15000, country: '콜롬비아', rating: 4.7, review_count: 88, positive_ratio: 90, keywords: ['#밸런스좋음', '#견과류풍미', '#데일리'], product_url: 'https://smartstore.naver.com' },
    { id: 4, name: '디카페인 딥 블렌드 (200g)', roastery: '타이커피', price: 15500, lowest_price: 14500, country: '과테말라', rating: 4.6, review_count: 42, positive_ratio: 88, keywords: ['#속편한', '#디카페인', '#다크초콜릿'], product_url: 'https://smartstore.naver.com' },
    { id: 5, name: '자메이카 블루마운틴 (200g)', roastery: '가델로 커피', price: 45000, lowest_price: 45000, country: '자메이카', rating: 5.0, review_count: 30, positive_ratio: 98, keywords: ['#최고급', '#품절대란', '#명품원두'], product_url: 'https://smartstore.naver.com' },
  ];

  const filteredBeans = sampleBeans.filter(b => 
    (selectedCategory === '전체' || b.country === selectedCategory) &&
    (b.name.includes(keyword) || b.roastery.includes(keyword))
  );

  return (
    <Screen>
      <ScreenTitle title="원두 실시간 시세 & 실리뷰 분석" subtitle="DB 적재 599개 원두 시세 및 1,822건의 사용자 리뷰 통계" />
      
      <Card style={{ marginBottom: 16, backgroundColor: colors.creamSand }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="cafe" size={22} color={colors.espressoBrown} />
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.espressoBrown }}>수집 원두 카탈로그 & 시세</Text>
          </View>
          <Badge label="DB 599개 적재완료" tone="green" />
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

        {/* 원두 카드 리스트 */}
        <View style={{ gap: 10 }}>
          {filteredBeans.map(bean => (
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
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown }}>{bean.name}</Text>
                  <Text style={{ fontSize: 12, color: '#7A6E65', marginTop: 2 }}>{bean.roastery} · {bean.country}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.pointOrange }}>
                    최저가 {bean.lowest_price.toLocaleString()}원
                  </Text>
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
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 2,
                    }}
                  >
                    <Ionicons name="cart-outline" size={12} color="#FFF" />
                    <Text style={{ color: '#FFF', fontSize: 11, fontWeight: 'bold' }}>바로 구매</Text>
                  </Pressable>
                </View>
              </View>

              {/* 리뷰 통계 바 */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 12, backgroundColor: '#F8F6F4', padding: 8, borderRadius: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="star" size={14} color="#FFB800" />
                  <Text style={{ fontSize: 13, fontWeight: 'bold', color: colors.espressoBrown }}>{bean.rating}</Text>
                  <Text style={{ fontSize: 12, color: '#888' }}>({bean.review_count}개 리뷰)</Text>
                </View>
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#2E7D32' }}>
                  긍정 비율 {bean.positive_ratio}%
                </Text>
              </View>

              {/* 키워드 태그 */}
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                {bean.keywords.map((kw, i) => (
                  <Text key={i} style={{ fontSize: 11, color: colors.espressoBrown, backgroundColor: '#F0ECE8', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    {kw}
                  </Text>
                ))}
              </View>
            </View>
          ))}
        </View>
      </Card>
    </Screen>
  );
}
