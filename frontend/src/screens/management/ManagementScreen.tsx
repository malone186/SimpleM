// 관리 허브 (⑥ 탭) — 풀폭 카드가 세로로 겹쳐 쌓이는 덱 레이아웃
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { PressableScale } from '../../components/motion';
import { Screen, ScreenTitle } from '../../components/ui';
import { colors, typography } from '../../theme';

type Item = {
  label: string;
  desc: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  route: string;
  params?: object;
};

// 각 카드 색을 다르게 — 커피 톤에 어울리는 깊은 주얼톤 (크림 제목 잘 읽힘)
const ITEMS: Item[] = [
  { label: '재료 관리', desc: '재료 단가 · 변동 이력', icon: 'leaf-outline', color: '#4E3629', route: 'Ingredient' },
  { label: '메뉴 관리', desc: '레시피 구성 · 원가율', icon: 'cafe-outline', color: '#8C4A32', route: 'Menu' },
  { label: '판매 입력', desc: 'POS 연동 · 수동 입력', icon: 'add-circle-outline', color: '#3F5E47', route: 'SalesInput' },
  { label: '원가 분석', desc: '메뉴별 원가율 진단', icon: 'calculator-outline', color: '#2F5A66', route: 'Cost' },
  { label: '법령 검색', desc: '노무 · 위생 법령', icon: 'library-outline', color: '#3A3F63', route: 'LawSearch' },
  { label: '서류 자동화', desc: '문서 초안 생성', icon: 'documents-outline', color: '#5E3A52', route: 'Document' },
  { label: '세금 관리', desc: '부가세 · 원천세', icon: 'card-outline', color: '#7A5A2E', route: 'Tabs', params: { screen: 'Operation' } },
  { label: '스케줄·급여', desc: '알바 스케줄 · 정산', icon: 'people-outline', color: '#5C4032', route: 'Tabs', params: { screen: 'Operation' } },
];

export default function ManagementScreen() {
  const navigation = useNavigation<any>();

  return (
    <Screen>
      <ScreenTitle title="관리" subtitle="가게 운영에 필요한 모든 기능" />

      <View style={styles.stack}>
        {ITEMS.map((it, i) => (
          <PressableScale
            key={it.label}
            style={[styles.card, { backgroundColor: it.color }, i > 0 && styles.overlap]}
            onPress={() => navigation.navigate(it.route, it.params)}
            to={0.97}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{it.label}</Text>
              <Text style={styles.desc}>{it.desc}</Text>
            </View>
            <View style={styles.iconBox}>
              <Ionicons name={it.icon} size={26} color={colors.creamSand} />
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.55)" />
          </PressableScale>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { paddingBottom: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 104,
    borderRadius: 26,
    paddingHorizontal: 22,
    paddingVertical: 20,
    // 덱처럼 겹쳐 보이도록 위쪽 그림자
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8,
  },
  // 이전 카드 위로 살짝 겹치기
  overlap: { marginTop: -18 },
  label: { fontSize: 22, fontWeight: '900', color: colors.creamSand },
  desc: { ...typography.L5, color: 'rgba(255,255,255,0.72)', marginTop: 6 },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
