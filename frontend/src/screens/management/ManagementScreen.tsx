// 관리 허브 (⑥ 탭) — 딥브라운 오로라 헤더는 고정, 그 아래 크림 시트 안에서 카드만 스크롤.
// 카드는 좌우로 번갈아 기울인 지그재그 배치이며, 탭에 들어올 때마다 아래에서 순차로 떠오른다.
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';

import { FadeInUp, PressableScale } from '../../components/motion';
import { colors } from '../../theme';
import Brew from '../../components/brew/Brew';

const IVORY = '#F4F1EF';
const DARKTX = '#463C34'; // 밝은 카드용 진한 텍스트

type Item = {
  label: string;
  en: string;
  desc: string;
  color: string;
  route: string;
  params?: object;
};

// 지정 팔레트 — 에스프레소 → 모카 → 토프 → 스톤 베이지 → 페일 아이보리
// 설정은 카드가 아니라 헤더 우상단 칩으로 들어간다.
const ITEMS: Item[] = [
  { label: '디저트 관리', en: 'DESSERT', desc: '소비기한 · 폐기 손실 · 마진 순위', color: '#6B4A32', route: 'Dessert' },
  { label: '스케줄·급여', en: 'PAYROLL', desc: '알바 스케줄 · 손익 정산', color: '#5B514C', route: 'Operation' },
  { label: '서류·세금', en: 'DOCUMENTS', desc: '문서 초안 · 세금 관리', color: '#9A8E82', route: 'Document' },
  { label: '판매 입력', en: 'SALES', desc: 'POS 연동 · 수동 입력', color: '#D1C6B9', route: 'SalesInput' },
  { label: '원가 분석', en: 'COST', desc: '메뉴별 원가율 진단', color: '#E1DCD7', route: 'Cost' },
  { label: '법령 검색', en: 'LAW', desc: '노무 · 위생 법령', color: '#F4F1EF', route: 'LawSearch' },
  { label: '운영·원두 분석', en: 'OPERATION', desc: '원두 최저가 시세 · 실리뷰 분석', color: '#463C34', route: 'BeanOperation' },
];

// 좌우로 번갈아 기울이고 밀어 지그재그를 만든다
const LAYOUT = [
  { deg: -2.5, tx: -10 },
  { deg: 2.5, tx: 12 },
  { deg: -2, tx: -12 },
  { deg: 2.5, tx: 10 },
  { deg: -2.5, tx: -8 },
  { deg: 2, tx: 12 },
  { deg: -2.5, tx: -10 },
];

const CARD_H = 132; // 카드 높이 (스크롤이 있으므로 넉넉하게)
const GAP = -14; // 음수 간격 — 뒤 카드가 앞 카드 위로 살짝 올라타는 스택 느낌 (zIndex로 아래 카드가 위에 쌓인다)

// 상태바(시계·카메라 노치)에 가리지 않을 만큼만 띄운다.
const TOP_INSET = Platform.select({
  android: (StatusBar.currentHeight ?? 24) + 4,
  ios: 56,
  default: 44, // 웹(디바이스 프레임)
}) as number;

// 배경색 밝기로 텍스트 명암 결정
const isDark = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55;
};

function scheme(color: string) {
  if (isDark(color)) {
    return {
      border: 'transparent',
      ghost: 'rgba(244,241,239,0.12)',
      en: 'rgba(244,241,239,0.62)',
      label: IVORY,
      desc: 'rgba(244,241,239,0.74)',
      arrowBg: 'rgba(244,241,239,0.16)',
      arrowFg: IVORY,
    };
  }
  return {
    border: 'rgba(70,60,52,0.16)',
    ghost: 'rgba(70,60,52,0.10)',
    en: 'rgba(70,60,52,0.55)',
    label: DARKTX,
    desc: 'rgba(70,60,52,0.66)',
    arrowBg: '#5B514C',
    arrowFg: IVORY,
  };
}

export default function ManagementScreen() {
  const navigation = useNavigation<any>();

  // 탭에 다시 들어올 때마다 카드 등장 애니메이션을 재생한다 (홈 화면과 같은 방식)
  const isFocused = useIsFocused();
  const [runId, setRunId] = useState(0);
  useEffect(() => {
    if (isFocused) setRunId((x) => x + 1);
  }, [isFocused]);

  // [월렛 스타일 흡입] 스크롤 위치를 네이티브 드라이버로 추적 — 카드가 시트 상단에 닿으면
  // 작아지고(scale) 반듯해지며(rotate→0) 뒤처지다(translateY) 다음 카드에 덮여 사라진다(opacity)
  // 하단 경계(탭 메뉴에 가려지는 지점)에서도 같은 효과가 거울상으로 걸린다.
  const scrollY = useRef(new Animated.Value(0)).current;
  // 아래 경계 계산에 필요한 스크롤 뷰포트 높이 — onLayout 전에는 통상치로 대체
  const [sheetH, setSheetH] = useState(0);
  const H = Math.max(sheetH, 300);

  return (
    <View style={styles.root}>
      {/* [전역 오로라 배경] 홈(대시보드)과 동일 — 상단 딥브라운에서 하단 크림으로 녹아든다 */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="mgmtAurora" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor="#1E1612" />
              <Stop offset="35%" stopColor="#251C17" />
              <Stop offset="70%" stopColor="#6E5544" stopOpacity="0.35" />
              <Stop offset="100%" stopColor={colors.creamSand} />
            </LinearGradient>
            <Filter id="mgmtGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="70" />
            </Filter>
          </Defs>
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#mgmtAurora)" />
          <Circle cx="85%" cy="12%" r="140" fill="#E28257" filter="url(#mgmtGlow)" opacity="0.25" />
          <Circle cx="15%" cy="22%" r="130" fill="#C29D7A" filter="url(#mgmtGlow)" opacity="0.2" />
          <Circle cx="60%" cy="4%" r="120" fill="#88BCB5" filter="url(#mgmtGlow)" opacity="0.16" />
        </Svg>
      </View>

      {/* 헤더 — ScrollView 밖에 있어 카드가 흘러도 제자리에 고정된다 */}
      <View style={styles.header}>
        <FadeInUp key={`title-${runId}`} style={styles.headerText}>
          <Text style={styles.bigTitle}>관리</Text>
          <Text style={styles.sub}>가게 운영에 필요한 모든 기능</Text>
        </FadeInUp>

        <View style={styles.headerRight}>
          {/* 설정 진입 — 카드가 아니라 헤더 안에 둔다 */}
          <PressableScale style={styles.gearBtn} onPress={() => navigation.navigate('Settings')} to={0.9}>
            <Ionicons name="settings-outline" size={15} color={colors.creamSand} />
            <Text style={styles.gearText}>설정</Text>
          </PressableScale>
          <Brew mood="clipboard" size={96} />
        </View>
      </View>

      {/* [둥근 크림 시트] 시트 자체는 고정, 그 안에서 카드만 스크롤한다 */}
      <View style={styles.body}>
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.deck}
          showsVerticalScrollIndicator={false}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
            useNativeDriver: true,
          })}
          scrollEventThrottle={16}
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
        >
          {ITEMS.map((it, i) => {
            const lay = LAYOUT[i % LAYOUT.length];
            const s = scheme(it.color);

            // 카드 상단의 콘텐츠 좌표 — 높이·간격이 고정이라 정확히 계산된다
            const STEP = CARD_H + GAP;
            const ct = i * STEP + 18; // deck paddingTop 포함
            // 위 경계 구간: 카드가 시트 상단에 닿아 빨려드는 스크롤 범위
            const t0 = ct;
            const t1 = ct + CARD_H;
            // 아래 경계 구간: 카드가 뷰포트 하단(탭 메뉴 라인) 아래 숨어 있다 올라오는 범위
            const b0 = ct - H;
            const b1 = ct + CARD_H - H;
            const suckScale = scrollY.interpolate({
              inputRange: [b0, b1, t0, t1],
              outputRange: [0.86, 1, 1, 0.86],
              extrapolate: 'clamp',
            });
            const suckY = scrollY.interpolate({
              inputRange: [b0, b1, t0, t1],
              outputRange: [CARD_H * 0.35, 0, 0, CARD_H * 0.35], // 경계 쪽으로 뒤처지며 가려진다
              extrapolate: 'clamp',
            });
            const suckRotate = scrollY.interpolate({
              inputRange: [b0 + CARD_H * 0.4, b1, t0, t0 + CARD_H * 0.6],
              outputRange: ['0deg', `${lay.deg}deg`, `${lay.deg}deg`, '0deg'], // 경계에선 반듯, 화면 안에선 지그재그
              extrapolate: 'clamp',
            });
            const suckOpacity = scrollY.interpolate({
              inputRange: [b0, b0 + CARD_H * 0.65, t0 + CARD_H * 0.35, t1],
              outputRange: [0, 1, 1, 0],
              extrapolate: 'clamp',
            });

            return (
              // 아래에서 순차로 떠오르는 진입 모션 — 카드마다 60ms씩 늦춰 물결처럼 들어온다
              <FadeInUp key={`${it.route}-${runId}`} delay={i * 60} distance={20}>
                {/* 스크롤 연동 변형은 별도 래퍼에 — FadeInUp/PressableScale의 자체 애니메이션과 분리 */}
                <Animated.View
                  style={{
                    opacity: suckOpacity,
                    transform: [{ translateY: suckY }, { rotate: suckRotate }, { translateX: lay.tx }, { scale: suckScale }],
                  }}
                >
                  <PressableScale
                    style={[
                      styles.card,
                      {
                        height: CARD_H,
                        marginTop: i === 0 ? 0 : GAP,
                        backgroundColor: it.color,
                        borderColor: s.border,
                        borderWidth: s.border === 'transparent' ? 0 : 1.5,
                        zIndex: i + 1,
                      },
                    ]}
                    onPress={() => navigation.navigate(it.route, it.params)}
                    to={0.97}
                  >
                    <Text style={[styles.cardGhost, { color: s.ghost }]}>{String(i + 1).padStart(2, '0')}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardEn, { color: s.en }]}>{it.en}</Text>
                      <Text style={[styles.cardLabel, { color: s.label }]} numberOfLines={1}>
                        {it.label}
                      </Text>
                      <Text style={[styles.cardDesc, { color: s.desc }]} numberOfLines={1}>
                        {it.desc}
                      </Text>
                    </View>
                    <View style={[styles.cardArrow, { backgroundColor: s.arrowBg }]}>
                      <Ionicons name="arrow-forward" size={17} color={s.arrowFg} />
                    </View>
                  </PressableScale>
                </Animated.View>
              </FadeInUp>
            );
          })}
        </Animated.ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Svg 로딩 지연 중 어두운 광원을 채우기 위한 딥 브라운 루트
  root: { flex: 1, backgroundColor: '#1E1612' },

  // [홈 웰컴 헤더와 같은 톤] 딥브라운 오로라 위 밝은 텍스트 + 우측 마스코트
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP_INSET,
    paddingBottom: 8,
    paddingHorizontal: 18,
  },
  headerText: { flex: 1, paddingRight: 8 },
  // 설정 칩을 마스코트 위에 얹어 세로로 쌓지 않는다 (헤더 높이 절약)
  headerRight: { alignItems: 'flex-end', gap: 2 },
  bigTitle: { fontSize: 24, fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5 },
  sub: { fontSize: 11.5, color: '#D4C9C1', marginTop: 4, fontWeight: '500', letterSpacing: -0.2 },
  gearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 999,
    paddingLeft: 9,
    paddingRight: 12,
    paddingVertical: 5,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  gearText: { color: colors.creamSand, fontSize: 11.5, fontWeight: '700' },

  // [홈 바디 카드시트와 동일] 둥근 크림 시트 — flex:1로 남은 높이를 채우고 내부만 스크롤
  body: {
    flex: 1,
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden', // 스크롤되는 카드가 둥근 모서리 밖으로 삐져나오지 않게
  },
  scroll: { flex: 1 },
  // 기울인 카드의 모서리가 잘리지 않도록 좌우로 숨통을 준다
  deck: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  cardGhost: {
    position: 'absolute',
    // 화살표(우측 20 + 지름 38)를 피해 그 왼쪽에 워터마크로 앉힌다 — 겹치면 둘 다 뭉개진다
    right: 62,
    top: -8,
    fontSize: 82,
    fontWeight: '900',
    letterSpacing: -4,
  },
  cardEn: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1.1 },
  cardLabel: { fontSize: 23, fontWeight: '900', letterSpacing: -0.5, marginTop: 2 },
  cardDesc: { fontSize: 12, fontWeight: '500', marginTop: 4 },
  cardArrow: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
