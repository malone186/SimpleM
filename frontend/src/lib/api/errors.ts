// API 실패를 "사장님이 뭘 해야 할지 아는 문장"으로 바꾸는 공용 분류기.
//
// apiFetch는 실패를 "409 · 서버가 준 안내문" 형태의 Error로 던지므로 상태 코드를 앞에서 읽을 수 있다.
// 이 구분이 없으면 가장 헷갈리는 경우가 신규 가입 계정이다 —
// 경영 리포트·매출 예측은 데이터가 쌓이기 전엔 열릴 수 없는데 화면에는
// "로그인과 서버를 확인해 주세요"가 떠서, 확인할 게 없는 걸 붙잡고 원인을 찾게 된다.
// 백엔드는 이런 경우 409와 함께 필요한 데이터량("최소 14일의 판매 기록…")을 문장으로 주니,
// 그 문장을 그대로 화면에 띄우는 게 가장 정확한 안내다.

export type ApiFailureKind =
  | 'needs_data' // 아직 데이터가 부족해서 못 하는 것 — 기다리거나 입력해야 열린다
  | 'auth' // 로그인 만료
  | 'missing' // 서버에 이 기능이 아직 없음 (배포 안 됨)
  | 'server' // 서버 오류
  | 'network' // 연결 실패
  | 'unknown';

export type ApiFailure = {
  kind: ApiFailureKind;
  /** 화면에 그대로 띄울 안내 문장 */
  message: string;
  /** '다시 시도' 버튼을 보여줄지 — 데이터가 없어서 안 되는 건 다시 눌러도 그대로다 */
  retryable: boolean;
};

// apiFetch의 두 가지 형태를 모두 읽는다:
//   상세 있음: "409 · 판매 데이터가 3일치뿐이라 …"  /  상세 없음: "API /x failed: 500"
// 가운뎃점은 폰트·편집기에 따라 다른 글자가 섞일 수 있어 후보를 함께 허용한다.
const withDetail = /^(\d{3})\s*[·・‧∙•]?\s*([\s\S]*)$/;

const parseError = (msg: string): { status: number | null; detail: string } => {
  const m = msg.match(withDetail);
  if (m) return { status: Number(m[1]), detail: m[2].trim() };
  const tail = msg.match(/(\d{3})\s*$/);
  return { status: tail ? Number(tail[1]) : null, detail: '' };
};

/** 한글 목적격 조사 — '리포트를' / '예측을' (받침 유무로 결정). */
const withObjectParticle = (noun: string): string => {
  const code = noun.charCodeAt(noun.length - 1);
  const hasFinalConsonant = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return `${noun}${hasFinalConsonant ? '을' : '를'}`;
};

/**
 * @param subject 실패한 대상 ('리포트', '예측' 등) — 안내 문장에 들어간다
 * @param language 화면 언어. 'en'이면 영문 문장을 돌려준다 (서버가 준 상세 안내는 한국어 그대로)
 */
export function describeApiFailure(
  e: unknown,
  subject: string,
  language: 'ko' | 'en' = 'ko',
): ApiFailure {
  const raw = e instanceof Error ? e.message : String(e);
  const { status, detail } = parseError(raw);
  const en = language === 'en';

  // 409 = "아직 조건이 안 됐다". 백엔드가 필요한 데이터량까지 문장으로 주므로 그대로 보여준다
  // (예: "판매 데이터가 3일치뿐이라 … 최소 14일의 판매 기록이 쌓이면 예측이 열립니다")
  if (status === 409 || (status === 400 && /데이터|기록|부족|필요/.test(detail))) {
    return {
      kind: 'needs_data',
      message: detail || (en
        ? `Not enough data yet for the ${subject}.`
        : `${withObjectParticle(subject)} 만들 데이터가 아직 부족해요.`),
      retryable: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: en
        ? 'Your session expired. Please sign in again.'
        : '로그인이 만료됐어요. 로그아웃 후 다시 로그인해 주세요.',
      retryable: true,
    };
  }
  if (status === 404) {
    return {
      kind: 'missing',
      message: en
        ? `The server does not have this feature yet (404).`
        : `서버에 이 기능이 아직 없어요 (404). 백엔드를 최신 버전으로 배포하면 바로 보입니다.`,
      retryable: true,
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: 'server',
      message: en
        ? 'The server hit an error. Please try again in a moment.'
        : '서버에서 오류가 났어요. 잠시 후 다시 시도해 주세요.',
      retryable: true,
    };
  }
  if (/Network|Failed to fetch|fetch failed|timeout|timed out/i.test(raw)) {
    return {
      kind: 'network',
      message: en
        ? 'Could not reach the server. Check your connection.'
        : '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.',
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    message: en
      ? `Could not load the ${subject}. (${raw})`
      : `${withObjectParticle(subject)} 가져오지 못했어요. (${raw})`,
    retryable: true,
  };
}
