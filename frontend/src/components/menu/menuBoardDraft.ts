// 메뉴판 초안을 다루는 순수 로직 (백엔드 B)
//
// 화면(MenuBoardScan.tsx)에서 떼어 둔 이유: 여기가 틀리면 원가가 조용히 어긋난다.
// 재료를 안 고른 줄이 섞여 들어가거나, 수량 파싱이 어긋나면 화면에는 그냥 숫자가
// 찍힐 뿐이라 사장님이 알 방법이 없다. 그래서 눈으로 확인하는 대신 테스트로 고정한다.
import type { MenuBoardCandidate, MenuBoardMenu, MenuBoardRecipe } from '../../lib/api/ocr';

/** 서버로 보낼 레시피 한 줄 */
export type ConfirmRecipe = { ingredient_id: number | null; quantity: number };
export type ConfirmMenu = { name: string; price: number | null; recipes: ConfirmRecipe[] };

/**
 * 수량 입력칸의 글자를 숫자로 바꾼다. 숫자가 아니면 null.
 *
 * null을 0이 아니라 null로 두는 이유: 0으로 저장하면 원가가 0원이 되어
 * '엄청 남는 메뉴'로 보인다. 값이 없으면 그 줄을 아예 빼는 게 맞다.
 */
export function parseQty(text: string): number | null {
  const clean = (text ?? '').replace(/[^0-9.]/g, '');
  const n = parseFloat(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 재료 후보를 골랐을 때 그 줄이 어떻게 바뀌는지.
 *
 * 재료만 바꾸고 양을 그대로 두면 안 된다 — 매장마다 세는 단위가 달라서
 * (kg으로 세는 원두 vs g으로 세는 원두) 같은 18이 1000배 차이가 난다.
 */
export function applyCandidate(recipe: MenuBoardRecipe, c: MenuBoardCandidate): MenuBoardRecipe {
  return { ...recipe, ingredient_id: c.id, unit: c.unit, quantity: c.quantity };
}

/** 아직 재료를 고르지 않은 줄 수 (고르기 전에는 원가에 안 들어간다) */
export function countPending(menu: MenuBoardMenu): number {
  return menu.recipes.filter((r) => r.ingredient_id == null && r.candidates.length > 1).length;
}

/** 재료는 정했는데 양이 비어 있는 줄 수 (환산 근거가 없어 사장님이 넣어야 하는 것) */
export function countNeedQty(menu: MenuBoardMenu): number {
  return menu.recipes.filter((r) => r.ingredient_id != null && !r.quantity).length;
}

/**
 * 서버로 보낼 payload를 만든다.
 *
 * 거르는 것:
 *  · 사장님이 체크를 푼 메뉴
 *  · 재료가 정해지지 않은 줄 (id 없이는 원가를 못 낸다)
 *  · 양이 비었거나 0 이하인 줄 (0으로 저장하면 원가가 0원이 된다)
 */
export function buildPayload(menus: MenuBoardMenu[], skip: Set<string>): ConfirmMenu[] {
  return menus
    .filter((m) => !skip.has(m.name))
    .map((m) => ({
      name: m.name,
      price: m.price,
      recipes: m.recipes
        .filter((r) => r.ingredient_id != null && r.quantity != null && r.quantity > 0)
        .map((r) => ({ ingredient_id: r.ingredient_id, quantity: r.quantity as number })),
    }));
}
