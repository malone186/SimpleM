// 브리핑 재생 훅 — GET /briefing 의 speech_text를 브라우저 TTS로 읽어준다.
//
// [한글 주석] 왜 버튼(사용자 조작)으로만 재생하는가:
// 브라우저는 사용자가 화면을 한 번도 건드리지 않은 상태에서 speechSynthesis.speak()를
// 호출하면 자동재생 정책으로 조용히 차단합니다(Chrome 등).
// 그래서 앱 진입 시 자동 재생이 아니라, 버튼을 누른 시점에 재생합니다.
//
// 재생은 speechPlayer.enqueue를 씁니다 — 알림(AlertsWatcher)과 같은 큐를 공유해야
// 브리핑과 완료 알림이 동시에 터져 겹치는 일이 없습니다.
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchBriefing, type BriefingData } from '../api/assistant';
import { enqueue as speechEnqueue, canPlayAudio } from './speechPlayer';
import type { AudioPlaybackPermission } from './speechTypes';

export type UseBriefingOptions = {
  /** 음성 문단에 나열할 최대 작업 건수 (서버 limit 파라미터) */
  limit?: number;
  /** 오류 발생 시 호출 */
  onError?: (message: string) => void;
};

export function useBriefing(options: UseBriefingOptions = {}) {
  const { limit = 3, onError } = options;

  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 재생 허용 여부 — 음성이 나갔는지/텍스트만 보여줬는지 화면에 알리기 위해 보관
  const [permission, setPermission] = useState<AudioPlaybackPermission | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 브리핑을 불러와 화면에 표시하고, 이어폰 착용 중이면 음성으로도 읽어줍니다. */
  const play = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const briefing = await fetchBriefing(limit);
      if (!mountedRef.current) return;
      setData(briefing);

      // 재생 허용 여부 확인 — 불허면 음성은 생략하고 텍스트만 남깁니다.
      const status = await canPlayAudio();
      if (!mountedRef.current) return;
      setPermission(status);

      if (status.allowed && briefing.speech_text) {
        // 알림과 같은 큐에 넣어 순서대로 재생 (겹침 방지)
        speechEnqueue(briefing.speech_text, 'briefing');
      }

      return briefing;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (mountedRef.current) setError(message);
      onError?.(message);
      return undefined;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [limit, loading, onError]);

  /** 표시 중인 브리핑을 닫습니다 */
  const dismiss = useCallback(() => {
    setData(null);
    setError(null);
  }, []);

  return {
    /** 브리핑 데이터 (완료/대기 목록 + speech_text) */
    data,
    /** 불러오는 중 */
    loading,
    /** 오류 메시지 */
    error,
    /** 마지막 재생 시점의 재생 허용 여부 (null = 아직 확인 전) */
    permission,
    /** 음성이 실제로 재생됐는지 (불허면 false → 텍스트만 표시됨) */
    spoken: !!permission?.allowed,
    play,
    dismiss,
  };
}

export default useBriefing;
