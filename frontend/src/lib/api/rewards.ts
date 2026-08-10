// 포인트·상점 API (백엔드 B) — 할 일을 끝내면 코인이 쌓이고, 코인으로 브루를 꾸민다.
import { apiFetch } from './client';

/** 꾸미기 부위 — 같은 부위에는 하나만 착용된다 (부위가 다르면 함께 착용된다) */
export type ItemSlot = 'pose' | 'background' | 'apron' | 'room';

export type ShopItem = {
  id: string;
  slot: ItemSlot;
  slot_label: string;
  name: string;
  emoji: string;
  price: number;
  desc: string;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
  /** 포즈 상품일 때만 — Brew의 mood 값 */
  mood?: string | null;
  /** 앞치마 색 상품일 때만 — apronVariants의 색 키 (navy·forest 등) */
  color?: string | null;
  /** 이 레벨부터 구매 가능 (0이면 조건 없음) */
  min_level?: number;
  /** 레벨 미달로 잠김 — 실루엣으로 보여주고 구매는 서버도 막는다 */
  locked?: boolean;
};

export type ShopState = {
  balance: number;
  /** 현재 브루 레벨 — 레벨 잠금 표시에 쓴다 */
  level?: number;
  items: ShopItem[];
};

/** 브루 캡슐 뽑기 결과 — 결과는 서버가 정한다 (조작 방지) */
export type GachaResult = {
  rarity: 'common' | 'rare' | 'epic';
  kind: 'coins' | 'item';
  cost: number;
  balance: number;
  coins?: number;
  item?: { id: string; slot: ItemSlot; slot_label: string; name: string; emoji: string; mood?: string | null; color?: string | null };
};

/** 브루 캡슐 뽑기 1회 (300코인) */
export function drawCapsule(token?: string | null): Promise<GachaResult> {
  return apiFetch<GachaResult>('/api/v1/rewards/gacha', {
    method: 'POST',
    headers: authHeader(token),
  });
}

export type PointHistoryItem = {
  id: number;
  delta: number; // 적립은 양수, 사용은 음수
  reason: string;
  reason_label: string;
  memo: string;
  created_at: string | null;
};

export type Wallet = {
  balance: number;
  total_earned: number;
  history: PointHistoryItem[];
};

/** 착용 중인 아이템. pose면 mood로 브루 그림이 바뀌고, apron이면 color로 앞치마 색이,
 *  background면 뒤에 효과가 깔린다. */
export type EquippedItem = { id: string; slot: ItemSlot; emoji: string; mood?: string; color?: string };

const authHeader = (token?: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

/** 코인 잔액 + 누적 적립 + 최근 내역 */
export function getWallet(token?: string | null): Promise<Wallet> {
  return apiFetch<Wallet>('/api/v1/rewards/wallet', { headers: authHeader(token) });
}

/** 상점 카탈로그 (보유·착용·구매가능 여부 포함) */
export function getShop(token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>('/api/v1/rewards/shop', { headers: authHeader(token) });
}

/** 아이템 구매 — 갱신된 상점 상태를 그대로 돌려주므로 재조회할 필요가 없다 */
export function buyItem(itemId: string, token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>(`/api/v1/rewards/shop/${itemId}/buy`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

/** 착용/해제 */
export function equipItem(itemId: string, equipped: boolean, token?: string | null): Promise<ShopState> {
  return apiFetch<ShopState>('/api/v1/rewards/equip', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ item_id: itemId, equipped }),
  });
}

/** 적립 결과 — awarded가 0이면 이미 받은 항목이라 잔액이 그대로다 */
export type AwardResult = { awarded: number; balance: number };

/**
 * 자동 도출 할 일(재고 발주·서류 갱신·브루 추천)을 끝냈다고 알린다.
 *
 * 이 항목들은 조건에서 매번 새로 조립되므로 서버에 저장된 행이 없다 — 그래서 완료
 * API가 없고, 대신 대시보드가 쓰는 안정적인 id(stock-<재료id> 등)를 key로 보낸다.
 * 같은 key로 두 번 보내도 코인은 한 번만 쌓인다(서버가 막는다).
 */
export function awardDerivedTodo(
  key: string,
  title: string,
  token?: string | null,
): Promise<AwardResult> {
  return apiFetch<AwardResult>('/api/v1/rewards/todo-done', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ key, title }),
  });
}

/** 착용 중인 아이템만 가볍게 — 브루를 그리는 화면들이 쓴다 */
export function getEquipped(token?: string | null): Promise<EquippedItem[]> {
  return apiFetch<EquippedItem[]>('/api/v1/rewards/equipped', { headers: authHeader(token) });
}

/** 오늘 할 일 N개 완료 시 보너스 — 진행 상황 */
export type DailyChallenge = {
  goal: number;
  progress: number;
  done: boolean;
  reward: number;
  claimed: boolean;
  just_awarded: boolean;
};

/** 브루 키우기 상태 — 레벨·EXP·스트릭·일일 도전 */
export type Progress = {
  exp: number;
  level: number;
  level_title: string;
  exp_in_level: number;
  exp_to_next: number;
  streak: number;
  streak_active_today: boolean;
  daily: DailyChallenge;
};

/** 성장 상태 조회 (일일 도전을 달성했으면 이 호출 중에 보너스가 지급될 수 있다) */
export function getProgress(token?: string | null): Promise<Progress> {
  return apiFetch<Progress>('/api/v1/rewards/progress', { headers: authHeader(token) });
}

/** 주간 퀘스트 한 건 — 이번 주 할 일 완료 누적으로 진행된다 */
export type Quest = {
  id: string;
  title: string;
  desc: string;
  goal: number;
  progress: number;
  reward: number;
  done: boolean;
  claimed: boolean;
  claimable: boolean;
};

// 오늘의 목표 (일일 퀘스트) — 손익분기 하루 목표 잔수 대비 오늘 판매량.
// 손익분기(고정비·레시피·객단가)가 안 갖춰지면 available=false + needs_setup.
export type DailyQuest = {
  id: string;
  date: string;           // 오늘 (YYYY-MM-DD) — 자정마다 리셋
  title: string;
  reward: number;
  available: boolean;     // 목표를 낼 수 있나
  needs_setup: boolean;   // 손익분기 설정이 필요
  message?: string;       // 설정 안내 문구
  desc?: string;
  goal?: number;          // 하루 목표 잔수
  progress?: number;      // 오늘 판매량(목표에서 멈춤)
  sold_cups?: number;     // 오늘 실제 판매 잔 수 (sale + prepaid)
  prepaid_cups?: number;  // 단골 선불 결제로 '팔면 바로' 잡힌 실시간 잔 수
  sale_cups?: number;     // POS 연동/파일 업로드로 잡힌 잔 수
  avg_ticket?: number;
  target_daily_revenue?: number;
  done?: boolean;
  claimed?: boolean;
  claimable?: boolean;
  awarded?: number;       // claim 응답에만
  balance?: number;       // claim 응답에만
};

// 이번 주 본전 스트릭 — 날짜별 ✓/✗ 달력. 손익분기 미설정이면 available=false.
export type BreakevenStreakDay = {
  date: string;       // YYYY-MM-DD
  weekday: string;    // 월·화·…
  done: boolean;      // 그날 본전 넘겼나
  is_today: boolean;
  is_future: boolean; // 아직 안 온 날
};
export type BreakevenStreak = {
  available: boolean;
  goal: number | null;
  days: BreakevenStreakDay[];
  achieved_count: number;
};

export type QuestBoard = {
  week: string; // 이번 주 월요일 (YYYY-MM-DD) — 월요일마다 리셋
  quests: Quest[];
  daily?: DailyQuest; // 오늘의 목표 (get_quests 응답에 함께 실림)
  breakeven_streak?: BreakevenStreak; // 이번 주 본전 달력
  awarded?: number; // claim 응답에만: 이번에 받은 코인
  balance?: number; // claim 응답에만: 수령 후 잔액
};

/** 주간 퀘스트 목록 (진행도·수령 여부 포함) */
export function getQuests(token?: string | null): Promise<QuestBoard> {
  return apiFetch<QuestBoard>('/api/v1/rewards/quests', { headers: authHeader(token) });
}

/** 달성한 퀘스트 보상 수령 */
export function claimQuest(questId: string, token?: string | null): Promise<QuestBoard> {
  return apiFetch<QuestBoard>(`/api/v1/rewards/quests/${questId}/claim`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

/** 오늘의 목표(일일 퀘스트) 단독 조회 — 홈 본전 카드가 쓴다 */
export function getDailyQuest(token?: string | null): Promise<DailyQuest> {
  return apiFetch<DailyQuest>('/api/v1/rewards/quests/daily', { headers: authHeader(token) });
}

/** 오늘의 목표(일일 퀘스트) 보상 수령 — 하루 1회 */
export function claimDailyQuest(token?: string | null): Promise<DailyQuest> {
  return apiFetch<DailyQuest>('/api/v1/rewards/quests/daily/claim', {
    method: 'POST',
    headers: authHeader(token),
  });
}
