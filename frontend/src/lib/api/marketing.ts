// 홍보/마케팅 API 클라이언트 (백엔드 B)
// 백엔드 /api/v1/chatbot/marketing/* 연동 — 홍보 문구 생성, AI 홍보 이미지 생성, 보관함.
//
// 이미지 생성은 서버가 Gemini(유료 키 있으면) → Pollinations(무료) 순으로 알아서
// 처리하므로 프론트는 항상 같은 API만 부르면 된다. 결과 provider 필드로 구분 가능.
import { API_BASE_URL, apiFetch } from './client';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 게시 채널 — 백엔드 _CHANNEL_LABELS와 동일한 키 */
export type PromotionChannel = 'instagram' | 'blog' | 'banner' | 'sms';

export const CHANNEL_META: Record<PromotionChannel, { label: string; icon: string; aspect: string }> = {
  instagram: { label: '인스타그램', icon: 'logo-instagram', aspect: '4:5' },
  blog: { label: '블로그·소식', icon: 'reader-outline', aspect: '4:3' },
  banner: { label: '포스터·현수막', icon: 'image-outline', aspect: '16:9' },
  sms: { label: '안내 문자', icon: 'chatbox-outline', aspect: '1:1' },
};

/** 생성된 홍보 이미지 1장 */
export type PromotionImage = {
  image_id: string;
  filename: string;
  url: string; // 루트 상대 경로 — promoImageUrl()로 절대 URL을 만든다
  mime_type: string;
  aspect_ratio: string;
  style: string;
  provider?: 'gemini' | 'pollinations'; // pollinations = 무료 생성(이미지에 글자 없음)
};

/** 홍보 콘텐츠 문서의 content 본문 */
export type PromotionContent = {
  channel: PromotionChannel;
  channel_label: string;
  topic: string;
  tone: string;
  focus_menu: string;
  store_name: string;
  headline: string;
  sub_headline: string;
  body: string;
  sns_caption: string;
  hashtags: string[];
  short_slogan: string;
  image_prompt: string;
  posting_tip: string;
  images: PromotionImage[];
};

/** 홍보 콘텐츠 문서 (generated_documents kind=marketing_content) */
export type PromotionDoc = {
  id: string;
  kind: string;
  title: string;
  period: string | null;
  status: string;
  content: PromotionContent;
  created_at: string;
};

/** 홍보 문구 세트 생성 — 매장 실데이터(상호·위치·베스트 메뉴) 근거 */
export const createPromotionCopy = (
  token: string,
  req: { topic?: string; channel?: PromotionChannel; tone?: string; menu?: string }
) =>
  apiFetch<PromotionDoc>('/api/v1/chatbot/marketing/promotions', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      topic: req.topic ?? '',
      channel: req.channel ?? 'instagram',
      tone: req.tone ?? '',
      menu: req.menu ?? '',
    }),
  });

/** AI 홍보 이미지 생성 — doc_id를 주면 그 문구에 맞춰 만들고 문서에 기록된다 */
export const createPromotionImage = (
  token: string,
  req: { doc_id?: string; request?: string; style?: string; aspect_ratio?: string }
) =>
  apiFetch<PromotionImage & { doc: PromotionDoc | null }>('/api/v1/chatbot/marketing/image', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      doc_id: req.doc_id ?? '',
      request: req.request ?? '',
      style: req.style ?? '',
      aspect_ratio: req.aspect_ratio ?? '1:1',
      include_text: true,
    }),
  });

/** 만들어 둔 홍보 콘텐츠 목록 (최신순) */
export const listPromotions = (token: string) =>
  apiFetch<PromotionDoc[]>('/api/v1/chatbot/documents?kind=marketing_content', {
    headers: auth(token),
  });

/** 홍보 콘텐츠 삭제 */
export const deletePromotion = (token: string, id: string) =>
  apiFetch<{ deleted: string }>(`/api/v1/chatbot/documents/${id}`, {
    method: 'DELETE',
    headers: auth(token),
  });

/** 이미지 상대 경로 → 표시 가능한 절대 URL */
export const promoImageUrl = (url: string) =>
  url.startsWith('http') ? url : `${API_BASE_URL}${url}`;

/** '4:5' 같은 화면비 문자열 → <Image> aspectRatio 숫자 */
export const aspectToNumber = (ar: string): number => {
  const m = /^(\d+):(\d+)$/.exec(ar);
  if (!m) return 1;
  return Number(m[1]) / Number(m[2]);
};
