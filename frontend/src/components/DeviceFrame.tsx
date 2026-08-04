// 웹 미리보기용 디바이스 프레임 (Design Spec §2)
// 웹에서만 폰 목업 틀을 씌운다. 실제 iOS/Android 빌드에는 영향 없음.
//
// [반응형] 예전에는 420×850 을 못 박아서 브라우저 창이 작으면 프레임 아래위가 잘리고
// 스크롤도 되지 않았다. 이제 창 크기에 맞춰 프레임을 줄이고, 창이 폰만큼 좁아지면
// (모바일 브라우저·PWA) 목업을 걷어내고 화면을 꽉 채운다 — 실기기와 같은 조건으로 보이게.
import type { ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { colors } from '../theme';

// 목업 기준 크기 — 이 비율을 유지한 채 창에 맞춰 축소한다
const FRAME_WIDTH = 420;
const FRAME_HEIGHT = 850;
const STAGE_PADDING = 24;

export default function DeviceFrame({ children }: { children: ReactNode }) {
  const { width: winW, height: winH } = useWindowDimensions();

  // 네이티브(실기기)에서는 화면 자체가 기기이므로 프레임 없이 그대로 렌더
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  // 브라우저 창이 폰 크기라면 목업이 오히려 방해가 된다 — 그대로 꽉 채운다
  const fillsScreen = winW < FRAME_WIDTH + STAGE_PADDING * 2;

  // 창에 들어갈 만큼만 축소 (확대는 하지 않는다 — 목업이 실물보다 커지면 감이 어긋난다)
  const scale = fillsScreen
    ? 1
    : Math.min(
        1,
        (winW - STAGE_PADDING * 2) / FRAME_WIDTH,
        (winH - STAGE_PADDING * 2) / FRAME_HEIGHT,
      );

  // [한글 주석] 목업을 쓰든 안 쓰든 트리 구조(View > View > app-screen)는 절대 바꾸지 않는다.
  // 조건부로 구조를 갈아끼우면 React 가 children 을 통째로 리마운트해서
  // 창 크기를 바꾸거나 폴더블을 펼치는 순간 화면 상태(네비게이션·입력값)가 날아간다.
  // 달라지는 건 스타일뿐이다.
  return (
    <View style={[styles.stage, fillsScreen && styles.stageBare]}>
      <View
        style={[
          styles.device,
          fillsScreen
            ? styles.deviceBare
            : { width: FRAME_WIDTH, height: FRAME_HEIGHT, transform: [{ scale }] },
        ]}
      >
        {/* 상단 노치 — 실물 크기 모드에서는 감춘다 */}
        <View style={[styles.notch, fillsScreen && styles.hidden]} />
        {/* nativeID → 웹 DOM id. 설정의 글자크기(zoom)·다크모드(색반전) 적용 대상 */}
        <View nativeID="app-screen" style={styles.screen}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    backgroundColor: '#2A211C', // 무대 배경 (프레임을 돋보이게)
    alignItems: 'center',
    justifyContent: 'center',
    padding: STAGE_PADDING,
    overflow: 'hidden',
  },
  // 좁은 창(모바일 브라우저)에서는 목업 없이 실기기처럼 꽉 채운다
  stageBare: { padding: 0, backgroundColor: colors.creamSand },
  deviceBare: {
    width: '100%',
    height: '100%',
    borderRadius: 0,
    borderWidth: 0,
    shadowOpacity: 0,
  },
  hidden: { display: 'none' },
  device: {
    borderRadius: 50,
    borderWidth: 8,
    borderColor: colors.stone300,
    backgroundColor: colors.creamSand,
    overflow: 'hidden',
    position: 'relative',
    // 폰 목업 그림자
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.4,
    shadowRadius: 40,
  },
  notch: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    width: 150,
    height: 26,
    backgroundColor: '#000',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    zIndex: 10,
  },
  screen: { flex: 1 },
});
