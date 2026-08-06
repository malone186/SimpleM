// [한글 주석: 상단 스와이프바(드래그 핸들)를 아래로 쓸어내려 닫을 수 있는 바텀시트 모달 컴포넌트]
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { useFrameSheetStyle } from '../DeviceFrame';
import { colors } from '../../theme';
import { useBottomInset } from '../../theme/responsive';

interface SwipeDownModalProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  sheetStyle?: ViewStyle;
}

export const SwipeDownModal: React.FC<SwipeDownModalProps> = ({
  visible,
  onClose,
  children,
  sheetStyle,
}) => {
  // [한글 주석] 기기 하단 시스템 바 실측값 + 현재 화면 높이 (회전·폴더블 전개 시 즉시 반영)
  const bottomInset = useBottomInset();
  const { height: windowHeight } = useWindowDimensions();
  // [한글 주석] 웹 목업 정렬 — Modal은 웹에서 document.body로 포털돼 DeviceFrame 밖에 그려진다.
  // 그대로 두면 앱 본문은 축소된 폰 목업 안에 있는데 시트만 원본 크기로 브라우저 바닥까지
  // 내려와 프레임을 뚫고 나가 잘려 보인다. 실기기·모바일 웹에서는 null이라 영향이 없다.
  const frameSheet = useFrameSheetStyle();
  // 모달 수직 이동 애니메이션 값 (0: 원래 위치, >0: 아래로 이동)
  const translateY = useRef(new Animated.Value(0)).current;

  // 모달이 열리고 닫힐 때 Y축 위치 초기화
  useEffect(() => {
    if (visible) {
      translateY.setValue(0);
    }
  }, [visible, translateY]);

  // [한글 주석: 상단 핸들바 드래그 제스처 처리기 (PanResponder)]
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 아래로 쓸어내리는 동작(dy > 3)일 때만 제스처 점유
        return gestureState.dy > 3;
      },
      onPanResponderMove: (_, gestureState) => {
        // 아래로 드래그할 때만 모달 이동 (위로는 이동 제한)
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        // 80px 이상 아래로 내렸거나 빠른 속도(vy > 0.5)로 아래로 튕긴 경우 닫기
        if (gestureState.dy > 80 || gestureState.vy > 0.5) {
          Animated.timing(translateY, {
            toValue: 400,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            onClose();
          });
        } else {
          // 미달 시 원위치로 부드럽게 스프링 복귀
          Animated.spring(translateY, {
            toValue: 0,
            bounciness: 4,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {/* 어두운 배경 클릭 시 닫기 */}
        <Pressable style={styles.backdrop} onPress={onClose} />

        {/* 제스처 적용 애니메이션 패널 */}
        <Animated.View
          style={[
            styles.sheet,
            sheetStyle,
            frameSheet,
            {
              // 드래그를 먼저 걸고 목업 축소를 나중에 겹친다 — 순서를 바꾸면 손가락은 100px
              // 내렸는데 시트는 축소 배율만큼만 따라와 드래그가 굼떠 보인다.
              transform: [{ translateY }, ...((frameSheet?.transform as any[]) ?? [])],
              // [한글 주석] 하단 제스처 바/홈 인디케이터 실측 여백 — 마지막 버튼이 시스템 바에 물리지 않게
              paddingBottom: 20 + bottomInset,
              // 세로가 짧은 기기(가로모드·플립 커버)에서 시트가 화면을 넘지 않게 상한을 둔다.
              // 웹 목업에서는 브라우저 높이가 아니라 프레임 내부 높이가 기준이다.
              maxHeight: frameSheet?.maxHeight ?? windowHeight * 0.9,
            },
          ]}
        >
          {/* [한글 주석: 상단 스와이프 바(드래그 핸들) 영역 - 터치 및 슬라이드 다운 제스처 반응] */}
          <View style={styles.handleWrapper} {...panResponder.panHandlers}>
            <View style={styles.handle} />
          </View>

          {children}
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    gap: 4,
  },
  handleWrapper: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 4,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.stone300,
  },
});

export default SwipeDownModal;
