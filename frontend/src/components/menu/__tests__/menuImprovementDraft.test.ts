/**
 * 메뉴 개선안 화면의 판단 로직 — 여기가 틀리면 사장님이 손대지 않은 메뉴의 가격이 바뀐다.
 *
 * 화면에는 그냥 숫자가 찍힐 뿐이라 틀린 줄 알 방법이 없다. 눈으로 보는 대신 여기서 고정한다.
 */
import {
  buildApplyPayload,
  buildManualChanges,
  initialPicked,
  keyOf,
  toChange,
  toPrice,
  type EditableMenu,
} from '../menuImprovementDraft';
import type { MenuReviewItem } from '../../../lib/api/menuReview';

const MENUS: EditableMenu[] = [
  { id: 1, name: '아메리카노', selling_price: 4000 },
  { id: 2, name: '카페라떼', selling_price: 4500 },
  { id: 3, name: '바닐라라떼', selling_price: 5000 },
];

const item = (over: Partial<MenuReviewItem> = {}): MenuReviewItem => ({
  kind: 'price',
  menu_id: 1,
  name: '아메리카노',
  before: { price: 4000, cost: 900, margin: 3100 },
  after: { price: 4500, cost: 900, margin: 3600 },
  monthly_delta: 250000,
  verdict: 'good',
  headline: '월 250,000원 늘어요',
  reason: '…',
  notes: [],
  ...over,
});

// ---------------------------------------------------------------------------
// 직접 고치기 → 보낼 변경 목록
// ---------------------------------------------------------------------------

describe('buildManualChanges', () => {
  it('손대지 않은 메뉴는 보내지 않는다', () => {
    expect(buildManualChanges(MENUS, {}, new Set(), '', '')).toEqual([]);
  });

  it('빈칸으로 지운 칸도 변경이 아니다', () => {
    expect(buildManualChanges(MENUS, { 1: '' }, new Set(), '', '')).toEqual([]);
  });

  it('지금 가격과 같은 값은 변경이 아니다', () => {
    expect(buildManualChanges(MENUS, { 1: '4000' }, new Set(), '', '')).toEqual([]);
  });

  it('고친 가격만 보낸다', () => {
    expect(buildManualChanges(MENUS, { 1: '4500', 2: '' }, new Set(), '', '')).toEqual([
      { kind: 'price', name: '아메리카노', price: 4500 },
    ]);
  });

  it('뺀 메뉴는 가격을 고쳤어도 빼기가 이긴다', () => {
    expect(buildManualChanges(MENUS, { 3: '5500' }, new Set([3]), '', '')).toEqual([
      { kind: 'remove', name: '바닐라라떼' },
    ]);
  });

  it('신메뉴는 이름과 가격이 다 있을 때만', () => {
    expect(buildManualChanges(MENUS, {}, new Set(), '흑임자라떼', '')).toEqual([]);
    expect(buildManualChanges(MENUS, {}, new Set(), '  ', '6000')).toEqual([]);
    expect(buildManualChanges(MENUS, {}, new Set(), ' 흑임자라떼 ', '6,000원')).toEqual([
      { kind: 'add', name: '흑임자라떼', price: 6000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 결과 → 실제 반영
// ---------------------------------------------------------------------------

describe('buildApplyPayload', () => {
  it('켜 둔 항목만 반영한다', () => {
    const items = [item(), item({ kind: 'remove', name: '바닐라라떼', after: null })];
    const payload = buildApplyPayload(items, new Set([keyOf(items[1])]));
    expect(payload).toEqual([{ kind: 'remove', name: '바닐라라떼' }]);
  });

  it('가격을 모르는 항목은 반영하지 않는다', () => {
    // 0원으로 저장되면 그 뒤 매출이 통째로 0으로 잡힌다
    const broken = item({ after: { price: 0, cost: null, margin: null } });
    expect(buildApplyPayload([broken], new Set([keyOf(broken)]))).toEqual([]);
  });

  it('새 메뉴는 가격과 함께 반영한다', () => {
    const add = item({
      kind: 'add', menu_id: null, name: '흑임자라떼', before: null,
      after: { price: 6000, cost: 2000, margin: 4000 }, monthly_delta: null,
    });
    expect(buildApplyPayload([add], new Set([keyOf(add)]))).toEqual([
      { kind: 'add', name: '흑임자라떼', price: 6000 },
    ]);
  });
});

describe('initialPicked', () => {
  it('사진에서 추측으로 잡힌 빼기는 꺼 둔다', () => {
    // 메뉴판 사진이 잘려 안 읽힌 것뿐일 수 있다 — 눌러야 반영되게 한다
    const guessed = item({ kind: 'remove', name: '바닐라라떼', after: null, uncertain: true });
    const sure = item();
    const picked = initialPicked([sure, guessed]);
    expect(picked.has(keyOf(sure))).toBe(true);
    expect(picked.has(keyOf(guessed))).toBe(false);
  });
});

describe('toPrice / toChange', () => {
  it('숫자만 남긴다', () => {
    expect(toPrice('4,500원')).toBe(4500);
    expect(toPrice('')).toBe(0);
    expect(toPrice(undefined)).toBe(0);
  });

  it('원가 조정은 원가를 보낸다', () => {
    const c = item({ kind: 'cost', after: { price: 4000, cost: 800, margin: 3200 } });
    expect(toChange(c)).toEqual({ kind: 'cost', name: '아메리카노', cost: 800 });
  });
});
