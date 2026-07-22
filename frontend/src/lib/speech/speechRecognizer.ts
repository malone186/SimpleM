// 네이티브(Android/iOS) 전용 STT — expo-speech-recognition 기반
// (Metro가 네이티브에서는 .ts를, 웹에서는 .web.ts를 자동 선택)
//
// [한글 주석] Android는 기기 내장 SpeechRecognizer(구글 음성 서비스),
// iOS는 SFSpeechRecognizer를 사용합니다. 웹 구현(speechRecognizer.web.ts)과
// 같은 인터페이스를 유지하므로 화면 코드는 플랫폼을 구분할 필요가 없습니다.
//
// Expo Go에는 이 네이티브 모듈이 없으므로 require가 실패하면
// isSupported()가 false를 반환해 화면이 텍스트 입력 폴백을 보여줍니다.
// (개발 빌드에서만 음성 입력이 활성화됩니다 — BLE·이어폰 감지와 동일한 정책)
import type {
  RecognitionHandlers,
  RecognitionSupport,
  SpeechRecognizer,
} from './speechTypes';

// 네이티브 모듈이 없으면 import 시점에 throw하므로 require를 try/catch로 감쌉니다.
// (speechPlayer.ts의 DeviceInfo 로드와 같은 패턴)
type NativeModuleLike = {
  start: (options: Record<string, unknown>) => void;
  stop: () => void;
  abort: () => void;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  isRecognitionAvailable: () => boolean;
  addListener: (event: string, cb: (payload: any) => void) => { remove: () => void };
};

let SpeechModule: NativeModuleLike | null = null;
try {
  const mod = require('expo-speech-recognition');
  SpeechModule = mod?.ExpoSpeechRecognitionModule ?? null;
} catch {
  SpeechModule = null;
}

// [한글 주석] 네이티브 오류 코드를 사람이 이해할 수 있는 한국어로 변환
// (웹 구현의 _ERROR_MESSAGES와 코드 체계가 같아 문구를 맞춰 둡니다)
const _ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '마이크 사용 권한이 거부되었습니다. 휴대폰 설정 > 앱 > 브루노트에서 마이크를 허용해 주세요.',
  'service-not-allowed': '이 기기에서 음성 인식 서비스를 사용할 수 없습니다. 구글 앱(음성 서비스)이 설치되어 있는지 확인해 주세요.',
  'language-not-supported': '이 기기의 음성 인식이 한국어를 지원하지 않습니다.',
  'no-speech': '음성이 감지되지 않았습니다. 다시 말씀해 주세요.',
  'audio-capture': '마이크를 사용할 수 없습니다. 다른 앱이 마이크를 쓰고 있지 않은지 확인해 주세요.',
  network: '네트워크 오류로 음성 인식에 실패했습니다.',
  interrupted: '전화·알람 등으로 음성 인식이 중단되었습니다.',
  aborted: '음성 인식이 취소되었습니다.',
  busy: '음성 인식기가 사용 중입니다. 잠시 후 다시 시도해 주세요.',
};

// ═══════════════════════════════════════════════════
// [한글 주석] 인식 세션 관리 — 웹 구현과 동일하게 항상 하나만 살아있도록
// 모듈 수준에서 관리합니다. 이벤트 구독은 세션 시작 시 걸고 종료 시 해제합니다.
// ═══════════════════════════════════════════════════

let _listening = false;
let _subscriptions: { remove: () => void }[] = [];

function _clearSubscriptions(): void {
  for (const sub of _subscriptions) {
    try {
      sub.remove();
    } catch {
      // 이미 해제된 구독은 무시
    }
  }
  _subscriptions = [];
}

function isSupported(): RecognitionSupport {
  if (!SpeechModule) {
    return {
      supported: false,
      reason: '이 빌드에는 음성 인식 모듈이 없습니다. (Expo Go — 개발 빌드에서 사용할 수 있어요)',
    };
  }
  try {
    if (!SpeechModule.isRecognitionAvailable()) {
      return {
        supported: false,
        reason: '이 기기에서 음성 인식을 사용할 수 없습니다. 구글 앱(음성 서비스)을 확인해 주세요.',
      };
    }
  } catch {
    return { supported: false, reason: '음성 인식 상태를 확인하지 못했습니다.' };
  }
  return { supported: true, reason: null };
}

function isListening(): boolean {
  return _listening;
}

function start(handlers: RecognitionHandlers): void {
  const support = isSupported();
  if (!support.supported || !SpeechModule) {
    handlers.onError?.(support.reason ?? '음성 인식을 사용할 수 없습니다.');
    handlers.onEnd?.();
    return;
  }
  const module = SpeechModule;

  // 이미 듣고 있으면 이전 세션을 정리하고 새로 시작합니다.
  if (_listening) {
    abort();
  }

  // [한글 주석] 권한 요청이 비동기라 start()는 즉시 반환하고 내부에서 이어갑니다.
  // (인터페이스가 sync void인 것은 웹 구현과 맞추기 위함)
  (async () => {
    let granted = false;
    try {
      const res = await module.requestPermissionsAsync();
      granted = !!res?.granted;
    } catch {
      granted = false;
    }
    if (!granted) {
      handlers.onError?.(_ERROR_MESSAGES['not-allowed']);
      handlers.onEnd?.();
      return;
    }

    _clearSubscriptions();

    _subscriptions.push(
      module.addListener('start', () => {
        _listening = true;
      }),
    );

    _subscriptions.push(
      module.addListener('result', (event: { isFinal: boolean; results: { transcript: string; confidence: number }[] }) => {
        const alternative = event?.results?.[0];
        if (!alternative) return;
        const payload = {
          transcript: (alternative.transcript ?? '').trim(),
          confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null,
          isFinal: !!event.isFinal,
        };
        // 중간 결과는 화면 표시용, 확정 결과만 실행에 사용합니다. (웹과 동일)
        if (payload.isFinal) {
          if (payload.transcript) handlers.onResult(payload);
        } else {
          handlers.onPartial?.(payload);
        }
      }),
    );

    _subscriptions.push(
      module.addListener('error', (event: { error: string; message?: string }) => {
        // abort()로 취소한 경우는 사용자가 의도한 것이므로 오류로 알리지 않습니다.
        if (event?.error === 'aborted') return;
        const message = _ERROR_MESSAGES[event?.error] ?? `음성 인식 오류: ${event?.message || event?.error}`;
        handlers.onError?.(message);
      }),
    );

    _subscriptions.push(
      module.addListener('end', () => {
        _listening = false;
        _clearSubscriptions();
        handlers.onEnd?.();
      }),
    );

    try {
      module.start({
        lang: 'ko-KR',
        // continuous=false: 한 마디 말하고 멈추면 자동으로 끝납니다 (명령어 입력에 적합)
        continuous: false,
        // interimResults=true: 말하는 도중의 중간 결과도 받아 화면에 실시간 표시
        interimResults: true,
        maxAlternatives: 1,
      });
    } catch (err) {
      _listening = false;
      _clearSubscriptions();
      handlers.onError?.(
        `음성 인식을 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
      handlers.onEnd?.();
    }
  })();
}

/** 인식을 정상 종료합니다 — 지금까지 들은 내용은 확정 결과로 전달됩니다 */
function stop(): void {
  if (!SpeechModule) return;
  try {
    SpeechModule.stop();
  } catch {
    // 세션이 없을 때의 stop은 무시
  }
}

/** 인식을 즉시 취소합니다 — 결과를 버립니다 */
function abort(): void {
  if (SpeechModule) {
    try {
      SpeechModule.abort();
    } catch {
      // 세션이 없을 때의 abort는 무시
    }
  }
  _listening = false;
  _clearSubscriptions();
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
