// 관리 허브 (⑥ 탭) — 에디토리얼: 기울여 겹쳐 흩뿌린 카드 덱 (그레이지 팔레트)
// 헤더는 홈(대시보드)과 동일한 딥브라운 오로라 배경 + 밝은 텍스트 + 둥근 크림 시트 구조로 통일.
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';

import { PressableScale } from '../../components/motion';
import { colors, spacing } from '../../theme';
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
const ITEMS: Item[] = [
  { label: '디저트 관리', en: 'DESSERT', desc: '소비기한 · 폐기 손실 · 마진 순위', color: '#6B4A32', route: 'Dessert' },
  { label: '스케줄·급여', en: 'PAYROLL', desc: '알바 스케줄 · 손익 정산', color: '#5B514C', route: 'Operation' },
  { label: '서류·세금', en: 'DOCUMENTS', desc: '문서 초안 · 세금 관리', color: '#9A8E82', route: 'Document' },
  { label: '판매 입력', en: 'SALES', desc: 'POS 연동 · 수동 입력', color: '#D1C6B9', route: 'SalesInput' },
  { label: '원가 분석', en: 'COST', desc: '메뉴별 원가율 진단', color: '#E1DCD7', route: 'Cost' },
  { label: '법령 검색', en: 'LAW', desc: '노무 · 위생 법령', color: '#F4F1EF', route: 'LawSearch' },
];

// 사진처럼 기울여 겹쳐 흩뿌리는 배치값 (회전 · 좌우 이동 · 겹침)
const LAYOUT = [
  { rotate: '-5deg', tx: -8, mt: 0 },
  { rotate: '4deg', tx: 14, mt: -18 },
  { rotate: '-3deg', tx: -14, mt: -20 },
  { rotate: '5deg', tx: 10, mt: -18 },
  { rotate: '-4deg', tx: -6, mt: -20 },
  { rotate: '3deg', tx: 12, mt: -20 },
];

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

  return (
    <View style={styles.root}>
      {/* [전역 오로라 배경] 홈(대시보드)과 동일 — 상단 딥브라운에서 하단 크림으로 자연스럽게 녹아든다 */}
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

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* 상단 바 — 설정 진입 (홈의 프로필 칩과 동일한 우상단 위치) */}
        <View style={styles.topBar}>
          <PressableScale style={styles.gearBtn} onPress={() => navigation.navigate('Settings')} to={0.9}>
            <Ionicons name="settings-outline" size={16} color={colors.creamSand} />
            <Text style={styles.gearText}>설정</Text>
          </PressableScale>
        </View>

        {/* 헤더 — 홈과 동일한 딥브라운 위 밝은 텍스트 + 관리 담당 브루(클립보드) */}
        <View style={styles.header}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={styles.bigTitle}>관리</Text>
            <Text style={styles.sub}>가게 운영에 필요한 모든 기능</Text>
          </View>
          <Brew mood="clipboard" size={148} style={styles.mascot} />
        </View>

        {/* [둥근 크림 시트] 홈의 바디 카드시트와 동일 — 카드 덱을 감싸 얹는다 */}
        <View style={styles.body}>
          {/* 기울여 겹쳐 흩뿌린 카드 덱 */}
          <View style={styles.deck}>
            {ITEMS.map((it, i) => {
            const lay = LAYOUT[i % LAYOUT.length];
            const s = scheme(it.color);
            return (
              <PressableScale
                key={it.route}
                style={[
                  styles.card,
                  {
                    backgroundColor: it.color,
                    borderColor: s.border,
                    borderWidth: s.border === 'transparent' ? 0 : 1.5,
                    marginTop: lay.mt,
                    zIndex: i + 1,
                    transform: [{ rotate: lay.rotate }, { translateX: lay.tx }],
                  },
                ]}
                onPress={() => navigation.navigate(it.route, it.params)}
                to={0.97}
              >
                <Text style={[styles.cardGhost, { color: s.ghost }]}>{String(i + 1).padStart(2, '0')}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardLabel, { color: s.label }]}>{it.label}</Text>
                  <Text style={[styles.cardDesc, { color: s.desc }]}>{it.desc}</Text>
                </View>
                <View style={[styles.cardArrow, { backgroundColor: s.arrowBg }]}>
                  <Ionicons name="arrow-forward" size={18} color={s.arrowFg} />
                </View>
              </PressableScale>
            );
          })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // [홈과 동일] Svg 로딩 지연 중 어두운 광원을 채우기 위한 딥 브라운 루트
  root: { flex: 1, backgroundColor: '#1E1612' },
  scroll: { flex: 1 },
  content: { paddingBottom: 0 },

  // 상단 바 — 우상단 설정 칩 (홈 프로필 칩 위치와 정렬)
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: 44,
    paddingHorizontal: spacing.globalPadding,
    marginBottom: -6,
  },
  gearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 999,
    paddingLeft: 9,
    paddingRight: 12,
    paddingVertical: 6,
    borderWidth: 0.8,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  gearText: { color: colors.creamSand, fontSize: 12, fontWeight: '700' },

  // [홈 웰컴 헤더와 동일 톤] 딥브라운 오로라 위 밝은 텍스트 + 우측 마스코트
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 14,
    paddingHorizontal: spacing.globalPadding,
  },
  mascot: { marginRight: 4 },
  bigTitle: { fontSize: 28, fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: '#D4C9C1', marginTop: 6, fontWeight: '500', letterSpacing: -0.2 },

  // [홈 바디 카드시트와 동일] 오로라 배경을 툭 끊김 없이 감싸안는 둥근 크림 시트
  body: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 36,
    borderTopRightRadius: 36,
    paddingHorizontal: spacing.globalPadding,
    paddingTop: spacing.verticalGap,
    paddingBottom: 110,
    gap: spacing.verticalGap,
  },

  deck: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 20 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 122,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingVertical: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  cardGhost: {
    position: 'absolute',
    right: 16,
    top: -8,
    fontSize: 82,
    fontWeight: '900',
    letterSpacing: -4,
  },
  cardLabel: { fontSize: 25, fontWeight: '900', letterSpacing: -0.5, marginTop: 4 },
  cardDesc: { fontSize: 12, fontWeight: '500', marginTop: 5 },
  cardArrow: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
