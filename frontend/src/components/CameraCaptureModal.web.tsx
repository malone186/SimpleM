// 웹에서 앱 안에 카메라를 띄워 명세서를 바로 찍는 모달.
//
// 왜 필요한가: 네이티브는 expo-image-picker의 launchCameraAsync로 촬영이 되지만, 웹에는
// 그런 API가 없어서 '촬영' 버튼 자체를 숨겨 뒀었다. 그러면 웹에서 쓰는 사장님은 사진을
// 미리 찍어 앨범에 넣어 두는 수밖에 없다. getUserMedia로 앱 안에서 바로 찍게 한다.
//
// 명세서는 글씨를 읽어야 하므로 해상도를 최대한 요구하고(ideal 1920), 후면 카메라를
// 우선 요청한다(environment) — 노트북은 전면밖에 없으니 실패하면 아무 카메라나 쓴다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from './motion';
import { colors, typography } from '../theme';

export type CapturedPhoto = { uri: string; mimeType: string; fileName: string };

export default function CameraCaptureModal({
  visible,
  onClose,
  onCapture,
}: {
  visible: boolean;
  onClose: () => void;
  onCapture: (photo: CapturedPhoto) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      stop();
      return;
    }
    let cancelled = false;
    setError(null);

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('이 브라우저에서는 카메라를 쓸 수 없어요. 앨범이나 파일에서 골라 주세요.');
        return;
      }
      try {
        // 후면 카메라 우선 — 실패하면(노트북 등) 제약을 풀어 아무 카메라나 잡는다
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(
          name === 'NotAllowedError'
            ? '카메라 권한이 거부됐어요. 브라우저 주소창의 카메라 아이콘에서 허용해 주세요.'
            : name === 'NotFoundError'
              ? '연결된 카메라를 찾지 못했어요. 앨범이나 파일에서 골라 주세요.'
              : '카메라를 열지 못했어요. 앨범이나 파일에서 골라 주세요.',
        );
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, stop]);

  const shoot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // 서버가 어차피 1600px대로 줄여 인식하므로 품질 0.9면 충분하다
    const uri = canvas.toDataURL('image/jpeg', 0.9);
    stop();
    onCapture({ uri, mimeType: 'image/jpeg', fileName: 'statement.jpg' });
  };

  if (Platform.OS !== 'web') return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>명세서 촬영</Text>
            <PressableScale onPress={onClose} to={0.9} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={colors.espressoBrown} />
            </PressableScale>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="videocam-off-outline" size={26} color={colors.mochaBrown} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : (
            <>
              <View style={styles.videoWrap}>
                {/* 웹 전용 파일이라 DOM의 video 태그를 그대로 렌더한다 */}
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                {/* 명세서를 프레임 안에 맞추도록 안내하는 가이드 테두리 */}
                <View pointerEvents="none" style={styles.guide} />
              </View>
              <Text style={styles.hint}>
                명세서 전체가 화면 안에 들어오게 맞추고, 글씨가 또렷할 때 찍어 주세요.
              </Text>
            </>
          )}

          <View style={styles.actions}>
            <PressableScale style={styles.cancelBtn} onPress={onClose} to={0.97}>
              <Text style={styles.cancelText}>취소</Text>
            </PressableScale>
            {!error && (
              <PressableScale
                style={[styles.shootBtn, !ready && { opacity: 0.5 }]}
                onPress={shoot}
                disabled={!ready}
                to={0.96}
              >
                <Ionicons name="camera" size={17} color={colors.white} />
                <Text style={styles.shootText}>{ready ? '촬영' : '카메라 준비 중…'}</Text>
              </PressableScale>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(30,22,16,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: 16,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { ...typography.L3, color: colors.espressoBrown },
  videoWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#131315',
    position: 'relative',
  },
  guide: {
    position: 'absolute',
    top: '8%',
    left: '6%',
    right: '6%',
    bottom: '8%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.55)',
    borderRadius: 8,
    borderStyle: 'dashed',
  },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 10, lineHeight: 15 },
  errorBox: { alignItems: 'center', gap: 10, paddingVertical: 30, paddingHorizontal: 10 },
  errorText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.coffeeCream,
    borderRadius: 12,
    paddingVertical: 13,
  },
  cancelText: { ...typography.L4, color: colors.espressoBrown },
  shootBtn: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 12,
    paddingVertical: 13,
  },
  shootText: { ...typography.L4, color: colors.white },
});
