// 첫 원가 세팅 가이드 (온보딩) — 신규 사장님을 "첫 원가"까지 순서대로 안내한다.
//
// 부품은 이미 다 있다: 영수증 OCR(→재료·단가 자동), 메뉴판 OCR(→메뉴·가격·레시피 자동).
// 없던 건 "재료 먼저 → 메뉴판 나중"이라는 순서를 신규 사장님에게 알려주는 진입로였다.
// 이 카드가 그 순서를 꿰어 화면으로 딥링크한다. 메뉴가 하나라도 생기면(세팅 완료) 사라진다.
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { apiFetch } from '../../lib/api/client';
import { Card } from '../ui';
import { PressableScale } from '../motion';
import { colors, typography } from '../../theme';

type Step = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  desc: string;
  route: string;
  done: boolean;
};

export default function SetupGuideCard({ refreshToken }: { refreshToken?: number }) {
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  const [state, setState] = useState<{ ingredients: number; menus: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const h = { Authorization: `Bearer ${token}` };
    // 재료·메뉴 개수만 본다. 실패해도(신규/네트워크) 0으로 두면 안내가 그대로 뜬다.
    Promise.all([
      apiFetch<unknown[]>('/api/v1/inventory/ingredients', { headers: h }).catch(() => []),
      apiFetch<unknown[]>('/api/v1/inventory/menus', { headers: h }).catch(() => []),
    ]).then(([ing, menus]) => {
      if (!cancelled) setState({ ingredients: (ing ?? []).length, menus: (menus ?? []).length });
    });
    return () => { cancelled = true; };
  }, [token, refreshToken]);

  // 아직 안 불렀으면 자리만 비우고, 메뉴가 이미 있으면(세팅 완료) 조용히 사라진다.
  if (!state || state.menus > 0) return null;

  const steps: Step[] = [
    { icon: 'receipt-outline', title: '재료 영수증 찍기',
      desc: '원두·우유 매입 영수증 → 재료·단가 자동 등록', route: 'Inventory', done: state.ingredients > 0 },
    { icon: 'restaurant-outline', title: '메뉴판 찍기',
      desc: '메뉴·가격·레시피를 자동으로 만들어요', route: 'Menu', done: state.menus > 0 },
    { icon: 'calculator-outline', title: '원가 확인',
      desc: '메뉴별 원가와 진짜 순이익이 바로 보여요', route: 'Cost', done: false },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card tone="cream">
      <View style={styles.head}>
        <Text style={styles.title}>☕ 3분이면 첫 원가가 보여요</Text>
        <Text style={styles.badge}>{doneCount}/3</Text>
      </View>
      <Text style={styles.hint}>
        사진 두 장만 찍으면 원가·순이익이 자동으로 나와요. 순서대로만 하면 됩니다.
      </Text>
      {steps.map((s, i) => (
        <PressableScale key={s.route} style={styles.step} onPress={() => navigation.navigate(s.route)} to={0.97}>
          <View style={[styles.num, s.done && styles.numDone]}>
            {s.done
              ? <Ionicons name="checkmark" size={15} color={colors.white} />
              : <Text style={styles.numText}>{i + 1}</Text>}
          </View>
          <Ionicons name={s.icon} size={20} color={s.done ? '#8AA88E' : colors.espressoBrown} style={{ marginRight: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.stepTitle, s.done && styles.stepTitleDone]}>{s.title}</Text>
            <Text style={styles.stepDesc}>{s.desc}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />
        </PressableScale>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { ...typography.L2, color: colors.espressoBrown, fontWeight: '800' },
  badge: { ...typography.L4, color: colors.pointOrange, fontWeight: '800' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginBottom: 12, lineHeight: 16 },
  step: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.white, borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: colors.mutedSand,
  },
  num: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.espressoBrown,
    alignItems: 'center', justifyContent: 'center',
  },
  numDone: { backgroundColor: '#3E9B4F' },
  numText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  stepTitle: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  stepTitleDone: { color: '#6E8A72' },
  stepDesc: { ...typography.L5, color: colors.mochaBrown, marginTop: 1 },
});
