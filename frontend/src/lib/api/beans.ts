// 원두 마켓/리뷰 검색 API 클라이언트 — 백엔드 /api/v1/roastery/* 연동
// (이 응답은 CommonResponse 래핑이 아니라 스키마 객체를 그대로 반환한다)
import { apiFetch } from './client';

/** 리뷰 요약 — 실제 리뷰 통계 */
export type BeanReviewSummary = {
  bean_id: number;
  avg_rating: number;
  review_count: number;
  positive_ratio: number; // 0.0 ~ 1.0
  top_keywords: string[];  // 대표 키워드 Top 5
};

/** 판매처 시세 1건 (가격 비교용) */
export type BeanOffer = {
  id: number;
  bean_id: number;
  source_site: string;
  price: number;
  product_url?: string;
  updated_at: string;
};

/** 원두 검색 결과 1건 */
export type BeanItem = {
  id: number;
  name: string;
  roastery_name: string;
  price: number;
  price_per_gram: number | null; // g당 단가 (잔당 원가 환산의 근거)
  country: string | null;
  process: string | null;        // 가공방식 (워시드/내추럴/허니 등)
  description: string | null;    // 로스터리 제공 설명·컵노트
  thumbnail_url: string | null;
  product_url: string;
  sold_out: boolean;
  review_summary: BeanReviewSummary;
  lowest_offer: BeanOffer | null;
  all_offers: BeanOffer[];
  alternative_recommendations: BeanItem[]; // 품절 시 대체 추천
};

export type BeanSearchResponse = {
  total_count: number;
  items: BeanItem[];
  disclaimer: string;
};

export type BeanSortBy =
  | 'relevance'
  | 'lowest_price'
  | 'price_asc'
  | 'price_desc'
  | 'reviews';

export type BeanSearchParams = {
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sortBy?: BeanSortBy;
  limit?: number;
};

/** 원산지·가공방식 그룹별 g당 단가 통계 */
export type MarketStats = {
  count: number;
  avg: number;
  median: number;
  min: number;
  max: number;
};

export type MarketSummary = {
  overall: MarketStats | null;
  by_country: Record<string, MarketStats>;
  by_process: Record<string, MarketStats>;
  min_group_size: number;
};

/**
 * 시세표를 가져옵니다 (원산지별 g당 단가 통계).
 *
 * [한글 주석] 원두마다 API를 부르면 50번 호출이 되므로, 그룹 통계만 한 번 받아
 * 각 원두의 g당 단가와 화면에서 비교합니다.
 */
export async function fetchMarketSummary(): Promise<MarketSummary> {
  return apiFetch<MarketSummary>('/api/v1/roastery/market/summary');
}

/** 원두 목록을 실제 DB에서 검색합니다 (이름·원산지·풍미 텍스트 + 정렬/필터) */
export async function searchBeans(params: BeanSearchParams = {}): Promise<BeanSearchResponse> {
  const q = new URLSearchParams();
  if (params.query) q.set('query', params.query);
  if (params.minPrice != null) q.set('min_price', String(params.minPrice));
  if (params.maxPrice != null) q.set('max_price', String(params.maxPrice));
  if (params.inStockOnly) q.set('in_stock_only', 'true');
  q.set('sort_by', params.sortBy ?? 'reviews');
  q.set('limit', String(params.limit ?? 30));

  return apiFetch<BeanSearchResponse>(`/api/v1/roastery/search?${q.toString()}`);
}
