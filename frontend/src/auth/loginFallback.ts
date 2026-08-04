/**
 * [한글 주석] 계정이 사는 곳이 두 군데라서 생기는 규칙을 한 곳에 모아 둔다.
 *
 *   · 앱에서 가입한 계정 → Firebase Auth
 *   · 데모/시드 계정(owner@cafe.com), 백엔드 /auth/signup으로 만든 계정 → 백엔드 DB
 *
 * 로그인 화면은 둘을 구분하지 않으므로, Firebase가 "그런 자격증명 없다"고 막으면
 * 백엔드 로그인을 한 번 더 두드려야 한다. 그 판단을 여기서 한다.
 *
 * 비밀번호가 틀렸을 뿐인 Firebase 계정도 이 목록에 걸려 백엔드를 한 번 더 부르지만,
 * 백엔드에도 없거나 틀렸으면 그대로 실패하므로 결과는 같고 왕복 한 번만 더 든다.
 */

/** Firebase 로그인 실패 코드 중 '백엔드에 물어볼 가치가 있는' 것들 */
const RETRYABLE_FIREBASE_CODES = new Set([
  'auth/user-not-found',
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/invalid-login-credentials', // 이메일 열거 방지가 켜지면 위 둘 대신 이게 온다
  // 이메일/비밀번호 로그인 수단이 콘솔에서 꺼져 있어도 백엔드 계정은 살아 있다
  'auth/operation-not-allowed',
  // 같은 이메일로 실패가 쌓여 Firebase가 캡차를 요구하는 상태 — 백엔드는 멀쩡하다
  'auth/too-many-requests',
  // Firebase에 못 닿는 상황. 백엔드가 살아 있으면 로그인은 되어야 한다
  'auth/network-request-failed',
  'auth/internal-error',
]);

export function shouldRetryWithBackendLogin(code?: string): boolean {
  if (!code) return true; // 코드 없는 예외(SDK 초기화 실패 등)도 백엔드로 한 번 시도한다
  return RETRYABLE_FIREBASE_CODES.has(code);
}
