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
