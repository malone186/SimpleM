// 음성 명령 버튼 — 화면 우하단에 떠 있는 마이크 버튼 (3단계 UI 진입점)
//
// [한글 주석] 이 컴포넌트가 화면에 응답 문구를 "글자로도" 보여주는 이유:
// speechPlayer는 이어폰이 없으면 TTS를 건너뜁니다(2단계 설계).
// 확인 질문이 음성으로 안 들리는데 시스템은 답을 기다리는 상황을 막으려면,
// 확인 문구와 [확인]/[취소] 버튼이 반드시 화면에 보여야 합니다.
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
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

  const [dismissed, setDismissed] = useState(false);

  const listening = vc.phase === 'listening';
  const processing = vc.phase === 'processing';
  const confirming = vc.phase === 'awaiting_confirmation';

  // [한글 주석: 음성 인식이 새로 시작되면 말풍선 닫힘 상태 리셋]
  useEffect(() => {
    if (listening) {
      setDismissed(false);
    }
  }, [listening]);

  // [한글 주석: 음성 응답 도착 시 6초 후 자동으로 말풍선이 스르륵 닫히는 오토 디스미스 타이머]
  useEffect(() => {
    if (vc.response && !confirming && !listening) {
      setDismissed(false);
      const timer = setTimeout(() => {
        setDismissed(true);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [vc.response, confirming, listening]);

  if (!token || !vc.support.supported || !prefs.ready || !prefs.voiceAssistantEnabled) return null;

  const bubbleText = listening
    ? vc.partial || '듣고 있습니다…'
    : vc.response?.speech_text ?? '';

  const closeBubble = () => {
    setDismissed(true);
    if (confirming) {
      vc.cancelPending();
    }
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {!dismissed && (listening || processing || confirming || !!vc.response) && !!bubbleText && (
        <View style={styles.bubble}>
          {/* [한글 주석: 우측 상단 앙증맞고 단정한 닫기 (X) 아이콘 버튼] */}
          <Pressable
            style={styles.closeBtn}
            hitSlop={8}
            onPress={closeBubble}
            accessibilityLabel="음성 안내 닫기"
          >
            <Ionicons name="close" size={16} color={colors.mochaBrown} />
          </Pressable>

          {!!vc.transcript && !listening && (
            <Text style={styles.heard}>“{vc.transcript}”</Text>
          )}
          <Text style={styles.bubbleText}>{bubbleText}</Text>

          {confirming && (
            <View style={styles.actions}>
              <Pressable
                style={[styles.actionBtn, styles.confirmBtn]}
                onPress={() => vc.confirmPending()}
              >
                <Text style={styles.confirmLabel}>확인</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={closeBubble}>
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
          <Ionicons name={listening ? 'square' : 'mic'} size={20} color={colors.white} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 16,
    bottom: 20, // [한글 주석: 하단 탭 바 위 딱 맞춰 안정적으로 배치되는 제자리 포지션]
    alignItems: 'flex-end',
    gap: 10,
  },
  bubble: {
    maxWidth: 265,
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 28,
    gap: 6,
    position: 'relative',
    ...shadows.medium,
  },
  closeBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    padding: 4,
    zIndex: 10,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.espressoBrown, // [한글 주석: 튀지 않고 차분한 딥 에스프레소 브라운 뱃지]
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    ...shadows.medium,
  },
  micActive: {
    backgroundColor: colors.trendGreenText,
  },
});
