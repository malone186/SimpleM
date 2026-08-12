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
  //
  // 값을 둘로 나눈 이유 — 부드러움이 여기서 갈린다:
  //   fade     투명도·이동. 네이티브 드라이버로 굴러서 JS가 바빠도 프레임이 안 깎인다.
  //   collapse 높이. 높이는 네이티브 드라이버가 못 다뤄서 매 프레임 레이아웃을 다시
  //            계산한다 — 리포트처럼 내용이 무거운 카드에선 이게 곧 끊김이다.
  //            그래서 '닫을 때만' 쓴다. 펼칠 때는 높이를 아예 건드리지 않아
  //            (내용 마운트·데이터 로딩과 겹치는 구간) 레이아웃 부담이 0이다.
  const fade = useRef(new Animated.Value(0)).current; // 0=숨김 1=보임 (네이티브)
  const collapse = useRef(new Animated.Value(1)).current; // 1=펼침 0=접힘 (닫을 때만)
  const [mounted, setMounted] = useState(false); // 닫힘 애니메이션이 끝날 때까지 유지
  const [closing, setClosing] = useState(false); // 이때만 높이를 제한한다
  // 접을 때 줄여 갈 높이. onLayout으로 재두고, 내용이 커지면 갱신한다.
  const contentH = useRef(0);

  useEffect(() => {
    if (open === null) return;
    if (open) {
      setClosing(false);
      setMounted(true);
      collapse.setValue(1);
      fade.setValue(0);
      // 애니메이션을 '내용이 마운트된 다음 프레임'에 시작한다.
      //
      // 리포트처럼 무거운 카드는 마운트+첫 렌더에만 0.5초쯤 잡아먹는데(실측 492ms),
      // 그 프레임에 애니메이션을 걸면 시작 구간이 통째로 건너뛰어져 '툭 끊긴' 것처럼
      // 보인다. 한 프레임 양보하면 무거운 일이 끝난 뒤 부드럽게 굴러간다.
      // (rAF 두 번 = 마운트 렌더가 화면에 그려진 뒤)
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          Animated.spring(fade, {
            toValue: 1, tension: 140, friction: 12, useNativeDriver: true,
          }).start();
        });
      });
      return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    } else if (mounted) {
      setClosing(true);
      // 접힘은 조금 빠르게 — 사라지는 건 기다릴 이유가 없다.
      // 투명도가 높이보다 먼저 빠져야 마지막 순간에 내용이 뭉개져 보이지 않는다.
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true,
        }),
        Animated.timing(collapse, {
          toValue: 0, duration: 220, easing: Easing.inOut(Easing.cubic), useNativeDriver: false,
        }),
      ]).start(({ finished }) => {
        if (finished) { setMounted(false); setClosing(false); } // 다 접힌 뒤에야 내용을 내린다
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fade, collapse]);

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
        // 바깥 = 높이(접을 때만). 안쪽 = 투명도·이동(네이티브).
        // 한 뷰에 섞으면 네이티브·JS 드라이버가 충돌해 RN이 거부한다 — 그래서 두 겹이다.
        <Animated.View
          style={closing && contentH.current > 0
            ? { height: collapse.interpolate({ inputRange: [0, 1], outputRange: [0, contentH.current] }), overflow: 'hidden' }
            : undefined}
        >
          <Animated.View
            style={{
              opacity: fade,
              transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
            }}
          >
            {/* 높이는 여기서 잰다 — 접히는 중에는 줄어드는 값이 잡히므로 그때는 무시한다 */}
            <View onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0 && !closing) contentH.current = h;
            }}>
              {children}
            </View>
          </Animated.View>
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
