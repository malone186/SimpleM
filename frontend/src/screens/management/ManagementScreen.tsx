// 관리 허브 (⑥ 탭) — 딥브라운 오로라 헤더 + 둥근 크림 시트 위에 항목 카드를 수평으로 나열.
// 헤더는 홈(대시보드)과 같은 톤이되 위아래로 짧게 눌러 카드가 쓸 높이를 확보한다.
// 시트 높이를 실측해 카드 높이를 나눠 갖게 하므로 기기 높이와 무관하게 스크롤 없이 한 화면에 들어온다.
import { useState } from 'react';
import { LayoutChangeEvent, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';

import { PressableScale } from '../../components/motion';
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

const GAP = 8; // 카드 사이 간격

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
  const [deckH, setDeckH] = useState(0);

  const onDeckLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && Math.abs(h - deckH) > 1) setDeckH(h);
  };

  // 남은 높이를 카드 수로 나눈다 (겹침 없음) — 글자 크기도 이 높이에 맞춰 스케일한다.
  const n = ITEMS.length;
  const cardH = deckH > 0 ? Math.max(52, (deckH - GAP * (n - 1)) / n) : 0;

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

      {/* 헤더 — 제목·마스코트와 설정 칩을 한 줄에 겹쳐 배치해 세로 길이를 줄였다 */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.bigTitle}>관리</Text>
          <Text style={styles.sub}>가게 운영에 필요한 모든 기능</Text>
        </View>

        <View style={styles.headerRight}>
          {/* 설정 진입 — 카드에서 내려와 헤더 안으로 들어왔다 */}
          <PressableScale style={styles.gearBtn} onPress={() => navigation.navigate('Settings')} to={0.9}>
            <Ionicons name="settings-outline" size={15} color={colors.creamSand} />
            <Text style={styles.gearText}>설정</Text>
          </PressableScale>
          <Brew mood="clipboard" size={96} />
        </View>
      </View>

      {/* [둥근 크림 시트] 홈의 바디 카드시트와 동일 — 카드를 감싸 얹는다 */}
      <View style={styles.body}>
        <View style={styles.deck} onLayout={onDeckLayout}>
          {cardH > 0 &&
            ITEMS.map((it, i) => {
              const s = scheme(it.color);
              return (
                <PressableScale
                  key={it.route}
                  style={[
                    styles.card,
                    {
                      height: cardH,
                      marginTop: i === 0 ? 0 : GAP,
                      backgroundColor: it.color,
                      borderColor: s.border,
                      borderWidth: s.border === 'transparent' ? 0 : 1,
                    },
                  ]}
                  onPress={() => navigation.navigate(it.route, it.params)}
                  to={0.97}
                >
                  <Text style={[styles.cardGhost, { color: s.ghost, fontSize: cardH * 0.72 }]}>
                    {String(i + 1).padStart(2, '0')}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardEn, { color: s.en }]}>{it.en}</Text>
                    <Text
                      style={[styles.cardLabel, { color: s.label, fontSize: Math.min(19, cardH * 0.26) }]}
                      numberOfLines={1}
                    >
                      {it.label}
                    </Text>
                    <Text style={[styles.cardDesc, { color: s.desc }]} numberOfLines={1}>
                      {it.desc}
                    </Text>
                  </View>
                  <View style={[styles.cardArrow, { backgroundColor: s.arrowBg }]}>
                    <Ionicons name="arrow-forward" size={15} color={s.arrowFg} />
                  </View>
                </PressableScale>
              );
            })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Svg 로딩 지연 중 어두운 광원을 채우기 위한 딥 브라운 루트
  root: { flex: 1, backgroundColor: '#1E1612' },

  // [홈 웰컴 헤더와 같은 톤] 딥브라운 오로라 위 밝은 텍스트 + 우측 마스코트.
  // 원안(마스코트 148·상하 여백 넉넉)보다 눌러서 카드가 쓸 높이를 확보했다.
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

  // [홈 바디 카드시트와 동일] 오로라 배경을 끊김 없이 감싸안는 둥근 크림 시트
  body: {
    flex: 1,
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  deck: { flex: 1 },

  // 기울임 없이 전부 수평. 높이는 시트 높이를 카드 수로 나눠 채운다.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: 16,
    overflow: 'hidden',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  cardGhost: {
    position: 'absolute',
    // 화살표(우측 16 + 지름 32)를 피해 그 왼쪽에 워터마크로 앉힌다 — 겹치면 둘 다 뭉개진다
    right: 56,
    top: -6,
    fontWeight: '900',
    letterSpacing: -4,
  },
  cardEn: { fontSize: 8.5, fontWeight: '800', letterSpacing: 1 },
  cardLabel: { fontWeight: '900', letterSpacing: -0.4, marginTop: 1 },
  cardDesc: { fontSize: 10.5, fontWeight: '500', marginTop: 2 },
  cardArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
