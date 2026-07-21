// 프론트 B 담당 — 챗봇이 만든 문서 초안을 말풍선 아래에 바로 보여주는 카드
// content 스키마는 kind별로 다르므로(발주서·임금명세서·장부 …) 범용 렌더링한다:
//   스칼라 → 라벨:값 행 / 객체 → 섹션 + 행 / 배열 → 품목 블록 (10건 초과는 접어서 표시)
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ChatDocument } from '../../lib/api/chatbot';
import { formatValue, labelFor } from '../../lib/documentLabels';
import { colors, typography } from '../../theme';
import { PressableScale } from '../motion';

const MAX_ITEMS_COLLAPSED = 10;

const KIND_LABEL: Record<string, string> = {
  purchase_order: '발주서 초안',
  stocktake_sheet: '재고실사표',
  inspection_report: '검수확인서',
  monthly_ledger: '매입·매출 장부',
  vat_reference: '부가세 참고자료',
  payslip: '임금명세서 초안',
  employment_contract: '근로계약서 초안',
  management_report: 'AI 경영 리포트',
};

// 키·값 한글 표기는 공용 모듈(documentLabels)을 쓴다 — 서류 자동화 화면과 항상 동일하게.
const label = labelFor;
const fmt = formatValue;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 배열 품목 한 건 — 대표 필드(이름/메뉴/거래처/날짜)를 제목으로, 나머지는 요약 줄로 */
function ItemBlock({ item }: { item: Record<string, unknown> }) {
  const primaryKey = ['name', 'menu', 'employee_name', 'vendor', 'date', 'period'].find(
    (k) => item[k] !== null && item[k] !== undefined && item[k] !== '',
  );
  const detail = Object.entries(item)
    .filter(([k, v]) => k !== primaryKey && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${label(k)} ${fmt(k, v)}`)
    .join(' · ');
  return (
    <View style={styles.itemBlock}>
      {primaryKey && <Text style={styles.itemTitle}>{fmt(primaryKey, item[primaryKey])}</Text>}
      {!!detail && <Text style={styles.itemDetail}>{detail}</Text>}
    </View>
  );
}

function ArraySection({ name, list }: { name: string; list: unknown[] }) {
  const [expanded, setExpanded] = useState(false);
  if (list.length === 0) {
    return <Row k={name} v={`${label(name)} 없음`} onlyValue />;
  }
  const visible = expanded ? list : list.slice(0, MAX_ITEMS_COLLAPSED);
  const hidden = list.length - visible.length;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{label(name)} ({list.length}건)</Text>
      {visible.map((it, i) =>
        isPlainObject(it) ? (
          <ItemBlock key={i} item={it} />
        ) : (
          <Text key={i} style={styles.itemDetail}>{fmt(name, it)}</Text>
        ),
      )}
      {hidden > 0 && (
        <PressableScale onPress={() => setExpanded(true)}>
          <Text style={styles.moreText}>외 {hidden}건 더 보기</Text>
        </PressableScale>
      )}
    </View>
  );
}

function Row({ k, v, onlyValue }: { k: string; v: string; onlyValue?: boolean }) {
  return (
    <View style={styles.row}>
      {!onlyValue && <Text style={styles.rowLabel}>{label(k)}</Text>}
      <Text style={[styles.rowValue, onlyValue && { textAlign: 'left', flex: 1 }]}>{v}</Text>
    </View>
  );
}

function ObjectSection({ name, obj }: { name: string; obj: Record<string, unknown> }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{label(name)}</Text>
      {/* 중첩 배열·객체(일별 매출·베스트 메뉴·카테고리별 지출 등)도 재귀 렌더링 —
          그냥 Row로 찍으면 배열/객체가 "[object Object]"로 보인다 */}
      {Object.entries(obj).map(([k, v]) => renderField(k, v))}
    </View>
  );
}

/** AI 조언처럼 긴 문장은 라벨:값 행으로 찍으면 오른쪽 정렬 좁은 칸에 뭉개진다 — 전용 블록으로 */
function AdviceBlock({ text }: { text: string }) {
  return (
    <View style={styles.adviceWrap}>
      <View style={styles.adviceHeader}>
        <Ionicons name="cafe-outline" size={13} color={colors.pointOrange} />
        <Text style={styles.adviceTitle}>브루의 조언</Text>
      </View>
      <Text style={styles.adviceText}>{text}</Text>
    </View>
  );
}

/** content의 한 필드를 타입에 맞는 컴포넌트로 — 배열→품목 블록, 객체→섹션, 스칼라→행 */
function renderField(key: string, value: unknown) {
  if (key === 'ai_advice' && typeof value === 'string') return <AdviceBlock key={key} text={value} />;
  if (Array.isArray(value)) return <ArraySection key={key} name={key} list={value} />;
  if (isPlainObject(value)) return <ObjectSection key={key} name={key} obj={value} />;
  return <Row key={key} k={key} v={fmt(key, value)} />;
}

export default function DocumentCard({ doc }: { doc: ChatDocument }) {
  const entries = Object.entries(doc.content ?? {});
  const note = typeof doc.content?.note === 'string' ? (doc.content.note as string) : null;
  // 경영 리포트처럼 항목이 많은 문서는 채팅을 길게 밀어내므로 접힌 상태로 시작한다
  const isLong = doc.kind === 'management_report' || entries.length > 6;
  const [open, setOpen] = useState(!isLong);

  return (
    <View style={styles.card}>
      <PressableScale style={styles.header} onPress={() => setOpen((v) => !v)}>
        <View style={styles.headerIcon}>
          <Ionicons name="document-text-outline" size={16} color={colors.pointOrange} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.kindBadge}>{KIND_LABEL[doc.kind] ?? doc.kind}</Text>
          <Text style={styles.title} numberOfLines={2}>{doc.title}</Text>
        </View>
        {doc.status === 'draft' && (
          <View style={styles.draftBadge}>
            <Text style={styles.draftBadgeText}>초안</Text>
          </View>
        )}
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={colors.mochaBrown}
        />
      </PressableScale>

      {open ? (
        <>
          <View style={styles.body}>
            {entries.map(([key, value]) =>
              key === 'note' ? null : renderField(key, value), // note는 하단 안내문으로 별도 표시
            )}
          </View>

          {note && (
            <View style={styles.noteWrap}>
              <Ionicons name="information-circle-outline" size={13} color={colors.mochaBrown} />
              <Text style={styles.noteText}>{note}</Text>
            </View>
          )}
        </>
      ) : (
        <PressableScale style={styles.collapsedHint} onPress={() => setOpen(true)}>
          <Text style={styles.collapsedHintText}>내용 펼쳐보기</Text>
        </PressableScale>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.coffeeCream,
    borderBottomWidth: 1,
    borderBottomColor: colors.mutedSand,
  },
  headerIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindBadge: { ...typography.L5, color: colors.pointOrange, fontWeight: '700' },
  title: { ...typography.L4, color: colors.espressoBrown, marginTop: 1 },
  draftBadge: {
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  draftBadgeText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  body: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { ...typography.L5, fontSize: 11, color: colors.mochaBrown },
  rowValue: {
    ...typography.L5,
    fontSize: 11,
    fontWeight: '700',
    color: colors.espressoBrown,
    flexShrink: 1,
    textAlign: 'right',
  },
  section: { marginTop: 4, gap: 5 },
  sectionTitle: { ...typography.L4, color: colors.espressoBrown },
  itemBlock: {
    backgroundColor: colors.creamSand,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 2,
  },
  itemTitle: { ...typography.L5, fontSize: 11, fontWeight: '700', color: colors.espressoBrown },
  itemDetail: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16 },
  adviceWrap: {
    backgroundColor: colors.coffeeCream,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    gap: 6,
  },
  adviceHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  adviceTitle: { ...typography.L5, fontWeight: '700', color: colors.pointOrange },
  adviceText: { ...typography.L5, fontSize: 12, color: colors.espressoBrown, lineHeight: 19 },
  collapsedHint: { paddingVertical: 9, alignItems: 'center' },
  collapsedHintText: { ...typography.L5, fontWeight: '700', color: colors.pointOrange },
  moreText: {
    ...typography.L5,
    fontWeight: '700',
    color: colors.pointOrange,
    paddingVertical: 4,
    textAlign: 'center',
  },
  noteWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.mutedSand,
    backgroundColor: colors.creamSand,
  },
  noteText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 14 },
});
