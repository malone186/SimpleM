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

  // 첫 화면은 '요약 + 이번 주 할 일'까지만 — 나머지 분석과 카페 목록은 눌러서 펼친다.
  // (항목을 전부 펼쳐 두면 불릿이 스무 개 넘게 쌓여 무엇부터 볼지 알 수 없다.)
  const [detailOpen, setDetailOpen] = useState(false);
  const [showAllCafes, setShowAllCafes] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false); // 카페 상세의 후기 원문 펼침

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
    // 반경을 바꾸면 목록·분석이 통째로 달라지므로 펼침 상태도 처음으로 되돌린다
    setShowAllCafes(false);
    setDetailOpen(false);
  }, [loadNearby, radius]);

  // 3) 카페 하나를 고르면 그 집의 네이버 후기 분석을 불러온다
  const openCafe = useCallback(
    async (cafe: NearbyCafe) => {
      setSelected(cafe);
      setAnalysis(null);
      setAnalysisError('');
      setReviewsOpen(false); // 다른 카페를 열 때마다 후기는 다시 접힌 상태로
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
  // 목록은 거리순이라 첫 항목이 곧 가장 가까운 경쟁점이다
  const nearest = nearby?.cafes[0]?.distance_m ?? null;
  const visibleCafes = showAllCafes ? (nearby?.cafes ?? []) : (nearby?.cafes ?? []).slice(0, 5);

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
              {/* ① 한눈 요약 — 숫자 세 개로 상권을 먼저 파악하게 한다 */}
              {nearby && nearby.count > 0 && (
                <View style={styles.statRow}>
                  <Stat value={`${nearby.count}곳`} label="주변 카페" />
                  <Stat value={`${nearest ?? '-'}m`} label="가장 가까운 곳" />
                  <Stat value={insight?.competition_level ?? '분석 중'} label="경쟁 강도" accent />
                </View>
              )}

              {/* ② 상권 한 줄 + 이번 주 할 일 3개 — 기본 화면은 여기까지만 보여 준다 */}
              {insight && (
                <View style={styles.insightCard}>
                  <Text style={styles.insightHeadline}>{insight.headline}</Text>
                  <Text style={styles.insightSummary}>{insight.market_summary}</Text>

                  {insight.actions?.length > 0 && (
                    <View style={styles.actionBox}>
                      <Text style={styles.actionTitle}>이번 주에 해 볼 일</Text>
                      {insight.actions.slice(0, 3).map((text, i) => (
                        <View key={`action-${i}`} style={styles.actionRow}>
                          <View style={styles.actionNum}>
                            <Text style={styles.actionNumText}>{i + 1}</Text>
                          </View>
                          <Text style={styles.actionText}>{text}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* 나머지 분석은 접어 둔다 — 필요할 때만 펼쳐 보게 */}
                  <TouchableOpacity style={styles.moreBtn} onPress={() => setDetailOpen((v) => !v)}>
                    <Text style={styles.moreBtnText}>
                      {detailOpen ? '분석 접기' : '기회 · 위협 · 트렌드 더 보기'}
                    </Text>
                    <Ionicons
                      name={detailOpen ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={colors.espressoBrown}
                    />
                  </TouchableOpacity>

                  {detailOpen && (
                    <>
                      <TagBlock title="💡 파고들 자리" items={insight.opportunities} tone="good" />
                      <TagBlock title="⚠️ 위협" items={insight.threats} tone="warn" />
                      <TagBlock title="🔎 동네 트렌드" items={insight.trends} />
                      {insight.watch_list?.length > 0 && (
                        <TagBlock
                          title="👀 주시할 카페"
                          items={insight.watch_list}
                          onPressItem={(name) => {
                            const hit = nearby?.cafes.find((c) => c.name === name);
                            if (hit) openCafe(hit);
                          }}
                        />
                      )}
                      <Text style={styles.aiNote}>
                        네이버 지역정보·블로그 후기를 모아 AI가 정리했어요. 참고용입니다.
                      </Text>
                    </>
                  )}
                </View>
              )}

              {/* ③ 카페 목록 — 기본 5곳만, 나머지는 버튼으로 */}
              {visibleCafes.map((cafe) => (
                <TouchableOpacity
                  key={`${cafe.name}-${cafe.lat}-${cafe.lon}`}
                  style={styles.cafeCard}
                  onPress={() => openCafe(cafe)}
                  activeOpacity={0.85}
                >
                  <View style={styles.distanceBadge}>
                    <Text style={styles.distanceText}>{cafe.distance_m}m</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cafeName} numberOfLines={1}>
                      {cafe.name}
                    </Text>
                    <Text style={styles.cafeMeta} numberOfLines={1}>
                      {cafe.category.split('>').pop()}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
                </TouchableOpacity>
              ))}

              {!!nearby && nearby.cafes.length > visibleCafes.length && (
                <TouchableOpacity style={styles.moreBtn} onPress={() => setShowAllCafes(true)}>
                  <Text style={styles.moreBtnText}>
                    카페 {nearby.cafes.length - visibleCafes.length}곳 더 보기
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.espressoBrown} />
                </TouchableOpacity>
              )}

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
                      {/* 태그 한 줄로 성격을 먼저 — 여론·가격·고객층·분위기를 문장 대신 칩으로 */}
                      <View style={styles.tagRow}>
                        <Tag label={`여론 ${analysis.analysis.sentiment}`} />
                        <Tag label={`가격 ${analysis.analysis.price_level}`} />
                        {!!analysis.analysis.main_customers && <Tag label={analysis.analysis.main_customers} />}
                        {!!analysis.analysis.atmosphere && <Tag label={analysis.analysis.atmosphere} />}
                      </View>
                      <Text style={styles.sheetSummary}>{analysis.analysis.summary}</Text>

                      <TagBlock title="👍 강점" items={analysis.analysis.strengths} tone="good" />
                      <TagBlock title="👎 약점" items={analysis.analysis.weaknesses} tone="warn" />
                      <TagBlock title="🍰 대표 메뉴" items={analysis.analysis.signature_menus} />

                      {/* 사장님이 실제로 쓸 한 줄 — 시트에서 가장 눈에 띄어야 한다 */}
                      <View style={styles.strategyBox}>
                        <Text style={styles.strategyLabel}>🎯 우리 대응</Text>
                        <Text style={styles.strategyText}>{analysis.analysis.counter_strategy}</Text>
                      </View>
                    </>
                  ) : (
                    <Text style={styles.sheetSummary}>
                      AI 분석을 생성하지 못했어요. 아래 후기 원문을 참고해 주세요.
                    </Text>
                  )}

                  {analysis.reviews.length > 0 && (
                    <>
                      <TouchableOpacity style={styles.moreBtn} onPress={() => setReviewsOpen((v) => !v)}>
                        <Text style={styles.moreBtnText}>
                          {reviewsOpen ? '후기 접기' : `근거가 된 후기 ${analysis.review_count}건 보기`}
                        </Text>
                        <Ionicons
                          name={reviewsOpen ? 'chevron-up' : 'chevron-down'}
                          size={14}
                          color={colors.espressoBrown}
                        />
                      </TouchableOpacity>
                      {reviewsOpen &&
                        analysis.reviews.map((r) => (
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

// 한눈 요약 숫자 한 칸 (주변 카페 수 · 최근접 거리 · 경쟁 강도)
function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, accent && { color: colors.trendGreenText }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// 제목 + 칩 묶음. 불릿 문장을 길게 늘어놓는 대신 짧은 칩으로 훑어보게 한다.
function TagBlock({
  title,
  items,
  tone,
  onPressItem,
}: {
  title: string;
  items?: string[];
  tone?: 'good' | 'warn';
  onPressItem?: (item: string) => void;
}) {
  const clean = (items ?? []).filter((t) => t && t.trim());
  if (clean.length === 0) return null;
  const toneStyle = tone === 'good' ? styles.tagGood : tone === 'warn' ? styles.tagWarn : null;
  const toneText = tone === 'good' ? styles.tagGoodText : tone === 'warn' ? styles.tagWarnText : null;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.listTitle}>{title}</Text>
      <View style={styles.chipRow}>
        {clean.map((text, i) => (
          <TouchableOpacity
            key={`${title}-${i}`}
            style={[styles.tag, toneStyle]}
            disabled={!onPressItem}
            onPress={() => onPressItem?.(text)}
          >
            <Text style={[styles.tagText, toneText]}>{text}</Text>
          </TouchableOpacity>
        ))}
      </View>
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
    color: '#AEAEB2',
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

  // 한눈 요약 3칸
  statRow: { flexDirection: 'row', gap: 8 },
  statBox: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  statValue: { ...typography.L3, color: colors.espressoBrown },
  statLabel: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },

  insightCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  insightHeadline: { ...typography.L3, color: colors.espressoBrown, lineHeight: 21 },
  insightSummary: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, marginTop: 6 },

  // 이번 주 할 일 — 번호를 붙여 '해야 할 목록'으로 읽히게 한다
  actionBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    gap: 8,
  },
  actionTitle: { ...typography.L4, color: colors.espressoBrown },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  actionNum: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: colors.espressoBrown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  actionNumText: { fontSize: 10, fontWeight: '900', color: colors.white },
  actionText: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 17, fontWeight: '600' },

  moreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 11,
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: colors.coffeeCream,
  },
  moreBtnText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  listTitle: { ...typography.L4, color: colors.espressoBrown, marginBottom: 6 },
  aiNote: { ...typography.L5, color: '#AEAEB2', marginTop: 12, lineHeight: 15 },

  cafeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  // 거리를 왼쪽 배지로 — 목록을 훑을 때 '얼마나 가까운가'가 먼저 보이게
  distanceBadge: {
    minWidth: 46,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 9,
    backgroundColor: colors.trendGreenBg,
    alignItems: 'center',
  },
  distanceText: { ...typography.L5, color: colors.trendGreenText, fontWeight: '800' },
  cafeName: { ...typography.L4, color: colors.espressoBrown },
  cafeMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
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
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  tag: { backgroundColor: colors.coffeeCream, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tagText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  // 강점=초록, 약점/위협=주의 — 색만 봐도 좋은 소식인지 나쁜 소식인지 구분된다
  tagGood: { backgroundColor: colors.trendGreenBg },
  tagGoodText: { color: colors.trendGreenText },
  tagWarn: { backgroundColor: 'rgba(226, 130, 87, 0.12)' },
  tagWarnText: { color: '#B4542C' },

  // 카페 상세에서 가장 중요한 한 줄 (우리 대응)
  strategyBox: {
    marginTop: 14,
    backgroundColor: colors.espressoBrown,
    borderRadius: 12,
    padding: 13,
    gap: 4,
  },
  strategyLabel: { ...typography.L5, color: 'rgba(255,255,255,0.7)', fontWeight: '800' },
  strategyText: { ...typography.L4, color: colors.white, lineHeight: 18 },

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
  reviewMeta: { ...typography.L5, color: '#AEAEB2', marginTop: 5 },
});
