// 관리 허브 (⑥ 탭) — 에디토리얼: 기울여 겹쳐 흩뿌린 카드 덱 (그레이지 팔레트)
// 상단 딥브라운 헤더는 제거하고 항목 카드만 남긴다. 덱 높이를 실측해 카드 높이·겹침을
// 역산하므로 기기 높이와 무관하게 스크롤 없이 항상 한 화면에 들어온다.
import { useState } from 'react';
import { LayoutChangeEvent, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { PressableScale } from '../../components/motion';
import { colors } from '../../theme';

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
  // 설정은 원래 헤더의 톱니 칩으로만 들어갈 수 있었다 — 헤더를 없앴으므로 카드로 내려 진입 경로를 유지한다.
  { label: '설정', en: 'SETTINGS', desc: '계정 · 알림 · 약관', color: '#463C34', route: 'Settings' },
];

// 기울여 흩뿌리는 배치값 (회전 · 좌우 이동). 겹침(marginTop)은 높이에서 역산한다.
// 7장을 한 화면에 압축하므로 원안(±3~5도)보다 각을 낮춰야 아래 카드의 설명이 가리지 않고
// 회전한 모서리가 화면 밖으로 삐져나가지 않는다.
const MAX_TILT_DEG = 2;
const LAYOUT = [
  { deg: -2, tx: -5 },
  { deg: 1.6, tx: 7 },
  { deg: -1.2, tx: -7 },
  { deg: 2, tx: 5 },
  { deg: -1.6, tx: -4 },
  { deg: 1.2, tx: 6 },
  { deg: -1.6, tx: -5 },
];

// 카드 높이 대비 겹치는 비율 — 원본의 122px 카드에 -20px 겹침과 같은 밀도
const OVERLAP = 0.14;

// 마지막 '설정' 카드는 부가 기능이라 나머지보다 낮게 (본 항목들과 위계를 준다)
const LAST_RATIO = 0.72;

// 상태바(시계·카메라 노치)에 가리지 않을 만큼만 띄운다 — 그 이상의 여백은 두지 않는다.
// Android는 실측값이 있으므로 그대로 쓰고, iOS는 다이내믹 아일랜드까지 덮는 높이를 준다.
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
  const [deck, setDeck] = useState({ w: 0, h: 0 });
  const { w: deckW, h: deckH } = deck;

  const onDeckLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (height > 0 && (Math.abs(height - deckH) > 1 || Math.abs(width - deckW) > 1)) {
      setDeck({ w: width, h: height });
    }
  };

  // 겹쳐 쌓은 총 높이에서 기준 카드 높이를 역산한다.
  // 총높이 = H + (n-2)*(H - 겹침) + (H*LAST_RATIO - 겹침),  겹침 = H*OVERLAP
  //        = H * [1 + (n-2)*(1-OVERLAP) + LAST_RATIO - OVERLAP]
  const n = ITEMS.length;
  const denom = 1 + (n - 2) * (1 - OVERLAP) + LAST_RATIO - OVERLAP;
  const cardH = deckH > 0 ? Math.max(64, deckH / denom) : 0;
  const overlap = cardH * OVERLAP;

  // 기울어진 다음 카드는 한쪽 모서리가 들려 올라와 겹침보다 더 깊게 파고든다.
  // 그 침범 깊이(카드 반폭 × sin θ)만큼 아래 여백을 더 줘서 설명 문구를 위로 밀어 올린다.
  const tiltPad = (deckW / 2) * Math.sin((MAX_TILT_DEG * Math.PI) / 180);

  return (
    <View style={styles.root}>
      <View style={styles.deck} onLayout={onDeckLayout}>
        {cardH > 0 &&
          ITEMS.map((it, i) => {
            const lay = LAYOUT[i % LAYOUT.length];
            const s = scheme(it.color);
            const isLast = i === n - 1;
            const h = isLast ? cardH * LAST_RATIO : cardH; // 설정 카드만 낮게
            return (
              <PressableScale
                key={it.route}
                style={[
                  styles.card,
                  {
                    height: h,
                    paddingTop: h * 0.1,
                    // 마지막 카드는 위에 덮이는 카드가 없으므로 보정이 필요 없다
                    paddingBottom: isLast ? h * 0.1 : overlap + tiltPad,
                    backgroundColor: it.color,
                    borderColor: s.border,
                    borderWidth: s.border === 'transparent' ? 0 : 1.5,
                    marginTop: i === 0 ? 0 : -overlap,
                    zIndex: i + 1,
                    transform: [{ rotate: `${lay.deg}deg` }, { translateX: lay.tx }],
                  },
                ]}
                onPress={() => navigation.navigate(it.route, it.params)}
                to={0.97}
              >
                <Text style={[styles.cardGhost, { color: s.ghost, fontSize: h * 0.62, top: -h * 0.08 }]}>
                  {String(i + 1).padStart(2, '0')}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardEn, { color: s.en }]}>{it.en}</Text>
                  <Text
                    style={[styles.cardLabel, { color: s.label, fontSize: Math.min(24, h * 0.22) }]}
                    numberOfLines={1}
                  >
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
            );
          })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.creamSand,
    // 시계·카메라(상태바)에 가리지 않을 만큼만 띄우고 나머지 여백은 최소화
    paddingTop: TOP_INSET,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  // 회전한 카드의 모서리가 잘리지 않도록 좌우로 약간의 숨통만 준다
  deck: { flex: 1, paddingHorizontal: 6 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 14,
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
    fontWeight: '900',
    letterSpacing: -4,
  },
  cardEn: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1.1 },
  cardLabel: { fontWeight: '900', letterSpacing: -0.5, marginTop: 2 },
  cardDesc: { fontSize: 11.5, fontWeight: '500', marginTop: 3 },
  cardArrow: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
