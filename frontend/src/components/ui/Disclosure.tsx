// 접힘 카드 (애플식 progressive disclosure) — 홈의 부가 카드를 한 줄로 접어 둔다.
//
// 홈에 카드가 다섯 장씩 쌓이면 정작 매일 봐야 할 매출·할 일이 스크롤 밑으로 밀린다.
// 토스·애플식 해법: 화면의 주인공만 펼쳐 두고, 나머지는 제목 한 줄로 접어 필요할 때 연다.
// 펼침/접힘 선택은 기기에 저장돼 다음 방문에도 유지된다 — 매번 다시 여는 건 고문이다.
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, typography } from '../../theme';
import { glassSurface } from '../../theme/glass';
import { PressableScale, SlideUp } from '../motion';

export default function Disclosure({
  id,
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  /** 저장 키 — 화면 안에서 고유해야 한다 (예: 'home-deposit') */
  id: string;
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  // null = 저장된 선택을 읽는 중 (한 프레임) — 기본값으로 그렸다가 뒤집히면 화면이 덜컥인다
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(`disclosure:${id}`)
      .then((v) => setOpen(v === null ? defaultOpen : v === '1'))
      .catch(() => setOpen(defaultOpen));
  }, [id, defaultOpen]);

  if (open === null) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    AsyncStorage.setItem(`disclosure:${id}`, next ? '1' : '0').catch(() => {});
  };

  return (
    <View>
      <PressableScale
        onPress={toggle}
        style={[styles.row, open && styles.rowOpen]}
        to={0.98}
      >
        <Ionicons name={icon} size={14} color={colors.mochaBrown} />
        <Text style={[styles.title, open && styles.titleOpen]}>{title}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={colors.mochaBrown} />
      </PressableScale>
      {/* 펼칠 때만 마운트 — 접힌 카드는 데이터도 안 부른다 (홈 초기 로딩이 가벼워진다) */}
      {open && <SlideUp>{children}</SlideUp>}
    </View>
  );
}

const styles = StyleSheet.create({
  // 접힘: 유리 알약 한 줄. 펼침: 카드 위 섹션 라벨처럼 가볍게 (배경을 걷어 이중 카드를 피한다)
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: radius.sm,
    ...glassSurface,
  },
  rowOpen: {
    backgroundColor: 'transparent',
    paddingVertical: 6,
    paddingHorizontal: 4,
    ...(({ backdropFilter: undefined } as object)), // 웹 유리 블러도 함께 끈다
  },
  title: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  titleOpen: { color: colors.mochaBrown },
});
