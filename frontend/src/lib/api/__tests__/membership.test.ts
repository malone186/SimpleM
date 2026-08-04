/**
 * [한글 주석] API 클라이언트 계약을 고정한다.
 *
 * 오늘 프런트에서 난 버그 셋이 전부 타입체크를 통과했다.
 *   · 토큰을 안 붙여 401       (string은 string이라 타입은 맞다)
 *   · 세션 복원에서 isStaff 누락 (선택 필드라 타입은 맞다)
 *   · 환불에 잘못된 금액 전달    (number는 number라 타입은 맞다)
 *
 * 타입은 "무엇이 들어가는가"만 보고 "무엇을 보내는가"는 안 본다.
 * 실제로 호출해보고 fetch가 받은 인자를 검사해야 잡힌다.
 */
import {
  chargeBalance,
  createCustomer,
  fetchChurnRisk,
  fetchPrepaidSummary,
  refundBalance,
  searchCustomers,
  useBalance,
} from '../membership';

const TOKEN = 'test-token-abc';

function mockJson(body: unknown = {}) {
  (globalThis.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function lastCall() {
  const calls = (globalThis.fetch as jest.Mock).mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init: init ?? {} };
}

function headerOf(init: RequestInit, key: string) {
  const h = (init.headers ?? {}) as Record<string, string>;
  const found = Object.keys(h).find((k) => k.toLowerCase() === key.toLowerCase());
  return found ? h[found] : undefined;
}

// --- 인증 ---

describe('모든 사장님 API는 토큰을 붙인다', () => {
  // [한글 주석] 이게 오늘 401이 났던 이유다.
  // apiFetch는 토큰을 자동으로 붙이지 않는데(공동 소유 파일이라 고정)
  // 팀 공통 패턴인 'API 함수가 token을 인자로 받는' 방식을 안 따랐다.
  const cases: [string, () => Promise<unknown>][] = [
    ['회원 검색', () => searchCustomers(TOKEN, '김')],
    ['회원 등록', () => createCustomer(TOKEN, { phone: '01012345678' })],
    ['충전', () => chargeBalance(TOKEN, 1, { charge_plan_id: 1 })],
    ['차감', () => useBalance(TOKEN, 1, { amount: 3000 })],
    ['환불', () => refundBalance(TOKEN, 1, { amount: 1000 })],
    ['선수금 집계', () => fetchPrepaidSummary(TOKEN)],
    ['뜸해진 단골', () => fetchChurnRisk(TOKEN)],
  ];

  test.each(cases)('%s', async (_label: string, call: () => Promise<unknown>) => {
    mockJson();
    await call();
    expect(headerOf(lastCall().init, 'Authorization')).toBe(`Bearer ${TOKEN}`);
  });
});

// --- 요청 형태 ---

test('회원 검색어는 URL 인코딩된다', async () => {
  mockJson([]);
  await searchCustomers(TOKEN, '김 손님');
  expect(lastCall().url).toContain('query=%EA%B9%80%20%EC%86%90%EB%8B%98');
});

test('검색어가 없으면 쿼리를 붙이지 않는다', async () => {
  mockJson([]);
  await searchCustomers(TOKEN);
  expect(lastCall().url).not.toContain('query=');
});

test('차감은 메뉴 id를 함께 보낸다', async () => {
  // [한글 주석] 원가 분석이 menu_id로 원가를 찾는다.
  // 빠지면 그 건은 '알 수 없음'으로 집계에서 제외된다.
  mockJson();
  await useBalance(TOKEN, 7, { amount: 3000, memo: '아메리카노', menu_id: 42 });
  const body = JSON.parse(String(lastCall().init.body));
  expect(body).toEqual({ amount: 3000, memo: '아메리카노', menu_id: 42 });
});

test('환불은 잔액 차감분을 보낸다 (건넬 현금이 아니다)', async () => {
  // [한글 주석] 오늘 실제로 헷갈렸던 지점.
  //   잔액 20,000원을 지우고 현금 16,667원을 건네는 구조라
  //   API에 보내야 하는 건 20,000(차감분)이다.
  //   16,667을 보내면 보너스가 남아 다음 환불에서 또 계산돼 돈이 샌다.
  mockJson();
  const 잔액차감분 = 20000;
  await refundBalance(TOKEN, 3, { amount: 잔액차감분, memo: '고객 요청' });
  expect(JSON.parse(String(lastCall().init.body)).amount).toBe(20000);
});

// --- 오류 처리 ---

test('서버 오류 메시지를 그대로 전달한다', async () => {
  // [한글 주석] "잔액이 부족합니다 (잔액 1,000원)" 같은 메시지가
  // 화면까지 와야 직원이 무엇이 문제인지 안다.
  (globalThis.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ detail: '잔액이 부족합니다. (잔액 1,000원 / 필요 4,000원)' }),
  });
  await expect(useBalance(TOKEN, 1, { amount: 4000 }))
    .rejects.toThrow('잔액이 부족합니다');
});
