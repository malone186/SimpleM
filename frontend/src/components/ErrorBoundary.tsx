// 화면 렌더링 오류 안전망 — 어느 화면 하나가 터져도 앱 전체가 흰 화면이 되지 않게 막는다.
// (예전엔 메뉴 관리처럼 렌더 중 예외가 나면 앱이 통째로 하얘져서 강제 종료 후 재실행해야 했다.)
// 오류를 잡으면 안내 카드를 띄우고, '다시 시도'를 누르면 화면 트리를 다시 마운트한다.
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from './motion';
import { colors, spacing, typography } from '../theme';

type Props = { children: ReactNode };
type State = { error: Error | null; runId: number };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, runId: 0 };

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 실기기에서 원인을 추적할 수 있도록 콘솔에 남긴다 (Metro / adb logcat에서 확인)
    console.error('화면 렌더링 오류:', error?.message, info?.componentStack);
  }

  // runId를 올려 자식 트리를 통째로 새로 마운트한다. 예전엔 error만 지웠는데,
  // 그러면 같은 상태의 같은 화면이 그대로 다시 그려져 즉시 또 터졌다 —
  // 이 경계가 앱 전체(RootNavigator)를 감싸고 있어서 강제 종료 말고는 빠져나갈 길이 없었다.
  reset = () => this.setState((s) => ({ error: null, runId: s.runId + 1 }));

  render() {
    const { error, runId } = this.state;
    if (!error) return <Fragment key={runId}>{this.props.children}</Fragment>;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>화면을 여는 중 문제가 생겼어요</Text>
          <Text style={styles.desc}>
            앱을 끄지 않아도 괜찮아요. 아래 버튼을 누르면 이 화면을 다시 엽니다.
          </Text>
          {/* [한글 주석] 사장님 화면에 'vh is not defined' 같은 영어 개발자 문구가 그대로 뜨면
              무슨 일인지 알 수도 없고 앱이 망가진 것처럼 보인다.
              원문은 componentDidCatch 에서 콘솔(Metro·logcat)에 남기고, 화면에는 쉬운 말만 둔다. */}
          <View style={styles.errBox}>
            <Text style={styles.errText}>
              이 화면의 정보를 불러오지 못했어요. 저장된 내용은 그대로 있습니다.
            </Text>
          </View>
          <PressableScale style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>다시 시도</Text>
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
