// 공동 소유 — 초기 세팅 후 거의 고정, 변경 시 팀 공지
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

// [세션 만료 전파] 인증이 붙은 요청이 401을 받으면 여기 등록된 리스너(AuthContext)에게
// 알린다 — 예전엔 전역 처리가 없어 토큰이 죽으면 화면마다 제각각 에러만 띄우고,
// 사용자가 직접 로그아웃 버튼을 찾아야 했다. 로그인/공개 경로의 401은 제외한다.
type AuthExpiredListener = () => void;
let authExpiredListener: AuthExpiredListener | null = null;
export function onAuthExpired(listener: AuthExpiredListener | null) {
  authExpiredListener = listener;
}
const AUTH_EXEMPT = /\/auth\/(login|signup|find-email|reset-password)|\/staff-accounts\/login/;

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // headers를 ...init보다 뒤에 두어야 한다 — 반대로 두면 호출자가 headers를 넘길 때
  // (undefined여도) Content-Type이 통째로 사라져 FastAPI가 body를 JSON으로 읽지 못한다(422)
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    // 인증 요청의 401 = 세션 만료 — AuthContext가 세션을 정리하고 로그인 화면으로 보낸다
    if (res.status === 401 && !AUTH_EXEMPT.test(path)) {
      const hasAuth = !!(init?.headers && 'Authorization' in (init.headers as Record<string, string>));
      if (hasAuth && authExpiredListener) authExpiredListener();
    }
    // 서버가 보낸 상세 오류(detail)를 최대한 뽑아 메시지에 포함
    let detail = '';
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') detail = body.detail;
      else if (Array.isArray(body?.detail)) {
        // FastAPI 422 검증 오류: [{loc, msg}] → "필드: 메시지"
        detail = body.detail
          .map((d: { loc?: (string | number)[]; msg?: string }) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg ?? ''}`)
          .join(', ');
      } else if (body) detail = JSON.stringify(body);
    } catch {
      // 본문 없음/파싱 실패는 무시
    }
    throw new Error(detail ? `${res.status} · ${detail}` : `API ${path} failed: ${res.status}`);
  }

  // 204 No Content 등 빈 응답 대응
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
