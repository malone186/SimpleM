// 메뉴 개선안 점검 (백엔드 B)
//
// 사장님은 메뉴를 자주 손본다 — 가격을 올리고, 안 나가는 메뉴를 빼고, 신메뉴를 넣는다.
// 그게 잘한 일인지는 다음 달 정산을 봐야 알 수 있는데, 이미 판매 기록과 원가가 있으니
// 바꾸기 전에 미리 계산해 볼 수 있다.
//
// 입구는 둘이다:
//   1. 새로 만든 메뉴판 사진 → 지금 메뉴와 대조해 무엇이 바뀌었는지 서버가 찾아낸다
//   2. 직접 고르기 → 가격을 손으로 바꾸거나 뺄 메뉴를 고른다
//
// 점검은 아무것도 저장하지 않는다. 반영은 결과 화면에서 '이대로 반영하기'를 눌러야 일어난다.
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import {
  applyMenuChanges,
  reviewMenuBoard,
  reviewMenuChanges,
  type MenuReviewItem,
  type MenuReviewResult,
} from '../../lib/api/menuReview';
import {
  buildApplyPayload,
  buildManualChanges,
  initialPicked,
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

const VERDICT_TONE = { good: 'green', watch: 'orange', risk: 'danger' } as const;
const VERDICT_ICON = { good: 'checkmark-circle', watch: 'alert-circle', risk: 'warning' } as const;

export default function MenuImprovementCheck({
  menus,
  onApplied,
}: {
  menus: EditableMenu[];
  onApplied: () => void;
}) {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<MenuReviewResult | null>(null);

  // 직접 고르기 상태 — 메뉴 id → 바꿀 가격(문자열), 뺄 메뉴 id 집합
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [drop, setDrop] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');

  // 결과에서 실제로 반영할 항목 (기본은 전부 켜되, 사진에서 추측한 '빼기'는 꺼 둔다)
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const openResult = (res: MenuReviewResult) => {
    setPicked(initialPicked(res.changes));
    setResult(res);
  };

  const reset = () => {
    setPrices({});
    setDrop(new Set());
    setNewName('');
    setNewPrice('');
  };

  /** 새 메뉴판 사진으로 확인 */
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

      setBusy(true);
      const a = p.assets[0];
      openResult(await reviewMenuBoard({ uri: a.uri, mimeType: a.mimeType, fileName: a.fileName }, token));
    } catch (e: any) {
      showAlert('확인하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  /** 직접 고른 내용을 변경 목록으로 (무엇을 거를지는 menuImprovementDraft가 정한다) */
  const manualChanges = useMemo(
    () => buildManualChanges(menus, prices, drop, newName, newPrice),
    [menus, prices, drop, newName, newPrice],
  );

  const runManual = async () => {
    if (!manualChanges.length) {
      showAlert('바꾼 내용이 없어요', '가격을 고치거나 뺄 메뉴를 골라 주세요.');
      return;
    }
    setBusy(true);
    try {
      const res = await reviewMenuChanges(manualChanges, token);
      setEditing(false);
      openResult(res);
    } catch (e: any) {
      showAlert('확인하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  /** 점검 결과 중 켜 둔 항목만 실제 메뉴에 반영 */
  const apply = async () => {
    const targets = buildApplyPayload(result?.changes ?? [], picked);
    if (!targets.length) {
      showAlert('반영할 항목이 없어요', '반영할 변경을 하나 이상 골라 주세요.');
      return;
    }
    setBusy(true);
    try {
      const res = await applyMenuChanges(targets, token);
      const lines: string[] = [];
      if (res.updated.length) lines.push(`가격 변경: ${res.updated.join(', ')}`);
      if (res.hidden.length) lines.push(`숨김: ${res.hidden.join(', ')} (판매 기록은 그대로 남아요)`);
      if (res.created.length) lines.push(`새 메뉴: ${res.created.join(', ')}`);
      if (res.warnings.length) lines.push('', '확인이 필요해요:', ...res.warnings.map((w) => `· ${w}`));
      showAlert('메뉴에 반영했어요', lines.join('\n') || '바뀐 내용이 없어요.');
      setResult(null);
      reset();
      onApplied();
    } catch (e: any) {
      showAlert('반영하지 못했어요', e?.message ?? '다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (item: MenuReviewItem) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  return (
    <>
      <Card tone="cream">
        <View style={styles.head}>
          <Ionicons name="pricetags-outline" size={18} color={colors.espressoBrown} />
          <Text style={styles.headText}>메뉴 바꾼 거 확인해 보기</Text>
        </View>
        <Text style={styles.desc}>
          가격을 올리거나 메뉴를 빼기 전에, 실제로 팔린 잔 수와 재료비로 계산해 봐요.
          손님이 얼마나 줄어도 괜찮은지까지 알려드려요.
        </Text>
        <View style={styles.btnRow}>
          <View style={styles.btnHalf}>
            <Button label="새 메뉴판 찍기" variant="secondary" onPress={() => pick('camera')} disabled={busy} />
          </View>
          <View style={styles.btnHalf}>
            <Button label="앨범에서" variant="secondary" onPress={() => pick('library')} disabled={busy} />
          </View>
        </View>
        <Button
          label="가격 직접 고쳐 보기"
          variant="ghost"
          onPress={() => setEditing(true)}
          disabled={busy}
          style={{ marginTop: 8 }}
        />
        {busy && !result && !editing && (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.espressoBrown} />
            <Text style={styles.busyText}>바뀐 점을 찾고 있어요…</Text>
          </View>
        )}
      </Card>

      {/* 직접 고르기 */}
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
          label={busy ? '계산 중…' : `${manualChanges.length}개 변경 확인해 보기`}
          onPress={runManual}
          disabled={busy || !manualChanges.length}
        />
      </SwipeDownModal>

      {/* 점검 결과 */}
      <SwipeDownModal visible={!!result} onClose={() => setResult(null)}>
        {result && (
          <>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{result.verdict_label}</Text>
              <Text style={styles.sheetSub}>최근 {result.days}일 판매·원가 기준</Text>
            </View>

            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: spacing.gridGap }}>
              <Text style={styles.comment}>{result.comment}</Text>

              {result.summary && result.changes.length > 0 && (
                <View style={styles.summary}>
                  <SummaryCell
                    label="한 달 남는 돈"
                    value={signedWon(result.summary.monthly_delta)}
                    tone={result.summary.monthly_delta >= 0 ? 'up' : 'down'}
                  />
                  <SummaryCell
                    label="잔당 평균 가격"
                    value={won(result.summary.avg_ticket_after)}
                    sub={`지금 ${won(result.summary.avg_ticket_before)}`}
                  />
                  <SummaryCell
                    label="메뉴 수"
                    value={`${result.summary.menu_count_after}개`}
                    sub={`지금 ${result.summary.menu_count_before}개`}
                  />
                </View>
              )}

              {result.changes.map((c) => (
                <ChangeCard key={keyOf(c)} item={c} on={picked.has(keyOf(c))} onToggle={() => toggle(c)} />
              ))}

              {!!result.unmatched.length && (
                <Text style={styles.note}>
                  못 찾은 메뉴: {result.unmatched.join(', ')}
                  {'\n'}등록된 이름과 같은지 확인해 주세요.
                </Text>
              )}
              {!!result.unchanged?.length && (
                <Text style={styles.note}>그대로인 메뉴 {result.unchanged.length}개는 넘어갔어요.</Text>
              )}
              {result.assumptions.map((a) => (
                <Text key={a} style={styles.assumption}>· {a}</Text>
              ))}
            </ScrollView>

            {result.changes.length > 0 && (
              <Button
                label={busy ? '반영 중…' : `고른 ${picked.size}개 메뉴에 반영하기`}
                onPress={apply}
                disabled={busy || picked.size === 0}
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

function ChangeCard({
  item,
  on,
  onToggle,
}: {
  item: MenuReviewItem;
  on: boolean;
  onToggle: () => void;
}) {
  const kindLabel = { price: '가격', add: '새 메뉴', remove: '빼기', cost: '원가' }[item.kind];

  return (
    <View style={[styles.card, !on && styles.cardOff]}>
      <PressableScale style={styles.cardHead} onPress={onToggle} to={0.98}>
        <Ionicons
          name={on ? 'checkbox' : 'square-outline'}
          size={19}
          color={on ? colors.espressoBrown : '#C4B5A5'}
        />
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        <Badge label={kindLabel} tone="neutral" />
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
        {item.before && item.after && (
          <Text style={styles.priceLine}>
            {won(item.before.price)} → <Text style={styles.priceNew}>{won(item.after.price)}</Text>
            {item.change_pct ? <Text style={styles.pct}>  {item.change_pct > 0 ? '+' : ''}{item.change_pct}%</Text> : null}
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
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btnHalf: { flex: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'center' },
  busyText: { ...typography.L5, color: colors.mochaBrown },

  sheetHead: { marginBottom: 8 },
  sheetTitle: { ...typography.L2, fontWeight: '800', color: colors.espressoBrown },
  sheetSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  // 직접 고르기
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
