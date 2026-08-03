// 이어폰 감지 — 웹(react-native-web) 구현
//
// [한글 주석] 브라우저는 "지금 어느 장치로 소리가 나가는지"를 알려주지 않는다.
// enumerateDevices()로 출력 장치 목록만 볼 수 있는데, 이것도 두 가지 함정이 있다:
//   · 마이크 권한을 준 적이 없으면 label이 전부 빈 문자열이라 이어폰인지 스피커인지 알 수 없다
//   · 크롬은 같은 스피커를 'default' / 'communications' / 실제 장치로 여러 번 보고한다
//     → 예전처럼 "출력 장치가 2개 이상이면 이어폰"으로 세면 스피커뿐인 PC도 이어폰으로 잡힌다
// 그래서 groupId로 중복을 걷어내고 label 키워드로 판단하되, 확신이 없으면 supported=false로
// 정직하게 보고한다 (정책이 침묵 대신 재생을 택하도록).
import type { EarphoneStatus } from './speechTypes';

const CACHE_TTL_MS = 1_500;
let _cache: { at: number; value: EarphoneStatus } | null = null;

/** 이어폰/헤드셋으로 볼 수 있는 장치 이름 키워드 */
const EARPHONE_HINTS = [
  'headphone',
  'headset',
  'earphone',
  'earbud',
  'airpod',
  'buds',
  'bluetooth',
  '이어폰',
  '헤드폰',
  '헤드셋',
  '버즈',
];

async function detectFresh(): Promise<EarphoneStatus> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return {
      connected: false,
      supported: false,
      via: null,
      reason: '이 브라우저는 오디오 장치 확인을 지원하지 않아요.',
    };
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    if (outputs.length === 0) {
      return {
        connected: false,
        supported: false,
        via: null,
        reason: '브라우저가 출력 장치를 알려주지 않았어요.',
      };
    }

    const labeled = outputs.filter((d) => (d.label || '').trim().length > 0);
    if (labeled.length === 0) {
      // 마이크 권한이 없어 장치 이름을 볼 수 없다 — 이어폰 여부를 단정할 수 없다
      return {
        connected: false,
        supported: false,
        via: null,
        reason: '브라우저가 장치 이름을 가려서(권한 없음) 이어폰인지 확인할 수 없어요.',
      };
    }

    const matched = labeled.find((d) => {
      const label = d.label.toLowerCase();
      return EARPHONE_HINTS.some((hint) => label.includes(hint));
    });
    if (matched) {
      return { connected: true, supported: true, via: 'wired', reason: null };
    }

    // 이름은 보이는데 이어폰 키워드가 없다 — 중복(default/communications)을 걷어낸 실제 장치 수로 보조 판단
    const groups = new Set(labeled.map((d) => d.groupId || d.deviceId));
    if (groups.size >= 2) {
      return { connected: true, supported: true, via: null, reason: null };
    }
    return {
      connected: false,
      supported: true,
      via: null,
      reason: '이어폰이 연결되어 있지 않아요.',
    };
  } catch {
    return {
      connected: false,
      supported: false,
      via: null,
      reason: '오디오 장치 확인에 실패했어요.',
    };
  }
}

export async function detectEarphone(): Promise<EarphoneStatus> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.value;
  const value = await detectFresh();
  _cache = { at: Date.now(), value };
  return value;
}

export function resetEarphoneCache(): void {
  _cache = null;
}

export default detectEarphone;
