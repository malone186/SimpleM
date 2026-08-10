// AI 메뉴 개선 (백엔드 B)
//
// 사장님은 메뉴를 자주 손보지만, '무엇을' 손봐야 하는지는 아무도 말해 주지 않는다.
// 이미 팔린 잔 수와 재료비가 있으니 브루가 먼저 찾아 줄 수 있다.
//
// 세 가지 입구 — 앞의 것이 이 화면의 본체다:
//   1. 개선안 받기: 팔수록 손해인 메뉴의 적정 가격, 안 나가는 메뉴 정리, 신메뉴 아이디어
//   2. 새 메뉴판 사진: 이미 바꾼 메뉴판을 찍으면 지금 메뉴와 대조해 바뀐 점을 채점
//   3. 직접 고치기: 가격을 손으로 바꿔 보고 결과만 확인
//
// 셋 다 아무것도 저장하지 않는다. 반영은 결과에서 '반영하기'를 눌러야 일어난다 —
// 브루가 권했다고 값이 저절로 바뀌면, 사장님은 자기 가격표를 믿을 수 없게 된다.
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import {
  applyMenuChanges,
  getMenuSuggestions,
  reviewMenuBoard,
  reviewMenuChanges,
  type MenuReviewItem,
  type MenuReviewResult,
  type MenuSuggestionResult,
} from '../../lib/api/menuReview';
import {
  buildApplyPayload,
  buildManualChanges,
  initialPicked,
  isActionable,
  keyOf,
  type EditableMenu,
} from './menuImprovementDraft';
import { showAlert } from '../../lib/ui/alert';
import { colors, spacing, typography } from '../../theme';
import { Badge, Button, Card, Divider } from '../ui';
import { SwipeDownModal } from '../ui/SwipeDownModal';
import { PressableScale } from '../motion';

const ACCENT = '#C07030';

export type { EditableMenu };

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const signedWon = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${won(Math.abs(n))}`;

const VERDICT_ICON = { good: 'checkmark-circle', watch: 'alert-circle', risk: 'warning' } as const;

/** 결과 시트는 '추천'과 '점검' 둘 다 그린다 — 항목 모양이 같아 카드를 두 벌 만들 이유가 없다 */
type Sheet =
  | { mode: 'suggest'; data: MenuSuggestionResult }
  | { mode: 'review'; data: MenuReviewResult };

type SheetItem = MenuReviewItem & { why?: string; actionable?: boolean; source?: string };

const itemsOf = (s: Sheet): SheetItem[] =>
  s.mode === 'suggest' ? s.data.suggestions : s.data.changes;

export default function MenuImprovementCheck({
  menus,
  onApplied,
}: {
  menus: EditableMenu[];
  onApplied: () => void;
}) {
  const { token } = useAuth();
  const [busy, setBusy] = useState<'' | 'suggest' | 'photo' | 'manual' | 'apply'>('');
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  // 직접 고치기 상태 — 메뉴 id → 바꿀 가격(문자열), 뺄 메뉴 id 집합
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [drop, setDrop] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');

  // 결과에서 실제로 반영할 항목
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const open = (next: Sheet) => {
    // 추천은 사장님이 보고 고르는 것이라 기본으로 켜 두지 않는다.
    // 사장님이 적은 안(점검)은 이미 사장님의 뜻이므로 켜 둔다.
    setPicked(initialPicked(itemsOf(next), { preselect: next.mode === 'review' }));
    setSheet(next);
  };

  const reset = () => {
    setPrices({});
    setDrop(new Set());
    setNewName('');
    setNewPrice('');
  };

  /** ① AI 개선안 받기 */
  const suggest = async () => {
    setBusy('suggest');
    try {
      open({ mode: 'suggest', data: await getMenuSuggestions(token) });
    } catch (e: any) {
      showAlert('개선안을 만들지 못했어요', e?.message ?? '잠시 뒤 다시 시도해 주세요.');
    } finally {
      setBusy('');
    }
  };

  /** ② 새 메뉴판 사진으로 확인 */
  const pick = async (from: 'camera' | 'library') => {
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showAlert('카메라 권한이 필요해요', '설정에서 카메라 권한을 켜 주세요.');
          return;
        }
      }
      const p =
        from === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (p.canceled || !p.assets?.[0]) return;

      setBusy('photo');
      const a = p.assets[0];
      const data = await reviewMenuBoard(
        { uri: a.uri, mimeType: a.mimeType, fileName: a.fileName },
        token,
      );
      open({ mode: 'review', data });
    } catch (e: any) {
      showAlert('확인하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy('');
    }
  };

  /** ③ 직접 고친 내용 (무엇을 거를지는 menuImprovementDraft가 정한다) */
  const manualChanges = useMemo(
    () => buildManualChanges(menus, prices, drop, newName, newPrice),
    [menus, prices, drop, newName, newPrice],
  );

  const runManual = async () => {
    if (!manualChanges.length) {
      showAlert('바꾼 내용이 없어요', '가격을 고치거나 뺄 메뉴를 골라 주세요.');
      return;
    }
    setBusy('manual');
    try {
      const data = await reviewMenuChanges(manualChanges, token);
      setEditing(false);
      open({ mode: 'review', data });
    } catch (e: any) {
      showAlert('확인하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy('');
    }
  };

  /** 켜 둔 항목만 실제 메뉴에 반영 */
  const apply = async () => {
    const targets = buildApplyPayload(sheet ? itemsOf(sheet) : [], picked);
    if (!targets.length) {
      showAlert('반영할 항목이 없어요', '반영할 변경을 하나 이상 골라 주세요.');
      return;
    }
    setBusy('apply');
    try {
      const res = await applyMenuChanges(targets, token);
      const lines: string[] = [];
      if (res.updated.length) lines.push(`가격 변경: ${res.updated.join(', ')}`);
      if (res.hidden.length) lines.push(`숨김: ${res.hidden.join(', ')} (판매 기록은 그대로 남아요)`);
      if (res.created.length) lines.push(`새 메뉴: ${res.created.join(', ')}`);
      if (res.warnings.length) lines.push('', '확인이 필요해요:', ...res.warnings.map((w) => `· ${w}`));
      showAlert('메뉴에 반영했어요', lines.join('\n') || '바뀐 내용이 없어요.');
      setSheet(null);
      reset();
      onApplied();
    } catch (e: any) {
      showAlert('반영하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy('');
    }
  };

  const toggle = (item: MenuReviewItem) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const items = sheet ? itemsOf(sheet) : [];
  const canApply = items.some(isActionable);

  return (
    <>
      <Card tone="cream">
        <View style={styles.head}>
          <Ionicons name="sparkles-outline" size={18} color={colors.espressoBrown} />
          <Text style={styles.headText}>AI 메뉴 개선 추천</Text>
        </View>
        <Text style={styles.desc}>
          팔린 잔 수와 재료비를 보고 뭘 바꾸면 좋을지 찾아드려요. 얼마로 올리면 되는지,
          어떤 메뉴를 빼면 되는지, 새로 넣을 만한 메뉴까지요.
        </Text>

        <Button
          label={busy === 'suggest' ? '찾는 중…' : '개선안 받기'}
          onPress={suggest}
          disabled={!!busy}
          style={{ marginTop: 12 }}
        />

        {/* 이미 바꿔 본 사장님을 위한 두 갈래 — 추천을 가리지 않게 작게 둔다 */}
        <View style={styles.subRow}>
          <PressableScale style={styles.subBtn} onPress={() => pick('camera')} to={0.97}>
            <Ionicons name="camera-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.subText}>바꾼 메뉴판 찍기</Text>
          </PressableScale>
          <Text style={styles.subDot}>·</Text>
          <PressableScale style={styles.subBtn} onPress={() => setEditing(true)} to={0.97}>
            <Ionicons name="create-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.subText}>가격 직접 고쳐 보기</Text>
          </PressableScale>
        </View>

        {!!busy && !sheet && !editing && (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.espressoBrown} />
            <Text style={styles.busyText}>
              {busy === 'suggest' ? '메뉴를 하나씩 따져 보고 있어요…' : '메뉴판을 읽고 있어요…'}
            </Text>
          </View>
        )}
      </Card>

      {/* 직접 고치기 */}
      <SwipeDownModal visible={editing} onClose={() => setEditing(false)}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>어떻게 바꿔 보셨어요?</Text>
          <Text style={styles.sheetSub}>바꿀 것만 고치면 돼요</Text>
        </View>

        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: spacing.gridGap }}>
          {menus.map((m) => {
            const dropped = drop.has(m.id);
            return (
              <View key={m.id} style={[styles.editRow, dropped && styles.editRowOff]}>
                <Text style={[styles.editName, dropped && styles.strike]} numberOfLines={1}>
                  {m.name}
                </Text>
                <Text style={styles.editNow}>{won(m.selling_price)}</Text>
                <Ionicons name="arrow-forward" size={13} color={colors.mochaBrown} />
                <TextInput
                  style={[styles.editInput, dropped && styles.editInputOff]}
                  value={prices[m.id] ?? ''}
                  editable={!dropped}
                  onChangeText={(t) => setPrices((p) => ({ ...p, [m.id]: t.replace(/[^\d]/g, '') }))}
                  keyboardType="number-pad"
                  placeholder="그대로"
                  placeholderTextColor="#B9A896"
                />
                <PressableScale
                  onPress={() =>
                    setDrop((prev) => {
                      const next = new Set(prev);
                      next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                      return next;
                    })
                  }
                  style={styles.dropBtn}
                  to={0.92}
                >
                  <Ionicons
                    name={dropped ? 'arrow-undo' : 'trash-outline'}
                    size={15}
                    color={dropped ? ACCENT : colors.mochaBrown}
                  />
                </PressableScale>
              </View>
            );
          })}

          <Divider style={{ marginVertical: 10 }} />
          <Text style={styles.newLabel}>새로 넣을 메뉴가 있다면</Text>
          <View style={styles.newRow}>
            <TextInput
              style={[styles.editInput, styles.newName]}
              value={newName}
              onChangeText={setNewName}
              placeholder="메뉴 이름"
              placeholderTextColor="#B9A896"
            />
            <TextInput
              style={styles.editInput}
              value={newPrice}
              onChangeText={(t) => setNewPrice(t.replace(/[^\d]/g, ''))}
              keyboardType="number-pad"
              placeholder="가격"
              placeholderTextColor="#B9A896"
            />
          </View>
        </ScrollView>

        <Button
          label={busy === 'manual' ? '계산 중…' : `${manualChanges.length}개 변경 확인해 보기`}
          onPress={runManual}
          disabled={!!busy || !manualChanges.length}
        />
      </SwipeDownModal>

      {/* 결과 — 추천과 점검이 같은 시트를 쓴다 */}
      <SwipeDownModal visible={!!sheet} onClose={() => setSheet(null)}>
        {sheet && (
          <>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>
                {sheet.mode === 'suggest' ? sheet.data.headline : sheet.data.verdict_label}
              </Text>
              <Text style={styles.sheetSub}>최근 {sheet.data.days}일 판매·재료비 기준</Text>
            </View>

            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: spacing.gridGap }}>
              <Text style={styles.comment}>{sheet.data.comment}</Text>

              {sheet.mode === 'review' && sheet.data.summary && sheet.data.changes.length > 0 && (
                <View style={styles.summary}>
                  <SummaryCell
                    label="한 달 남는 돈"
                    value={signedWon(sheet.data.summary.monthly_delta)}
                    tone={sheet.data.summary.monthly_delta >= 0 ? 'up' : 'down'}
                  />
                  <SummaryCell
                    label="잔당 평균 가격"
                    value={won(sheet.data.summary.avg_ticket_after)}
                    sub={`지금 ${won(sheet.data.summary.avg_ticket_before)}`}
                  />
                  <SummaryCell
                    label="메뉴 수"
                    value={`${sheet.data.summary.menu_count_after}개`}
                    sub={`지금 ${sheet.data.summary.menu_count_before}개`}
                  />
                </View>
              )}

              {items.map((c) => (
                <ChangeCard
                  key={keyOf(c)}
                  item={c}
                  on={picked.has(keyOf(c))}
                  onToggle={() => toggle(c)}
                />
              ))}

              {sheet.mode === 'review' && !!sheet.data.unmatched.length && (
                <Text style={styles.note}>
                  못 찾은 메뉴: {sheet.data.unmatched.join(', ')}
                  {'\n'}등록된 이름과 같은지 확인해 주세요.
                </Text>
              )}
              {sheet.mode === 'review' && !!sheet.data.unchanged?.length && (
                <Text style={styles.note}>
                  그대로인 메뉴 {sheet.data.unchanged.length}개는 넘어갔어요.
                </Text>
              )}
              {sheet.data.assumptions.map((a) => (
                <Text key={a} style={styles.assumption}>· {a}</Text>
              ))}
            </ScrollView>

            {canApply && (
              <Button
                label={busy === 'apply' ? '반영 중…' : `고른 ${picked.size}개 메뉴에 반영하기`}
                onPress={apply}
                disabled={!!busy || picked.size === 0}
              />
            )}
          </>
        )}
      </SwipeDownModal>
    </>
  );
}

function SummaryCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down';
}) {
  return (
    <View style={styles.sumCell}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text
        style={[
          styles.sumValue,
          tone === 'up' && { color: colors.trendGreenText },
          tone === 'down' && { color: '#B23B2E' },
        ]}
      >
        {value}
      </Text>
      {!!sub && <Text style={styles.sumSub}>{sub}</Text>}
    </View>
  );
}

const KIND_LABEL: Record<string, string> = {
  price: '가격',
  add: '새 메뉴',
  remove: '빼기',
  cost: '원가',
  info: '먼저 할 일',
};

function ChangeCard({
  item,
  on,
  onToggle,
}: {
  item: SheetItem;
  on: boolean;
  onToggle: () => void;
}) {
  // 반영할 수 없는 안내 항목은 체크박스를 주지 않는다 — 눌러도 아무 일이 없으면 고장으로 보인다
  const selectable = isActionable(item);

  return (
    <View style={[styles.card, selectable && !on && styles.cardOff]}>
      <PressableScale
        style={styles.cardHead}
        onPress={selectable ? onToggle : undefined}
        disabled={!selectable}
        to={selectable ? 0.98 : 1}
      >
        {selectable ? (
          <Ionicons
            name={on ? 'checkbox' : 'square-outline'}
            size={19}
            color={on ? colors.espressoBrown : '#C4B5A5'}
          />
        ) : (
          <Ionicons name="information-circle" size={19} color={ACCENT} />
        )}
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        <Badge label={KIND_LABEL[item.kind] ?? item.kind} tone="neutral" />
        {item.source === 'ai' && <Badge label="AI 제안" tone="orange" />}
        <View style={{ marginLeft: 'auto' }}>
          <Ionicons
            name={VERDICT_ICON[item.verdict]}
            size={17}
            color={
              item.verdict === 'good' ? colors.trendGreenText : item.verdict === 'risk' ? '#B23B2E' : ACCENT
            }
          />
        </View>
      </PressableScale>

      <View style={styles.cardBody}>
        {/* 왜 권하는지가 먼저다 — 결과부터 보여주면 근거 없는 지시로 읽힌다 */}
        {!!item.why && <Text style={styles.why}>{item.why}</Text>}

        {item.before && item.after && (
          <Text style={styles.priceLine}>
            {won(item.before.price)} → <Text style={styles.priceNew}>{won(item.after.price)}</Text>
            {item.change_pct ? (
              <Text style={styles.pct}>  {item.change_pct > 0 ? '+' : ''}{item.change_pct}%</Text>
            ) : null}
          </Text>
        )}
        {item.kind === 'add' && item.after && (
          <Text style={styles.priceLine}>{won(item.after.price)}</Text>
        )}

        <Text style={[styles.headline, item.verdict === 'risk' && { color: '#B23B2E' }]}>
          {item.headline}
        </Text>
        <Text style={styles.reason}>{item.reason}</Text>

        {/* 가격을 올릴 때 사장님이 진짜 궁금해하는 숫자 — 눈에 띄게 따로 뽑는다 */}
        {item.breakeven_drop_pct != null && (
          <View style={styles.hero}>
            <Text style={styles.heroValue}>{item.breakeven_drop_pct}%</Text>
            <Text style={styles.heroLabel}>
              손님이 이만큼 줄어도 본전{'\n'}
              <Text style={styles.heroSub}>{item.breakeven_drop_cups}잔까지</Text>
            </Text>
          </View>
        )}
        {item.breakeven_gain_pct != null && (
          <View style={styles.hero}>
            <Text style={styles.heroValue}>+{item.breakeven_gain_pct}%</Text>
            <Text style={styles.heroLabel}>
              이만큼 더 팔아야 본전{'\n'}
              <Text style={styles.heroSub}>{item.breakeven_gain_cups}잔 더</Text>
            </Text>
          </View>
        )}

        {item.notes.map((n) => (
          <Text key={n} style={styles.cardNote}>· {n}</Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText: { ...typography.L3, fontWeight: '800', color: colors.espressoBrown },
  desc: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 18 },
  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  subBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  subText: { ...typography.L5, color: colors.mochaBrown, textDecorationLine: 'underline' },
  subDot: { ...typography.L5, color: '#C4B5A5' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'center' },
  busyText: { ...typography.L5, color: colors.mochaBrown },

  sheetHead: { marginBottom: 8 },
  sheetTitle: { ...typography.L2, fontWeight: '800', color: colors.espressoBrown },
  sheetSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  // 직접 고치기
  editRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.white, borderRadius: 12, padding: 10, marginBottom: 6,
  },
  editRowOff: { opacity: 0.55 },
  editName: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown, flex: 1 },
  strike: { textDecorationLine: 'line-through' },
  editNow: { ...typography.L5, color: colors.mochaBrown },
  editInput: {
    ...typography.L5, color: colors.espressoBrown, minWidth: 68, textAlign: 'right',
    borderWidth: 1, borderColor: '#DCD2C6', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.white,
  },
  editInputOff: { backgroundColor: '#F1EBE3' },
  dropBtn: { padding: 4 },
  newLabel: { ...typography.L5, color: colors.mochaBrown, marginBottom: 6 },
  newRow: { flexDirection: 'row', gap: 8 },
  newName: { flex: 1, textAlign: 'left' },

  // 결과
  comment: { ...typography.L4, color: colors.espressoBrown, lineHeight: 21, marginBottom: 10 },
  summary: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  sumCell: { flex: 1, backgroundColor: colors.white, borderRadius: 12, padding: 10 },
  sumLabel: { ...typography.L5, color: colors.mochaBrown },
  sumValue: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown, marginTop: 3 },
  sumSub: { ...typography.L5, color: '#A2917F', marginTop: 1 },

  card: { backgroundColor: colors.white, borderRadius: 14, padding: 12, marginBottom: 8 },
  cardOff: { opacity: 0.55 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardName: { ...typography.L4, fontWeight: '700', color: colors.espressoBrown, flexShrink: 1 },
  cardBody: { marginTop: 8, paddingLeft: 25 },
  why: { ...typography.L5, color: colors.espressoBrown, lineHeight: 18, marginBottom: 6 },
  priceLine: { ...typography.L5, color: colors.mochaBrown },
  priceNew: { color: colors.espressoBrown, fontWeight: '800' },
  pct: { color: ACCENT, fontWeight: '700' },
  headline: { ...typography.L4, fontWeight: '800', color: colors.espressoBrown, marginTop: 4 },
  reason: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18, marginTop: 3 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8,
    backgroundColor: '#FBF3EA', borderRadius: 12, padding: 10,
  },
  heroValue: { ...typography.L2, fontWeight: '800', color: ACCENT },
  heroLabel: { ...typography.L5, color: colors.espressoBrown, lineHeight: 17 },
  heroSub: { color: colors.mochaBrown },

  cardNote: { ...typography.L5, color: '#A2917F', lineHeight: 17, marginTop: 6 },
  note: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, marginTop: 6 },
  assumption: { ...typography.L5, color: '#A2917F', lineHeight: 17, marginTop: 4 },
});
