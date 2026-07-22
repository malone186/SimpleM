// 음성 명령 훅 — 마이크(STT) → 백엔드 해석/실행 → 응답 음성 재생(TTS)까지 한 번에 묶는다.
//
// [한글 주석] 확인 절차가 이 훅의 핵심입니다.
// 서버는 세션을 기억하지 않으므로, "완료 처리할까요?"라는 응답에 딸려 온 pending_action을
// 이 훅이 들고 있다가, 사용자의 다음 발화("네")와 함께 그대로 돌려보냅니다.
// 그때 비로소 서버가 실행합니다. — 즉, 한 번의 발화로는 절대 완료 처리되지 않습니다.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  sendVoiceCommand,
  type PendingAction,
  type VoiceCommandData,
} from '../api/assistant';
import speechRecognizer from './speechRecognizer';
import { enqueue as speechEnqueue } from './speechPlayer';
import type { RecognitionSupport } from './speechTypes';

/** 음성 명령의 진행 단계 */
export type VoicePhase =
  | 'idle'                  // 대기 중
  | 'listening'             // 마이크로 듣는 중
  | 'processing'            // 서버가 해석/실행 중
  | 'awaiting_confirmation'; // 확인 답변을 기다리는 중 (파괴적 명령)

export type UseVoiceCommandOptions = {
  /** 서버 응답을 음성으로 읽어줄지 (기본 true) */
  speakResponse?: boolean;
  /** 명령이 실제로 수행된 뒤 호출 — 목록 새로고침 등에 사용 */
  onExecuted?: (result: VoiceCommandData) => void;
  /** 오류 발생 시 호출 (토스트 표시 등) */
  onError?: (message: string) => void;
};

export function useVoiceCommand(options: UseVoiceCommandOptions = {}) {
  const { speakResponse = true, onExecuted, onError } = options;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');       // 확정된 발화
  const [partial, setPartial] = useState('');             // 말하는 도중의 중간 결과
  const [response, setResponse] = useState<VoiceCommandData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [support] = useState<RecognitionSupport>(() => speechRecognizer.isSupported());

  // 확인 대기 중인 명령 — 다음 발화와 함께 서버로 되돌려 보낸다
  const pendingActionRef = useRef<PendingAction | null>(null);
  // 언마운트 후 setState 방지
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 화면을 떠나면 마이크를 확실히 닫는다
      speechRecognizer.abort();
    };
  }, []);

  const fail = useCallback(
    (message: string) => {
      if (!mountedRef.current) return;
      setError(message);
      setPhase(pendingActionRef.current ? 'awaiting_confirmation' : 'idle');
      onError?.(message);
    },
    [onError]
  );

  /**
   * 텍스트 한 줄을 서버로 보내 해석/실행합니다.
   * 음성뿐 아니라 텍스트 입력(네이티브 폴백)에서도 그대로 씁니다.
   */
  const submitText = useCallback(
    async (text: string, confirm: boolean = false) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (mountedRef.current) {
        setTranscript(trimmed);
        setPartial('');
        setError(null);
        setPhase('processing');
      }

      try {
        const result = await sendVoiceCommand(trimmed, pendingActionRef.current, confirm);
        if (!mountedRef.current) return;

        setResponse(result);

        // 확인이 필요한 명령이면 pending_action을 들고 있다가 다음 발화에 함께 보낸다.
        // 그 외의 상태(실행됨/취소됨/실패/되물음)에서는 확인 대기를 해제한다.
        if (result.status === 'needs_confirmation') {
          pendingActionRef.current = result.pending_action;
          setPhase('awaiting_confirmation');
        } else {
          pendingActionRef.current = null;
          setPhase('idle');
        }

        // 응답 문구를 음성으로 재생 (이어폰 미착용 시 speechPlayer가 알아서 건너뜀)
        if (speakResponse && result.speech_text) {
          speechEnqueue(result.speech_text, `voice-cmd-${result.status}-${Date.now()}`);
        }

        if (result.executed) {
          onExecuted?.(result);
        }
        return result;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [speakResponse, onExecuted, fail]
  );

  /** 마이크를 열고 한 마디를 듣습니다 (말을 멈추면 자동 종료) */
  const startListening = useCallback(() => {
    if (!support.supported) {
      fail(support.reason ?? '음성 인식을 사용할 수 없습니다.');
      return;
    }
    if (speechRecognizer.isListening()) return;

    setError(null);
    setPartial('');
    setPhase('listening');

    speechRecognizer.start({
      onPartial: (r) => {
        if (mountedRef.current) setPartial(r.transcript);
      },
      onResult: (r) => {
        // 확정된 발화만 서버로 보낸다 (중간 결과로 실행하면 오작동한다)
        submitText(r.transcript);
      },
      onError: (message) => {
        fail(message);
      },
      onEnd: () => {
        if (!mountedRef.current) return;
        // 서버 처리 중이면 그 상태를 유지한다
        setPhase((prev) => (prev === 'listening' ? (pendingActionRef.current ? 'awaiting_confirmation' : 'idle') : prev));
        setPartial('');
      },
    });
  }, [support, submitText, fail]);

  /** 듣기를 정상 종료합니다 (지금까지 들은 내용은 처리됨) */
  const stopListening = useCallback(() => {
    speechRecognizer.stop();
  }, []);

  /** 확인 대기 중인 명령을 버튼으로 승인합니다 (음성 대신 화면에서 확인) */
  const confirmPending = useCallback(async () => {
    const action = pendingActionRef.current;
    if (!action) return;
    return submitText('네', true);
  }, [submitText]);

  /** 확인 대기 중인 명령을 취소합니다 */
  const cancelPending = useCallback(() => {
    pendingActionRef.current = null;
    speechRecognizer.abort();
    if (!mountedRef.current) return;
    setPhase('idle');
    setResponse(null);
    setPartial('');
  }, []);

  return {
    /** 현재 단계 */
    phase,
    /** 마이크가 열려 있는지 */
    isListening: phase === 'listening',
    /** 확인 답변을 기다리는 중인지 */
    isAwaitingConfirmation: phase === 'awaiting_confirmation',
    /** 확인 대기 중인 명령 (없으면 null) */
    pendingAction: pendingActionRef.current,
    /** 확정된 발화 */
    transcript,
    /** 말하는 도중의 중간 결과 (화면 표시용) */
    partial,
    /** 마지막 서버 응답 */
    response,
    /** 마지막 오류 메시지 */
    error,
    /** 이 환경에서 음성 인식이 가능한지 */
    support,
    startListening,
    stopListening,
    submitText,
    confirmPending,
    cancelPending,
  };
}

export default useVoiceCommand;
