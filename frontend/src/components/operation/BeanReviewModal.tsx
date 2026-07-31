// 원두 후기 모달 — 수집한 실제 블로그·카페 후기 원문을 보여준다.
//
// [한글 주석] 왜 원문을 보여줘야 하는가:
// 지금까지 화면에는 '★3.6 (30개 리뷰)' 같은 숫자만 있었다. 숫자만으로는
// 왜 그 평점인지 알 수 없고, 특히 긍정 비율이 낮을 때 이유를 확인할 방법이 없다.
// 사장님이 20만원어치 발주를 결정하려면 "사람들이 실제로 뭐라고 썼는지"가 필요하다.
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

import { fetchBeanReviews, type BeanReview, type BeanReviewSummary } from '../../lib/api/beans';
import { colors } from '../../theme';

type Props = {
  visible: boolean;
  beanId: number | null;
  beanName: string;
  onClose: () => void;
};

/** 감성별 표시 색 — 부정 후기를 숨기지 않고 함께 보여주기 위한 구분 */
const SENTIMENT_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  positive: { label: '긍정', bg: '#E6F4EA', fg: '#2E7D32' },
  neutral: { label: '보통', bg: '#F0ECE8', fg: '#7A6E65' },
  negative: { label: '부정', bg: '#FBE9E7', fg: '#B23B2E' },
};

export default function BeanReviewModal({ visible, beanId, beanName, onClose }: Props) {
  const [reviews, setReviews] = useState<BeanReview[]>([]);
  const [summary, setSummary] = useState<BeanReviewSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 부정 후기만 따로 보고 싶을 때가 있다 — 발주 판단에는 불만이 더 중요하다.
  const [filter, setFilter] = useState<'all' | 'positive' | 'negative'>('all');

  const load = useCallback(async () => {
    if (beanId == null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBeanReviews(beanId);
      setReviews(res.reviews ?? []);
      setSummary(res.summary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [beanId]);

  useEffect(() => {
    if (visible) {
      setFilter('all');
      load();
    }
  }, [visible, load]);

  const openOriginal = (url: string | null) => {
    if (!url) return;
    if (Platform.OS === 'web') window.open(url, '_blank');
    else Linking.openURL(url);
  };

  const shown = reviews.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'negative') return r.sentiment === 'negative';
    return r.sentiment === 'positive';
  });

  const negCount = reviews.filter((r) => r.sentiment === 'negative').length;
  const posCount = reviews.filter((r) => r.sentiment === 'positive').length;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* 헤더 */}
          <View style={styles.header}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.title} numberOfLines={2}>{beanName}</Text>
              {summary && summary.review_count > 0 && (
                <Text style={styles.subtitle}>
                  ★ {summary.avg_rating.toFixed(1)} · 후기 {summary.review_count}건 · 긍정{' '}
                  {Math.round((summary.positive_ratio ?? 0) * 100)}%
                </Text>
              )}
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.mochaBrown} />
            </Pressable>
          </View>

          {/* 필터 — 부정 후기를 일부러 찾아볼 수 있게 */}
          {reviews.length > 0 && (
            <View style={styles.filterRow}>
              {([
                ['all', `전체 ${reviews.length}`],
                ['positive', `긍정 ${posCount}`],
                ['negative', `부정 ${negCount}`],
              ] as const).map(([key, label]) => (
                <Pressable
                  key={key}
                  onPress={() => setFilter(key)}
                  style={[styles.filterChip, filter === key && styles.filterChipOn]}
                >
                  <Text style={[styles.filterText, filter === key && styles.filterTextOn]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* 본문 */}
          {loading && (
            <View style={styles.state}>
              <ActivityIndicator color={colors.espressoBrown} />
              <Text style={styles.stateText}>후기를 불러오는 중…</Text>
            </View>
          )}

          {!loading && error && (
            <View style={styles.state}>
              <Text style={styles.stateText}>후기를 불러오지 못했어요.{'\n'}{error}</Text>
              <Pressable style={styles.retry} onPress={load}>
                <Text style={styles.retryText}>다시 시도</Text>
              </Pressable>
            </View>
          )}

          {!loading && !error && shown.length === 0 && (
            <View style={styles.state}>
              <Text style={styles.stateText}>
                {reviews.length === 0
                  ? '아직 수집된 후기가 없어요.'
                  : '해당 조건의 후기가 없어요.'}
              </Text>
            </View>
          )}

          {!loading && !error && shown.length > 0 && (
            <ScrollView style={styles.list} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
              {shown.map((r) => {
                const s = SENTIMENT_STYLE[r.sentiment ?? 'neutral'] ?? SENTIMENT_STYLE.neutral;
                return (
                  <View key={r.id} style={styles.card}>
                    <View style={styles.cardHead}>
                      <View style={[styles.badge, { backgroundColor: s.bg }]}>
                        <Text style={[styles.badgeText, { color: s.fg }]}>{s.label}</Text>
                      </View>
                      <Text style={styles.source}>{r.source_site}</Text>
                    </View>

                    <Text style={styles.content}>{r.content}</Text>

                    {!!r.keywords?.length && (
                      <View style={styles.kwRow}>
                        {r.keywords.slice(0, 4).map((k, i) => (
                          <Text key={i} style={styles.kw}>#{k}</Text>
                        ))}
                      </View>
                    )}

                    {!!r.source_url && (
                      <Pressable onPress={() => openOriginal(r.source_url)} style={styles.linkRow}>
                        <Ionicons name="open-outline" size={12} color={colors.pointOrange} />
                        <Text style={styles.link}>원문 보기</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}

          {/* [한글 주석] 별점의 성격을 밝힌다 — 쇼핑몰 별점이 아니라 추정치다 */}
          <Text style={styles.disclaimer}>
            블로그·카페 후기에는 별점이 없어, 평점은 글의 감성을 분석한 추정치입니다.
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
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  title: { fontSize: 15, fontWeight: 'bold', color: colors.espressoBrown, lineHeight: 20 },
  subtitle: { fontSize: 12, color: '#7A6E65', marginTop: 4 },

  filterRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  filterChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 13,
    backgroundColor: '#EFEAE6',
  },
  filterChipOn: { backgroundColor: colors.espressoBrown },
  filterText: { fontSize: 11.5, fontWeight: '600', color: colors.espressoBrown },
  filterTextOn: { color: '#FFF' },

  state: { alignItems: 'center', gap: 10, paddingVertical: 30 },
  stateText: { fontSize: 13, color: '#7A6E65', textAlign: 'center', lineHeight: 19 },
  retry: {
    backgroundColor: colors.espressoBrown,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  retryText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  list: { maxHeight: 460 },
  card: {
    backgroundColor: '#FAF8F6',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#EFE9E4',
    gap: 7,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9 },
  badgeText: { fontSize: 10.5, fontWeight: '800' },
  source: { fontSize: 10.5, color: '#A79E96' },
  content: { fontSize: 12.5, color: colors.espressoBrown, lineHeight: 19 },
  kwRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  kw: {
    fontSize: 10.5,
    color: colors.espressoBrown,
    backgroundColor: '#F0ECE8',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  link: { fontSize: 11, color: colors.pointOrange, fontWeight: '600' },

  disclaimer: {
    fontSize: 10.5,
    color: '#B0A79E',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 15,
  },
});
