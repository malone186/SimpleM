// 디저트 관리 전역 상태 — 로컬 영구저장(AsyncStorage).
//  ① 소비기한 관리: 입고 배치(수량+소비기한)를 쌓고, 임박/오늘/지남을 계산해 알림
//  ② 폐기 기록·금액화: 폐기 수량 × 매입가 = 손실액, 이번 달 합계
//  ③ 마진 순위: 디저트별 (판매가 − 매입가) 랭킹
// [단계적] 지금은 프론트 로컬 저장. 추후 백엔드(inventory 도메인) 연동으로 확장 가능.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type Dessert = {
  id: string;
  name: string;
  sellPrice: number; // 판매가
  buyPrice: number;  // 매입가(원가)
};

export type Batch = {
  id: string;
  dessertId: string;
  qty: number;       // 남은 수량
  expiry: string;    // 소비기한 'YYYY-MM-DD'
  createdAt: string;
};

export type WasteRecord = {
  id: string;
  dessertId: string;
  dessertName: string; // 기록 시점 이름 스냅샷 (디저트 삭제돼도 집계 유지)
  qty: number;
  unitCost: number;    // 폐기 시점 매입가
  date: string;        // 폐기일 'YYYY-MM-DD'
};

type DessertData = {
  desserts: Dessert[];
  batches: Batch[];
  wastes: WasteRecord[];
};

const EMPTY: DessertData = { desserts: [], batches: [], wastes: [] };

// 데모 편의를 위한 초기 샘플 (저장된 데이터가 하나도 없을 때만 1회 주입)
function seed(): DessertData {
  const t = new Date();
  const iso = (offset: number) => {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const d1: Dessert = { id: 'seed-tira', name: '티라미수', sellPrice: 6500, buyPrice: 3200 };
  const d2: Dessert = { id: 'seed-cheese', name: '치즈케이크', sellPrice: 6000, buyPrice: 3800 };
  const d3: Dessert = { id: 'seed-madeleine', name: '마들렌', sellPrice: 2800, buyPrice: 900 };
  return {
    desserts: [d1, d2, d3],
    batches: [
      { id: 'b1', dessertId: d1.id, qty: 3, expiry: iso(0), createdAt: iso(-1) },   // 오늘까지
      { id: 'b2', dessertId: d2.id, qty: 2, expiry: iso(1), createdAt: iso(-1) },   // 내일
      { id: 'b3', dessertId: d3.id, qty: 8, expiry: iso(4), createdAt: iso(0) },    // 여유
    ],
    wastes: [],
  };
}

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
  addDessert: (name: string, sellPrice: number, buyPrice: number) => string;
  updateDessert: (id: string, patch: Partial<Omit<Dessert, 'id'>>) => void;
  removeDessert: (id: string) => void;
  addBatch: (dessertId: string, qty: number, expiry: string) => void;
  sell: (batchId: string, qty: number) => void;   // 판매(팔림) — 수량만 차감
  waste: (batchId: string, qty: number) => void;   // 폐기 — 차감 + 손실 기록
};

const DessertContext = createContext<Ctx | null>(null);
const STORAGE_KEY = 'simplem:desserts';

export function DessertProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DessertData>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        setData(raw ? (JSON.parse(raw) as DessertData) : seed());
      } catch (err) {
        console.error('디저트 데이터 복원 실패:', err);
        setData(seed());
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persist = useCallback((next: DessertData) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  }, []);

  const addDessert = useCallback(
    (name: string, sellPrice: number, buyPrice: number) => {
      const id = uid();
      setData((prev) => persist({ ...prev, desserts: [...prev.desserts, { id, name, sellPrice, buyPrice }] }));
      return id;
    },
    [persist]
  );

  const updateDessert = useCallback(
    (id: string, patch: Partial<Omit<Dessert, 'id'>>) => {
      setData((prev) =>
        persist({ ...prev, desserts: prev.desserts.map((d) => (d.id === id ? { ...d, ...patch } : d)) })
      );
    },
    [persist]
  );

  const removeDessert = useCallback(
    (id: string) => {
      // 폐기 기록(wastes)은 회계 집계를 위해 남긴다. 디저트 정의와 재고 배치만 제거.
      setData((prev) =>
        persist({
          ...prev,
          desserts: prev.desserts.filter((d) => d.id !== id),
          batches: prev.batches.filter((b) => b.dessertId !== id),
        })
      );
    },
    [persist]
  );

  const addBatch = useCallback(
    (dessertId: string, qty: number, expiry: string) => {
      setData((prev) =>
        persist({
          ...prev,
          batches: [...prev.batches, { id: uid(), dessertId, qty, expiry, createdAt: todayISO() }],
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
    (batchId: string, qty: number) => {
      setData((prev) => {
        const batch = prev.batches.find((b) => b.id === batchId);
        if (!batch) return prev;
        const dessert = prev.desserts.find((d) => d.id === batch.dessertId);
        const record: WasteRecord = {
          id: uid(),
          dessertId: batch.dessertId,
          dessertName: dessert?.name ?? '(삭제된 디저트)',
          qty,
          unitCost: dessert?.buyPrice ?? 0,
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

  return (
    <DessertContext.Provider
      value={{ ...data, ready, addDessert, updateDessert, removeDessert, addBatch, sell, waste }}
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
