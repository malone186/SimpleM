// [한글 주석: 원두 상세 정보 모달 - DB 데이터 기반으로 완전 재설계]
// 각 원두의 실제 DB 값(원산지, 가공방식, 설명/맛)을 최우선으로 표시하고
// 그 아래에 해당 데이터에 맞춘 커피 가이드를 보조 설명으로 붙입니다.
import {
  Image,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RoasteryBean } from '../../lib/api/inventory';
import { colors, shadows, typography } from '../../theme';

// ─── 원산지(나라) → 지역 특성 한 줄 설명 ────────────────────────────────
// ─── 원산지(나라) → 지역 특성 한 줄 설명 ────────────────────────────────
const ORIGIN_HINT: Record<string, { region: string; hint: string }> = {
  에티오피아:   { region: '아프리카', hint: '꽃향·베리·홍차 같은 화려한 과일 향의 고향' },
  케냐:         { region: '아프리카', hint: '선명한 산미, 블랙커런트·자몽의 복잡한 풍미' },
  르완다:       { region: '아프리카', hint: '레드베리·복숭아·허브의 달콤하고 섬세한 향' },
  탄자니아:     { region: '아프리카', hint: '체리·자두·초콜릿의 복합적인 밝은 맛' },
  우간다:       { region: '아프리카', hint: '진한 바디감, 견과류·초콜릿의 풍부한 향미' },
  콜롬비아:     { region: '중남미', hint: '캐러멜·헤이즐넛·초콜릿의 균형 잡힌 단맛' },
  브라질:       { region: '중남미', hint: '견과류·초콜릿·카카오의 묵직하고 고소한 맛' },
  과테말라:     { region: '중남미', hint: '다크초콜릿·브라운슈거·스파이스의 복잡한 달콤함' },
  코스타리카:   { region: '중남미', hint: '복숭아·사과·꿀의 깔끔하고 밝은 단맛' },
  파나마:       { region: '중남미', hint: '게이샤의 본고장. 재스민·열대과일의 귀한 향' },
  페루:         { region: '중남미', hint: '부드러운 산미와 다크초콜릿·꿀의 은은한 단맛' },
  멕시코:       { region: '중남미', hint: '가볍고 부드러운 바디, 견과류·밀크초콜릿 향' },
  인도네시아:   { region: '아시아', hint: '흙내음·스파이시·허브의 묵직하고 개성 강한 맛' },
  예멘:         { region: '중동', hint: '와인·건포도·시나몬의 신비롭고 복고적인 향' },
  인도:         { region: '아시아', hint: '몬순 처리 특유의 묵직한 바디, 스파이시한 향' },
  중국:         { region: '아시아', hint: '운남성 원두 특유의 다크초콜릿·흑설탕 풍미' },
};

// ─── 가공 방식 → 설명 ──────────────────────────────────────────────────
const PROCESS_HINT: Record<string, { label: string; hint: string }> = {
  washed:    { label: 'Washed (워시드)', hint: '물로 씻어 말린 방식 — 깨끗하고 투명한 산미, 원산지 본연의 맛이 살아남' },
  natural:   { label: 'Natural (내추럴)', hint: '통째로 말린 방식 — 과일처럼 진한 단맛과 풍부한 향, 묵직한 바디감' },
  honey:     { label: 'Honey (허니)', hint: '점액질을 남겨 말린 방식 — 꿀처럼 달콤하고 부드럽게 마무리됨' },
  anaerobic: { label: 'Anaerobic (애너로빅)', hint: '밀폐 발효 방식 — 와인·캔디·열대과일의 독특하고 복잡한 풍미' },
  pulped:    { label: 'Pulped Natural', hint: '과육 일부 제거 후 건조 — 단맛·산미의 균형, 부드러운 질감' },
};

function getProcessInfo(raw: string | null) {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
  if (lower.includes('natural')) return PROCESS_HINT['natural'];
  if (lower.includes('honey')) return PROCESS_HINT['honey'];
  if (lower.includes('anaerobic')) return PROCESS_HINT['anaerobic'];
  if (lower.includes('washed') || lower.includes('wash')) return PROCESS_HINT['washed'];
  if (lower.includes('pulped')) return PROCESS_HINT['pulped'];
  return null;
}

function getOriginInfo(country: string | null) {
  if (!country) return null;
  for (const [key, val] of Object.entries(ORIGIN_HINT)) {
    if (country.includes(key) || key.includes(country)) return { ...val, key };
  }
  return null;
}

// ─── 정보 행 컴포넌트 ─────────────────────────────────────────────────
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={rowStyles.value}>{value}</Text>
    </View>
  );
}
const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6 },
  label: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown, width: 64, flexShrink: 0 },
  value: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 18 },
});

// ─── 섹션 타이틀 (이모지 제거 버전) ───────────────────────────────────
function SectionTitle({ title }: { title: string }) {
  return (
    <View style={sectionStyles.row}>
      <Text style={sectionStyles.text}>{title}</Text>
    </View>
  );
}
const sectionStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  text: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
});

// ─── 특성 배지 ─────────────────────────────────────────────────────────
function Tag({ label, color = colors.coffeeCream, textColor = colors.mochaBrown }: {
  label: string; color?: string; textColor?: string;
}) {
  return (
    <View style={[tagStyles.chip, { backgroundColor: color }]}>
      <Text style={[tagStyles.text, { color: textColor }]}>{label}</Text>
    </View>
  );
}
const tagStyles = StyleSheet.create({
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  text: { fontSize: 11, fontWeight: '700' },
});

// ─── 로스팅 단계 데이터 ────────────────────────────────────────────────
const ROAST_LEVELS = [
  { label: '라이트', color: '#C8A882', acidity: 5, bitter: 1, note: '꽃향·과일향 생생, 밝고 화사' },
  { label: '미디엄', color: '#A67B5B', acidity: 4, bitter: 2, note: '산미·단맛의 균형, 견과류·캐러멜' },
  { label: '미디엄 다크', color: '#7B5535', acidity: 2, bitter: 4, note: '고소·진한 초콜릿 향, 풍부한 바디감' },
  { label: '다크', color: '#3E2009', acidity: 1, bitter: 5, note: '묵직·스모키·카카오, 산미 거의 없음' },
];

function StarRow({ count, max = 5, color }: { count: number; max?: number; color: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {Array.from({ length: max }).map((_, i) => (
        <Ionicons key={i} name={i < count ? 'star' : 'star-outline'} size={9} color={i < count ? color : colors.stone300} />
      ))}
    </View>
  );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────
interface Props {
  bean: RoasteryBean | null;
  visible: boolean;
  onClose: () => void;
}

export default function BeanDetailModal({ bean, visible, onClose }: Props) {
  if (!bean) return null;

  const originInfo = getOriginInfo(bean.country);
  const processInfo = getProcessInfo(bean.process);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>

      {/* [한글 주석: FormSheet 패턴] 전체 Modal 위에 root로 폰 너비(maxWidth 420)를 제한합니다 */}
      <View style={styles.root}>

        {/* 딤드 배경 — root 안에서만 덮음 */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableOpacity>

        {/* 바텀 시트 */}
        <View style={styles.sheet}>

          {/* 핸들 */}
          <View style={styles.handle} />

        {/* 닫기 버튼 */}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={18} color={colors.espressoBrown} />
        </TouchableOpacity>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          bounces={false}
        >

          {/* ━━━ 헤더: 원두 기본 정보 ━━━ */}
          <View style={styles.headerCard}>
            {bean.thumbnail_url ? (
              <Image source={{ uri: bean.thumbnail_url }} style={styles.thumb} resizeMode="cover" />
            ) : (
              <View style={styles.thumbPlaceholder}>
                <Ionicons name="cafe" size={26} color={colors.mochaBrown} />
              </View>
            )}
            <View style={styles.headerInfo}>
              {bean.roastery?.name && (
                <Text style={styles.roasteryName} numberOfLines={1}>{bean.roastery.name}</Text>
              )}
              <Text style={styles.beanName} numberOfLines={2}>{bean.name}</Text>
              <Text style={styles.price}>
                {bean.price.toLocaleString('ko-KR')}원
                {bean.price_per_gram
                  ? <Text style={styles.perGram}> · {bean.price_per_gram.toFixed(1)}원/g</Text>
                  : null}
              </Text>
            </View>
          </View>

          {/* ━━━ 배지 줄 (이모지 완벽 제거) ━━━ */}
          <View style={styles.tagRow}>
            {bean.best && <Tag label="BEST" color="rgba(212,120,50,0.14)" textColor="#C07030" />}
            {bean.new && <Tag label="NEW" color="rgba(78,125,58,0.14)" textColor="#4E7D3A" />}
            {bean.gesha && <Tag label="게이샤" color="rgba(60,100,180,0.12)" textColor="#3C64B4" />}
            {bean.decaf && <Tag label="디카페인" />}
            {bean.blend && <Tag label="블렌드" />}
            {bean.sold_out && <Tag label="품절" color="rgba(0,0,0,0.06)" textColor="#999" />}
          </View>

          {/* ━━━ 핵심 정보 (이모지 완벽 제거) ━━━ */}
          <View style={styles.section}>
            <SectionTitle title="원두 정보" />
            <View style={styles.infoBox}>

              {/* 원산지: DB의 실제 country 값 */}
              {bean.country && (
                <View>
                  <InfoRow
                    label="원산지"
                    value={originInfo
                      ? `${bean.country} (${originInfo.region})`
                      : bean.country}
                  />
                  {/* 해당 나라의 커피 특성 한 줄 힌트 */}
                  {originInfo && (
                    <View style={styles.hintBox}>
                      <Text style={styles.hintText}>{originInfo.hint}</Text>
                    </View>
                  )}
                  <View style={styles.divider} />
                </View>
              )}

              {/* 가공 방식: DB의 실제 process 값 */}
              {bean.process && (
                <View>
                  <InfoRow
                    label="가공"
                    value={processInfo ? processInfo.label : bean.process}
                  />
                  {processInfo && (
                    <View style={styles.hintBox}>
                      <Text style={styles.hintText}>{processInfo.hint}</Text>
                    </View>
                  )}
                  <View style={styles.divider} />
                </View>
              )}

              {/* 블렌드 여부 */}
              <InfoRow
                label="타입"
                value={bean.blend ? '블렌드 (여러 원두 혼합)' : '싱글 오리진 (단일 산지)'}
              />

              {/* 디카페인 여부 */}
              {bean.decaf && (
                <>
                  <View style={styles.divider} />
                  <InfoRow label="카페인" value="디카페인 (카페인 제거 처리)" />
                </>
              )}

            </View>
          </View>

          {/* ━━━ 원두 소개 / 맛 설명 (이모지 완벽 제거) ━━━ */}
          {bean.description ? (
            <View style={styles.section}>
              <SectionTitle title="맛과 향" />
              <View style={styles.descBox}>
                <Text style={styles.descText}>{bean.description}</Text>
              </View>
            </View>
          ) : (
            // description이 없을 때 원산지 기반 힌트로 대체
            originInfo && (
              <View style={styles.section}>
                <SectionTitle title="예상되는 맛과 향" />
                <View style={styles.descBox}>
                  <Text style={styles.descText}>
                    {bean.country} 원두는 일반적으로 {originInfo.hint.replace(' 특성', '')} 특징을 가집니다.
                    {bean.process ? `\n가공 방식: ${bean.process}` : ''}
                  </Text>
                </View>
              </View>
            )
          )}

          {/* ━━━ 로스팅 단계 가이드 (이모지 완벽 제거) ━━━ */}
          <View style={styles.section}>
            <SectionTitle title="로스팅 단계 가이드" />
            <Text style={styles.guideNote}>
              원두 포장지의 로스팅 표기를 참고해 취향에 맞는 원두를 고르세요.
            </Text>
            <View style={styles.roastGrid}>
              {ROAST_LEVELS.map((r) => (
                <View key={r.label} style={[styles.roastCard, { borderTopColor: r.color }]}>
                  <View style={[styles.roastDot, { backgroundColor: r.color }]} />
                  <Text style={[styles.roastLabel, { color: r.color }]}>{r.label}</Text>
                  <Text style={styles.roastNote}>{r.note}</Text>
                  <View style={styles.roastStars}>
                    <Text style={styles.roastStat}>산미</Text>
                    <StarRow count={r.acidity} color="#E07050" />
                  </View>
                  <View style={styles.roastStars}>
                    <Text style={styles.roastStat}>쓴맛</Text>
                    <StarRow count={r.bitter} color={r.color} />
                  </View>
                </View>
              ))}
            </View>
          </View>

          {/* [한글 주석: 사용자 요청에 따라 테이스팅 노트 설명 섹션 제거 완료] */}

          {/* ━━━ 구매 버튼 ━━━ */}
          {bean.product_url && !bean.sold_out && (
            <TouchableOpacity
              style={styles.buyBtn}
              onPress={() => {
                let url = bean.product_url!.replace(/https?:\/\/(m\.)+/g, 'https://');
                url = url.replace('/main/products/', '/products/');
                Linking.openURL(url);
              }}
            >
              <Ionicons name="cart-outline" size={16} color={colors.white} />
              <Text style={styles.buyText}>웹사이트에서 원두 구매하기</Text>
              <Ionicons name="open-outline" size={13} color={colors.white} />
            </TouchableOpacity>
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
        </View>{/* sheet 닫기 */}
      </View>{/* root 닫기 */}
    </Modal>
  );
}

// ─── 스타일 ────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },

  // [한글 주석: FormSheet와 동일한 패턴 적용]
  // Modal이 전체 뷰포트를 덮더라도, root에서 maxWidth+alignSelf로 폰 프레임 안에 가둡니다.
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center' as const,
  },

  // 바텀 시트 패널
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%' as any,
    ...shadows.medium,
  },


  handle: {
    width: 36, height: 4,
    borderRadius: 999,
    backgroundColor: colors.stone300,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 2,
  },

  closeBtn: {
    position: 'absolute',
    top: 10, right: 14,
    width: 30, height: 30,
    borderRadius: 999,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center', justifyContent: 'center',
    zIndex: 20,
  },

  // [한글 주석: 상단 닫기(X) 버튼과 헤더 카드가 겹치지 않도록 상단 여백(paddingTop)을 44px로 확장]
  content: { paddingHorizontal: 16, paddingTop: 44, paddingBottom: 20 },

  // 헤더 카드
  headerCard: {
    flexDirection: 'row', gap: 12,
    backgroundColor: colors.white,
    borderRadius: 14, padding: 12,
    marginBottom: 10,
    ...shadows.soft,
  },
  thumb: { width: 70, height: 70, borderRadius: 10, backgroundColor: colors.coffeeCream },
  thumbPlaceholder: {
    width: 70, height: 70, borderRadius: 10,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center', justifyContent: 'center',
  },
  headerInfo: { flex: 1, justifyContent: 'center', gap: 2 },
  roasteryName: { ...typography.L5, color: colors.mochaBrown, fontSize: 10 },
  beanName: { ...typography.L4, color: colors.espressoBrown, lineHeight: 18 },
  price: { ...typography.L4, color: colors.pointOrange, fontWeight: '900', marginTop: 4, fontSize: 13 },
  perGram: { ...typography.L5, color: colors.mochaBrown, fontWeight: '500', fontSize: 10 },

  // 배지 줄
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },

  // 공통 섹션
  section: {
    backgroundColor: colors.white,
    borderRadius: 14, padding: 14,
    marginBottom: 10,
    ...shadows.soft,
  },

  // 정보 박스
  infoBox: { gap: 0 },
  divider: { height: 1, backgroundColor: colors.coffeeCream, marginVertical: 4 },
  hintBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5,
    marginBottom: 6, marginLeft: 64,
  },
  hintText: { ...typography.L5, color: colors.mochaBrown, fontSize: 10, lineHeight: 15 },

  // 맛과 향 설명 박스 (DB description)
  descBox: {
    backgroundColor: 'rgba(140,111,86,0.07)',
    borderRadius: 10, padding: 12,
    borderLeftWidth: 3, borderLeftColor: colors.mochaBrown,
  },
  descText: { ...typography.L5, color: colors.espressoBrown, lineHeight: 20 },

  // 로스팅 가이드 참고 안내
  guideNote: { ...typography.L5, color: colors.mochaBrown, marginBottom: 10, lineHeight: 16, fontSize: 10 },

  // 로스팅 단계 2×2 그리드
  roastGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: 8,
  },
  roastCard: {
    flex: 1, minWidth: '45%',
    backgroundColor: colors.coffeeCream,
    borderRadius: 10, padding: 10,
    borderTopWidth: 3,
    gap: 3,
  },
  roastDot: { width: 8, height: 8, borderRadius: 999, marginBottom: 2 },
  roastLabel: { fontSize: 11, fontWeight: '800' },
  roastNote: { ...typography.L5, fontSize: 9, color: colors.mochaBrown, lineHeight: 14, marginBottom: 4 },
  roastStars: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  roastStat: { ...typography.L5, fontSize: 9, color: colors.mochaBrown, width: 26 },

  // 테이스팅 노트 박스
  tasteBox: {
    backgroundColor: 'rgba(140,111,86,0.06)',
    borderRadius: 10, padding: 12,
  },
  tasteText: { ...typography.L5, color: colors.espressoBrown, lineHeight: 20 },
  tasteBold: { fontWeight: '800', color: colors.mochaBrown },

  // 구매 버튼
  buyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.espressoBrown,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  buyText: { ...typography.L4, color: colors.white },
});
