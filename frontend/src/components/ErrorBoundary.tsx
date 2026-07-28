// 화면 렌더링 오류 안전망 — 어느 화면 하나가 터져도 앱 전체가 흰 화면이 되지 않게 막는다.
// (예전엔 메뉴 관리처럼 렌더 중 예외가 나면 앱이 통째로 하얘져서 강제 종료 후 재실행해야 했다.)
// 오류를 잡으면 안내 카드를 띄우고, '홈으로 돌아가기'를 누르면 화면 트리를 다시 마운트한다.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from './motion';
import { colors, spacing, typography } from '../theme';

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 실기기에서 원인을 추적할 수 있도록 콘솔에 남긴다 (Metro / adb logcat에서 확인)
    console.error('화면 렌더링 오류:', error?.message, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>화면을 여는 중 문제가 생겼어요</Text>
          <Text style={styles.desc}>
            앱을 끄지 않아도 괜찮아요. 아래 버튼을 누르면 홈 화면으로 돌아갑니다.
          </Text>
          <View style={styles.errBox}>
            <Text style={styles.errText}>{error?.message || String(error)}</Text>
          </View>
          <PressableScale style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>홈으로 돌아가기</Text>
          </PressableScale>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.globalPadding, gap: 12 },
  title: { ...typography.L1, color: colors.espressoBrown },
  desc: { ...typography.L4, color: colors.mochaBrown, lineHeight: 21 },
  errBox: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    padding: 14,
  },
  errText: { ...typography.L5, color: colors.mochaBrown },
  btn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  btnText: { ...typography.L3, color: colors.white },
});
