// 웹 미리보기용 디바이스 프레임 (Design Spec §2)
// 웹에서만 420×850 폰 목업 틀을 씌운다. 실제 iOS/Android 빌드에는 영향 없음.
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { colors } from '../theme';

export default function DeviceFrame({ children }: { children: ReactNode }) {
  // 네이티브(실기기)에서는 화면 자체가 기기이므로 프레임 없이 그대로 렌더
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  return (
    <View style={styles.stage}>
      <View style={styles.device}>
        {/* 상단 노치 */}
        <View style={styles.notch} />
        <View style={styles.screen}>{children}</View>
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
    padding: 24,
  },
  device: {
    width: 420,
    height: 850,
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
