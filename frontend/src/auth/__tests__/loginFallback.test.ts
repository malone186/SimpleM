/**
 * [한글 주석] 로그인 이중화 규칙을 고정한다.
 *
 * 오늘 여기서 버그가 났다.
 *   Firebase 키가 실제 키라서 로그인이 Firebase만 물어봤는데,
 *   데모 계정(owner@cafe.com)과 백엔드로 가입한 계정(s@gmail.com)은
 *   Firebase에 없고 백엔드 DB에만 있었다.
 *   그래서 비밀번호를 정확히 넣어도 "이메일 또는 비밀번호가 일치하지 않습니다"만 떴다.
 *
 * Firebase가 자격증명 문제로 막았을 때는 백엔드 로그인을 한 번 더 두드려야 한다.
 */
import { shouldRetryWithBackendLogin } from '../loginFallback';

test('Firebase에 없는 계정이면 백엔드로 한 번 더 시도한다', () => {
  // 이메일 열거 방지가 켜진 프로젝트는 아래 두 코드로 온다
  expect(shouldRetryWithBackendLogin('auth/invalid-credential')).toBe(true);
  expect(shouldRetryWithBackendLogin('auth/invalid-login-credentials')).toBe(true);
  expect(shouldRetryWithBackendLogin('auth/user-not-found')).toBe(true);
  expect(shouldRetryWithBackendLogin('auth/wrong-password')).toBe(true);
});

test('Firebase 쪽 사정(차단·네트워크)으로 막혀도 백엔드는 살아 있다', () => {
  // 같은 이메일로 실패가 쌓이면 Firebase가 캡차를 요구하며 막는다
  expect(shouldRetryWithBackendLogin('auth/too-many-requests')).toBe(true);
  expect(shouldRetryWithBackendLogin('auth/network-request-failed')).toBe(true);
  expect(shouldRetryWithBackendLogin('auth/operation-not-allowed')).toBe(true);
});

test('이메일 형식이 틀린 건 백엔드도 못 받는다 — 그냥 실패시킨다', () => {
  // 백엔드는 EmailStr로 검증하므로 어차피 422다. 왕복만 늘어난다.
  expect(shouldRetryWithBackendLogin('auth/invalid-email')).toBe(false);
  expect(shouldRetryWithBackendLogin('auth/user-disabled')).toBe(false);
});

test('코드 없는 예외도 백엔드로 한 번 시도한다', () => {
  // SDK 초기화 실패처럼 code가 없는 예외 — 백엔드가 살아 있으면 로그인은 되어야 한다
  expect(shouldRetryWithBackendLogin(undefined)).toBe(true);
});
