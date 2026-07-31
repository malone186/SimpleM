// 대체 원두 추천 모달 — "이 원두와 비슷한데 더 싼 것"
//
// [한글 주석] 왜 취향 추천이 아니라 대체 추천인가:
// 카페 사장님이 원두를 바꾸는 이유는 취향이 아니라 원가다.
// "당신 취향에 92% 맞아요"보다 "맛은 비슷한데 잔당 200원 싸요"가
// 발주 결정에 직접 쓰인다. 그래서 절감액을 가장 크게 보여준다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { fetchBeanAlternatives, type BeanAlternative } from '../../lib/api/beans';
import { colors } from '../../theme';

type Props = {
  visible: boolean;
  beanId: number | null;
  beanName: string;
  onClose: () => void;
};

export default function BeanAlternativeModal({ visible, beanId, beanName, onClose }: Props) {
  const [items, setItems] = useState<BeanAlternative[]>([]);
  const [basePpg, setBasePpg] = useState<number | null>(null);
  const [baseGrams, setBaseGrams] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (beanId == null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBeanAlternatives(beanId, 5);
      setItems(res.alternatives ?? []);
      setBasePpg(res.base_price_per_gram ?? null);
      setBaseGrams(res.base_grams ?? null);
      setMessage(res.message ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [beanId]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const open = (url: string | null) => {
    if (!url) return;
    if (Platform.OS === 'web') window.open(url, '_blank');
    else Linking.openURL(url);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.title}>더 저렴한 대체 원두</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {beanName}
                {baseGrams != null ? ` · ${baseGrams}g` : ''}
                {basePpg != null ? ` · ${basePpg}원/g` : ''}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.mochaBrown} />
            </Pressable>
          </View>

          {loading && (
            <View style={styles.state}>
              <ActivityIndicator color={colors.espressoBrown} />
              <Text style={styles.stateText}>비슷한 원두를 찾는 중…</Text>
            </View>
          )}

          {!loading && error && (
            <View style={styles.state}>
              <Text style={styles.stateText}>추천을 불러오지 못했어요.{'\n'}{error}</Text>
              <Pressable style={styles.retry} onPress={load}>
                <Text style={styles.retryText}>다시 시도</Text>
              </Pressable>
            </View>
          )}

          {!loading && !error && items.length === 0 && (
            <View style={styles.state}>
              <Text style={styles.stateText}>{message || '대체 원두를 찾지 못했어요.'}</Text>
            </View>
          )}

          {!loading && !error && items.length > 0 && (
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 10 }}>
              {items.map((a) => (
                <View key={a.id} style={styles.card}>
                  {/* 절감액을 가장 크게 — 발주 판단의 핵심 숫자 */}
                  <View style={styles.savingRow}>
                    <Text style={styles.savingMain}>잔당 {a.saving_per_shot.toLocaleString()}원 절약</Text>
                    <View style={styles.pctBadge}>
                      <Text style={styles.pctText}>-{a.saving_pct}%</Text>
                    </View>
                  </View>

                  <Text style={styles.beanName} numberOfLines={2}>{a.name}</Text>
                  <Text style={styles.meta}>
                    {[a.roastery_name, a.country, a.process].filter(Boolean).join(' · ')}
                  </Text>
                  {/* 중량을 함께 보여준다 — 어떤 포장끼리 비교했는지 보여야 신뢰가 된다 */}
                  <Text style={styles.price}>
                    {a.price.toLocaleString()}원
                    {a.grams != null ? ` / ${a.grams}g` : ''} · {a.price_per_gram}원/g
                  </Text>

                  {!!a.cup_notes && (
                    <Text style={styles.notes} numberOfLines={2}>☕ {a.cup_notes}</Text>
                  )}

                  {/* 추천 근거를 반드시 보여준다 — 이유 없는 추천은 쓰이지 않는다 */}
                  {a.reasons.length > 0 && (
                    <View style={styles.reasonRow}>
                      {a.reasons.map((r, i) => (
                        <Text key={i} style={styles.reason}>{r}</Text>
                      ))}
                    </View>
                  )}

                  {/* 별점 대신 근거의 양을 보여준다 — 별점은 감성에서 역산한 값이라
                      원두 간 비교에 쓸 만한 변별력이 없다 */}
                  {a.review_count > 0 && (
                    <Text style={styles.review}>
                      후기 {a.review_count}건{a.review_count < 5 ? ' · 표본 적음' : ''}
                    </Text>
                  )}

                  {!!a.product_url && (
                    <Pressable style={styles.linkBtn} onPress={() => open(a.product_url)}>
                      <Ionicons name="open-outline" size={13} color="#FFF" />
                      <Text style={styles.linkText}>상품 보기</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </ScrollView>
          )}

          <Text style={styles.disclaimer}>
            같은 원산지·가공방식·풍미를 공유하면서 포장 용량이 비슷한 원두만 비교합니다.
            실제 맛은 로스팅에 따라 다를 수 있어 샘플 확인을 권합니다.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    backgroundColor: '#FFF',
    borderRadius: 18,
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  title: { fontSize: 16, fontWeight: 'bold', color: colors.espressoBrown },
  subtitle: { fontSize: 11.5, color: '#7A6E65', marginTop: 3 },

  state: { alignItems: 'center', gap: 10, paddingVertical: 30 },
  stateText: { fontSize: 13, color: '#7A6E65', textAlign: 'center', lineHeight: 19 },
  retry: {
    backgroundColor: colors.espressoBrown,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  retryText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  card: {
    backgroundColor: '#FAF8F6',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#EFE9E4',
    gap: 5,
  },
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  savingMain: { fontSize: 15, fontWeight: '900', color: '#2E7D32' },
  pctBadge: {
    backgroundColor: '#E6F4EA',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 9,
  },
  pctText: { fontSize: 11, fontWeight: '800', color: '#2E7D32' },

  beanName: { fontSize: 13.5, fontWeight: '700', color: colors.espressoBrown, marginTop: 3 },
  meta: { fontSize: 11.5, color: '#7A6E65' },
  price: { fontSize: 12, color: colors.pointOrange, fontWeight: '700' },
  notes: { fontSize: 11.5, color: '#7A6E65', lineHeight: 17 },

  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 2 },
  reason: {
    fontSize: 10.5,
    color: colors.espressoBrown,
    backgroundColor: '#F0ECE8',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  review: { fontSize: 11, color: '#888' },

  linkBtn: {
    marginTop: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 8,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  linkText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  disclaimer: {
    fontSize: 10.5,
    color: '#B0A79E',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 15,
  },
});
