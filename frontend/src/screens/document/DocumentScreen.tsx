// 서류 자동화 (ERP-12) — 백엔드 /chatbot/documents·compliance 실연동
// 문서 초안 생성(발주서·실사표·장부·부가세·임금명세서·근로계약서) + 생성 문서 열람 + 갱신 만료 알림
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Card, Divider, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import {
  ComplianceItem,
  GeneratedDocument,
  KIND_LABELS,
  addCompliance,
  createContract,
  createMonthlyLedger,
  createPayslip,
  createPurchaseOrder,
  createStocktakeSheet,
  createVatReference,
  deleteCompliance,
  listCompliance,
  listDocuments,
} from '../../lib/api/documents';
import { colors, typography } from '../../theme';

// content JSON을 읽기 좋은 줄로 펼친다 (kind별 스키마가 달라 범용 렌더러 사용)
const KEY_LABELS: Record<string, string> = {
  date: '날짜', items: '품목', note: '안내', total_estimated: '예상 총액',
  name: '이름', unit: '단위', current_quantity: '현재고', safety_quantity: '안전재고',
  suggested_quantity: '제안 수량', unit_price: '단가', estimated_amount: '예상 금액',
  book_quantity: '장부 수량', counted_quantity: '실사 수량', difference: '차이',
  vendor: '거래처', delivery_date: '납품일', inspection_date: '검수일', condition: '상태',
  quantity: '수량', period: '기간', purchases: '매입', sales: '매출',
  purchase_total: '매입 합계', sales_total: '매출 합계', balance: '잔액',
  employee_name: '직원', hourly_wage: '시급', work_hours: '근무시간', hours_source: '집계 방식',
  earnings: '지급 내역', base_pay: '기본급', weekly_holiday_pay: '주휴수당',
  weekly_avg_hours: '주평균 시간', gross: '지급 총액', deductions: '공제 내역',
  withholding_rate: '공제율(%)', withholding: '공제액', net_pay: '실지급액', calculation: '계산식',
  estimated_sales_vat: '매출세액(추정)', purchase_subtotal: '매입 공급가', purchase_tax: '매입세액',
  purchase_document_count: '매입 문서 수', estimated_payable_vat: '예상 납부세액',
  contract_period: '계약 기간', start: '시작', end: '종료', workplace: '근무 장소', duties: '업무',
  working_conditions: '근로 조건', work_days_per_week: '주 근무일', work_hours_per_day: '일 근무시간',
  weekly_hours: '주 근무시간', rest: '휴게', weekly_holiday: '주휴일', annual_leave: '연차',
  wage: '임금', payment_day: '지급일', payment_method: '지급 방법', social_insurance: '4대보험',
  total_gross: '지급 총계', total_net: '실지급 총계', employer: '사업주',
  doc_type: '문서 종류', subtotal: '공급가액', tax: '세액', total: '합계', menu: '메뉴',
  total_price: '금액', source_document: '원본 문서', spec: '규격', signatures: '서명',
  inspector_sign: '검수자 서명',
};
const label = (k: string) => KEY_LABELS[k] ?? k;
const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
};

function ContentRows({ content, depth = 0 }: { content: Record<string, unknown>; depth?: number }) {
  return (
    <View style={{ marginLeft: depth * 10 }}>
      {Object.entries(content).map(([key, value]) => {
        if (Array.isArray(value)) {
          return (
            <View key={key} style={styles.block}>
              <Text style={styles.rowKey}>{label(key)} ({value.length}건)</Text>
              {value.map((row, i) => (
                <Text key={i} style={styles.itemLine}>
                  · {typeof row === 'object' && row !== null
                    ? Object.entries(row as Record<string, unknown>)
                        .filter(([, v2]) => v2 !== null && v2 !== '' && v2 !== undefined)
                        .map(([k2, v2]) => `${label(k2)} ${fmt(v2)}`)
                        .join(' / ')
                    : fmt(row)}
                </Text>
              ))}
            </View>
          );
        }
        if (typeof value === 'object' && value !== null) {
          return (
            <View key={key} style={styles.block}>
              <Text style={styles.rowKey}>{label(key)}</Text>
              <ContentRows content={value as Record<string, unknown>} depth={depth + 1} />
            </View>
          );
        }
        return (
          <View key={key} style={styles.kvRow}>
            <Text style={styles.rowKey}>{label(key)}</Text>
            <Text style={styles.rowValue}>{fmt(value)}</Text>
          </View>
        );
      })}
    </View>
  );
}

export default function DocumentScreen() {
  const { token } = useAuth();
  const [docs, setDocs] = useState<GeneratedDocument[]>([]);
  const [renewals, setRenewals] = useState<ComplianceItem[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 생성 중인 템플릿 id
  const [openForm, setOpenForm] = useState<string | null>(null);

  // 임금명세서·근로계약서·갱신 등록 폼 입력
  const now = new Date();
  const [empName, setEmpName] = useState('');
  const [payYear, setPayYear] = useState(String(now.getFullYear()));
  const [payMonth, setPayMonth] = useState(String(now.getMonth() + 1));
  const [ctName, setCtName] = useState('');
  const [ctWage, setCtWage] = useState('');
  const [ctStart, setCtStart] = useState('');
  const [cpName, setCpName] = useState('');
  const [cpExpiry, setCpExpiry] = useState('');

  const reload = useCallback(() => {
    if (!token) return;
    listDocuments(token).then(setDocs).catch(() => {});
    listCompliance(token).then(setRenewals).catch(() => {});
  }, [token]);

  useEffect(() => { reload(); }, [reload]);

  const run = async (id: string, fn: () => Promise<GeneratedDocument>) => {
    if (!token) return toast('로그인 필요', '서류 생성은 로그인 후 가능합니다.');
    setBusy(id);
    try {
      const doc = await fn();
      reload();
      setOpenDocId(doc.id);
      setOpenForm(null);
      toast('초안 생성 완료', `${doc.title} — 아래 '생성된 문서'에서 확인하세요.`);
    } catch (e) {
      toast('생성 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(null);
    }
  };

  const addRenewal = async () => {
    if (!token) return;
    if (!cpName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(cpExpiry))
      return toast('입력 확인', '서류 이름과 만료일(YYYY-MM-DD)을 입력하세요.');
    try {
      await addCompliance(token, { name: cpName.trim(), expiry_date: cpExpiry });
      setCpName(''); setCpExpiry(''); setOpenForm(null);
      reload();
    } catch (e) {
      toast('등록 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const removeRenewal = async (item: ComplianceItem) => {
    if (!token) return;
    try {
      await deleteCompliance(token, item.id);
      reload();
    } catch {
      toast('삭제 실패', '잠시 후 다시 시도해 주세요.');
    }
  };

  const quarterRange = () => {
    const q = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), q * 3, 1);
    const end = new Date(now.getFullYear(), q * 3 + 3, 1);
    // toISOString()은 UTC 기준이라 KST 자정이 전날로 밀린다 — 로컬 날짜로 직접 포맷
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [iso(start), iso(end)] as const;
  };

  const dueTone = (s: ComplianceItem['status']) => (s === 'expired' ? 'danger' : s === 'due_soon' ? 'orange' : 'green');

  return (
    <Screen>
      <ScreenTitle title="서류 자동화" subtitle="시스템 데이터로 서류 초안을 만들어드려요" />

      <Card tone="cream">
        <View style={styles.noticeRow}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.mochaBrown} />
          <Text style={styles.noticeText}>
            모든 서류는 <Text style={{ fontWeight: '700' }}>초안(draft)</Text>입니다. 발주·급여 지급 등
            실제 실행은 내용 확인 후 직접 진행하세요.
          </Text>
        </View>
      </Card>

      {/* 정기 갱신 알림 — 보건증·위생교육·계약 만료 추적 */}
      <Card>
        <View style={styles.headRow}>
          <SectionTitle>갱신 만료 알림</SectionTitle>
          <PressableScale onPress={() => setOpenForm(openForm === 'renewal' ? null : 'renewal')}>
            <Text style={styles.linkText}>{openForm === 'renewal' ? '닫기' : '+ 등록'}</Text>
          </PressableScale>
        </View>
        {openForm === 'renewal' && (
          <View style={styles.form}>
            <TextInput style={styles.input} placeholder="서류 이름 (예: 보건증-홍길동)" value={cpName} onChangeText={setCpName} />
            <TextInput style={styles.input} placeholder="만료일 (YYYY-MM-DD)" value={cpExpiry} onChangeText={setCpExpiry} />
            <PressableScale style={styles.smallBtn} onPress={addRenewal}>
              <Text style={styles.btnText}>등록</Text>
            </PressableScale>
          </View>
        )}
        {renewals.length === 0 ? (
          <Text style={styles.emptyText}>등록된 갱신 서류가 없어요. 보건증·위생교육 수료증·임대차계약 만료일을 등록해 두면 미리 알려드려요.</Text>
        ) : (
          renewals.map((r) => (
            <View key={r.id} style={styles.renewalRow}>
              <Badge label={r.days_left < 0 ? `${-r.days_left}일 지남` : `D-${r.days_left}`} tone={dueTone(r.status)} />
              <Text style={styles.renewalName}>{r.name}</Text>
              <Text style={styles.renewalDate}>{r.expiry_date}</Text>
              <PressableScale onPress={() => removeRenewal(r)}>
                <Ionicons name="close-circle-outline" size={18} color={colors.mochaBrown} />
              </PressableScale>
            </View>
          ))
        )}
      </Card>

      {/* 문서 생성 */}
      <SectionTitle>문서 만들기</SectionTitle>

      <Card>
        <TemplateRow icon="cart-outline" name="발주서" desc="안전재고 이하 재료를 자동 추출해 수량 제안"
          busy={busy === 'po'} onPress={() => run('po', () => createPurchaseOrder(token!))} />
        <Divider />
        <TemplateRow icon="clipboard-outline" name="재고실사표" desc="장부 수량이 채워진 실사용 시트"
          busy={busy === 'st'} onPress={() => run('st', () => createStocktakeSheet(token!))} />
        <Divider />
        <TemplateRow icon="book-outline" name={`매입·매출 장부 (${now.getMonth() + 1}월)`} desc="확정 OCR 문서·판매 기록 월 집계"
          busy={busy === 'lg'} onPress={() => run('lg', () => createMonthlyLedger(token!, now.getFullYear(), now.getMonth() + 1))} />
        <Divider />
        <TemplateRow icon="calculator-outline" name="부가세 참고자료 (이번 분기)" desc="참고용 집계 — 최종 신고는 세무사·홈택스 확인"
          busy={busy === 'vat'} onPress={() => { const [s, e] = quarterRange(); run('vat', () => createVatReference(token!, s, e)); }} />
      </Card>

      {/* 임금명세서 */}
      <Card>
        <TemplateRow icon="cash-outline" name="임금명세서" desc="근무 스케줄 자동 집계 → 기본급·주휴수당·공제 계산"
          busy={busy === 'pay'} actionLabel={openForm === 'pay' ? '닫기' : '입력'}
          onPress={() => setOpenForm(openForm === 'pay' ? null : 'pay')} />
        {openForm === 'pay' && (
          <View style={styles.form}>
            <TextInput style={styles.input} placeholder="직원 이름" value={empName} onChangeText={setEmpName} />
            <View style={styles.formRow}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="연도" keyboardType="numeric" value={payYear} onChangeText={setPayYear} />
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="월" keyboardType="numeric" value={payMonth} onChangeText={setPayMonth} />
            </View>
            <PressableScale style={styles.smallBtn} onPress={() => {
              if (!empName.trim()) return toast('입력 확인', '직원 이름을 입력하세요.');
              run('pay', () => createPayslip(token!, { employee_name: empName.trim(), year: Number(payYear), month: Number(payMonth) }));
            }}>
              <Text style={styles.btnText}>초안 생성</Text>
            </PressableScale>
          </View>
        )}
      </Card>

      {/* 근로계약서 */}
      <Card>
        <TemplateRow icon="document-text-outline" name="근로계약서" desc="근로기준법 필수 기재사항을 채운 표준 초안"
          busy={busy === 'ct'} actionLabel={openForm === 'ct' ? '닫기' : '입력'}
          onPress={() => setOpenForm(openForm === 'ct' ? null : 'ct')} />
        {openForm === 'ct' && (
          <View style={styles.form}>
            <TextInput style={styles.input} placeholder="직원 이름" value={ctName} onChangeText={setCtName} />
            <View style={styles.formRow}>
              <TextInput style={[styles.input, { flex: 1 }]} placeholder="시급 (원)" keyboardType="numeric" value={ctWage} onChangeText={setCtWage} />
              <TextInput style={[styles.input, { flex: 1.4 }]} placeholder="시작일 YYYY-MM-DD" value={ctStart} onChangeText={setCtStart} />
            </View>
            <PressableScale style={styles.smallBtn} onPress={() => {
              if (!ctName.trim() || !Number(ctWage) || !/^\d{4}-\d{2}-\d{2}$/.test(ctStart))
                return toast('입력 확인', '이름·시급·시작일(YYYY-MM-DD)을 입력하세요.');
              run('ct', () => createContract(token!, { employee_name: ctName.trim(), hourly_wage: Number(ctWage), start_date: ctStart }));
            }}>
              <Text style={styles.btnText}>초안 생성</Text>
            </PressableScale>
          </View>
        )}
      </Card>

      {/* 생성된 문서 */}
      <SectionTitle>생성된 문서</SectionTitle>
      {docs.length === 0 ? (
        <Card><Text style={styles.emptyText}>아직 생성된 문서가 없어요. 위에서 초안을 만들어 보세요.</Text></Card>
      ) : (
        docs.map((d) => (
          <Card key={d.id}>
            <PressableScale onPress={() => setOpenDocId(openDocId === d.id ? null : d.id)}>
              <View style={styles.docRow}>
                <Badge label={KIND_LABELS[d.kind] ?? d.kind} tone="neutral" />
                <Text style={styles.docTitle} numberOfLines={1}>{d.title}</Text>
                <Ionicons name={openDocId === d.id ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mochaBrown} />
              </View>
            </PressableScale>
            {openDocId === d.id && (
              <View style={styles.docBody}>
                <ContentRows content={d.content} />
              </View>
            )}
          </Card>
        ))
      )}
    </Screen>
  );
}

function TemplateRow({ icon, name, desc, busy, onPress, actionLabel }: {
  icon: keyof typeof Ionicons.glyphMap; name: string; desc: string;
  busy: boolean; onPress: () => void; actionLabel?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.iconBox}>
        <Ionicons name={icon} size={20} color={colors.espressoBrown} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.desc}>{desc}</Text>
      </View>
      <PressableScale style={styles.makeBtn} onPress={onPress}>
        <Text style={styles.makeText}>{busy ? '생성 중…' : actionLabel ?? '초안 생성'}</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 15 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkText: { ...typography.L4, color: colors.pointOrange, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  iconBox: {
    width: 38, height: 38, borderRadius: 10, backgroundColor: colors.coffeeCream,
    alignItems: 'center', justifyContent: 'center',
  },
  name: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  desc: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  makeBtn: { backgroundColor: colors.pointOrange, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  makeText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  smallBtn: { backgroundColor: colors.pointOrange, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  form: { gap: 8, marginTop: 10 },
  formRow: { flexDirection: 'row', gap: 8 },
  input: {
    borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, ...typography.L4, color: colors.espressoBrown,
    backgroundColor: colors.white,
  },
  emptyText: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18 },
  renewalRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  renewalName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  renewalDate: { ...typography.L5, color: colors.mochaBrown },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  docTitle: { ...typography.L4, color: colors.espressoBrown, flex: 1, fontWeight: '600' },
  docBody: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.mutedSand },
  block: { marginTop: 6 },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, gap: 12 },
  rowKey: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  rowValue: { ...typography.L5, color: colors.espressoBrown, flexShrink: 1, textAlign: 'right' },
  itemLine: { ...typography.L5, color: colors.espressoBrown, marginTop: 3, lineHeight: 16 },
});
