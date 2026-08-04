// 음성 비서(TTS) 공용 타입 — 플랫폼별 구현(speechPlayer.web.ts / speechPlayer.ts)이 공유
// (Metro가 웹에서는 .web.ts, 네이티브에서는 .ts를 자동 선택한다)

/** 음성 큐에 넣을 항목 1건 */
export type SpeechQueueItem = {
  /** 고유 ID (중복 방지용) */
  id: string;
  /** TTS로 읽어줄 한국어 텍스트 */
  text: string;
  /** 큐에 등록된 시각 */
  enqueuedAt: number;
};

/** 이어폰 감지 결과 */
export type EarphoneStatus = {
  /** 이어폰(외부 오디오 출력 장치)이 연결되어 있는지 */
  connected: boolean;
  /** 감지 실패 등의 사유 (없으면 null) */
  reason: string | null;
  /** 이 환경에서 출력 장치를 확인할 수 있는지.
   *  false면 connected 값은 "모름"이라는 뜻이다 — 이걸 "안 꽂힘"으로 오해해
   *  음성을 통째로 건너뛰던 버그가 있었다. 정책(audioPolicy)은 이때 재생을 택한다. */
  supported?: boolean;
  /** 어떤 경로로 감지했는지 — 'recent'는 최근 '꽂힘' 신호로 유지 중이라는 뜻 */
  via?: 'wired' | 'bluetooth' | 'recent' | null;
};

/** 지금 소리를 내도 되는지에 대한 판단 결과
 *
 * [한글 주석] 이어폰 연결 여부와 분리한 이유:
 * 웹은 출력 장치를 셀 수 있어 "이어폰 착용 시에만 재생"이 가능하지만,
 * 네이티브(앱)는 출력 장치를 감지할 방법이 없습니다.
 * 그래서 "이어폰이 꽂혔는가"(사실)와 "재생해도 되는가"(정책)를 나누고,
 * 정책 판단은 플랫폼별 구현이 각자 내리도록 했습니다.
 */
export type AudioPlaybackPermission = {
  /** 지금 음성을 재생해도 되는지 */
  allowed: boolean;
  /** 허용/차단 사유 (화면 안내 문구로 사용) */
  reason: string | null;
};

/** speak() 한 번에만 적용할 임시 설정 — 설정 화면 미리듣기용
 *
 * [한글 주석] 저장하기 전의 값으로 바로 들려주기 위한 통로다. 예를 들어 '말하는 속도'를
 * 고르는 순간 그 속도로 샘플이 나가야 사장님이 비교할 수 있다. 넘기지 않으면
 * 저장된 설정(voicePrefs)을 그대로 따른다. */
export type SpeakOptions = {
  /** 목소리 타입 (warm_female | friendly_male | calm_male | cute_child) */
  voiceType?: string;
  /** 말하는 속도 배율 (1.0 = 보통) */
  rate?: number;
};

/** speechPlayer가 외부에 노출하는 인터페이스 */
export type SpeechPlayer = {
  /** 이어폰 착용 여부를 확인합니다 (사실 확인 — 화면 표시용) */
  isEarphoneConnected: () => Promise<EarphoneStatus>;
  /** 지금 음성을 재생해도 되는지 판단합니다 (정책 — 호출부는 이것만 보면 됩니다) */
  canPlayAudio: () => Promise<AudioPlaybackPermission>;
  /** 텍스트를 즉시 음성으로 읽습니다 — 명시적 사용자 조작 전용(설정 '샘플 듣기' 등).
   *  이어폰 게이트 없이 바로 재생하며, options로 저장 전 목소리·속도 미리듣기를 지원.
   *  자동 알림은 이걸 쓰지 말고 enqueue(출력 정책 적용)를 쓸 것. */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** 큐에 추가하고 순서대로 재생합니다 (겹침 방지) */
  enqueue: (text: string, id?: string) => void;
  /** 큐 전체를 비우고 현재 재생도 중단합니다 */
  cancelAll: () => void;
  /** 현재 재생 중인지 여부 */
  isSpeaking: () => boolean;
  /** 서버 TTS(/chatbot/tts) 호출용 로그인 토큰 주입 — AlertsWatcher가 로그인/로그아웃 시 호출.
   *  토큰이 없으면(비로그인) 서버 TTS를 건너뛰고 기기 로컬 TTS로만 말한다. */
  setAuthToken: (token: string | null) => void;
  /** 이 환경이 AI 목소리(서버 TTS)를 쓰는지. false면 항상 기기 내장 목소리로 읽는다 —
   *  네이티브 빌드에 오디오 재생 모듈이 없어 서버가 준 WAV를 틀 수 없기 때문이다.
   *  설정 화면의 '분당 3회' 안내는 이게 true일 때만 의미가 있다. */
  usesAiVoice: () => boolean;
  /** AI 목소리(서버 TTS)가 분당 한도로 쉬고 있는 남은 초. 0이면 지금 AI 목소리로 나간다.
   *  무료 티어가 분당 3회라 그 이상은 기기 기본 목소리로 자동 전환된다 — 설정 화면 안내용.
   *  (usesAiVoice()가 false인 환경에서는 항상 0) */
  aiVoiceCooldownSec: () => number;
};


// ═══════════════════════════════════════════════════
// [한글 주석] STT(음성 → 텍스트) 공용 타입
// 구현: speechRecognizer.web.ts (브라우저) / speechRecognizer.ts (네이티브 no-op)
// ═══════════════════════════════════════════════════

/** 음성 인식 결과 1건 */
export type RecognitionResult = {
  /** 인식된 텍스트 */
  transcript: string;
  /** 브라우저가 보고한 인식 신뢰도 (0.0~1.0, 미제공 시 null) */
  confidence: number | null;
  /** 확정된 결과인지(true) 중간 결과인지(false) */
  isFinal: boolean;
};

/** 음성 인식 시작 시 넘기는 콜백 모음 */
export type RecognitionHandlers = {
  /** 중간 결과 — 말하는 도중 실시간으로 들어옵니다 (화면에만 표시하고 실행하지 마세요) */
  onPartial?: (result: RecognitionResult) => void;
  /** 확정 결과 — 이 값만 서버로 보내야 합니다 */
  onResult: (result: RecognitionResult) => void;
  /** 오류 발생 (마이크 권한 거부, 네트워크 등) */
  onError?: (message: string) => void;
  /** 인식 세션 종료 (성공/실패 무관하게 호출) */
  onEnd?: () => void;
};

/** 음성 인식 지원 여부 */
export type RecognitionSupport = {
  supported: boolean;
  /** 미지원 사유 (지원되면 null) */
  reason: string | null;
};

/** speechRecognizer가 외부에 노출하는 인터페이스 */
export type SpeechRecognizer = {
  /** 이 환경에서 음성 인식을 쓸 수 있는지 확인합니다 */
  isSupported: () => RecognitionSupport;
  /** 마이크를 열고 인식을 시작합니다 */
  start: (handlers: RecognitionHandlers) => void;
  /** 인식을 중단합니다 (지금까지 들은 내용은 확정 결과로 전달됨) */
  stop: () => void;
  /** 인식을 즉시 취소합니다 (결과 버림) */
  abort: () => void;
  /** 현재 듣고 있는지 여부 */
  isListening: () => boolean;
};
