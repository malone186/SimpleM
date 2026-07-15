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

/** 명세서/영수증 이미지를 업로드해 OCR 초안을 만든다 (자동 확정 없음). */
export async function uploadOcrImage(asset: { uri: string; mimeType?: string | null; fileName?: string | null }): Promise<OcrDocument> {
  const form = new FormData();
  const name = asset.fileName ?? 'receipt.jpg';
  const type = asset.mimeType ?? 'image/jpeg';

  if (Platform.OS === 'web') {
    // 웹: uri(blob/data URL)를 실제 Blob으로 변환해야 multipart로 전송된다
    const blob = await (await fetch(asset.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    // 네이티브(iOS/Android): {uri, name, type} 객체를 그대로 전달
    form.append('file', { uri: asset.uri, name, type } as unknown as Blob);
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/ocr/documents`, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `OCR 업로드 실패 (${res.status})`);
  }
  return res.json();
}

export function listOcrDocuments(status?: OcrDocument['status']): Promise<OcrDocument[]> {
  const query = status ? `?status=${status}` : '';
  return apiFetch(`/api/v1/chatbot/ocr/documents${query}`);
}

/** 사람이 확인을 마친 초안을 확정한다. 토큰을 주면 확정 즉시 내 매장 재고에 입고 반영된다. */
export function confirmOcrDocument(id: string, target?: OcrDocument['suggested_target'], token?: string | null) {
  return apiFetch<{ id: string; status: string; target: string; applied: boolean; message: string }>(
    `/api/v1/chatbot/ocr/documents/${id}/confirm`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: JSON.stringify({ target: target ?? null }),
    },
  );
}

export function rejectOcrDocument(id: string): Promise<OcrDocument> {
  return apiFetch(`/api/v1/chatbot/ocr/documents/${id}/reject`, { method: 'POST' });
}

// [초안 수정 API] 사용자가 직접 수정한 품목 및 영수증 정보를 백엔드 DB에 업데이트합니다.
export function updateOcrDocument(id: string, patch: { items?: OcrItem[] }): Promise<OcrDocument> {
  return apiFetch(`/api/v1/chatbot/ocr/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}
