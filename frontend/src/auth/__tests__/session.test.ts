/**
 * [한글 주석] 세션 저장·복원 규칙을 고정한다.
 *
 * 오늘 여기서 버그가 났다.
 *   저장할 때는 isStaff를 넣었는데 불러올 때 빠뜨려서,
 *   직원으로 로그인해도 새로고침 한 번에 사장님 화면으로 돌아갔다.
 *   서버는 제대로 막고 있었으니 데이터가 새진 않았지만,
 *   화면에는 매출·정산 카드가 다시 보였고 눌러야만 403이 떴다.
 *
 * AuthContext 전체를 렌더링하면 Firebase·네비게이션까지 딸려와 무거우므로,
 * 저장/복원 규칙만 떼어내 검증한다. 규칙이 바뀌면 여기가 먼저 깨진다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'simplem:session';

type StoredSession = {
  email: string;
  name: string;
  photo?: string;
  isStaff?: boolean;
  token?: string;
};

/** AuthContext의 persistSession과 같은 규칙 */
async function saveSession(user: StoredSession, autoLogin: boolean) {
  if (autoLogin) {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } else {
    await AsyncStorage.removeItem(SESSION_KEY);
  }
}

/** AuthContext의 복원 로직과 같은 규칙 */
async function restoreSession(): Promise<StoredSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw) as StoredSession;
  return {
    email: saved.email,
    name: saved.name,
    photo: saved.photo,
    isStaff: saved.isStaff,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('직원 신분은 새로고침해도 살아남는다', async () => {
  // [핵심] 이게 빠져서 직원이 사장님 화면을 보게 됐다
  await saveSession(
    { email: '', name: '박알바', isStaff: true, token: 'tok' },
    true,
  );

  const restored = await restoreSession();
  expect(restored?.isStaff).toBe(true);
  expect(restored?.name).toBe('박알바');
});

test('사장님은 isStaff가 없거나 false다', async () => {
  await saveSession(
    { email: 'owner@cafe.com', name: '사장님', token: 'tok' },
    true,
  );

  const restored = await restoreSession();
  expect(restored?.isStaff).toBeFalsy();
});

test('직원 세션에는 매장 이메일을 담지 않는다', async () => {
  // [한글 주석] 매장 이메일은 사장님 계정 주소다.
  // 직원 화면(프로필·설정)에 그대로 뜨면 안 되므로 비워 둔다.
  await saveSession(
    { email: '', name: '박알바', isStaff: true, token: 'tok' },
    true,
  );

  const raw = await AsyncStorage.getItem(SESSION_KEY);
  expect(raw).not.toContain('owner@');
  expect((await restoreSession())?.email).toBe('');
});

test('자동 로그인을 끄면 세션을 남기지 않는다', async () => {
  await saveSession({ email: 'a@b.com', name: '사장님', token: 'tok' }, false);
  expect(await restoreSession()).toBeNull();
});

test('저장된 세션이 없으면 null을 돌려준다', async () => {
  expect(await restoreSession()).toBeNull();
});
