// [한글 주석] 테스트 공통 준비.
//
//   AsyncStorage는 네이티브 모듈이라 테스트 환경에 없다.
//   세션 저장·복원을 검증하려면 메모리로 흉내 내야 한다
//   (오늘 isStaff가 복원에서 빠진 버그가 정확히 이 경로에 있었다).

jest.mock('@react-native-async-storage/async-storage', () => {
  let store = {};
  return {
    setItem: jest.fn(async (k, v) => {
      store[k] = v;
    }),
    getItem: jest.fn(async (k) => (k in store ? store[k] : null)),
    removeItem: jest.fn(async (k) => {
      delete store[k];
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
    __reset: () => {
      store = {};
    },
  };
});

// 테스트마다 fetch를 새로 감시한다 — 호출 인자를 검사하는 게 핵심이다
beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.clearAllMocks();
});
