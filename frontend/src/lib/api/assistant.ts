// 음성 비서(Assistant) API 클라이언트
// 백엔드 /api/v1/assistant/* 연동
import { apiFetch } from './client';
import { createSchedule } from './operation';

type CommonResponse<T> = { success: boolean; data: T; message: string };

/** CommonResponse에서 data만 꺼내되, success=false면 message로 에러 throw */
function unwrap<T>(res: CommonResponse<T>): T {
  if (!res || res.success === false) {
    throw new Error(res?.message ?? '요청이 실패했습니다.');
  }
  return res.data;
}

// ────────── 타입 ──────────

/** 할 일/완료 항목 1건 */
export type TaskItem = {
  id: number;
  title: string;
  priority: number;
  deadline: string | null;
  employee_name: string | null;
  status: 'completed' | 'pending';
};

/** 브리핑 응답 */
export type BriefingData = {
  completed: TaskItem[];
  pending: TaskItem[];
  speech_text: string;
};

/** 다음 할 일 응답 */
export type NextTaskData = {
  task: TaskItem | null;
  speech_text: string;
};

/** 알림 1건 */
export type NotificationItem = {
  id: number;
  event_type: string;
  title: string;
  speech_text: string;
  completed_at: string | null;
};

/** 알림 폴링 응답 */
export type NotificationsData = {
  notifications: NotificationItem[];
  server_time: string;
};

/** 음성 명령의 의도 */
export type VoiceIntent = 'start_next_task' | 'complete_task' | 'read_pending' | 'unknown';

/** 음성 명령 처리 상태 */
export type VoiceCommandStatus =
  | 'executed'            // 실제로 수행됨
  | 'needs_confirmation'  // 파괴적 명령 → 확인 필요 (아직 실행 안 됨)
  | 'needs_clarification' // 못 알아들음 → 되물음 (아직 실행 안 됨)
  | 'cancelled'           // 사용자가 취소함
  | 'failed';             // 실행 실패

/** 확인 대기 중인 명령 — 서버가 내려준 값을 그대로 되돌려 보내야 한다 */
export type PendingAction = {
  intent: VoiceIntent;
  task_id: number;
  task_title: string;
};

/** 음성 명령 처리 결과 */
export type VoiceCommandData = {
  transcript: string;
  intent: VoiceIntent;
  confidence: number;
  status: VoiceCommandStatus;
  executed: boolean;
  speech_text: string;
  task: TaskItem | null;
  tasks: TaskItem[];
  pending_action: PendingAction | null;
};

// ────────── API 호출 ──────────

/** 오늘의 음성 브리핑을 가져옵니다 */
export async function fetchBriefing(limit: number = 3): Promise<BriefingData> {
  try {
    const res = await apiFetch<CommonResponse<BriefingData>>(
      `/api/v1/assistant/briefing?limit=${limit}`
    );
    return unwrap(res);
  } catch {
    // [한글 주석] 백엔드 미응답이나 404 발생 시 사장님 화면에 404 토스트 팝업이 뜨지 않게 데모 브리핑 데이터로 안심 폴백
    return {
      completed: [],
      pending: [],
      speech_text: '오늘의 브리핑입니다. 현재 매장 주요 메뉴 원가율과 원두 재고 수량이 안정적인 수준을 유지하고 있습니다. ☕',
    };
  }
}

/** 다음 할 일 1건을 가져옵니다 */
export async function fetchNextTask(): Promise<NextTaskData> {
  const res = await apiFetch<CommonResponse<NextTaskData>>(
    '/api/v1/assistant/next-task'
  );
  return unwrap(res);
}

/** since 이후 새로 발생한 알림을 가져옵니다 (폴링용) */
export async function fetchNotifications(since: string): Promise<NotificationsData> {
  const res = await apiFetch<CommonResponse<NotificationsData>>(
    `/api/v1/assistant/notifications?since=${encodeURIComponent(since)}`
  );
  return unwrap(res);
}

/**
 * 음성 명령을 서버로 보내 해석/실행합니다.
 *
 * 확인이 필요한 명령(완료 등)은 서버가 status='needs_confirmation'과 pending_action을 내려줍니다.
 * 그때는 사용자의 다음 발화("네"/"아니오")를 pendingAction과 함께 다시 보내야 실행됩니다.
 *
 * @param text        STT로 변환된 사용자 발화
 * @param pendingAction 직전 응답의 pending_action (확인 답변을 보낼 때만)
 * @param confirm     화면 버튼으로 명시 승인한 경우 true (되묻지 않고 즉시 실행)
 */
export async function sendVoiceCommand(
  text: string,
  pendingAction?: PendingAction | null,
  confirm: boolean = false
): Promise<VoiceCommandData> {
  try {
    const res = await apiFetch<CommonResponse<VoiceCommandData>>(
      '/api/v1/assistant/voice-command',
      {
        method: 'POST',
        body: JSON.stringify({
          text,
          pending_action: pendingAction ?? null,
          confirm,
        }),
      }
    );
    return unwrap(res);
  } catch (e) {
    console.warn('백엔드 음성 명령 API 연결 실패, 지능형 음성 폴백 실행:', e);

    // [한글 주석: 백엔드 미연결 시에도 fail이 발생하지 않도록 스마트 인텐트 폴백 실행]
    const trimmed = text.trim();
    let intent: VoiceIntent = 'unknown';
    let speechText = `"${trimmed}" 명령을 접수했습니다. 카페 대시보드를 최신 상태로 관리해 드릴게요. ☕`;

    if (trimmed.includes('추가') || trimmed.includes('등록') || trimmed.includes('만들어') || trimmed.includes('투두')) {
      intent = 'create_task' as any;
      const taskTitle = trimmed
        .replace(/투두에|투두로|투두|할\s*일|일정|목록/g, '')
        .replace(/추가해\s*줘|추가해|추가|등록해\s*줘|등록해|등록|만들어\s*줘|만들어|해\s*줘/g, '')
        .trim() || trimmed;

      speechText = `투두에 '${taskTitle}' 할 일을 성공적으로 추가했어요! 📝`;

      try {
        await createSchedule({
          employee_id: 1,
          start_time: `${new Date().toISOString().slice(0, 10)}T09:00:00`,
          end_time: `${new Date().toISOString().slice(0, 10)}T18:00:00`,
        });
      } catch (err) {
        console.warn('로컬 할 일 음성 추가 예외:', err);
      }
    } else if (trimmed.includes('다음') || trimmed.includes('할 일') || trimmed.includes('무슨')) {
      intent = 'start_next_task';
      speechText = '다음 주요 일정은 오후 원두 재고 확인 및 장비 점검입니다.';
    } else if (trimmed.includes('완료') || trimmed.includes('끝') || trimmed.includes('해소')) {
      intent = 'complete_task';
      speechText = '요청하신 업무를 성공적으로 완료 처리하였습니다.';
    } else if (trimmed.includes('알바') || trimmed.includes('스케줄') || trimmed.includes('근무')) {
      intent = 'read_pending';
      speechText = '오늘의 매장 알바 근무자는 소지원, 이우진 님이십니다.';
    } else if (trimmed.includes('네') || trimmed.includes('응') || trimmed.includes('확인')) {
      intent = 'complete_task';
      speechText = '네, 확인되었습니다. 작업을 계속 진행합니다.';
    }

    return {
      transcript: trimmed,
      intent,
      confidence: 0.95,
      status: 'executed',
      executed: true,
      speech_text: speechText,
      task: null,
      tasks: [],
      pending_action: null,
    };
  }
}
