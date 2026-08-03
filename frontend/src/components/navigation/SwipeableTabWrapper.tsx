import React, { useRef } from 'react';
import { PanResponder, View, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { RootTabParamList } from '../../navigation/RootNavigator';

// [한글 주석: 하단 메인 4개 탭 순서 배열 — 좌/우 슬라이드 제스처 시 이 순서대로 넘겨집니다]
const TAB_ORDER: (keyof RootTabParamList)[] = ['Dashboard', 'Inventory', 'Chatbot', 'Management'];

interface SwipeableTabWrapperProps {
  children: React.ReactNode;
}

/**
 * [한글 주석: 터치 제스처를 감지하여 하단 탭을 좌/우 슬라이드로 넘겨주는 스와이프 래퍼]
 */
export function SwipeableTabWrapper({ children }: SwipeableTabWrapperProps) {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const route = useRoute();

  // [한글 주석: 제스처 이벤트 감지기 생성]
  const panResponder = useRef(
    PanResponder.create({
      // [한글 주석: 세로 스크롤과 충돌하지 않게 가로 슬라이드가 확실할 때만 제스처 가로채기]
      onMoveShouldSetPanResponder: (_, gestureState) => {
        const { dx, dy } = gestureState;
        // [한글 주석: 가로 이동 거리(dx)가 20px 이상이고, 세로 이동(dy)보다 1.5배 이상 클 때만 가로 슬라이드로 처리]
        return Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.5;
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx } = gestureState;
        const currentTabName = route.name as keyof RootTabParamList;
        const currentIndex = TAB_ORDER.indexOf(currentTabName);

        if (currentIndex === -1) return;

        // [한글 주석: 오른쪽 ➡️ 왼쪽 슬라이드 (손가락을 왼쪽으로 밈) : 다음 탭으로 이동]
        if (dx < -35 && currentIndex < TAB_ORDER.length - 1) {
          navigation.navigate(TAB_ORDER[currentIndex + 1]);
        }
        // [한글 주석: 왼쪽 ➡️ 오른쪽 슬라이드 (손가락을 오른쪽으로 밈) : 이전 탭으로 이동]
        else if (dx > 35 && currentIndex > 0) {
          navigation.navigate(TAB_ORDER[currentIndex - 1]);
        }
      },
    })
  ).current;

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
