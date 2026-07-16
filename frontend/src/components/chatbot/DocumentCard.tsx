// 프론트 B 담당 — 챗봇이 만든 문서 초안을 말풍선 아래에 바로 보여주는 카드
// content 스키마는 kind별로 다르므로(발주서·임금명세서·장부 …) 범용 렌더링한다:
//   스칼라 → 라벨:값 행 / 객체 → 섹션 + 행 / 배열 → 품목 블록 (10건 초과는 접어서 표시)
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ChatDocument } from '../../lib/api/chatbot';
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

// 백엔드 content의 영문 키 → 사장님용 한글 라벨 (없는 키는 그대로 노출)
const FIELD_LABEL: Record<string, string> = {
  date: '작성일',
  items: '품목',
  total_estimated: '예상 발주 총액',
  name: '이름',
  unit: '단위',
  current_quantity: '현재 수량',
  safety_quantity: '안전재고',
  suggested_quantity: '제안 수량',
  unit_price: '단가',
  estimated_amount: '예상 금액',
  book_quantity: '장부 수량',
  counted_quantity: '실사 수량',
  difference: '차이',
  inspection_date: '검수일',
  vendor: '거래처',
  delivery_date: '납품일',
  quantity: '수량',
  condition: '상태',
  inspector_sign: '검수자 서명',
  period: '기간',
  purchases: '매입 내역',
  sales: '매출 내역',
  doc_type: '문서 종류',
  subtotal: '공급가액',
  tax: '세액',
  total: '합계',
  menu: '메뉴',
  total_price: '금액',
  purchase_total: '매입 합계',
  sales_total: '매출 합계',
  balance: '수지 (매출-매입)',
  employee_name: '직원',
  hourly_wage: '시급',
  work_hours: '근무시간',
  hours_source: '집계 방식',
  earnings: '지급 내역',
  base_pay: '기본급',
  weekly_holiday_pay: '주휴수당',
  weekly_avg_hours: '주 평균 시간',
  gross: '지급 총액',
  deductions: '공제 내역',
  withholding_rate: '공제율(%)',
  withholding: '공제액',
  net_pay: '실지급액',
  calculation: '계산식',
  estimated_sales_vat: '매출세액(추정)',
  purchase_subtotal: '매입 공급가액',
  purchase_tax: '매입세액',
  purchase_document_count: '매입 문서 수',
  estimated_payable_vat: '납부세액(추정)',
  start: '시작',
  end: '종료',
  employer: '사업주',
  contract_period: '계약 기간',
  workplace: '근무 장소',
  duties: '업무 내용',
  working_conditions: '근로 조건',
  work_days_per_week: '주 근무일',
  work_hours_per_day: '일 근무시간',
  weekly_hours: '주 근무시간',
  rest: '휴게',
  weekly_holiday: '주휴일',
  annual_leave: '연차',
  wage: '임금',
  payment_day: '지급일',
  payment_method: '지급 방법',
  social_insurance: '4대보험',
  signatures: '서명',
  employee: '근로자',
  entries: '내역',
  year: '연도',
  total_gross: '지급 총액 합계',
  total_net: '실지급 합계',
  payslip_id: '명세서 ID',
  // 경영 리포트 (management_report)
  period_type: '리포트 종류',
  highlights: '핵심 요약',
  cups: '판매 잔 수',
  prev_total: '이전 기간',
  change_pct: '증감률(%)',
  daily_trend: '일별 매출',
  top_menus: '베스트 메뉴',
  document_count: '매입 문서 수',
  expenses: '기타 지출',
  by_category: '카테고리별 지출',
  category: '카테고리',
  amount: '금액',
  labor: '인건비',
  scheduled_hours: '스케줄 근무시간',
  estimated_cost: '인건비 추정',
  employee_count: '근무 직원 수',
  shift_count: '근무 건수',
  profit: '수익 추정',
  total_cost: '총 비용',
  estimated_profit: '추정 수익',
  margin_pct: '마진율(%)',
  inventory: '재고 현황',
  ingredient_count: '등록 재료 수',
  total_value: '재고 평가액',
  low_stock: '안전재고 이하',
  orders: '발주 진행',
  open_count: '진행 중 발주',
  open_amount: '발주 예상 금액',
  compliance_alerts: '갱신 임박 서류',
  expiry_date: '만료일',
  remind_before_days: '알림 시작(일 전)',
  memo: '메모',
  days_left: '남은 일수',
  status: '상태',
};

// 금액 키는 '원'을 붙여 읽기 쉽게
const MONEY_KEYS = new Set([
  'total_estimated', 'unit_price', 'estimated_amount', 'subtotal', 'tax', 'total',
  'total_price', 'purchase_total', 'sales_total', 'balance', 'hourly_wage', 'base_pay',
  'weekly_holiday_pay', 'gross', 'withholding', 'net_pay', 'estimated_sales_vat',
  'purchase_subtotal', 'purchase_tax', 'estimated_payable_vat', 'total_gross', 'total_net',
  'prev_total', 'estimated_cost', 'total_cost', 'estimated_profit', 'total_value',
  'open_amount', 'amount',
]);

const label = (key: string) => FIELD_LABEL[key] ?? key;

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    const n = v.toLocaleString('ko-KR');
    return MONEY_KEYS.has(key) ? `${n}원` : n;
  }
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}

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
      {Object.entries(obj).map(([k, v]) => (
        <Row key={k} k={k} v={fmt(k, v)} />
      ))}
    </View>
  );
}

export default function DocumentCard({ doc }: { doc: ChatDocument }) {
  const entries = Object.entries(doc.content ?? {});
  const note = typeof doc.content?.note === 'string' ? (doc.content.note as string) : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
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
      </View>

      <View style={styles.body}>
        {entries.map(([key, value]) => {
          if (key === 'note') return null; // 하단 안내문으로 별도 표시
          if (Array.isArray(value)) return <ArraySection key={key} name={key} list={value} />;
          if (isPlainObject(value)) return <ObjectSection key={key} name={key} obj={value} />;
          return <Row key={key} k={key} v={fmt(key, value)} />;
        })}
      </View>

      {note && (
        <View style={styles.noteWrap}>
          <Ionicons name="information-circle-outline" size={13} color={colors.mochaBrown} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
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
  itemDetail: { ...typography.L5, color: colors.mochaBrown, lineHeight: 14 },
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
