// OCR 입고 API (백엔드 B의 /api/v1/chatbot/ocr/* 연동)
// 이미지 업로드는 multipart라 apiFetch(JSON 전용)를 쓰지 않고 직접 fetch한다.
import { Platform } from 'react-native';

import { apiFetch, API_BASE_URL } from './client';

export type OcrItem = {
  name: string;
  spec: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number | null;
  warnings: string[];
};

export type OcrResult = {
  doc_type: 'purchase_statement' | 'tax_invoice' | 'receipt' | 'sales_summary' | 'unknown';
  vendor: { name: string | null; biz_no: string | null; phone: string | null };
  issued_date: string | null;
  items: OcrItem[];
  discount: number | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
};

export type OcrDocument = {
  id: string;
  status: 'draft' | 'confirmed' | 'rejected';
  filename: string | null;
  result: OcrResult;
  suggested_target: 'inventory_inbound' | 'expense' | 'sales' | null;
  warnings: string[];
  confirmed_target: string | null;
  applied: boolean;
  elapsed_sec: number | null;
  ocr_backend: string | null;
  created_at: string;
  updated_at: string;
};

// 초안은 매장(로그인 계정)별로 격리된다 — 토큰 없이 만들면 어느 매장에서도 안 보이므로 항상 넘길 것
const authHeader = (token?: string | null): Record<string, string> | undefined =>
  token ? { Authorization: `Bearer ${token}` } : undefined;

/** 업로드할 파일 한 건 — 촬영·앨범(ImagePicker)과 파일 선택(DocumentPicker) 결과의 공통 모양 */
export type UploadAsset = {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
};

// 확장자 → MIME. 안드로이드 파일 선택기나 일부 브라우저가 mimeType을 안 주거나
// application/octet-stream으로 주는 경우가 있어, 그때 파일명으로 되짚는다.
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

function resolveMime(asset: UploadAsset): string {
  const given = (asset.mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (given && given !== 'application/octet-stream') return given;
  const ext = (asset.fileName ?? asset.uri).split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/**
 * 명세서/영수증을 업로드해 OCR 초안을 만든다 (자동 확정 없음). 토큰으로 내 매장 소유가 된다.
 * 사진뿐 아니라 PDF도 받는다 — 거래처 명세서는 이메일 PDF로 오는 일이 더 많아서,
 * 화면을 찍어 올릴 필요 없이 파일 그대로 보내면 인식 정확도도 더 좋다.
 */
export async function uploadOcrImage(
  asset: UploadAsset,
  token?: string | null,
): Promise<OcrDocument> {
  const form = new FormData();
  const type = resolveMime(asset);
  const name = asset.fileName ?? (type === 'application/pdf' ? 'statement.pdf' : 'receipt.jpg');

  if (Platform.OS === 'web') {
    // 웹: uri(blob/data URL)를 실제 Blob으로 변환해야 multipart로 전송된다.
    // blob.type이 비어 있는 경우가 있어 확장자로 되짚은 type을 우선 채운다.
    const blob = await (await fetch(asset.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    // 네이티브(iOS/Android): {uri, name, type} 객체를 그대로 전달
    form.append('file', { uri: asset.uri, name, type } as unknown as Blob);
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/ocr/documents`, {
    method: 'POST',
    headers: authHeader(token),
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `OCR 업로드 실패 (${res.status})`);
  }
  return res.json();
}

// ── 메뉴판 OCR ──────────────────────────────────────────────────────────
// 메뉴판 사진 한 장으로 메뉴·가격·레시피 초안을 만든다.
// 원가를 보려면 레시피가 있어야 하는데 손으로 넣으면 30분이 걸려 그 전에 앱을 닫는다.

/** 재료 후보. 고르는 순간 쓸 수 있게 매장 단위로 환산한 양까지 딸려 온다. */
export type MenuBoardCandidate = {
  id: number;
  name: string;
  /** 매장이 이 재료를 세는 단위 (kg·팩·개…) */
  unit: string;
  /** 매장 단위로 환산한 양. 환산 근거가 없으면 null → 사장님이 직접 넣는다 */
  quantity: number | null;
  /** 표준 1단위(1g·1ml)당 매장 단위 값. 사장님이 '18g'을 '20g'으로 고치면 여기에 곱해
   *  저장할 양을 다시 낸다 (환산 규칙을 프론트에 복사하지 않으려고 서버가 준다) */
  ratio: number | null;
};

/** 레시피 한 줄. 매장 재료와 연결돼야(ingredient_id) 원가 계산에 들어간다. */
export type MenuBoardRecipe = {
  ingredient: string;          // 표준 레시피가 말하는 재료명 ("원두")
  /** 표준 레시피 원래 값 — "원두 18g"처럼 근거로 보여준다 */
  preset_quantity: number;
  preset_unit: string;
  /** 실제로 저장될 양 (매장 단위). 정할 수 없으면 null */
  quantity: number | null;
  /** 저장될 양의 단위 (매장 재료 단위) */
  unit: string;
  /** 매장 재료와 연결된 id. 후보가 여럿이면 null — 사장님이 골라야 한다 */
  ingredient_id: number | null;
  /** 이 재료일 수 있는 매장 재료들 (원두를 두 종류 쓰는 매장이 있다) */
  candidates: MenuBoardCandidate[];
};

export type MenuBoardMenu = {
  name: string;
  price: number | null;
  /** 이미 등록된 메뉴인가 — 두 번 찍어도 중복 등록되지 않는다 */
  exists: boolean;
  /** preset=표준 사전, ai=사전에 없어 AI가 추정, none=레시피 없음 */
  recipe_source: 'preset' | 'ai' | 'none';
  recipes: MenuBoardRecipe[];
};

export type MenuBoardDraft = {
  menus: MenuBoardMenu[];
  /** 매장에 없어 새로 만들어야 하는 재료 이름들 */
  unknown_ingredients: string[];
  /** 레시피는 업계 통상치 추정이다 — 화면에서 '추정'임을 밝혀야 한다 */
  estimated: boolean;
};

/** 메뉴판 사진 → 등록 초안. 저장하지 않는다 (confirm에서 저장). */
export async function analyzeMenuBoard(
  asset: UploadAsset,
  token?: string | null,
): Promise<MenuBoardDraft> {
  const form = new FormData();
  const type = resolveMime(asset);
  const name = asset.fileName ?? 'menuboard.jpg';

  if (Platform.OS === 'web') {
    const blob = await (await fetch(asset.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    form.append('file', { uri: asset.uri, name, type } as unknown as Blob);
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/ocr/menu-board`, {
    method: 'POST',
    headers: authHeader(token),
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `메뉴판 인식 실패 (${res.status})`);
  }
  return res.json();
}

/** 확인·수정을 마친 메뉴를 실제로 등록한다. */
export function confirmMenuBoard(
  menus: { name: string; price: number | null; recipes: { ingredient_id: number | null; quantity: number }[] }[],
  token?: string | null,
  // warnings: 저장은 됐지만 확인이 필요한 것 (레시피 없음 · 재료비가 판매가보다 큼)
): Promise<{ created: string[]; skipped: string[]; warnings: string[] }> {
  return apiFetch('/api/v1/chatbot/ocr/menu-board/confirm', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ menus }),
  });
}

export function listOcrDocuments(status?: OcrDocument['status'], token?: string | null): Promise<OcrDocument[]> {
  const query = status ? `?status=${status}` : '';
  return apiFetch(`/api/v1/chatbot/ocr/documents${query}`, { headers: authHeader(token) });
}

/** 사람이 확인을 마친 초안을 확정한다. 토큰을 주면 확정 즉시 내 매장 재고에 입고 반영된다. */
export function confirmOcrDocument(id: string, target?: OcrDocument['suggested_target'], token?: string | null) {
  return apiFetch<{ id: string; status: string; target: string; applied: boolean; message: string }>(
    `/api/v1/chatbot/ocr/documents/${id}/confirm`,
    {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ target: target ?? null }),
    },
  );
}

export function rejectOcrDocument(id: string, token?: string | null): Promise<OcrDocument> {
  return apiFetch(`/api/v1/chatbot/ocr/documents/${id}/reject`, { method: 'POST', headers: authHeader(token) });
}

// [초안 수정 API] 사용자가 직접 수정한 품목 및 영수증 정보를 백엔드 DB에 업데이트합니다.
export function updateOcrDocument(id: string, patch: { items?: OcrItem[] }, token?: string | null): Promise<OcrDocument> {
  return apiFetch(`/api/v1/chatbot/ocr/documents/${id}`, {
    method: 'PATCH',
    headers: authHeader(token),
    body: JSON.stringify(patch),
  });
}
