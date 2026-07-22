// 네이티브(Android/iOS) 전용 STT — no-op 구현
// SpeechRecognition은 브라우저 전용 API이므로, 네이티브에서는 텍스트 입력으로 대체합니다.
// 향후 @react-native-voice/voice 등을 연동하면 이 파일만 교체하면 됩니다.
// (Metro가 네이티브에서는 .ts를, 웹에서는 .web.ts를 자동 선택)
import type {
  RecognitionHandlers,
  RecognitionSupport,
  SpeechRecognizer,
} from './speechTypes';

// [한글 주석] 네이티브에서는 음성 인식을 지원하지 않습니다.
// 화면은 isSupported()를 먼저 확인해 마이크 버튼 대신 텍스트 입력을 보여주면 됩니다.
function isSupported(): RecognitionSupport {
  return {
    supported: false,
    reason: '네이티브 앱에서는 아직 음성 입력을 지원하지 않습니다. 텍스트로 입력해 주세요.',
  };
}

function start(handlers: RecognitionHandlers): void {
  handlers.onError?.('네이티브 앱에서는 아직 음성 입력을 지원하지 않습니다.');
  handlers.onEnd?.();
}

function stop(): void {
  // no-op: 네이티브 STT 미구현
}

function abort(): void {
  // no-op: 네이티브 STT 미구현
}

function isListening(): boolean {
  return false;
}

const speechRecognizer: SpeechRecognizer = {
  isSupported,
  start,
  stop,
  abort,
  isListening,
};

export default speechRecognizer;
export { isSupported, start, stop, abort, isListening };
