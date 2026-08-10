// 매출을 올린 '그 순간' 본전 달성을 축하한다.
//
// 이 앱의 최대 약점은 '사장님이 매출을 안 올려서 예측·원가·리포트가 다 무너지는 것'이다.
// 그래서 업로드라는 행동에 보상(코인 + 축하)을 걸어 습관을 만든다. 매출 저장 API가
// breakeven_reward를 함께 주면, 저장한 화면들이 이 함수 하나로 같은 문구를 띄운다.
import { toast } from '../components/toast';
import type { BreakevenReward } from './api/sales';

/** 오늘(YYYY-MM-DD)이면 '오늘', 어제면 '어제', 아니면 'M월 D일'로 읽는다. */
function labelDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  return `${m}월 ${d}일`;
}

/** 매출 저장 응답의 breakeven_reward를 받아 축하 토스트를 띄운다(달성 없으면 조용히 패스). */
export function celebrateBreakeven(reward?: BreakevenReward | null): boolean {
  if (!reward || reward.count <= 0 || !reward.latest) return false;
  if (reward.count === 1) {
    toast('본전 넘었어요! 🎉', `${labelDate(reward.latest)} 목표 달성 — ${reward.coins}코인을 받았어요 🪙`);
  } else {
    // 과거를 몰아 올렸을 때 — 여러 날 한꺼번에 달성
    toast('본전 달성 🎉', `${reward.count}일치 목표를 넘겼어요 — 총 ${reward.coins}코인 획득 🪙`);
  }
  return true;
}
