// 디저트 관리 상태 — 디저트는 '메뉴'다.
//  · 디저트 자체(이름·판매가)는 메뉴 관리와 똑같이 백엔드 menus 테이블에 등록된다.
//  · 여기 남는 건 메뉴판이 다루지 않는 디저트 전용 정보뿐:
//      ① 매입가(완제품 사입가)  ② 입고 배치(수량+소비기한)  ③ 폐기 기록
//  · 모두 menuId(숫자)로 메뉴에 붙는다. 로컬 영구저장(AsyncStorage).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// 디저트로 표시된 메뉴의 추가 정보 (판매가·이름은 메뉴(DB)가 원본)
export type DessertMeta = {
  menuId: number;
  buyPrice: number; // 매입가(사입 원가)
};

export type Batch = {
  id: string;
  menuId: number;
  qty: number; // 남은 수량
  expiry: string; // 소비기한 'YYYY-MM-DD'
  createdAt: string;
};

export type WasteRecord = {
  id: string;
  menuId: number;
  name: string; // 기록 시점 이름 스냅샷 (메뉴가 삭제돼도 집계 유지)
  qty: number;
  unitCost: number; // 폐기 시점 매입가
  date: string; // 폐기일 'YYYY-MM-DD'
};

type DessertData = {
  metas: DessertMeta[];
  batches: Batch[];
  wastes: WasteRecord[];
};

// 예전(관리 탭 시절) 로컬 전용 디저트 데이터 — 메뉴로 옮겨 심을 때만 잠깐 쓴다
export type LegacyDessert = { id: string; name: string; sellPrice: number; buyPrice: number };
type LegacyData = {
  desserts: LegacyDessert[];
  batches: { id: string; dessertId: string; qty: number; expiry: string; createdAt: string }[];
  wastes: {
    id: string;
    dessertId: string;
    dessertName: string;
    qty: number;
    unitCost: number;
    date: string;
  }[];
};

const EMPTY: DessertData = { metas: [], batches: [], wastes: [] };

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 소비기한까지 남은 일수 (오늘=0, 지남=음수)
export function daysLeft(expiry: string): number {
  const [y, m, d] = expiry.split('-').map(Number);
  const exp = new Date(y, (m || 1) - 1, d || 1).getTime();
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((exp - t0) / 86_400_000);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

type Ctx = DessertData & {
  ready: boolean;
  /** 이 메뉴가 디저트로 등록돼 있으면 매입가, 아니면 null */
  buyPriceOf: (menuId: number) => number | null;
  /** 디저트 표시 + 매입가 저장 (메뉴 등록/수정 후 호출) */
  markDessert: (menuId: number, buyPrice: number) => void;
  /** 디저트 해제 — 메뉴 삭제 시 로컬 배치도 함께 정리 (폐기 집계는 유지) */
  unmarkDessert: (menuId: number) => void;
  addBatch: (menuId: number, qty: number, expiry: string) => void;
  sell: (batchId: string, qty: number) => void; // 판매(팔림) — 수량만 차감
  waste: (batchId: string, qty: number, name: string) => void; // 폐기 — 차감 + 손실 기록
  /** 아직 메뉴로 옮기지 못한 예전 로컬 디저트 (없으면 null) */
  legacy: LegacyData | null;
  /** 예전 디저트 id → 새로 만든 메뉴 id 매핑을 넘기면 배치·폐기까지 이관하고 예전 저장소를 비운다 */
  applyLegacy: (idMap: Record<string, number>, buyPrices: Record<string, number>) => void;
};

const DessertContext = createContext<Ctx | null>(null);
const STORAGE_KEY = 'simplem:desserts:v2';
const LEGACY_KEY = 'simplem:desserts';

export function DessertProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DessertData>(EMPTY);
  const [legacy, setLegacy] = useState<LegacyData | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [raw, legacyRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(LEGACY_KEY),
        ]);
        if (raw) setData(JSON.parse(raw) as DessertData);
        if (legacyRaw) {
          const parsed = JSON.parse(legacyRaw) as LegacyData;
          // 옮길 게 없으면(빈 껍데기) 바로 정리
          if (parsed?.desserts?.length) setLegacy(parsed);
          else AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
        }
      } catch (err) {
        console.error('디저트 데이터 복원 실패:', err);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persist = useCallback((next: DessertData) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  }, []);

  const buyPriceMap = useMemo(
    () => Object.fromEntries(data.metas.map((m) => [m.menuId, m.buyPrice])) as Record<number, number>,
    [data.metas]
  );

  const buyPriceOf = useCallback(
    (menuId: number) => (menuId in buyPriceMap ? buyPriceMap[menuId] : null),
    [buyPriceMap]
  );

  const markDessert = useCallback(
    (menuId: number, buyPrice: number) => {
      setData((prev) =>
        persist({
          ...prev,
          metas: prev.metas.some((m) => m.menuId === menuId)
            ? prev.metas.map((m) => (m.menuId === menuId ? { ...m, buyPrice } : m))
            : [...prev.metas, { menuId, buyPrice }],
        })
      );
    },
    [persist]
  );

  const unmarkDessert = useCallback(
    (menuId: number) => {
      // 폐기 기록(wastes)은 회계 집계를 위해 남긴다. 디저트 표시와 재고 배치만 제거.
      setData((prev) =>
        persist({
          ...prev,
          metas: prev.metas.filter((m) => m.menuId !== menuId),
          batches: prev.batches.filter((b) => b.menuId !== menuId),
        })
      );
    },
    [persist]
  );

  const addBatch = useCallback(
    (menuId: number, qty: number, expiry: string) => {
      setData((prev) =>
        persist({
          ...prev,
          batches: [...prev.batches, { id: uid(), menuId, qty, expiry, createdAt: todayISO() }],
        })
      );
    },
    [persist]
  );

  const sell = useCallback(
    (batchId: string, qty: number) => {
      setData((prev) =>
        persist({
          ...prev,
          batches: prev.batches
            .map((b) => (b.id === batchId ? { ...b, qty: Math.max(0, b.qty - qty) } : b))
            .filter((b) => b.qty > 0),
        })
      );
    },
    [persist]
  );

  const waste = useCallback(
    (batchId: string, qty: number, name: string) => {
      setData((prev) => {
        const batch = prev.batches.find((b) => b.id === batchId);
        if (!batch) return prev;
        const record: WasteRecord = {
          id: uid(),
          menuId: batch.menuId,
          name,
          qty,
          unitCost: prev.metas.find((m) => m.menuId === batch.menuId)?.buyPrice ?? 0,
          date: todayISO(),
        };
        return persist({
          ...prev,
          batches: prev.batches
            .map((b) => (b.id === batchId ? { ...b, qty: Math.max(0, b.qty - qty) } : b))
            .filter((b) => b.qty > 0),
          wastes: [...prev.wastes, record],
        });
      });
    },
    [persist]
  );

  // 예전 로컬 디저트를 메뉴로 옮긴 뒤 호출 — 배치·폐기 기록의 소유자를 새 메뉴 id로 갈아끼운다
  const applyLegacy = useCallback(
    (idMap: Record<string, number>, buyPrices: Record<string, number>) => {
      if (!legacy) return;
      setData((prev) => {
        const metas = [...prev.metas];
        for (const [oldId, menuId] of Object.entries(idMap)) {
          if (metas.some((m) => m.menuId === menuId)) continue;
          metas.push({ menuId, buyPrice: buyPrices[oldId] ?? 0 });
        }
        const batches = [
          ...prev.batches,
          ...legacy.batches
            .filter((b) => idMap[b.dessertId] != null)
            .map((b) => ({
              id: b.id,
              menuId: idMap[b.dessertId],
              qty: b.qty,
              expiry: b.expiry,
              createdAt: b.createdAt,
            })),
        ];
        const wastes = [
          ...prev.wastes,
          ...legacy.wastes
            .filter((w) => idMap[w.dessertId] != null)
            .map((w) => ({
              id: w.id,
              menuId: idMap[w.dessertId],
              name: w.dessertName,
              qty: w.qty,
              unitCost: w.unitCost,
              date: w.date,
            })),
        ];
        return persist({ metas, batches, wastes });
      });
      setLegacy(null);
      AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
    },
    [legacy, persist]
  );

  return (
    <DessertContext.Provider
      value={{
        ...data,
        ready,
        buyPriceOf,
        markDessert,
        unmarkDessert,
        addBatch,
        sell,
        waste,
        legacy,
        applyLegacy,
      }}
    >
      {children}
    </DessertContext.Provider>
  );
}

export function useDesserts() {
  const ctx = useContext(DessertContext);
  if (!ctx) throw new Error('useDesserts must be used within DessertProvider');
  return ctx;
}
