// 홍보/마케팅 API 클라이언트 (백엔드 B)
// 백엔드 /api/v1/chatbot/marketing/* 연동 — 홍보 문구 생성, AI 홍보 이미지 생성, 보관함.
//
// 이미지 생성은 서버가 Gemini(유료 키 있으면) → Pollinations(무료) 순으로 알아서
// 처리하므로 프론트는 항상 같은 API만 부르면 된다. 결과 provider 필드로 구분 가능.
import { Platform } from 'react-native';

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

/** 이미지에 새길 한글 슬로건의 위치 — 서버가 Pillow로 직접 합성한다 */
export type OverlayLayout = 'auto' | 'none' | 'bottom' | 'center' | 'top';

export const OVERLAY_META: { key: OverlayLayout; label: string }[] = [
  { key: 'bottom', label: '아래' },
  { key: 'center', label: '가운데' },
  { key: 'top', label: '위' },
  { key: 'none', label: '글자 없이' },
];

/** 생성된 홍보 이미지 1장 */
export type PromotionImage = {
  image_id: string;
  filename: string;
  url: string; // 루트 상대 경로 — promoImageUrl()로 절대 URL을 만든다
  mime_type: string;
  aspect_ratio: string;
  style: string;
  provider?: 'gemini' | 'hf' | 'pollinations'; // hf·pollinations = 무료 생성
  // --- 아래는 슬로건 합성이 들어간 뒤 생긴 필드 (옛 이미지에는 없다)
  raw_filename?: string;
  raw_url?: string; // 글자 없는 원본 — overlay가 none이면 url과 같다
  overlay?: Exclude<OverlayLayout, 'auto'>;
  slogan?: string;
  quality?: 'high' | 'standard';
  prompt?: string;
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
  req: {
    doc_id?: string;
    request?: string;
    style?: string;
    aspect_ratio?: string;
    overlay?: OverlayLayout;
    quality?: 'high' | 'standard';
  }
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
      overlay: req.overlay ?? 'auto',
      quality: req.quality ?? 'high',
    }),
  });

/**
 * 슬로건 위치만 바꾸기 — 서버가 저장해 둔 '글자 없는 원본'을 다시 합성한다.
 * AI를 다시 부르지 않아 1초 안에 끝나고, 몇 번을 바꿔도 화질이 나빠지지 않는다.
 */
export const restylePromotionImage = (
  token: string,
  req: { doc_id: string; image_id?: string; layout: OverlayLayout }
) =>
  apiFetch<PromotionImage & { doc: PromotionDoc | null }>(
    '/api/v1/chatbot/marketing/image/overlay',
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        doc_id: req.doc_id,
        image_id: req.image_id ?? '',
        layout: req.layout,
      }),
    }
  );

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

/** 채널에 맞는 본문 — 인스타는 캡션, 나머지는 본문 */
export const promotionBody = (c: PromotionContent) =>
  c.channel === 'instagram' ? c.sns_caption : c.body;

/** 그대로 붙여넣어 올릴 수 있는 문구 전문 (본문 + 해시태그) */
export const promotionText = (c: PromotionContent, withHeadline = false) =>
  [withHeadline ? c.headline : '', promotionBody(c), (c.hashtags ?? []).join(' ')]
    .filter(Boolean)
    .join('\n\n');

/** 저장·공유용 파일명 — 한글이 섞이면 일부 OS에서 파일이 깨져 영문·숫자만 쓴다 */
export const promoFilename = (image: PromotionImage) => {
  const ext = image.mime_type === 'image/png' ? 'png' : image.mime_type === 'image/webp' ? 'webp' : 'jpg';
  return `brewnote_promo_${image.image_id}.${ext}`;
};

/** '4:5' 같은 화면비 문자열 → <Image> aspectRatio 숫자 */
export const aspectToNumber = (ar: string): number => {
  const m = /^(\d+):(\d+)$/.exec(ar);
  if (!m) return 1;
  return Number(m[1]) / Number(m[2]);
};

// ── 실물 사진 홍보 이미지 — 누끼(rembg) + 감성 배경 합성 ──
export const PHOTO_BG_STYLES: { key: string; label: string }[] = [
  { key: 'wood', label: '우드 테이블' },
  { key: 'marble', label: '대리석' },
  { key: 'cozy', label: '코지 감성' },
  { key: 'studio', label: '스튜디오' },
  { key: 'season', label: '시즌 감성' },
];

/** 사장님이 올린 실물 메뉴 사진으로 홍보 이미지 합성 (AI 생성 대신 '진짜 우리 메뉴') */
export async function createPhotoPromoImage(
  token: string,
  file: { uri: string; mimeType?: string | null; fileName?: string | null },
  req: { doc_id?: string; style?: string; aspect_ratio?: string },
): Promise<PromotionImage & { doc: PromotionDoc | null }> {
  const form = new FormData();
  const name = file.fileName ?? 'menu_photo.jpg';
  const type = file.mimeType ?? 'image/jpeg';
  if (Platform.OS === 'web') {
    const blob = await (await fetch(file.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    form.append('file', { uri: file.uri, name, type } as unknown as Blob);
  }
  form.append('style', req.style ?? 'wood');
  form.append('aspect_ratio', req.aspect_ratio ?? '1:1');
  form.append('doc_id', req.doc_id ?? '');
  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/marketing/photo-image`, {
    method: 'POST',
    headers: auth(token),
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `사진 합성 실패 (${res.status})`);
  }
  return res.json();
}
