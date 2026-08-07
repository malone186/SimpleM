// 메뉴 개선안 화면의 판단 로직 — 무엇을 서버로 보낼지 정하는 곳.
//
// 화면 코드에 섞어 두면 눈으로밖에 확인할 수 없는데, 여기서 한 글자만 어긋나도
// 사장님이 손대지 않은 메뉴의 가격이 바뀐다(그리고 화면에는 그냥 숫자가 찍힐 뿐이다).
// 그래서 순수 함수로 떼어내 테스트로 고정한다 — menuBoardDraft.ts와 같은 이유.
import type { MenuChange, MenuReviewItem } from '../../lib/api/menuReview';

export type EditableMenu = { id: number; name: string; selling_price: number };

/** 숫자만 남긴다 ('4,500원' → 4500). 값이 없으면 0 */
export const toPrice = (raw: string | undefined | null): number =>
  Number(String(raw ?? '').replace(/[^\d]/g, '')) || 0;

/** 항목 식별자 — 같은 메뉴에 두 종류 변경이 함께 오지 않으므로 종류+이름이면 충분하다 */
export const keyOf = (c: MenuReviewItem) => `${c.kind}:${c.name}`;

/**
 * '직접 고치기' 화면의 입력 → 서버에 보낼 변경 목록.
 *
 * 넣지 않는 것:
 *  · 빈칸 (손대지 않은 메뉴)
 *  · 지금 가격과 같은 값 (바꾼 게 아니다)
 *  · 이름만 있고 가격이 없는 신메뉴 (원가·마진을 낼 수 없다)
 * 뺀 메뉴는 가격을 고쳤더라도 '빼기'가 이긴다 — 없앨 메뉴의 가격을 바꿀 이유가 없다.
 */
export function buildManualChanges(
  menus: EditableMenu[],
  prices: Record<number, string>,
  drop: Set<number>,
  newName: string,
  newPrice: string,
): MenuChange[] {
  const out: MenuChange[] = [];

  menus.forEach((m) => {
    if (drop.has(m.id)) {
      out.push({ kind: 'remove', name: m.name });
      return;
    }
    const raw = prices[m.id];
    if (raw == null || raw === '') return;
    const price = toPrice(raw);
    if (!price || price === m.selling_price) return;
    out.push({ kind: 'price', name: m.name, price });
  });

  const np = toPrice(newPrice);
  if (newName.trim() && np > 0) out.push({ kind: 'add', name: newName.trim(), price: np });
  return out;
}

/** 점검 결과 항목 → 반영 입력 한 줄 */
export function toChange(item: MenuReviewItem): MenuChange {
  if (item.kind === 'remove') return { kind: 'remove', name: item.name };
  if (item.kind === 'cost') return { kind: 'cost', name: item.name, cost: item.after?.cost ?? 0 };
  return { kind: item.kind, name: item.name, price: item.after?.price ?? 0 };
}

/**
 * 결과 화면에서 켜 둔 항목만 반영 목록으로.
 * 가격을 알 수 없는 항목은 거른다 — 0원으로 저장되면 매출이 0으로 잡힌다.
 */
export function buildApplyPayload(items: MenuReviewItem[], picked: Set<string>): MenuChange[] {
  return items
    .filter((i) => picked.has(keyOf(i)))
    .map(toChange)
    .filter((c) => c.kind === 'remove' || (c.price ?? c.cost ?? 0) > 0);
}

/** 결과를 처음 열 때 켜 둘 항목 — 사진에서 '추측'으로 잡힌 빼기는 꺼 둔다 */
export const initialPicked = (items: MenuReviewItem[]): Set<string> =>
  new Set(items.filter((i) => !i.uncertain).map(keyOf));
