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
};

/** speechPlayer가 외부에 노출하는 인터페이스 */
export type SpeechPlayer = {
  /** 이어폰 착용 여부를 확인합니다 */
  isEarphoneConnected: () => Promise<EarphoneStatus>;
  /** 텍스트를 즉시 음성으로 읽습니다 (이어폰 미착용 시 스킵) */
  speak: (text: string) => Promise<void>;
  /** 큐에 추가하고 순서대로 재생합니다 (겹침 방지) */
  enqueue: (text: string, id?: string) => void;
  /** 큐 전체를 비우고 현재 재생도 중단합니다 */
  cancelAll: () => void;
  /** 현재 재생 중인지 여부 */
  isSpeaking: () => boolean;
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
