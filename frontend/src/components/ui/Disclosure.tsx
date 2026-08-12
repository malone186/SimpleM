// 접힘 카드 (애플식 progressive disclosure) — 홈의 부가 카드를 한 줄로 접어 둔다.
//
// 홈에 카드가 다섯 장씩 쌓이면 정작 매일 봐야 할 매출·할 일이 스크롤 밑으로 밀린다.
// 토스·애플식 해법: 화면의 주인공만 펼쳐 두고, 나머지는 제목 한 줄로 접어 필요할 때 연다.
// 펼침/접힘 선택은 기기에 저장돼 다음 방문에도 유지된다 — 매번 다시 여는 건 고문이다.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, typography } from '../../theme';
import { glassSurface } from '../../theme/glass';
import { PressableScale } from '../motion';

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

  // ── 펼침·접힘 애니메이션 ──────────────────────────────────────────────────
  // 예전엔 열 때만 SlideUp으로 마운트하고 닫을 때는 그냥 언마운트해서, 펼칠 때는
  // 스르륵 나오는데 접을 때는 카드가 뚝 사라졌다. 닫는 동안 내용을 살려 두고
  // 같은 곡선을 거꾸로 태워야 열고 닫는 느낌이 짝을 이룬다.
  const anim = useRef(new Animated.Value(0)).current; // 0=접힘 1=펼침
  const [mounted, setMounted] = useState(false); // 닫힘 애니메이션이 끝날 때까지 유지
  // 높이를 0으로 줄여야 아래 카드들이 따라 올라온다. 실제 높이는 onLayout으로 잰다
  // (내용이 데이터 로딩 후 커지므로 한 번 재고 끝이 아니라 바뀔 때마다 갱신한다).
  const [contentH, setContentH] = useState(0);

  useEffect(() => {
    if (open === null) return;
    if (open) {
      setMounted(true);
      // 펼침은 SlideUp과 같은 스프링 감각 (tension 140 / friction 12)
      Animated.spring(anim, {
        toValue: 1, tension: 140, friction: 12, useNativeDriver: false,
      }).start();
    } else {
      // 접힘은 조금 빠르게 — 사라지는 건 기다릴 이유가 없다
      Animated.timing(anim, {
        toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setMounted(false); // 다 접힌 뒤에야 내용을 내린다
      });
    }
  }, [open, anim]);

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
      {/* 펼칠 때만 마운트 — 접힌 카드는 데이터도 안 부른다 (홈 초기 로딩이 가벼워진다).
          닫는 중에는 애니메이션이 끝날 때까지 mounted로 남겨 둔다. */}
      {mounted && (
        <Animated.View
          style={{
            // 처음 펼칠 때는 높이를 아직 몰라 제한하지 않는다 (그 프레임엔 페이드·슬라이드만).
            // 한 번 재고 나면 그다음부터는 접힐 때 높이도 같이 줄어 아래 카드가 따라 올라온다.
            height: contentH > 0
              ? anim.interpolate({ inputRange: [0, 1], outputRange: [0, contentH] })
              : undefined,
            opacity: anim.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.6, 1] }),
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
            overflow: 'hidden',
          }}
        >
          <View onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            // 접히는 중(높이가 줄어드는 중)에 잰 값으로 덮어쓰면 애니메이션이 튄다
            if (h > 0 && h !== contentH && open) setContentH(h);
          }}>
            {children}
          </View>
        </Animated.View>
      )}
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
