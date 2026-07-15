// 공동 소유 — 초기 세팅 후 거의 고정, 변경 시 팀 공지
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // headers를 ...init보다 뒤에 두어야 한다 — 반대로 두면 호출자가 headers를 넘길 때
  // (undefined여도) Content-Type이 통째로 사라져 FastAPI가 body를 JSON으로 읽지 못한다(422)
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
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
