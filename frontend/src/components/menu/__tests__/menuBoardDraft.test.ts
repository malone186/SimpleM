/**
 * 메뉴판 초안 로직 — 여기가 틀리면 원가가 조용히 어긋난다.
 *
 * 이 화면에서 저장되는 값은 곧 메뉴 원가가 된다. 재료를 안 고른 줄이 섞여 들어가거나
 * 수량이 0으로 들어가면, 화면에는 그냥 숫자가 찍힐 뿐이라 사장님이 틀린 줄 알 방법이 없다
 * ("원가율 0%"는 오히려 좋아 보인다). 그래서 눈으로 보는 대신 여기서 고정한다.
 */
import {
  applyCandidate,
  buildPayload,
  countNeedQty,
  countPending,
  parseQty,
} from '../menuBoardDraft';
import type { MenuBoardCandidate, MenuBoardMenu, MenuBoardRecipe } from '../../../lib/api/ocr';

const recipe = (over: Partial<MenuBoardRecipe> = {}): MenuBoardRecipe => ({
  ingredient: '원두',
  preset_quantity: 18,
  preset_unit: 'g',
  quantity: 0.018,
  unit: 'kg',
  ingredient_id: 1,
  candidates: [{ id: 1, name: '에티오피아 원두', unit: 'kg', quantity: 0.018 }],
  ...over,
});

const menu = (over: Partial<MenuBoardMenu> = {}): MenuBoardMenu => ({
  name: '아메리카노',
  price: 4500,
  exists: false,
  recipe_source: 'preset',
  recipes: [recipe()],
  ...over,
});

// ─── 수량 입력 ────────────────────────────────────────────────────────────

describe('parseQty', () => {
  it('소수를 읽는다 — 원두는 0.018kg처럼 소수가 필요하다', () => {
    expect(parseQty('0.018')).toBeCloseTo(0.018);
    expect(parseQty('200')).toBe(200);
  });

  it('빈칸·글자는 null (0이 아니다)', () => {
    // 0으로 바꾸면 원가가 0원이 되어 '엄청 남는 메뉴'로 보인다
    expect(parseQty('')).toBeNull();
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('.')).toBeNull();
  });

  it('0은 null', () => {
    expect(parseQty('0')).toBeNull();
    expect(parseQty('0.0')).toBeNull();
  });

  it('부호는 걷어낸다 — 입력칸도 부호를 지우므로 화면과 저장값이 같아진다', () => {
    expect(parseQty('-5')).toBe(5);
  });

  it('숫자 사이의 글자는 걷어낸다', () => {
    expect(parseQty('18g')).toBe(18);
    expect(parseQty('1,000')).toBe(1000);
  });
});

// ─── 재료 선택 ────────────────────────────────────────────────────────────

describe('applyCandidate', () => {
  const kg: MenuBoardCandidate = { id: 7, name: '콜롬비아 원두', unit: 'kg', quantity: 0.018 };
  const g: MenuBoardCandidate = { id: 8, name: '원두(소분)', unit: 'g', quantity: 18 };

  it('고른 재료의 단위와 양으로 함께 바뀐다', () => {
    const r = applyCandidate(recipe({ ingredient_id: null, quantity: null, unit: 'g' }), kg);
    expect(r.ingredient_id).toBe(7);
    expect(r.unit).toBe('kg');
    expect(r.quantity).toBeCloseTo(0.018);
  });

  it('재료를 바꾸면 양도 그 재료 기준으로 다시 잡힌다', () => {
    // 같은 원두 18g이라도 kg으로 세는 재료면 0.018, g으로 세는 재료면 18이다.
    // 양을 그대로 두면 1000배 차이가 난다.
    const first = applyCandidate(recipe(), kg);
    const second = applyCandidate(first, g);
    expect(second.quantity).toBe(18);
    expect(second.unit).toBe('g');
  });

  it('환산이 안 되는 재료를 고르면 양은 비워 둔다', () => {
    const noConv: MenuBoardCandidate = { id: 9, name: '우유', unit: '개', quantity: null };
    expect(applyCandidate(recipe(), noConv).quantity).toBeNull();
  });

  it('표준값은 건드리지 않는다 (근거로 계속 보여줘야 한다)', () => {
    const r = applyCandidate(recipe(), kg);
    expect(r.preset_quantity).toBe(18);
    expect(r.preset_unit).toBe('g');
  });
});

// ─── 남은 할 일 세기 ──────────────────────────────────────────────────────

describe('countPending / countNeedQty', () => {
  it('후보가 여럿인데 안 고른 줄을 센다', () => {
    const m = menu({
      recipes: [
        recipe({
          ingredient_id: null,
          candidates: [
            { id: 1, name: '에티오피아 원두', unit: 'kg', quantity: 0.018 },
            { id: 2, name: '콜롬비아 원두', unit: 'kg', quantity: 0.018 },
          ],
        }),
      ],
    });
    expect(countPending(m)).toBe(1);
  });

  it('매장에 아예 없는 재료는 고를 게 없으니 세지 않는다', () => {
    const m = menu({ recipes: [recipe({ ingredient_id: null, candidates: [] })] });
    expect(countPending(m)).toBe(0);
  });

  it('재료는 정했는데 양이 빈 줄을 센다', () => {
    const m = menu({ recipes: [recipe({ quantity: null })] });
    expect(countNeedQty(m)).toBe(1);
  });

  it('다 채워졌으면 0', () => {
    expect(countPending(menu())).toBe(0);
    expect(countNeedQty(menu())).toBe(0);
  });
});

// ─── 서버로 보낼 payload ──────────────────────────────────────────────────

describe('buildPayload', () => {
  it('체크를 푼 메뉴는 보내지 않는다', () => {
    const out = buildPayload([menu({ name: '아메리카노' }), menu({ name: '카페라떼' })],
                             new Set(['카페라떼']));
    expect(out.map((m) => m.name)).toEqual(['아메리카노']);
  });

  it('재료가 안 정해진 줄은 뺀다 — id 없이는 원가를 못 낸다', () => {
    const m = menu({
      recipes: [recipe(), recipe({ ingredient: '우유', ingredient_id: null })],
    });
    expect(buildPayload([m], new Set())[0].recipes).toHaveLength(1);
  });

  it('양이 비었거나 0이면 뺀다 — 0으로 저장하면 원가가 0원이 된다', () => {
    const m = menu({
      recipes: [
        recipe({ quantity: null }),
        recipe({ quantity: 0 }),
        recipe({ quantity: 0.018 }),
      ],
    });
    const rs = buildPayload([m], new Set())[0].recipes;
    expect(rs).toHaveLength(1);
    expect(rs[0].quantity).toBeCloseTo(0.018);
  });

  it('레시피가 전부 빠져도 메뉴는 보낸다', () => {
    // 이름과 가격만 있어도 매출 입력에는 쓸 수 있다.
    // (원가가 0원이 되는 건 서버가 경고로 알려 준다)
    const m = menu({ recipes: [recipe({ ingredient_id: null })] });
    const out = buildPayload([m], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].recipes).toEqual([]);
  });

  it('가격이 없어도 그대로 보낸다 (서버가 판단한다)', () => {
    expect(buildPayload([menu({ price: null })], new Set())[0].price).toBeNull();
  });
});
