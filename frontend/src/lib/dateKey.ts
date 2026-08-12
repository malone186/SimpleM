// 날짜 키(YYYY-MM-DD, 기기 시간대) — 한 곳에서 관리
//
// 같은 템플릿 리터럴이 화면 8곳에 복붙돼 있었고, 그중 하나가 UTC로 잘라
// (`toISOString().split('T')[0]` 류) KST 자정~09시에 어제로 분류되는 사고가 실제로
// 있었다 (대시보드 할 일 실종). 날짜 키가 필요하면 반드시 여기 것을 쓰자.

/** Date → 기기 시간대 기준 YYYY-MM-DD */
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO 타임스탬프(주로 UTC) → 기기 시간대의 YYYY-MM-DD.
 * split('T')[0]은 'UTC의 날짜'가 나온다 — KST 00:00~08:59가 어제로 밀린다. */
export function localDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.split('T')[0];
  return dateKey(d);
}

/** Date → 기기 시간대 기준 YYYY-MM (월 키) */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** YYYY-MM-DD → 기기 시간대의 그 날 자정 Date.
 * `new Date('2026-08-12')`는 **UTC 자정**으로 읽혀(=KST 09:00) 음수 시간대에서는
 * 하루 앞 날짜가 된다 — 요일 계산이 통째로 밀린다. 날짜 키에서 Date가 필요하면 이걸 쓰자. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return new Date(key); // 형식이 다르면 원래 동작으로 둔다
  return new Date(y, m - 1, d);
}
