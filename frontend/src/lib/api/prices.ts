// 인터넷 가격 비교 API (백엔드 B의 /chatbot/prices/compare 연동)
// 다나와(+네이버쇼핑 키 있으면 병용)에서 최저가 후보를 가져온다 — 발주 추천 화면 보조.
import { apiFetch } from './client';

export type PriceResult = {
  name: string;
  price: number;
  source: string; // 다나와 | 네이버쇼핑
  mall: string;
  link: string; // 상품 페이지 (다나와는 몰별 가격 비교표)
  spec: string;
};

export type PriceCompare = {
  query: string;
  current_price: number;
  results: PriceResult[]; // 가격 오름차순 상위 5개
  best: PriceResult;
  saving_pct: number | null; // 양수 = 현재 단가보다 저렴
  sources: string[];
  note: string;
};

/** 상품명으로 인터넷 최저가를 비교한다. currentPrice(현재 단가)를 주면 절감률 계산. */
export const comparePrices = (q: string, currentPrice = 0) =>
  apiFetch<PriceCompare>(
    `/api/v1/chatbot/prices/compare?q=${encodeURIComponent(q)}&current_price=${currentPrice}`,
  );
