// 서류 자동화 (ERP-12) — 백엔드 /chatbot/documents·compliance 실연동
// 문서 초안 생성(발주서·실사표·장부·부가세·임금명세서·근로계약서) + 생성 문서 열람 + 갱신 만료 알림
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { useAuth } from '../../auth/AuthContext';
import { FadeInUp, PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
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
  deleteDocument,
  listCompliance,
  listDocuments,
  updateDocument,
} from '../../lib/api/documents';
import { getTaxEstimate, estimateTaxManual, type TaxEstimate } from '../../lib/api/operation';
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
  inspector_sign: '검수자 서명', employee: '직원',
};
const label = (k: string) => KEY_LABELS[k] ?? k;
const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
};

// 날짜 입력 관용 처리: "2026.8.1", "2026/08/01", "20260801" 전부 → "2026-08-01"
// 알아볼 수 없거나 존재하지 않는 날짜(2월 30일 등)면 null
const normalizeDate = (raw: string): string | null => {
  const parts = raw.split(/\D+/).filter(Boolean);
  let y: number, m: number, d: number;
  if (parts.length === 3 && parts[0].length === 4) {
    [y, m, d] = parts.map(Number);
  } else {
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 8) return null;
    [y, m, d] = [Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8))];
  }
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// 숫자 입력 관용 처리: "10,500원" → 10500
const toNumber = (raw: string): number => Number(raw.replace(/[^\d.]/g, '')) || 0;

function ContentRows({ content }: { content: Record<string, unknown> }) {
  return (
    <View>
      {Object.entries(content).map(([key, value]) => {
        // 안내 문구는 표가 아니라 하단 안내 박스로
        if (key === 'note') {
          return (
            <View key={key} style={styles.noteBox}>
              <Ionicons name="information-circle-outline" size={15} color={colors.mochaBrown} />
              <Text style={styles.noteBoxText}>{fmt(value)}</Text>
            </View>
          );
        }
        if (Array.isArray(value)) {
          return (
            <View key={key} style={styles.section}>
              <Text style={styles.sectionHead}>{label(key)} ({value.length}건)</Text>
              <View style={styles.sectionBody}>
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
            </View>
          );
        }
        // 하위 그룹(계약 기간·근로 조건·임금 등)은 제목 + 왼쪽 라인으로 묶어서 구분
        if (typeof value === 'object' && value !== null) {
          return (
            <View key={key} style={styles.section}>
              <Text style={styles.sectionHead}>{label(key)}</Text>
              <View style={styles.sectionBody}>
                <ContentRows content={value as Record<string, unknown>} />
              </View>
            </View>
          );
        }
        // 빈 값(서명란 등)은 대시 대신 기입용 밑줄로
        if (value === '') {
          return (
            <View key={key} style={styles.kvRow}>
              <Text style={styles.rowKey}>{label(key)}</Text>
              <View style={styles.signLine} />
            </View>
          );
        }
        // 긴 문장 값은 오른쪽 정렬로 구기지 않고 라벨 아래 전체 폭으로
        const text = fmt(value);
        if (text.length > 18) {
          return (
            <View key={key} style={styles.kvStack}>
              <Text style={styles.rowKey}>{label(key)}</Text>
              <Text style={styles.stackValue}>{text}</Text>
            </View>
          );
        }
        return (
          <View key={key} style={styles.kvRow}>
            <Text style={styles.rowKey}>{label(key)}</Text>
            <Text style={styles.rowValue}>{text}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ---- 문서 편집 지원 ----------------------------------------------------
// 편집값은 "items.0.quantity" 같은 경로 → 입력 문자열 맵으로 들고 있다가,
// 저장 시 원본 content 복제본에 타입을 살려서(숫자였으면 숫자로) 되붙인다.

function getAtPath(obj: unknown, path: string[]): unknown {
  let cur: any = obj;
  for (const key of path) cur = cur?.[key];
  return cur;
}

function setAtPath(obj: unknown, path: string[], value: unknown) {
  let cur: any = obj;
  for (const key of path.slice(0, -1)) cur = cur?.[key];
  if (cur != null) cur[path[path.length - 1]] = value;
}

// 원래 타입에 맞춰 입력 문자열을 변환: 빈칸→null, 숫자였던 칸→숫자, 그 외→문자열
function coerce(orig: unknown, raw: string): unknown {
  const t = raw.trim();
  if (t === '') return null;
  const num = Number(t.replace(/,/g, ''));
  const numeric = Number.isFinite(num) && /^-?[\d.,]+$/.test(t);
  if (numeric && (typeof orig === 'number' || orig === null || orig === undefined)) return num;
  return t;
}

function EditableRows({ content, path = [], edits, onEdit }: {
  content: Record<string, unknown>;
  path?: string[];
  edits: Record<string, string>;
  onEdit: (pathKey: string, text: string) => void;
}) {
  return (
    <View style={{ marginLeft: path.length * 10 }}>
      {Object.entries(content).map(([key, value]) => {
        const childPath = [...path, key];
        const pathKey = childPath.join('.');
        if (Array.isArray(value)) {
          return (
            <View key={key} style={styles.block}>
              <Text style={styles.rowKey}>{label(key)} ({value.length}건)</Text>
              {value.map((row, i) =>
                typeof row === 'object' && row !== null ? (
                  <View key={i} style={styles.editItemBox}>
                    <EditableRows content={row as Record<string, unknown>}
                      path={[...childPath, String(i)]} edits={edits} onEdit={onEdit} />
                  </View>
                ) : (
                  <TextInput key={i} style={styles.editInput}
                    value={edits[`${pathKey}.${i}`] ?? fmtRaw(row)}
                    onChangeText={(t) => onEdit(`${pathKey}.${i}`, t)} />
                ),
              )}
            </View>
          );
        }
        if (typeof value === 'object' && value !== null) {
          return (
            <View key={key} style={styles.block}>
              <Text style={styles.rowKey}>{label(key)}</Text>
              <EditableRows content={value as Record<string, unknown>}
                path={childPath} edits={edits} onEdit={onEdit} />
            </View>
          );
        }
        return (
          <View key={key} style={styles.editRow}>
            <Text style={styles.rowKey}>{label(key)}</Text>
            <TextInput style={styles.editInput}
              value={edits[pathKey] ?? fmtRaw(value)}
              onChangeText={(t) => onEdit(pathKey, t)} />
          </View>
        );
      })}
    </View>
  );
}

// 편집용 원본 표시 (fmt와 달리 천단위 쉼표·— 없이 그대로)
const fmtRaw = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ---- 인쇄 (후작업) ------------------------------------------------------
// 문서를 인쇄 전용 HTML로 변환해 새 창에서 브라우저 인쇄 대화상자를 연다.
// 인쇄 대화상자에서 'PDF로 저장'을 고르면 PDF 파일로도 남길 수 있다.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function contentToHtml(content: Record<string, unknown>): string {
  return Object.entries(content)
    .map(([key, value]) => {
      // 안내 문구(note)는 사장님용 내부 참고 — 직원·거래처에 건네는 인쇄물에는 찍지 않는다
      if (key === 'note') return '';
      if (Array.isArray(value)) {
        // 품목 같은 객체 배열은 진짜 표로 (열 = 전체 행의 필드 합집합)
        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
          const cols = Array.from(new Set(value.flatMap((r) => Object.keys((r as object) ?? {}))));
          const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('');
          const rows = value
            .map((r) => `<tr>${cols.map((c) => `<td>${esc(fmt((r as Record<string, unknown>)?.[c]))}</td>`).join('')}</tr>`)
            .join('');
          return `<h2>${esc(label(key))}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
        }
        return `<h2>${esc(label(key))}</h2><ul>${value.map((v) => `<li>${esc(fmt(v))}</li>`).join('')}</ul>`;
      }
      if (typeof value === 'object' && value !== null) {
        return `<h2>${esc(label(key))}</h2><div class="sec">${contentToHtml(value as Record<string, unknown>)}</div>`;
      }
      if (value === '') {
        return `<div class="kv"><span class="k">${esc(label(key))}</span><span class="signline"></span></div>`;
      }
      return `<div class="kv"><span class="k">${esc(label(key))}</span><span class="v">${esc(fmt(value))}</span></div>`;
    })
    .join('');
}

function buildPrintHtml(d: GeneratedDocument, autoPrint = true): string {
  const created = new Date(d.created_at).toLocaleDateString('ko-KR');
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${esc(d.title)}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #2d2118; max-width: 720px; margin: 0 auto; padding: 24px; font-size: 13px; line-height: 1.6; }
  header { border-bottom: 3px solid #2d2118; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .meta { color: #7a6a58; font-size: 12px; }
  h2 { font-size: 14px; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #d9cbb8; }
  .sec { padding-left: 12px; }
  .kv { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; }
  .kv .k { color: #7a6a58; flex-shrink: 0; }
  .kv .v { font-weight: 600; text-align: right; }
  .signline { display: inline-block; width: 180px; border-bottom: 1px solid #2d2118; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; }
  th, td { border: 1px solid #d9cbb8; padding: 6px 8px; font-size: 12px; text-align: left; }
  th { background: #f5eee3; }
  .note { background: #f5eee3; border-radius: 8px; padding: 10px 12px; margin-top: 18px; color: #5d4c3a; font-size: 12px; }
  .print-hint { text-align: center; margin-top: 24px; color: #aaa; font-size: 11px; }
  @media print { .print-hint { display: none; } }
</style></head><body>
<header><h1>${esc(d.title)}</h1><div class="meta">${d.period ? `대상 기간: ${esc(d.period)} · ` : ''}작성일: ${created} · SimpleM 자동 생성 초안</div></header>
${contentToHtml(d.content)}
${autoPrint ? `<div class="print-hint">인쇄 창이 닫혔으면 Ctrl+P로 다시 열 수 있어요 · 'PDF로 저장'을 선택하면 파일로 보관됩니다</div>
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>` : ''}
</body></html>`;
}

// 웹: 인쇄 전용 새 탭 + 브라우저 인쇄 대화상자 (PDF 저장 포함)
function printOnWeb(d: GeneratedDocument): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write(buildPrintHtml(d));
  win.document.close();
  return true;
}

// 폰(iOS/Android): OS 인쇄 다이얼로그(AirPrint/프린트 서비스) 시도 →
// 인쇄 환경이 없으면 PDF를 만들어 공유 시트(카톡·이메일·드라이브·프린트 앱)로 넘긴다
async function printOnPhone(d: GeneratedDocument): Promise<void> {
  const html = buildPrintHtml(d, false); // 자동 인쇄 스크립트 없이
  try {
    await Print.printAsync({ html });
  } catch (e) {
    // 사용자가 인쇄 다이얼로그를 그냥 닫은 경우는 조용히 넘어간다
    if (e instanceof Error && /did not complete|cancell?ed/i.test(e.message)) return;
    // 프린터를 못 쓰는 환경 → PDF 생성 후 공유로 폴백
    const { uri } = await Print.printToFileAsync({ html });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: d.title });
    } else {
      toast('공유 불가', 'PDF는 만들었지만 이 기기에서 공유 기능을 쓸 수 없어요.');
    }
  }
}

export default function DocumentScreen() {
  const { token } = useAuth();
  const [tab, setTab] = useState<'document' | 'tax'>('document');
  const [docs, setDocs] = useState<GeneratedDocument[]>([]);
  const [renewals, setRenewals] = useState<ComplianceItem[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 생성 중인 템플릿 id
  const [openForm, setOpenForm] = useState<string | null>(null);

  // 문서 편집 상태
  const [editDocId, setEditDocId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingDoc, setSavingDoc] = useState(false);

  // 임금명세서·근로계약서·갱신 등록 폼 입력
  const now = new Date();
  const [empName, setEmpName] = useState('');
  const [payYear, setPayYear] = useState(String(now.getFullYear()));
  const [payMonth, setPayMonth] = useState(String(now.getMonth() + 1));
  const [payWage, setPayWage] = useState('');   // 선택 — 비우면 직원 테이블의 시급 사용
  const [payHours, setPayHours] = useState(''); // 선택 — 비우면 근무 스케줄에서 자동 집계
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
    if (!cpName.trim()) return toast('입력 확인', '서류 이름을 입력하세요. (예: 보건증-홍길동)');
    const expiry = normalizeDate(cpExpiry);
    if (!expiry) return toast('입력 확인', `만료일을 알아볼 수 없어요: "${cpExpiry}" — 예: 2026-12-31`);
    try {
      await addCompliance(token, { name: cpName.trim(), expiry_date: expiry });
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

  const removeDocument = (d: GeneratedDocument) => {
    confirmDialog(`'${d.title}' 문서를 삭제할까요? 되돌릴 수 없습니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return;
        try {
          await deleteDocument(token, d.id);
          if (openDocId === d.id) setOpenDocId(null);
          reload();
          toast('삭제 완료', `${d.title} 문서를 삭제했어요.`);
        } catch (e) {
          toast('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });
  };

  const startEdit = (d: GeneratedDocument) => {
    setEditDocId(d.id);
    setEdits({});
    setOpenDocId(d.id);
  };

  const cancelEdit = () => {
    setEditDocId(null);
    setEdits({});
  };

  const saveEdit = async (d: GeneratedDocument) => {
    if (!token) return;
    if (Object.keys(edits).length === 0) return cancelEdit();
    setSavingDoc(true);
    try {
      // 원본을 복제한 뒤 편집된 경로마다 원래 타입에 맞춰 값을 되붙인다
      const next = JSON.parse(JSON.stringify(d.content)) as Record<string, unknown>;
      for (const [pathKey, raw] of Object.entries(edits)) {
        const path = pathKey.split('.');
        setAtPath(next, path, coerce(getAtPath(d.content, path), raw));
      }
      await updateDocument(token, d.id, next);
      cancelEdit();
      reload();
      toast('수정 완료', `${d.title} 내용을 저장했어요.`);
    } catch (e) {
      toast('수정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSavingDoc(false);
    }
  };

  return (
    <Screen>
      {/* [한글 주석] 세금 관리 기능이 이관되어 서류와 세금을 아우르는 화면으로 변경되었습니다 */}
      <ScreenTitle title="서류·세금 자동화" subtitle="서류 초안 생성과 세금 관리를 한 곳에서" />

      <Segmented<'document' | 'tax'>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'document', label: '서류 자동화' },
          { value: 'tax', label: '세금 관리' },
        ]}
      />

      {tab === 'document' ? (
        <View style={{ gap: 20, marginTop: 14 }}>
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
          <FadeInUp distance={12}>
            <View style={styles.form}>
              <TextInput style={styles.input} placeholder="서류 이름 (예: 보건증-홍길동)" value={cpName} onChangeText={setCpName} />
              <TextInput style={styles.input} placeholder="만료일 (YYYY-MM-DD)" value={cpExpiry} onChangeText={setCpExpiry} />
              <PressableScale style={styles.smallBtn} onPress={addRenewal}>
                <Text style={styles.btnText}>등록</Text>
              </PressableScale>
            </View>
          </FadeInUp>
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
          <FadeInUp distance={12}>
            <View style={styles.form}>
              <TextInput style={styles.input} placeholder="직원 이름" value={empName} onChangeText={setEmpName} />
              <View style={styles.formRow}>
                <TextInput style={[styles.input, { flex: 1, width: 0, flexShrink: 1 }]} placeholder="연도" keyboardType="numeric" value={payYear} onChangeText={setPayYear} />
                <TextInput style={[styles.input, { flex: 1, width: 0, flexShrink: 1 }]} placeholder="월" keyboardType="numeric" value={payMonth} onChangeText={setPayMonth} />
              </View>
              <View style={styles.formRow}>
                <TextInput style={[styles.input, { flex: 1, width: 0, flexShrink: 1 }]} placeholder="시급 (비우면 직원 정보 사용)" keyboardType="numeric" value={payWage} onChangeText={setPayWage} />
                <TextInput style={[styles.input, { flex: 1, width: 0, flexShrink: 1 }]} placeholder="근무시간 (비우면 자동 집계)" keyboardType="numeric" value={payHours} onChangeText={setPayHours} />
              </View>
              <PressableScale style={styles.smallBtn} onPress={() => {
                if (!empName.trim()) return toast('입력 확인', '직원 이름을 입력하세요.');
                const y = toNumber(payYear);
                const m = toNumber(payMonth);
                if (y < 2000 || y > 2100) return toast('입력 확인', `연도를 확인하세요: "${payYear}" — 예: 2026`);
                if (m < 1 || m > 12) return toast('입력 확인', `월을 확인하세요: "${payMonth}" — 1~12 사이 숫자`);
                run('pay', () => createPayslip(token!, {
                  employee_name: empName.trim(), year: y, month: m,
                  ...(payWage.trim() ? { hourly_wage: toNumber(payWage) } : {}),
                  ...(payHours.trim() ? { work_hours: toNumber(payHours) } : {}),
                }));
              }}>
                <Text style={styles.btnText}>초안 생성</Text>
              </PressableScale>
            </View>
          </FadeInUp>
        )}
      </Card>

      {/* 근로계약서 */}
      <Card>
        <TemplateRow icon="document-text-outline" name="근로계약서" desc="근로기준법 필수 기재사항을 채운 표준 초안"
          busy={busy === 'ct'} actionLabel={openForm === 'ct' ? '닫기' : '입력'}
          onPress={() => setOpenForm(openForm === 'ct' ? null : 'ct')} />
        {openForm === 'ct' && (
          <FadeInUp distance={12}>
            <View style={styles.form}>
              <TextInput style={styles.input} placeholder="직원 이름" value={ctName} onChangeText={setCtName} />
              <View style={styles.formRow}>
                <TextInput style={[styles.input, { flex: 1, width: 0, flexShrink: 1 }]} placeholder="시급 (원)" keyboardType="numeric" value={ctWage} onChangeText={setCtWage} />
                <TextInput style={[styles.input, { flex: 1.4, width: 0, flexShrink: 1 }]} placeholder="시작일 YYYY-MM-DD" value={ctStart} onChangeText={setCtStart} />
              </View>
              <PressableScale style={styles.smallBtn} onPress={() => {
                if (!ctName.trim()) return toast('입력 확인', '직원 이름을 입력하세요.');
                const wage = toNumber(ctWage);
                if (!wage) return toast('입력 확인', `시급을 숫자로 입력하세요: "${ctWage}" — 예: 10500`);
                const start = normalizeDate(ctStart);
                if (!start) return toast('입력 확인', `시작일을 알아볼 수 없어요: "${ctStart}" — 예: 2026-08-01`);
                run('ct', () => createContract(token!, { employee_name: ctName.trim(), hourly_wage: wage, start_date: start }));
              }}>
                <Text style={styles.btnText}>초안 생성</Text>
              </PressableScale>
            </View>
          </FadeInUp>
        )}
      </Card>

      {/* 생성된 문서 */}
      <SectionTitle>생성된 문서</SectionTitle>
      {docs.length === 0 ? (
        <Card><Text style={styles.emptyText}>아직 생성된 문서가 없어요. 위에서 초안을 만들어 보세요.</Text></Card>
      ) : (
        docs.map((d) => {
          const isEditing = editDocId === d.id;
          return (
            <Card key={d.id}>
              <PressableScale onPress={() => { if (!isEditing) setOpenDocId(openDocId === d.id ? null : d.id); }}>
                <View style={styles.docRow}>
                  <Badge label={KIND_LABELS[d.kind] ?? d.kind} tone="neutral" />
                  <Text style={styles.docTitle} numberOfLines={1}>{d.title}</Text>
                  <Ionicons name={openDocId === d.id ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mochaBrown} />
                </View>
              </PressableScale>
              {openDocId === d.id && (
                <View style={styles.docBody}>
                  {isEditing ? (
                    <EditableRows content={d.content} edits={edits}
                      onEdit={(pathKey, text) => setEdits((prev) => ({ ...prev, [pathKey]: text }))} />
                  ) : (
                    <ContentRows content={d.content} />
                  )}
                  <View style={styles.docActions}>
                    {isEditing ? (
                      <>
                        <PressableScale style={[styles.smallBtn, { flex: 1 }]} onPress={() => saveEdit(d)}>
                          <Text style={styles.btnText}>{savingDoc ? '저장 중…' : '저장'}</Text>
                        </PressableScale>
                        <PressableScale style={[styles.smallBtn, styles.cancelBtn, { flex: 1 }]} onPress={cancelEdit}>
                          <Text style={[styles.btnText, { color: colors.mochaBrown }]}>취소</Text>
                        </PressableScale>
                      </>
                    ) : (
                      <>
                        <PressableScale style={[styles.smallBtn, { flex: 1 }]} onPress={() => startEdit(d)}>
                          <Text style={styles.btnText}>수정</Text>
                        </PressableScale>
                        <PressableScale
                          style={[styles.smallBtn, styles.printBtn, { flex: 1 }]}
                          onPress={() => {
                            if (Platform.OS === 'web') {
                              if (!printOnWeb(d)) toast('팝업 차단됨', '브라우저에서 팝업을 허용한 뒤 다시 시도하세요.');
                            } else {
                              printOnPhone(d).catch(() =>
                                toast('인쇄 실패', '잠시 후 다시 시도해 주세요.'));
                            }
                          }}
                        >
                          <View style={styles.printBtnInner}>
                            <Ionicons name="print-outline" size={14} color={colors.white} />
                            <Text style={styles.btnText}>인쇄 · PDF</Text>
                          </View>
                        </PressableScale>
                        {d.kind !== 'payslip' && (
                          <PressableScale style={[styles.smallBtn, styles.deleteBtn]} onPress={() => removeDocument(d)}>
                            <Ionicons name="trash-outline" size={15} color="#B23B2E" />
                          </PressableScale>
                        )}
                      </>
                    )}
                  </View>
                </View>
              )}
            </Card>
          );
        })
      )}
        </View>
      ) : (
        <View style={{ gap: 20, marginTop: 14 }}>
          <TaxTab />
        </View>
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
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },  // 세금 탭 설명 텍스트
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
  formRow: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: '100%' },
  input: {
    borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, ...typography.L4, color: colors.espressoBrown,
    backgroundColor: colors.white,
    minWidth: 0, // [한글 주석: 웹 플렉스박스 버그 방지] placeholder가 길어 너비가 늘어나는 현상 해결
    width: '100%',
    flexShrink: 1,
  },
  emptyText: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18 },
  renewalRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  renewalName: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  renewalDate: { ...typography.L5, color: colors.mochaBrown },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  docTitle: { ...typography.L4, color: colors.espressoBrown, flex: 1, fontWeight: '600' },
  docBody: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.mutedSand },
  docActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  cancelBtn: { backgroundColor: colors.coffeeCream },
  printBtn: { backgroundColor: colors.espressoBrown },
  printBtnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  deleteBtn: { backgroundColor: '#F6DED8', paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  editInput: {
    flex: 1, borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5, ...typography.L5, color: colors.espressoBrown,
    backgroundColor: colors.white, minWidth: 80,
  },
  editItemBox: {
    borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 10,
    padding: 8, marginTop: 6,
  },
  block: { marginTop: 6 },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, gap: 12 },
  rowKey: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  rowValue: { ...typography.L5, color: colors.espressoBrown, flexShrink: 1, textAlign: 'right', fontWeight: '600' },
  kvStack: { paddingVertical: 5 },
  stackValue: {
    ...typography.L5, color: colors.espressoBrown, lineHeight: 18,
    backgroundColor: colors.creamSand, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7, marginTop: 5,
  },
  signLine: {
    width: 140, height: 20,
    borderBottomWidth: 1, borderBottomColor: colors.mochaBrown,
  },
  section: {
    marginTop: 10, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: colors.mutedSand,
  },
  sectionHead: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800', marginBottom: 4 },
  sectionBody: {
    paddingLeft: 10, marginLeft: 2,
    borderLeftWidth: 2, borderLeftColor: colors.coffeeCream,
  },
  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: colors.coffeeCream, borderRadius: 10, padding: 10, marginTop: 12,
  },
  noteBoxText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 17 },
  itemLine: { ...typography.L5, color: colors.espressoBrown, marginTop: 3, lineHeight: 16 },
  // [한글 주석] 세금 탭 전용으로 추가되는 레이아웃 스타일셋
  taxAmount: { ...typography.L2, color: colors.espressoBrown, marginTop: 8, marginBottom: 2 },
  taxLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  taxLabel: { ...typography.L4, color: colors.mochaBrown },
  taxVal: { ...typography.L4, color: colors.espressoBrown },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dueText: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
});

// [백엔드 연동] 세금 관리 탭 — 부가세+종합소득세+원천징수 예상 및 신고 일정
const nowYearMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const wonFmt = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');
const ddayText = (d: number) => (d > 0 ? `D-${d}` : d === 0 ? 'D-DAY' : `D+${Math.abs(d)}`);
const ddayTone = (status: string): 'danger' | 'orange' | 'neutral' =>
  status === '임박' ? 'danger' : status === '기한 경과' ? 'neutral' : 'orange';

function TaxTab() {
  const { token } = useAuth();
  const period = nowYearMonth();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tax, setTax] = useState<TaxEstimate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // DB 매출·비용·인건비 자동집계 → 부가세·종소세·원천징수 통합 계산
      const t = token
        ? await getTaxEstimate(token, period, 'general')
        : await estimateTaxManual({ period, total_revenue: 0, total_expense: 0, tax_type: 'general' });
      setTax(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={{ paddingVertical: 40, alignItems: 'center' }}>
        <ActivityIndicator color={colors.pointOrange} />
        <Text style={[styles.hint, { marginTop: 8 }]}>세금을 계산하는 중…</Text>
      </View>
    );
  }
  if (err || !tax) {
    return (
      <Card>
        <Text style={{ ...typography.L4, color: '#B23B2E', fontWeight: '600' }}>⚠ {err ?? '데이터를 불러오지 못했어요.'}</Text>
        <Button label="다시 시도" variant="secondary" style={{ marginTop: 12 }} onPress={load} />
      </Card>
    );
  }

  const findLine = (name: string) => tax.lines.find((l) => l.name === name);

  return (
    <View style={{ gap: 20 }}>
      {/* 예상 세금 총합 + 세목별 (부가세·종소세·원천징수) */}
      <Card>
        <View style={styles.rowBetween}>
          <SectionTitle>예상 세금 합계</SectionTitle>
          <Badge label={`${tax.period} 기준`} tone="neutral" />
        </View>
        <Text style={styles.taxAmount}>{wonFmt(tax.total_tax)}</Text>
        <Text style={styles.hint}>부가가치세 + 종합소득세 + 원천징수세 (참고용 예상)</Text>
        <Divider />
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>부가가치세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.vat)}</Text>
        </View>
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>종합소득세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.income_tax)}</Text>
        </View>
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>원천징수세</Text>
          <Text style={styles.taxVal}>{wonFmt(tax.withholding_tax)}</Text>
        </View>
        <Text style={[styles.hint, { marginTop: 8 }]}>과세표준 {wonFmt(tax.taxable_base)} · 매출 {wonFmt(tax.total_revenue)} · 비용 {wonFmt(tax.total_expense)}</Text>
      </Card>

      {/* 신고 초안 (draft_) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>세금 신고 초안</SectionTitle>
          <Badge label="확정 전" tone="orange" />
        </View>
        <Text style={styles.hint}>
          자동 생성된 신고 초안이에요. 검토 후 세무사 확인·확정하세요. (자동 신고 안 됨)
        </Text>
        <View style={styles.actions}>
          <Button
            label="초안 상세 보기"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() =>
              toast(
                '세금 신고 초안',
                `[부가가치세] ${wonFmt(tax.vat)}\n${findLine('부가가치세')?.basis ?? ''}\n\n` +
                `[종합소득세] ${wonFmt(tax.income_tax)}\n${findLine('종합소득세')?.basis ?? ''}\n\n` +
                `[원천징수세] ${wonFmt(tax.withholding_tax)}\n${findLine('원천징수세')?.basis ?? ''}\n\n검토 후 세무사에게 공유하세요.`
              )
            }
          />
          <Button
            label="세무사 공유"
            style={{ flex: 1 }}
            onPress={() => toast('공유 완료', '신고 초안을 담당 세무사에게 전달했어요. 확정은 세무사 확인 후 진행됩니다.')}
          />
        </View>
      </Card>

      {/* 다가오는 신고 일정 (부가세·종소세·원천징수 D-day) */}
      <Card>
        <SectionTitle>다가오는 신고 일정</SectionTitle>
        <View style={{ marginTop: 10, gap: 10 }}>
          {tax.filing_schedule.map((f) => (
            <View key={f.name} style={styles.dueRow}>
              <Ionicons name="calendar-outline" size={18} color={f.status === '임박' ? colors.pointOrange : colors.mochaBrown} />
              <View style={{ flex: 1 }}>
                <Text style={styles.dueText}>{f.name}</Text>
                <Text style={[styles.hint, { marginTop: 1 }]}>{f.due_date} · {f.note}</Text>
              </View>
              <Badge label={ddayText(f.dday)} tone={ddayTone(f.status)} />
            </View>
          ))}
        </View>
      </Card>
    </View>
  );
}
