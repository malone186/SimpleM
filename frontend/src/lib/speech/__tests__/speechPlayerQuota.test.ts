/**
 * [한글 주석] "AI 목소리는 1분에 3회, 넘으면 기기 기본 목소리" 규칙을 고정한다.
 *
 * 설정 화면이 사장님께 그렇게 약속해 놓았는데, 서버 카운터만 믿으면 배포가 늦거나
 * 인스턴스가 여러 개일 때 약속이 지켜지지 않는다. 그래서 웹 플레이어가 스스로도 세고,
 * 그 동작을 여기서 검증한다 — 타입체크로는 절대 안 잡히는 종류의 규칙이다.
 *
 * 확인하는 것:
 *   1) 1~3번째는 서버(AI 목소리)로 나간다
 *   2) 4번째는 서버를 부르지 않고 기기 기본 목소리(speechSynthesis)로 읽는다
 *   3) 1분이 지나면 다시 AI 목소리로 돌아온다
 *   4) 서버 캐시에 있는 문장(X-Tts-Cache: hit)은 쿼터를 안 쓰므로 한도에 안 걸린다
 *   5) 서버가 429를 주면 그 즉시 기기 기본 목소리로 폴백한다 (소리가 끊기지 않는다)
 */

jest.mock('../../api/client', () => ({ API_BASE_URL: 'http://test.local' }));
jest.mock('../audioPolicy', () => ({
  canPlayAudio: async () => ({ allowed: true, reason: null }),
  isEarphoneConnected: async () => ({ connected: true, reason: null, supported: true }),
}));
jest.mock('../voicePrefs', () => ({
  readVoicePrefs: async () => ({ voiceType: 'warm_female', speechRate: 1 }),
  clampRate: (v: number) => v,
}));

import speechPlayer from '../speechPlayer.web';

/** 서버 TTS 응답 흉내 — cache가 'hit'이면 구글을 안 부른 응답이라는 뜻 */
function ttsResponse(cache: 'hit' | 'miss' = 'miss') {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'X-Tts-Cache' ? cache : null) },
    blob: async () => ({ type: 'audio/wav' }), // URL.createObjectURL이 스텁이라 내용은 무의미
  };
}

function rateLimitedResponse(retryAfter = 37) {
  return {
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h === 'Retry-After' ? String(retryAfter) : null) },
    blob: async () => ({}),
  };
}

let spoken: string[]; // 기기 기본 목소리(speechSynthesis)로 읽은 문장들

beforeEach(() => {
  spoken = [];

  // <audio> 재생 — 만들자마자 끝난 것으로 처리해 큐가 흐르게 한다
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    playbackRate = 1;
    pause() {}
    play() {
      setTimeout(() => this.onended?.(), 0);
      return Promise.resolve();
    }
  }
  (globalThis as any).Audio = FakeAudio;
  (globalThis as any).URL.createObjectURL = () => 'blob:fake';
  (globalThis as any).URL.revokeObjectURL = () => {};

  // 브라우저 내장 TTS — 폴백이 실제로 말했는지 확인하는 지점
  (globalThis as any).window = globalThis;
  (globalThis as any).speechSynthesis = {
    getVoices: () => [{ name: 'Google 한국의', lang: 'ko-KR' }],
    speak: (u: any) => {
      spoken.push(u.text);
      u.onend?.();
    },
    cancel: () => {},
  };
  (globalThis as any).SpeechSynthesisUtterance = class {
    text: string;
    lang = '';
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };

  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout'] }); // Date.now만 조작
  jest.setSystemTime(new Date('2026-08-04T09:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

/** 매번 새 모듈 인스턴스로 시작한다 (분당 카운터가 모듈 안에 산다) */
async function freshPlayer() {
  let mod: typeof speechPlayer;
  jest.isolateModules(() => {
    mod = require('../speechPlayer.web').default;
  });
  mod!.setAuthToken('test-token'); // 토큰이 없으면 서버를 부르지 않고 바로 폴백한다
  return mod!;
}

test('1~3번째는 AI 목소리, 4번째는 기기 기본 목소리로 읽는다', async () => {
  const player = await freshPlayer();
  const fetchMock = jest.fn(async () => ttsResponse('miss'));
  (globalThis as any).fetch = fetchMock;

  for (let i = 1; i <= 3; i++) {
    await player.speak(`문장 ${i}`);
  }
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(spoken).toEqual([]); // 아직 기기 목소리는 쓰이지 않았다

  await player.speak('문장 4');
  expect(fetchMock).toHaveBeenCalledTimes(3); // 서버를 아예 안 부른다
  expect(spoken).toEqual(['문장 4']); // 기기 기본 목소리로 읽었다
  expect(player.aiVoiceCooldownSec()).toBeGreaterThan(0);
});

test('1분이 지나면 다시 AI 목소리로 돌아온다', async () => {
  const player = await freshPlayer();
  const fetchMock = jest.fn(async () => ttsResponse('miss'));
  (globalThis as any).fetch = fetchMock;

  for (let i = 1; i <= 3; i++) await player.speak(`문장 ${i}`);
  await player.speak('한도 초과');
  expect(spoken).toEqual(['한도 초과']);

  jest.setSystemTime(new Date('2026-08-04T09:01:01Z')); // 61초 경과
  expect(player.aiVoiceCooldownSec()).toBe(0);

  await player.speak('돌아온 뒤');
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(spoken).toEqual(['한도 초과']); // 기기 목소리는 더 쓰이지 않았다
});

test('서버 캐시에 있는 문장은 한도에 세지 않는다', async () => {
  const player = await freshPlayer();
  const fetchMock = jest.fn(async () => ttsResponse('hit'));
  (globalThis as any).fetch = fetchMock;

  for (let i = 1; i <= 5; i++) await player.speak('반복되는 알림 문구');

  expect(fetchMock).toHaveBeenCalledTimes(5); // 전부 서버(=AI 목소리)로 나갔다
  expect(spoken).toEqual([]);
  expect(player.aiVoiceCooldownSec()).toBe(0);
});

test('서버가 429를 주면 그 자리에서 기기 기본 목소리로 읽는다', async () => {
  const player = await freshPlayer();
  const fetchMock = jest.fn(async () => rateLimitedResponse(37));
  (globalThis as any).fetch = fetchMock;

  await player.speak('한도 초과 문장');

  expect(spoken).toEqual(['한도 초과 문장']);
  expect(player.aiVoiceCooldownSec()).toBe(37);
});
