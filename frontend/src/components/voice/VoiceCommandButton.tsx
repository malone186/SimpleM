// 음성 명령 버튼 — 화면 우하단에 떠 있는 마이크 버튼 (3단계 UI 진입점)
//
// [한글 주석] 이 컴포넌트가 화면에 응답 문구를 "글자로도" 보여주는 이유:
// speechPlayer는 이어폰이 없으면 TTS를 건너뜁니다(2단계 설계).
// 확인 질문이 음성으로 안 들리는데 시스템은 답을 기다리는 상황을 막으려면,
// 확인 문구와 [확인]/[취소] 버튼이 반드시 화면에 보여야 합니다.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthContext';
import { usePreferences } from '../../preferences/PreferencesContext';
import { useVoiceCommand } from '../../lib/speech/useVoiceCommand';
import { colors, shadows, typography } from '../../theme';
import { toast } from '../toast';

export default function VoiceCommandButton() {
  const { token } = useAuth();
  const prefs = usePreferences();
  const vc = useVoiceCommand({
    onError: (message) => toast('🎤 음성 명령', message),
  });

  // 로그인 상태가 아니거나 음성 인식을 못 쓰는 환경(네이티브·미지원 브라우저)이면 숨깁니다.
  // 설정 > 알림 수신 설정의 '음성 비서 버튼 표시'를 꺼도 숨깁니다.
  if (!token || !vc.support.supported || !prefs.ready || !prefs.voiceAssistantEnabled) return null;

  const listening = vc.phase === 'listening';
  const processing = vc.phase === 'processing';
  const confirming = vc.phase === 'awaiting_confirmation';

  // 말풍선에 띄울 문구 — 말하는 중에는 중간 결과, 그 외에는 서버 응답
  const bubbleText = listening
    ? vc.partial || '듣고 있습니다…'
    : vc.response?.speech_text ?? '';

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {/* 상태 말풍선 */}
      {(listening || processing || confirming || !!vc.response) && !!bubbleText && (
        <View style={styles.bubble}>
          {!!vc.transcript && !listening && (
            <Text style={styles.heard}>“{vc.transcript}”</Text>
          )}
          <Text style={styles.bubbleText}>{bubbleText}</Text>

          {/* 파괴적 명령 확인 — 음성('네') 대신 버튼으로도 답할 수 있게 */}
          {confirming && (
            <View style={styles.actions}>
              <Pressable
                style={[styles.actionBtn, styles.confirmBtn]}
                onPress={() => vc.confirmPending()}
              >
                <Text style={styles.confirmLabel}>확인</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={() => vc.cancelPending()}>
                <Text style={styles.cancelLabel}>취소</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {/* 마이크 버튼 */}
      <Pressable
        style={[styles.mic, listening && styles.micActive]}
        disabled={processing}
        onPress={() => (listening ? vc.stopListening() : vc.startListening())}
        accessibilityLabel={listening ? '음성 인식 중지' : '음성 명령 시작'}
      >
        {processing ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : (
          <Text style={styles.micIcon}>{listening ? '⏹' : '🎤'}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 16,
    bottom: 88, // 하단 탭바 위로 띄움
    alignItems: 'flex-end',
    gap: 10,
  },
  bubble: {
    maxWidth: 260,
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 6,
    ...shadows.medium,
  },
  heard: {
    ...typography.L5,
    color: colors.mochaBrown,
    fontStyle: 'italic',
  },
  bubbleText: {
    ...typography.L4,
    color: colors.espressoBrown,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  confirmBtn: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  confirmLabel: {
    ...typography.L4,
    color: colors.white,
  },
  cancelLabel: {
    ...typography.L4,
    color: colors.mochaBrown,
  },
  mic: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.pointOrange,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.medium,
  },
  micActive: {
    backgroundColor: colors.trendGreenText,
  },
  micIcon: {
    fontSize: 22,
  },
});
