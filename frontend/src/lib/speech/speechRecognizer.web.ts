// 웹(react-native-web) 전용 STT — 브라우저 내장 SpeechRecognition API
// (Metro가 웹에서는 .web.ts를 자동 선택)
//
// [한글 주석] 표준 이름은 SpeechRecognition이지만 Chrome/Edge/Safari는
// webkitSpeechRecognition이라는 접두어 붙은 이름으로 제공합니다. 둘 다 확인합니다.
// Firefox는 아직 미지원이라 isSupported()가 false를 반환합니다.
import type {
  RecognitionHandlers,
  RecognitionSupport,
  SpeechRecognizer,
} from './speechTypes';

// ═══════════════════════════════════════════════════
// [한글 주석] 브라우저 SpeechRecognition 타입 선언
// TypeScript 기본 lib에 포함되지 않아 필요한 부분만 최소한으로 정의합니다.
// ═══════════════════════════════════════════════════

type SpeechRecognitionAlternative = { transcript: string; confidence: number };
type SpeechRecognitionResultLike = {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};
type SpeechRecognitionErrorEventLike = { error: string; message?: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** 브라우저에서 SpeechRecognition 생성자를 찾아 반환합니다 (없으면 null) */
function _getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// [한글 주석] 브라우저 오류 코드를 사람이 이해할 수 있는 한국어로 변환
const _ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '마이크 사용 권한이 거부되었습니다. 브라우저 주소창의 자물쇠 아이콘에서 허용해 주세요.',
  'service-not-allowed': '브라우저가 음성 인식 서비스를 차단했습니다.',
  'no-speech': '음성이 감지되지 않았습니다. 다시 말씀해 주세요.',
  'audio-capture': '마이크를 찾을 수 없습니다. 장치 연결을 확인해 주세요.',
  network: '네트워크 오류로 음성 인식에 실패했습니다.',
  aborted: '음성 인식이 취소되었습니다.',
};

// ═══════════════════════════════════════════════════
// [한글 주석] 인식 세션 관리
// 동시에 두 개의 인식이 돌면 브라우저가 오류를 내므로,
// 항상 하나만 살아있도록 모듈 수준에서 관리합니다.
// ═══════════════════════════════════════════════════

let _recognition: SpeechRecognitionLike | null = null;
let _listening = false;

function isSupported(): RecognitionSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reason: '브라우저 환경이 아닙니다.' };
  }
  if (!_getRecognitionCtor()) {
    return {
      supported: false,
      reason: '이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.',
    };
  }
  // [한글 주석] 마이크는 보안 컨텍스트(HTTPS 또는 localhost)에서만 열립니다.
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return {
      supported: false,
      reason: '음성 인식은 HTTPS 또는 localhost에서만 사용할 수 있습니다.',
    };
  }
  return { supported: true, reason: null };
}

function isListening(): boolean {
  return _listening;
}

function start(handlers: RecognitionHandlers): void {
  const support = isSupported();
  if (!support.supported) {
    handlers.onError?.(support.reason ?? '음성 인식을 사용할 수 없습니다.');
    handlers.onEnd?.();
    return;
  }

  // 이미 듣고 있으면 이전 세션을 정리하고 새로 시작합니다.
  if (_listening) {
    abort();
  }

  const Ctor = _getRecognitionCtor();
  if (!Ctor) {
    handlers.onError?.('음성 인식을 초기화하지 못했습니다.');
    handlers.onEnd?.();
    return;
  }

  const recognition = new Ctor();
  recognition.lang = 'ko-KR';
  // continuous=false: 한 마디 말하고 멈추면 자동으로 끝납니다 (명령어 입력에 적합)
  recognition.continuous = false;
  // interimResults=true: 말하는 도중의 중간 결과도 받아 화면에 실시간 표시
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    _listening = true;
  };

  recognition.onresult = (event) => {
    // [한글 주석] resultIndex부터 새로 들어온 결과입니다.
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result[0];
      if (!alternative) continue;

      const payload = {
        transcript: alternative.transcript.trim(),
        confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null,
        isFinal: result.isFinal,
      };

      // 중간 결과는 화면 표시용, 확정 결과만 실행에 사용합니다.
      if (result.isFinal) {
        if (payload.transcript) handlers.onResult(payload);
      } else {
        handlers.onPartial?.(payload);
      }
    }
  };

  recognition.onerror = (event) => {
    const message = _ERROR_MESSAGES[event.error] ?? `음성 인식 오류: ${event.error}`;
    handlers.onError?.(message);
  };

  recognition.onend = () => {
    _listening = false;
    _recognition = null;
    handlers.onEnd?.();
  };

  _recognition = recognition;

  try {
    recognition.start();
  } catch (err) {
    // 이미 시작된 상태에서 start()를 부르면 InvalidStateError가 납니다.
    _listening = false;
    _recognition = null;
    handlers.onError?.(
      `음성 인식을 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`
    );
    handlers.onEnd?.();
  }
}

/** 인식을 정상 종료합니다 — 지금까지 들은 내용은 확정 결과로 전달됩니다 */
function stop(): void {
  if (_recognition) {
    _recognition.stop();
  }
}

/** 인식을 즉시 취소합니다 — 결과를 버립니다 */
function abort(): void {
  if (_recognition) {
    _recognition.abort();
    _recognition = null;
  }
  _listening = false;
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
