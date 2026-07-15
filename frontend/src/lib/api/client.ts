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
    throw new Error(`API ${path} failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}
