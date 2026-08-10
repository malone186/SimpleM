// 메뉴 개선안 점검 API (백엔드 B의 /api/v1/chatbot/menu/review*)
//
// "가격을 이렇게 바꿔봤는데 괜찮은가"를 실제 판매·원가로 확인한다.
// 점검(review)은 아무것도 저장하지 않는다 — 반영은 사장님이 apply를 누를 때만 일어난다.
import { Platform } from 'react-native';

import { apiFetch, API_BASE_URL } from './client';
import type { UploadAsset } from './ocr';

// info는 바로 적용할 수 없는 안내 항목(원가 미등록 등) — 추천에서만 온다
export type MenuChangeKind = 'price' | 'add' | 'remove' | 'cost' | 'info';

/** 개선안 한 줄 — 서버에 보내는 입력 */
export type MenuChange = {
  kind: MenuChangeKind;
  name: string;
  /** 바꿀 판매가 (price/add) */
  price?: number;
  /** 지금 가격에서의 증감 (price에 값이 없을 때만) */
  delta?: number;
  /** 바꿀 재료비 (cost/add) */
  cost?: number;
};

type Side = {
  price: number;
  cost: number | null;
  margin: number | null;
  sold_qty_30d?: number;
  cost_ratio?: number | null;
  /** 신메뉴 원가의 출처: preset(표준 레시피) · average(매장 평균) · manual(직접 입력) */
  cost_source?: 'preset' | 'average' | 'manual' | 'unknown';
};

/** 점검 결과 한 항목 */
export type MenuReviewItem = {
  kind: MenuChangeKind;
  menu_id: number | null;
  name: string;
  before: Side | null;
  after: Side | null;
  /** 한 달 남는 돈의 변화 (원). 계산할 수 없으면 null — 0과 구분해야 한다 */
  monthly_delta: number | null;
  change_pct?: number;
  /** 가격을 올릴 때: 판매량이 이만큼 줄어도 본전 */
  breakeven_drop_pct?: number;
  breakeven_drop_cups?: number;
  /** 가격을 내릴 때: 이만큼 더 팔아야 본전 */
  breakeven_gain_pct?: number;
  breakeven_gain_cups?: number;
  /** 신메뉴: 한 달에 이만큼 팔면 기존 메뉴 중간 수준 */
  target_qty_30d?: number;
  margin_share?: number;
  /** 사진 대조에서 '메뉴판에 안 보인다'는 이유로 잡힌 항목 — 단정할 수 없다 */
  uncertain?: boolean;
  verdict: 'good' | 'watch' | 'risk';
  headline: string;
  reason: string;
  notes: string[];
};

export type MenuReviewSummary = {
  monthly_margin_before: number;
  monthly_margin_after: number;
  monthly_delta: number;
  avg_ticket_before: number;
  avg_ticket_after: number;
  menu_count_before: number;
  menu_count_after: number;
  cost_ratio_avg_after: number | null;
  top3_margin_share_after: number | null;
};

export type MenuReviewResult = {
  days: number;
  changes: MenuReviewItem[];
  /** 등록된 메뉴에서 못 찾은 줄 — 조용히 빼면 반영된 줄 안다 */
  unmatched: string[];
  /** 사진 점검일 때만: 그대로인 메뉴 이름들 */
  unchanged?: string[];
  summary: MenuReviewSummary | null;
  risks: string[];
  wins: string[];
  verdict: 'good' | 'caution' | 'risky';
  verdict_label: string;
  comment: string;
  comment_source: 'ai' | 'rule';
  assumptions: string[];
  source?: 'board';
};

/** AI 추천 한 건 — 점검 결과와 같은 모양에 '왜 권하는지'가 붙는다 */
export type MenuSuggestion = MenuReviewItem & {
  /** 왜 이걸 권하는지 (근거 숫자 포함) */
  why: string;
  /** 급한 순 (작을수록 급함) */
  priority: number;
  /** false면 바로 반영할 수 없는 안내 항목 (원가 미등록 등) */
  actionable: boolean;
  /** 신메뉴 아이디어가 AI에서 왔을 때 */
  source?: 'ai';
};

export type MenuSuggestionResult = {
  days: number;
  suggestions: MenuSuggestion[];
  /** "다 하면 한 달에 약 31만원 더 남아요" */
  headline: string;
  expected_gain: number;
  comment: string;
  assumptions: string[];
};

export type MenuApplyResult = {
  updated: string[];
  hidden: string[];
  created: string[];
  warnings: string[];
};

const authHeader = (token?: string | null): Record<string, string> | undefined =>
  token ? { Authorization: `Bearer ${token}` } : undefined;

/** AI가 바꾸면 좋을 곳을 찾아 준다 (저장 없음). */
export function getMenuSuggestions(
  token?: string | null,
  includeNew = true,
): Promise<MenuSuggestionResult> {
  return apiFetch(`/api/v1/chatbot/menu/suggestions?include_new=${includeNew}`, {
    headers: authHeader(token),
  });
}

/** 개선안을 판매·원가로 점검한다 (저장 없음). */
export function reviewMenuChanges(
  changes: MenuChange[],
  token?: string | null,
  days = 30,
): Promise<MenuReviewResult> {
  return apiFetch('/api/v1/chatbot/menu/review', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ changes, days }),
  });
}

/** 새 메뉴판 사진 → 지금 메뉴와 대조해 바뀐 점을 찾아 점검한다 (저장 없음). */
export async function reviewMenuBoard(
  asset: UploadAsset,
  token?: string | null,
): Promise<MenuReviewResult> {
  const form = new FormData();
  const name = asset.fileName ?? 'menuboard.jpg';
  const type = asset.mimeType ?? 'image/jpeg';

  if (Platform.OS === 'web') {
    const blob = await (await fetch(asset.uri)).blob();
    form.append('file', new File([blob], name, { type: blob.type || type }));
  } else {
    form.append('file', { uri: asset.uri, name, type } as unknown as Blob);
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/chatbot/menu/review/board`, {
    method: 'POST',
    headers: authHeader(token),
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `메뉴판을 확인하지 못했어요 (${res.status})`);
  }
  return res.json();
}

/** 점검을 마친 개선안을 실제 메뉴에 반영한다 (사장님이 눌렀을 때만). */
export function applyMenuChanges(
  changes: MenuChange[],
  token?: string | null,
): Promise<MenuApplyResult> {
  return apiFetch('/api/v1/chatbot/menu/review/apply', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ changes }),
  });
}
