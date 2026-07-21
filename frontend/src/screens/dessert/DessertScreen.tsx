// 디저트 관리 (신규) — 관리 허브에서 진입.
//  ① 소비기한 임박 알림  ② 이번 달 폐기 손실 금액화  ③ 디저트 마진 순위
// 데이터는 DessertContext(로컬 영구저장). 입고 시 소비기한만 입력하면 임박 알림이 뜬다.
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Badge, Button, Card, Divider, ProgressBar, Screen, SectionTitle } from '../../components/ui';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { colors, typography } from '../../theme';
import { daysLeft, todayISO, useDesserts, type Batch, type Dessert } from '../../dessert/DessertContext';

const won = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');
const toNum = (s: string) => Number(s.replace(/[^\d]/g, '')) || 0;

// 날짜 관용 입력: "2026.8.1" "20260801" "2026-8-1" → "2026-08-01" (틀리면 null)
function normalizeDate(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  let y: number, m: number, d: number;
  const parts = raw.split(/\D+/).filter(Boolean);
  if (parts.length === 3 && parts[0].length === 4) {
    [y, m, d] = parts.map(Number);
  } else if (digits.length === 8) {
    [y, m, d] = [Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8))];
  } else return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 소비기한 상태 → 라벨/색
function expiryState(dl: number): { label: string; tone: 'danger' | 'orange' | 'neutral' | 'green' } {
  if (dl < 0) return { label: `${-dl}일 지남`, tone: 'danger' };
  if (dl === 0) return { label: '오늘까지', tone: 'danger' };
  if (dl === 1) return { label: '내일까지', tone: 'orange' };
  if (dl <= 3) return { label: `D-${dl}`, tone: 'orange' };
  return { label: `D-${dl}`, tone: 'green' };
}

export default function DessertScreen() {
  const { desserts, batches, wastes, addDessert, addBatch, removeDessert, sell, waste } = useDesserts();

  const [stockOpen, setStockOpen] = useState(false); // 입고 모달
  const [newOpen, setNewOpen] = useState(false);     // 새 디저트 모달

  const nameById = useMemo(() => Object.fromEntries(desserts.map((d) => [d.id, d.name])), [desserts]);

  // ① 임박 알림 — 소비기한 임박/오늘/지남 배치 (오래된 순)
  const urgent = useMemo(
    () =>
      batches
        .map((b) => ({ ...b, dl: daysLeft(b.expiry), name: nameById[b.dessertId] ?? '(삭제됨)' }))
        .filter((b) => b.dl <= 1)
        .sort((a, b) => a.dl - b.dl),
    [batches, nameById]
  );

  // ② 이번 달 폐기 손실
  const ym = todayISO().slice(0, 7);
  const monthWaste = useMemo(() => {
    const rows = wastes.filter((w) => w.date.startsWith(ym));
    return {
      total: rows.reduce((s, w) => s + w.qty * w.unitCost, 0),
      count: rows.reduce((s, w) => s + w.qty, 0),
      byName: rows.reduce<Record<string, number>>((acc, w) => {
        acc[w.dessertName] = (acc[w.dessertName] ?? 0) + w.qty * w.unitCost;
        return acc;
      }, {}),
    };
  }, [wastes, ym]);
  const topWasteName = Object.entries(monthWaste.byName).sort((a, b) => b[1] - a[1])[0]?.[0];

  // ③ 디저트별 마진 순위 (+ 이번 달 폐기 수량으로 "빼는 것 고려" 신호)
  const ranking = useMemo(() => {
    const wasteCountByDessert = wastes
      .filter((w) => w.date.startsWith(ym))
      .reduce<Record<string, number>>((acc, w) => {
        acc[w.dessertId] = (acc[w.dessertId] ?? 0) + w.qty;
        return acc;
      }, {});
    return desserts
      .map((d) => {
        const margin = d.sellPrice - d.buyPrice;
        const rate = d.sellPrice > 0 ? (margin / d.sellPrice) * 100 : 0;
        const wasteCnt = wasteCountByDessert[d.id] ?? 0;
        return { ...d, margin, rate, wasteCnt, drop: rate < 35 && wasteCnt >= 3 };
      })
      .sort((a, b) => b.margin - a.margin);
  }, [desserts, wastes, ym]);
  const maxMargin = Math.max(1, ...ranking.map((r) => r.margin));

  return (
    <Screen>
      {/* ① 소비기한 임박 알림 */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>소비기한 임박 알림</SectionTitle>
          <Badge label={`${urgent.length}건`} tone={urgent.length ? 'danger' : 'neutral'} />
        </View>
        {urgent.length === 0 ? (
          <Text style={styles.empty}>임박한 디저트가 없어요. 여유롭게 판매하세요 ☕</Text>
        ) : (
          <View style={{ marginTop: 10, gap: 10 }}>
            {urgent.map((b) => {
              const st = expiryState(b.dl);
              return (
                <View key={b.id} style={styles.urgentRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.urgentText}>
                      {st.label} 팔아야 할 <Text style={styles.urgentName}>{b.name} {b.qty}개</Text>
                    </Text>
                    <Text style={styles.urgentSub}>소비기한 {b.expiry}</Text>
                  </View>
                  <PressableScale style={[styles.miniBtn, styles.sellBtn]} onPress={() => sell(b.id, 1)} to={0.9}>
                    <Text style={styles.sellBtnText}>판매 −1</Text>
                  </PressableScale>
                  <PressableScale
                    style={[styles.miniBtn, styles.wasteBtn]}
                    onPress={() =>
                      confirmDialog(`${b.name} 1개를 폐기로 기록할까요? (손실에 반영)`, {
                        confirmLabel: '폐기',
                        destructive: true,
                        onConfirm: () => waste(b.id, 1),
                      })
                    }
                    to={0.9}
                  >
                    <Text style={styles.wasteBtnText}>폐기</Text>
                  </PressableScale>
                </View>
              );
            })}
          </View>
        )}
      </Card>

      {/* ② 이번 달 폐기 손실 */}
      <Card>
        <SectionTitle>이번 달 폐기로 나간 돈</SectionTitle>
        <Text style={styles.wasteMoney}>{won(monthWaste.total)}</Text>
        <Text style={styles.wasteSub}>
          폐기 {monthWaste.count}개{topWasteName ? ` · 가장 많이 버린 건 ‘${topWasteName}’` : ''}
        </Text>
        {monthWaste.total > 0 ? (
          <View style={styles.noteBox}>
            <Ionicons name="trending-down-outline" size={15} color="#B23B2E" />
            <Text style={styles.noteText}>
              막연한 손실을 숫자로 — 폐기가 잦은 디저트는 입고량을 줄이거나 마진 순위에서 확인해 보세요.
            </Text>
          </View>
        ) : (
          <Text style={styles.empty}>이번 달 폐기 기록이 없어요. 좋아요! 👏</Text>
        )}
      </Card>

      {/* ③ 디저트 마진 순위 */}
      <Card>
        <View style={styles.rowBetween}>
          <SectionTitle>디저트 마진 순위</SectionTitle>
          <Text style={styles.hint}>판매가 − 매입가</Text>
        </View>
        {ranking.length === 0 ? (
          <Text style={styles.empty}>등록된 디저트가 없어요. 아래에서 새 디저트를 등록하세요.</Text>
        ) : (
          <View style={{ marginTop: 10, gap: 12 }}>
            {ranking.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <View style={[styles.rankRow, { marginTop: i > 0 ? 12 : 0 }]}>
                  <Text style={styles.rankNum}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.rankName}>{r.name}</Text>
                      <Text style={[styles.rankMargin, { color: r.margin >= 0 ? colors.trendGreenText : '#B23B2E' }]}>
                        {won(r.margin)}
                      </Text>
                    </View>
                    <View style={{ marginTop: 5 }}>
                      <ProgressBar ratio={Math.max(0, r.margin) / maxMargin} tone={r.rate < 35 ? 'danger' : 'green'} />
                    </View>
                    <View style={[styles.rowBetween, { marginTop: 5 }]}>
                      <Text style={styles.rankSub}>
                        마진율 {r.rate.toFixed(0)}% · 판매 {won(r.sellPrice)} / 매입 {won(r.buyPrice)}
                      </Text>
                      {r.wasteCnt > 0 ? <Text style={styles.rankWaste}>이번 달 폐기 {r.wasteCnt}개</Text> : null}
                    </View>
                    {r.drop ? (
                      <View style={styles.dropFlag}>
                        <Ionicons name="alert-circle" size={13} color="#B23B2E" />
                        <Text style={styles.dropText}>마진 낮고 폐기 많음 — 메뉴에서 빼는 것 고려</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </Card>

      {/* 재고 현황 (디저트별 배치) */}
      <Card>
        <SectionTitle>재고 현황</SectionTitle>
        {batches.length === 0 ? (
          <Text style={styles.empty}>입고된 디저트가 없어요. ‘디저트 입고’로 소비기한을 등록하세요.</Text>
        ) : (
          <View style={{ marginTop: 8 }}>
            {desserts.map((d) => {
              const bs = batches.filter((b) => b.dessertId === d.id).sort((a, b) => daysLeft(a.expiry) - daysLeft(b.expiry));
              if (bs.length === 0) return null;
              return (
                <View key={d.id} style={{ marginTop: 8 }}>
                  <Text style={styles.stockName}>{d.name}</Text>
                  {bs.map((b) => {
                    const st = expiryState(daysLeft(b.expiry));
                    return (
                      <View key={b.id} style={styles.stockRow}>
                        <Badge label={st.label} tone={st.tone === 'green' ? 'neutral' : st.tone} />
                        <Text style={styles.stockQty}>{b.qty}개</Text>
                        <Text style={styles.stockExp}>~{b.expiry}</Text>
                        <View style={{ flex: 1 }} />
                        <PressableScale style={[styles.miniBtn, styles.sellBtn]} onPress={() => sell(b.id, 1)} to={0.9}>
                          <Text style={styles.sellBtnText}>판매</Text>
                        </PressableScale>
                        <PressableScale
                          style={[styles.miniBtn, styles.wasteBtn]}
                          onPress={() => waste(b.id, 1)}
                          to={0.9}
                        >
                          <Text style={styles.wasteBtnText}>폐기</Text>
                        </PressableScale>
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </View>
        )}
      </Card>

      {/* 액션 버튼 */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="＋ 디저트 입고" style={{ flex: 1 }} onPress={() => setStockOpen(true)} />
        <Button label="새 디저트 등록" variant="secondary" style={{ flex: 1 }} onPress={() => setNewOpen(true)} />
      </View>

      <StockInModal
        visible={stockOpen}
        onClose={() => setStockOpen(false)}
        desserts={desserts}
        onSubmit={(dessertId, qty, expiry) => {
          addBatch(dessertId, qty, expiry);
          setStockOpen(false);
          toast('입고 완료', `${nameById[dessertId]} ${qty}개 · 소비기한 ${expiry}`);
        }}
      />
      <NewDessertModal
        visible={newOpen}
        onClose={() => setNewOpen(false)}
        onSubmit={(name, sell, buy) => {
          addDessert(name, sell, buy);
          setNewOpen(false);
          toast('디저트 등록', `${name} 등록 완료 (마진 ${won(sell - buy)})`);
        }}
        desserts={desserts}
        onRemove={(id, name) =>
          confirmDialog(`‘${name}’를 삭제할까요? 재고 배치도 함께 삭제돼요. (폐기 집계는 유지)`, {
            confirmLabel: '삭제',
            destructive: true,
            onConfirm: () => removeDessert(id),
          })
        }
      />
    </Screen>
  );
}

// ── 디저트 입고 모달 ─────────────────────────────
function StockInModal({
  visible,
  onClose,
  desserts,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  desserts: Dessert[];
  onSubmit: (dessertId: string, qty: number, expiry: string) => void;
}) {
  const [dessertId, setDessertId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [expiry, setExpiry] = useState('');

  const submit = () => {
    if (!dessertId) return toast('입고', '디저트를 선택해 주세요.');
    const q = toNum(qty);
    if (q <= 0) return toast('입고', '수량을 입력해 주세요.');
    const iso = normalizeDate(expiry);
    if (!iso) return toast('입고', '소비기한을 올바르게 입력해 주세요. (예: 2026-07-25)');
    onSubmit(dessertId, q, iso);
    setDessertId(null);
    setQty('');
    setExpiry('');
  };

  return (
    <FormModal visible={visible} title="디저트 입고" onClose={onClose}>
      <Text style={styles.fieldLabel}>디저트 선택</Text>
      {desserts.length === 0 ? (
        <Text style={styles.empty}>먼저 ‘새 디저트 등록’으로 디저트를 만들어 주세요.</Text>
      ) : (
        <View style={styles.chips}>
          {desserts.map((d) => (
            <PressableScale
              key={d.id}
              style={[styles.chip, dessertId === d.id && styles.chipActive]}
              onPress={() => setDessertId(d.id)}
              to={0.95}
            >
              <Text style={[styles.chipText, dessertId === d.id && styles.chipTextActive]}>{d.name}</Text>
            </PressableScale>
          ))}
        </View>
      )}
      <Field label="수량" value={qty} onChangeText={setQty} placeholder="예: 5" keyboardType="numeric" />
      <Field label="소비기한" value={expiry} onChangeText={setExpiry} placeholder="예: 2026-07-25" />
      <Button label="입고하기" style={{ marginTop: 16 }} onPress={submit} />
    </FormModal>
  );
}

// ── 새 디저트 등록 모달 ───────────────────────────
function NewDessertModal({
  visible,
  onClose,
  onSubmit,
  desserts,
  onRemove,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (name: string, sellPrice: number, buyPrice: number) => void;
  desserts: Dessert[];
  onRemove: (id: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [sell, setSell] = useState('');
  const [buy, setBuy] = useState('');

  const submit = () => {
    if (!name.trim()) return toast('등록', '디저트 이름을 입력해 주세요.');
    const s = toNum(sell);
    const b = toNum(buy);
    if (s <= 0 || b <= 0) return toast('등록', '판매가와 매입가를 입력해 주세요.');
    onSubmit(name.trim(), s, b);
    setName('');
    setSell('');
    setBuy('');
  };

  return (
    <FormModal visible={visible} title="새 디저트 등록" onClose={onClose}>
      <Field label="디저트 이름" value={name} onChangeText={setName} placeholder="예: 티라미수" />
      <Field label="판매가 (원)" value={sell} onChangeText={setSell} placeholder="예: 6500" keyboardType="numeric" />
      <Field label="매입가 (원)" value={buy} onChangeText={setBuy} placeholder="예: 3200" keyboardType="numeric" />
      <Button label="등록하기" style={{ marginTop: 16 }} onPress={submit} />

      {desserts.length > 0 ? (
        <>
          <Divider style={{ marginTop: 16 }} />
          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>등록된 디저트</Text>
          {desserts.map((d) => (
            <View key={d.id} style={styles.manageRow}>
              <Text style={styles.manageName}>{d.name}</Text>
              <Text style={styles.manageSub}>
                {won(d.sellPrice)} / {won(d.buyPrice)}
              </Text>
              <Pressable onPress={() => onRemove(d.id, d.name)} hitSlop={8} style={{ padding: 4 }}>
                <Ionicons name="trash-outline" size={16} color="#B23B2E" />
              </Pressable>
            </View>
          ))}
        </>
      ) : null}
    </FormModal>
  );
}

// ── 공용 모달/입력 ───────────────────────────────
function FormModal({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalCard}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={colors.espressoBrown} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric';
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(140,111,86,0.5)"
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { ...typography.L5, color: colors.mochaBrown },
  empty: { ...typography.L5, color: colors.mochaBrown, marginTop: 10, lineHeight: 17 },

  // 임박 알림
  urgentRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  urgentText: { ...typography.L4, color: colors.espressoBrown },
  urgentName: { fontWeight: '900', color: '#B23B2E' },
  urgentSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  // 폐기 손실
  wasteMoney: { ...typography.L2, color: '#B23B2E', marginTop: 8 },
  wasteSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: '#F7E7E3', borderRadius: 10, padding: 10, marginTop: 12,
  },
  noteText: { ...typography.L5, color: '#8A4038', flex: 1, lineHeight: 16 },

  // 마진 순위
  rankRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rankNum: { ...typography.L3, color: colors.mochaBrown, width: 20, textAlign: 'center' },
  rankName: { ...typography.L4, color: colors.espressoBrown, fontWeight: '800' },
  rankMargin: { ...typography.L4, fontWeight: '900' },
  rankSub: { ...typography.L5, color: colors.mochaBrown, flex: 1 },
  rankWaste: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },
  dropFlag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F7E7E3', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, marginTop: 6, alignSelf: 'flex-start',
  },
  dropText: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },

  // 재고
  stockName: { ...typography.L4, color: colors.espressoBrown, fontWeight: '800', marginTop: 6 },
  stockRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  stockQty: { ...typography.L4, color: colors.espressoBrown },
  stockExp: { ...typography.L5, color: colors.mochaBrown },

  // 미니 버튼
  miniBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9 },
  sellBtn: { backgroundColor: colors.espressoBrown },
  sellBtnText: { ...typography.L5, color: colors.white, fontWeight: '800' },
  wasteBtn: { backgroundColor: '#F6DED8' },
  wasteBtnText: { ...typography.L5, color: '#B23B2E', fontWeight: '800' },

  // 모달/입력
  modalOverlay: { flex: 1, backgroundColor: colors.black40, justifyContent: 'center', paddingHorizontal: 24 },
  modalCard: { backgroundColor: colors.creamSand, borderRadius: 20, padding: 18, maxHeight: '84%' },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modalTitle: { ...typography.L1, color: colors.espressoBrown },
  fieldLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700', marginTop: 12 },
  input: {
    ...typography.L4, fontWeight: '500', color: colors.espressoBrown,
    backgroundColor: colors.coffeeCream, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, marginTop: 6,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
    backgroundColor: colors.white, borderWidth: 1.2, borderColor: 'rgba(140,111,86,0.18)',
  },
  chipActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  chipText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  chipTextActive: { color: colors.white },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  manageName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  manageSub: { ...typography.L5, color: colors.mochaBrown },
});
