// 매장 지도 화면 — 대시보드 웰컴헤더 왼쪽 위 지도 아이콘 직결용
//
// [설계 원칙] 이 화면의 중심은 '기기 현위치'가 아니라 계정에 등록된 매장 고정 위치다.
// 회원가입 2단계에서 찍은 지도 핀이 users.store_lat/lon으로 저장되고, 어느 기기에서
// 로그인하든 지도는 그 자리에 고정된다. (예전엔 GPS로 그려서 집에서 앱을 켜면 매장이 이사했다.)
//
// 그 위에 '주변 카페 상권 분석'을 얹는다 — 백엔드가 네이버 지역검색으로 반경 안의 카페를 모으고,
// 네이버 블로그 후기를 수집해 Gemini로 분석한 결과를 마커·카드로 보여 준다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import StoreLocationMap from '../../components/dashboard/StoreLocationMap';
import StoreLocationPicker from '../../components/dashboard/StoreLocationPicker';
import {
  getCafeAnalysis,
  getNeighborhoodInsight,
  type CafeAnalysisResult,
  type NearbyCafe,
  type NeighborhoodResult,
} from '../../lib/api/nearbyCafes';
import {
  cacheRegisteredStore,
  resolveStoreLocation,
  saveStoreLocation,
  type ResolvedStoreLocation,
} from '../../lib/api/store';
import { colors, shadows, spacing, typography } from '../../theme';

const RADIUS_OPTIONS = [500, 1000, 2000] as const;

export default function StoreMapScreen() {
  const { token, user } = useAuth();

  const [store, setStore] = useState<ResolvedStoreLocation | null>(null);
  const [loadingStore, setLoadingStore] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  const [radius, setRadius] = useState<number>(1000);
  const [nearby, setNearby] = useState<NeighborhoodResult | null>(null);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [nearbyError, setNearbyError] = useState('');

  const [selected, setSelected] = useState<NearbyCafe | null>(null);
  const [analysis, setAnalysis] = useState<CafeAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');

  // 1) 매장 고정 위치 — 계정(DB)이 원본, 기기 캐시는 보조. GPS는 쓰지 않는다.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLoadingStore(false);
      return;
    }
    (async () => {
      try {
        const loc = await resolveStoreLocation(token);
        if (!cancelled) setStore(loc);
      } catch (e) {
        console.error('매장 위치 조회 실패:', e);
      } finally {
        if (!cancelled) setLoadingStore(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) 주변 카페 + 상권 AI 분석 — 매장 위치가 확정된 뒤에만 부른다
  const loadNearby = useCallback(
    async (radiusM: number) => {
      if (!token || !store) return;
      setLoadingNearby(true);
      setNearbyError('');
      try {
        const data = await getNeighborhoodInsight(token, radiusM);
        setNearby(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setNearbyError(msg.replace(/^\d+\s·\s/, ''));
      } finally {
        setLoadingNearby(false);
      }
    },
    [token, store],
  );

  useEffect(() => {
    loadNearby(radius);
  }, [loadNearby, radius]);

  // 3) 카페 하나를 고르면 그 집의 네이버 후기 분석을 불러온다
  const openCafe = useCallback(
    async (cafe: NearbyCafe) => {
      setSelected(cafe);
      setAnalysis(null);
      setAnalysisError('');
      if (!token) return;
      try {
        setAnalysis(await getCafeAnalysis(token, cafe, nearby?.region ?? ''));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAnalysisError(msg.replace(/^\d+\s·\s/, ''));
      }
    },
    [token, nearby?.region],
  );

  const handlePinConfirm = async (picked: { lat: number; lon: number; address?: string }) => {
    if (!token) return;
    setSavingPin(true);
    try {
      await saveStoreLocation(token, { lat: picked.lat, lon: picked.lon, address: picked.address });
      await cacheRegisteredStore({ lat: picked.lat, lon: picked.lon, region: picked.address });
      setStore({ lat: picked.lat, lon: picked.lon, region: picked.address, registered: true });
      setNearby(null);
      setPickerOpen(false);
    } catch (e) {
      console.error('매장 위치 저장 실패:', e);
    } finally {
      setSavingPin(false);
    }
  };

  // --- 매장 위치가 아직 없을 때 ---
  if (!loadingStore && !store) {
    return (
      <View style={styles.root}>
        <View style={styles.center}>
          <Ionicons name="location-outline" size={40} color={colors.mochaBrown} />
          <Text style={styles.loadingText}>매장 위치가 등록되지 않았습니다.</Text>
          <Text style={styles.hintText}>
            지도에 표시할 매장 자리를 한 번만 지정해 주세요.{'\n'}
            등록한 위치는 계정에 저장되어 어느 기기에서 로그인해도 그대로 유지됩니다.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setPickerOpen(true)}>
            <Ionicons name="map" size={16} color={colors.white} />
            <Text style={styles.primaryBtnText}>매장 위치 등록</Text>
          </TouchableOpacity>
        </View>
        <StoreLocationPicker
          visible={pickerOpen}
          initial={null}
          saving={savingPin}
          onClose={() => setPickerOpen(false)}
          onConfirm={handlePinConfirm}
        />
      </View>
    );
  }

  if (loadingStore || !store) {
    return (
      <View style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.pointOrange} size="large" />
          <Text style={styles.loadingText}>매장 위치 지도를 불러오는 중...</Text>
        </View>
      </View>
    );
  }

  const insight = nearby?.insight ?? null;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
        {/* 지도 — 브라운 핀=내 매장(고정), 초록 핀=주변 카페, 오렌지 핀=인근 행사 */}
        <View style={styles.mapBox}>
          <StoreLocationMap
            lat={store.lat}
            lon={store.lon}
            regionName={nearby?.region ?? store.region ?? ''}
            shopLabel={user?.name ? `내 매장 (${user.name})` : '내 매장'}
            nearbyCafes={nearby?.cafes ?? []}
            onCafePress={openCafe}
            containerId="standalone-store-map"
          />
        </View>

        <View style={styles.body}>
          {/* 등록된 매장 위치 + 변경 버튼 */}
          <View style={styles.storeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.storeLabel}>등록된 매장 위치</Text>
              <Text style={styles.storeAddress}>
                {store.region || nearby?.region || `${store.lat.toFixed(5)}, ${store.lon.toFixed(5)}`}
              </Text>
            </View>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => setPickerOpen(true)}>
              <Ionicons name="create-outline" size={14} color={colors.espressoBrown} />
              <Text style={styles.ghostBtnText}>위치 변경</Text>
            </TouchableOpacity>
          </View>

          {/* 반경 선택 */}
          <View style={styles.radiusRow}>
            <Text style={styles.sectionTitle}>주변 카페</Text>
            <View style={styles.chipRow}>
              {RADIUS_OPTIONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, radius === r && styles.chipActive]}
                  onPress={() => setRadius(r)}
                >
                  <Text style={[styles.chipText, radius === r && styles.chipTextActive]}>
                    {r >= 1000 ? `${r / 1000}km` : `${r}m`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {loadingNearby ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="small" color={colors.mochaBrown} />
              <Text style={styles.inlineLoadingText}>
                네이버에서 주변 카페와 후기를 모아 분석하는 중...
              </Text>
            </View>
          ) : nearbyError ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{nearbyError}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={() => loadNearby(radius)}>
                <Text style={styles.retryText}>다시 시도</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* 상권 AI 분석 요약 */}
              {insight && (
                <View style={styles.insightCard}>
                  <View style={styles.insightHead}>
                    <Text style={styles.insightHeadline}>{insight.headline}</Text>
                    <View style={styles.levelBadge}>
                      <Text style={styles.levelText}>경쟁 {insight.competition_level}</Text>
                    </View>
                  </View>
                  <Text style={styles.insightSummary}>{insight.market_summary}</Text>

                  <InsightList title="🔎 동네 트렌드" items={insight.trends} />
                  <InsightList title="💡 우리가 파고들 자리" items={insight.opportunities} />
                  <InsightList title="⚠️ 위협 요인" items={insight.threats} />
                  <InsightList title="✅ 이번 주 실행안" items={insight.actions} highlight />

                  {insight.watch_list?.length > 0 && (
                    <View style={styles.watchRow}>
                      <Text style={styles.watchLabel}>주시할 경쟁 카페</Text>
                      <View style={styles.chipRow}>
                        {insight.watch_list.map((name) => {
                          const hit = nearby?.cafes.find((c) => c.name === name);
                          return (
                            <TouchableOpacity
                              key={name}
                              style={styles.watchChip}
                              disabled={!hit}
                              onPress={() => hit && openCafe(hit)}
                            >
                              <Text style={styles.watchChipText}>{name}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}
                  <Text style={styles.aiNote}>
                    네이버 지역정보·블로그 후기를 모아 AI가 정리했어요. 참고용으로 봐 주세요.
                  </Text>
                </View>
              )}

              {/* 카페 목록 (거리순) */}
              {nearby?.cafes.map((cafe) => (
                <TouchableOpacity
                  key={`${cafe.name}-${cafe.lat}-${cafe.lon}`}
                  style={styles.cafeCard}
                  onPress={() => openCafe(cafe)}
                  activeOpacity={0.85}
                >
                  <View style={styles.cafeDot} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cafeName}>{cafe.name}</Text>
                    <Text style={styles.cafeMeta}>
                      {cafe.category} · {cafe.distance_m}m
                    </Text>
                    <Text style={styles.cafeAddress} numberOfLines={1}>
                      {cafe.address}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
                </TouchableOpacity>
              ))}

              {nearby && nearby.count === 0 && (
                <Text style={styles.emptyText}>
                  이 반경에서는 등록된 카페를 찾지 못했어요. 반경을 넓혀 보세요.
                </Text>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* 카페 상세 — 네이버 후기 기반 AI 분석 */}
      <Modal visible={!!selected} animationType="slide" transparent onRequestClose={() => setSelected(null)}>
        {/* [FormSheet 패턴] 웹에서 Modal이 뷰포트 전체를 덮으므로 폰 프레임(maxWidth 420)에 가둔다 */}
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setSelected(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{selected?.name}</Text>
                <Text style={styles.sheetMeta}>
                  {selected?.category} · 내 매장에서 {selected?.distance_m}m
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              {analysisError ? (
                <Text style={styles.errorText}>{analysisError}</Text>
              ) : !analysis ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator size="small" color={colors.mochaBrown} />
                  <Text style={styles.inlineLoadingText}>네이버 후기를 모아 분석하는 중...</Text>
                </View>
              ) : (
                <>
                  {analysis.analysis ? (
                    <>
                      <Text style={styles.sheetSummary}>{analysis.analysis.summary}</Text>
                      <View style={styles.tagRow}>
                        <Tag label={`여론 ${analysis.analysis.sentiment}`} />
                        <Tag label={`가격 ${analysis.analysis.price_level}`} />
                        <Tag label={`후기 ${analysis.review_count}건`} />
                      </View>
                      <InsightList title="👍 강점" items={analysis.analysis.strengths} />
                      <InsightList title="👎 약점" items={analysis.analysis.weaknesses} />
                      {analysis.analysis.signature_menus.length > 0 && (
                        <InsightList title="🍰 대표 메뉴" items={analysis.analysis.signature_menus} />
                      )}
                      <InsightList
                        title="🙋 주 고객층 · 분위기"
                        items={[analysis.analysis.main_customers, analysis.analysis.atmosphere]}
                      />
                      <InsightList title="🎯 우리 대응 전략" items={[analysis.analysis.counter_strategy]} highlight />
                    </>
                  ) : (
                    <Text style={styles.sheetSummary}>
                      AI 분석을 생성하지 못했어요. 아래 후기 원문을 참고해 주세요.
                    </Text>
                  )}

                  {analysis.reviews.length > 0 && (
                    <>
                      <Text style={styles.listTitle}>📝 후기 원문</Text>
                      {analysis.reviews.map((r) => (
                        <TouchableOpacity
                          key={r.link}
                          style={styles.reviewItem}
                          onPress={() => r.link && Linking.openURL(r.link)}
                        >
                          <Text style={styles.reviewTitle} numberOfLines={1}>
                            {r.title}
                          </Text>
                          <Text style={styles.reviewSnippet} numberOfLines={2}>
                            {r.snippet}
                          </Text>
                          <Text style={styles.reviewMeta}>
                            {r.blogger} · {r.date}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <StoreLocationPicker
        visible={pickerOpen}
        initial={{ lat: store.lat, lon: store.lon, address: store.region }}
        saving={savingPin}
        onClose={() => setPickerOpen(false)}
        onConfirm={handlePinConfirm}
      />
    </View>
  );
}

// 목록형 인사이트 블록 (제목 + 불릿)
function InsightList({ title, items, highlight }: { title: string; items?: string[]; highlight?: boolean }) {
  const clean = (items ?? []).filter((t) => t && t.trim());
  if (clean.length === 0) return null;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.listTitle}>{title}</Text>
      {clean.map((text, i) => (
        <View key={`${title}-${i}`} style={styles.bulletRow}>
          <Text style={[styles.bulletDot, highlight && { color: colors.trendGreenText }]}>•</Text>
          <Text style={[styles.bulletText, highlight && { color: colors.espressoBrown, fontWeight: '700' }]}>
            {text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  loadingText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  hintText: {
    fontSize: 11.5,
    lineHeight: 18,
    color: '#A99C90',
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginTop: 6,
  },
  primaryBtnText: { ...typography.L4, color: colors.white },

  mapBox: { height: 320, backgroundColor: colors.coffeeCream },
  body: { paddingHorizontal: spacing.globalPadding, paddingTop: 14, gap: 10 },

  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  storeLabel: { ...typography.L5, color: colors.mochaBrown },
  storeAddress: { ...typography.L4, color: colors.espressoBrown, marginTop: 3, lineHeight: 17 },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: colors.coffeeCream,
  },
  ghostBtnText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  radiusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  sectionTitle: { ...typography.L3, color: colors.espressoBrown },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.coffeeCream,
  },
  chipActive: { backgroundColor: colors.espressoBrown },
  chipText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '800' },
  chipTextActive: { color: colors.white },

  inlineLoading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
  inlineLoadingText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '600' },

  errorCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  errorText: { ...typography.L5, color: colors.espressoBrown, lineHeight: 17 },
  retryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  retryText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  insightCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  insightHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  insightHeadline: { ...typography.L3, color: colors.espressoBrown, flex: 1, lineHeight: 21 },
  levelBadge: { backgroundColor: colors.trendGreenBg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  levelText: { ...typography.L5, color: colors.trendGreenText, fontWeight: '800' },
  insightSummary: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, marginTop: 8 },

  listTitle: { ...typography.L4, color: colors.espressoBrown, marginBottom: 5, marginTop: 4 },
  bulletRow: { flexDirection: 'row', gap: 6, marginTop: 3 },
  bulletDot: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17 },
  bulletText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 17 },

  watchRow: { marginTop: 14, gap: 6 },
  watchLabel: { ...typography.L4, color: colors.espressoBrown },
  watchChip: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  watchChipText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  aiNote: { ...typography.L5, color: '#A99C90', marginTop: 12, lineHeight: 15 },

  cafeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  cafeDot: { width: 9, height: 9, borderRadius: 999, backgroundColor: '#3F8F6B' },
  cafeName: { ...typography.L4, color: colors.espressoBrown },
  cafeMeta: { ...typography.L5, color: colors.trendGreenText, fontWeight: '700', marginTop: 2 },
  cafeAddress: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  emptyText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', paddingVertical: 18 },

  modalRoot: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    maxHeight: '85%',
    ...shadows.medium,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  sheetTitle: { ...typography.L1, color: colors.espressoBrown },
  sheetMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  sheetSummary: { ...typography.L5, color: colors.espressoBrown, lineHeight: 18 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  tag: { backgroundColor: colors.coffeeCream, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tagText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  reviewItem: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  reviewTitle: { ...typography.L4, color: colors.espressoBrown },
  reviewSnippet: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 3 },
  reviewMeta: { ...typography.L5, color: '#A99C90', marginTop: 5 },
});
