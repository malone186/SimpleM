// 매출 입력 — POS 매출 파일 불러오기를 메인으로 삼는 화면.
//
// 설계 의도(사장님 피드백 반영):
//   · POS기에서 뽑은 엑셀/CSV를 올리면 LLM이 열을 알아서 매핑해 매출로 등록해 준다.
//     이게 가장 빠른 길이라 화면 맨 위 히어로 카드로 크게 배치했다.
//   · LLM이 열을 잘못 분류할 수 있으니, DB에 넣기 전에 미리보기로 사용자에게 꼭 확인받는다.
//   · 파일이 없거나 손으로 적고 싶은 경우를 위해 '직접 입력'은 버튼으로 분리해
//     별도 화면(ManualSalesScreen)에서 열리게 했다.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import {
  deletePosConnection,
  getPosConnection,
  savePosConnection,
  syncPosNow,
  type PosConnection,
} from '../../lib/api/pos';
import { confirmSalesImport, previewSalesImport, registerImportMenus, type ImportPreview } from '../../lib/api/sales';
import { colors, typography } from '../../theme';

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '');

export default function SalesInputScreen() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();

  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importedName, setImportedName] = useState('');
  // 미등록 메뉴 등록용 — 이름별 편집 중인 판매가, 등록 진행 상태
  const [menuPrices, setMenuPrices] = useState<Record<string, string>>({});
  const [registering, setRegistering] = useState(false);
  // 버리기로 결정한 미등록 메뉴 이름들 — 미매칭은 말없이 버려지지 않는다.
  // 모든 미등록 메뉴가 '등록' 또는 '버리기'로 결정돼야 저장할 수 있다.
  const [discardedMenus, setDiscardedMenus] = useState<Set<string>>(new Set());

  // ── POS 실시간 연동 (Square) ──
  const [posConn, setPosConn] = useState<PosConnection | null>(null);
  const [posFormOpen, setPosFormOpen] = useState(false);
  const [posToken, setPosToken] = useState('');
  const [posSigKey, setPosSigKey] = useState('');
  const [posEnv, setPosEnv] = useState<'production' | 'sandbox'>('production');
  const [posAutoSync, setPosAutoSync] = useState(true);
  const [posSaving, setPosSaving] = useState(false);
  const [posSyncing, setPosSyncing] = useState(false);

  const loadPosConnection = async () => {
    if (!token) return;
    try {
      setPosConn(await getPosConnection(token));
    } catch {
      // 조회 실패는 카드에 '확인 불가'로만 — 화면 전체를 막지 않는다
      setPosConn(null);
    }
  };

  useEffect(() => {
    loadPosConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const savePos = async () => {
    if (!token || posSaving) return;
    if (posToken.trim().length < 8) {
      toast('토큰 확인', 'Square Access Token을 입력해 주세요.');
      return;
    }
    setPosSaving(true);
    try {
      const conn = await savePosConnection(token, {
        provider: 'square',
        environment: posEnv,
        access_token: posToken.trim(),
        webhook_signature_key: posSigKey.trim() || null,
        auto_sync: posAutoSync,
      });
      setPosConn(conn);
      setPosFormOpen(false);
      setPosToken('');
      setPosSigKey('');
      toast('POS 연결 완료', 'Square 계정 검증까지 끝났어요. 이제 주문이 자동으로 매출에 반영됩니다.');
    } catch (e) {
      toast('연결 실패', e instanceof Error ? e.message : 'Square 토큰을 확인해 주세요.');
    } finally {
      setPosSaving(false);
    }
  };

  const disconnectPos = async () => {
    if (!token) return;
    try {
      await deletePosConnection(token);
      setPosConn({ connected: false });
      toast('연결 해제', 'POS 연동을 해제했어요.');
    } catch (e) {
      toast('해제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const runPosSync = async () => {
    if (!token || posSyncing) return;
    setPosSyncing(true);
    try {
      const r = await syncPosNow(token);
      const unmatched = r.unmatched_items.length
        ? ` · 미등록 메뉴 ${r.unmatched_items.length}종 제외`
        : '';
      toast(
        '동기화 완료',
        `주문 ${r.orders_synced}건 → 매출 ${r.sales_created}건 · ${r.total_amount.toLocaleString()}원 반영${unmatched}`,
      );
      loadPosConnection();
    } catch (e) {
      toast('동기화 실패', e instanceof Error ? e.message : 'Square 통신을 확인해 주세요.');
      loadPosConnection();
    } finally {
      setPosSyncing(false);
    }
  };

  // 미리보기에서 미매칭(=미등록) 메뉴를 중복 없이 모으고, 파일의 단가(금액/수량)로 판매가 추정
  const unmatchedMenus = useMemo(() => {
    if (!importPreview) return [] as { name: string; suggested: number }[];
    const seen = new Map<string, number>();
    for (const r of importPreview.rows) {
      if (r.menu_id != null || seen.has(r.menu_name)) continue;
      const unit = r.total_price && r.quantity ? Math.round(r.total_price / r.quantity) : 0;
      seen.set(r.menu_name, unit);
    }
    return [...seen.entries()].map(([name, suggested]) => ({ name, suggested }));
  }, [importPreview]);

  // 아직 등록도 버리기도 결정 안 된 미등록 메뉴 (등록 버튼의 대상)
  const pendingMenus = useMemo(
    () => unmatchedMenus.filter((m) => !discardedMenus.has(m.name)),
    [unmatchedMenus, discardedMenus],
  );

  // 행 단위 집계 — 버리기로 결정된 행 수 / 아직 결정 안 된 미매칭 행 수
  const { discardedRows, undecidedRows } = useMemo(() => {
    let d = 0, u = 0;
    for (const r of importPreview?.rows ?? []) {
      if (r.menu_id != null) continue;
      if (discardedMenus.has(r.menu_name)) d += 1;
      else u += 1;
    }
    return { discardedRows: d, undecidedRows: u };
  }, [importPreview, discardedMenus]);

  const toggleDiscard = (name: string) =>
    setDiscardedMenus((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const discardAllPending = () =>
    setDiscardedMenus((prev) => {
      const next = new Set(prev);
      for (const m of unmatchedMenus) next.add(m.name);
      return next;
    });

  // ---- 파일 선택 → LLM 매핑 미리보기 (DB 저장은 아직 안 함) ----
  // 웹에서는 네이티브 모듈 없이 <input type="file">로 바로 고른다.
  // 네이티브(안드로이드)에서는 expo-document-picker를 쓰는데, 이 네이티브 모듈이
  // 포함된 새 앱 빌드가 있어야 동작한다(현재 구버전 빌드에는 없음 → 안내만).
  const runPreview = async (picked: { uri: string; mimeType?: string | null; fileName?: string | null }) => {
    if (!token) return;
    setImporting(true);
    setImportPreview(null);
    setMenuPrices({});
    setDiscardedMenus(new Set());
    setImportedName(picked.fileName ?? '');
    try {
      const pv = await previewSalesImport(picked, token);
      setImportPreview(pv);
    } catch (e) {
      toast('파일 분석 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setImporting(false);
    }
  };

  const pickAndPreview = async () => {
    if (!token) { toast('로그인 필요', '파일 불러오기는 로그인 후 가능합니다.'); return; }

    // 웹: 브라우저 파일 선택창 — 네이티브 모듈 불필요
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        runPreview({ uri: URL.createObjectURL(f), mimeType: f.type || 'text/csv', fileName: f.name });
      };
      input.click();
      return;
    }

    // 네이티브: expo-document-picker (모듈이 빌드에 포함돼 있어야 함)
    try {
      const DocumentPicker = require('expo-document-picker');
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'text/csv', 'text/comma-separated-values', 'application/csv',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      await runPreview({ uri: a.uri, mimeType: a.mimeType, fileName: a.name });
    } catch {
      // 네이티브 모듈이 이 빌드에 없을 때(구버전 앱) 여기로 온다
      toast('파일 선택은 다음 업데이트부터', '이 기능은 새 앱 빌드에 포함돼요. 지금은 웹(브라우저)에서 파일을 올려 테스트할 수 있어요.');
    }
  };

  // ---- 파일에서 발견된 미등록 메뉴를 메뉴로 등록 → 해당 행을 매칭으로 전환 ----
  const registerUnmatched = async () => {
    if (!token || !importPreview || registering || pendingMenus.length === 0) return;
    // 버리기로 결정한 메뉴는 등록하지 않는다 — 남은(결정 대기) 메뉴만 등록
    const payload = pendingMenus.map((m) => ({
      name: m.name,
      selling_price: Number(menuPrices[m.name] ?? String(m.suggested)) || 0,
    }));
    setRegistering(true);
    try {
      const { menus } = await registerImportMenus(token, payload);
      const byName = new Map(menus.map((m) => [m.name, m]));
      // 새로 등록된 메뉴 이름과 같은 미매칭 행을 매칭으로 바꾸고 요약을 다시 계산
      setImportPreview((pv) => {
        if (!pv) return pv;
        const rows = pv.rows.map((r) => {
          const hit = r.menu_id == null ? byName.get(r.menu_name) : undefined;
          if (!hit) return r;
          return {
            ...r,
            menu_id: hit.menu_id,
            matched_name: r.menu_name,
            total_price: r.total_price ?? hit.selling_price * r.quantity,
            warnings: r.warnings.filter((w) => w !== '메뉴 매칭 안 됨'),
          };
        });
        const matched = rows.filter((r) => r.menu_id != null).length;
        return {
          ...pv,
          rows,
          summary: {
            ...pv.summary,
            matched,
            unmatched: rows.length - matched,
            sum_amount: rows.reduce((s, r) => s + (r.total_price ?? 0), 0),
          },
        };
      });
      const created = menus.filter((m) => m.created).length;
      toast('메뉴를 등록했어요', `${created}개 등록 · 이제 매칭돼요. 저장하면 매출에 반영됩니다.`);
    } catch (e) {
      toast('메뉴 등록 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setRegistering(false);
    }
  };

  // ---- 미리보기에서 확인한 (매칭된) 행만 실제 매출로 저장 ----
  // 미매칭 행은 말없이 버리지 않는다 — 모든 미등록 메뉴가 '등록' 또는 '버리기'로
  // 결정되기 전에는 저장을 막아, 수백 행이 사장님 모르게 사라지는 일을 방지한다.
  const submitImport = async () => {
    if (!token || !importPreview) return;
    if (undecidedRows > 0) {
      toast(
        '미매칭 메뉴를 먼저 결정해 주세요',
        `미매칭 ${undecidedRows}행이 남아 있어요. 위 목록에서 메뉴를 등록하거나 [버리기]를 눌러야 저장할 수 있어요.`,
      );
      return;
    }
    const rows = importPreview.rows
      .filter((r) => r.menu_id != null)
      .map((r) => ({ menu_id: r.menu_id as number, quantity: r.quantity, total_price: r.total_price, sold_at: r.sold_at }));
    if (rows.length === 0) {
      toast('저장할 항목이 없어요', '메뉴가 매칭된 행이 없어요. 미등록 메뉴를 등록하면 저장에 포함됩니다.');
      return;
    }
    setImporting(true);
    try {
      const result = await confirmSalesImport(token, rows);
      const dropped = discardedRows > 0 ? ` · 버리기 ${discardedRows}행 제외` : '';
      toast('매출을 저장했어요', `${result.created}건 · ${result.total.toLocaleString()}원 반영 (재고 자동 차감)${dropped}`);
      setImportPreview(null);
      setImportedName('');
      setDiscardedMenus(new Set());
    } catch (e) {
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle
        title="매출 입력"
        subtitle="POS 매출 파일을 올리면 자동 분석해 매출로 등록해요"
      />

      {/* ── 히어로: POS 매출 파일 불러오기 (엑셀/CSV) ── */}
      <Card>
        <View style={styles.heroHead}>
          <View style={styles.heroIcon}>
            <Ionicons name="document-attach" size={22} color={colors.creamSand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>POS 매출 파일 불러오기</Text>
            <Text style={styles.heroSub}>엑셀·CSV를 올리면 브루가 열을 자동 분석해요 (저장 전 확인)</Text>
          </View>
        </View>

        <PressableScale style={styles.filePickBtn} onPress={pickAndPreview} disabled={importing} to={0.97}>
          <Ionicons name="cloud-upload-outline" size={18} color={colors.white} />
          <Text style={styles.filePickText}>{importedName ? `파일 다시 선택 (${importedName})` : '파일 선택 (엑셀 / CSV)'}</Text>
        </PressableScale>

        {importing && !importPreview && (
          <View style={styles.fileRowCenter}>
            <ActivityIndicator color={colors.mochaBrown} />
            <Text style={styles.fileSub}>파일을 분석하고 있어요…</Text>
          </View>
        )}

        {!importPreview && !importing && (
          <Text style={styles.heroHint}>
            POS기에서 “매출 내역”을 엑셀 또는 CSV로 내려받아 올려 주세요. 열 순서가 달라도 브루가 알아서
            날짜·메뉴·수량·금액을 찾아 줍니다.
          </Text>
        )}

        {importPreview && (
          <View style={{ gap: 8, marginTop: 12 }}>
            {/* 어떤 엔진으로 열을 분석했는지 표시 — 조용한 폴백을 눈에 보이게 */}
            <View style={styles.engineRow}>
              <View style={[styles.engineBadge, importPreview.source === 'ai' ? styles.engineAi : styles.engineHeur]}>
                <Ionicons
                  name={importPreview.source === 'ai' ? 'sparkles' : 'construct-outline'}
                  size={12}
                  color={importPreview.source === 'ai' ? colors.white : colors.espressoBrown}
                />
                <Text style={[styles.engineBadgeText, { color: importPreview.source === 'ai' ? colors.white : colors.espressoBrown }]}>
                  {importPreview.source === 'ai' ? 'AI 자동 분석' : '간이 분석 (AI 미사용)'}
                </Text>
              </View>
            </View>
            {importPreview.source !== 'ai' && importPreview.mapping_error && (
              <Text style={styles.engineWarn}>AI 분석 실패로 간이 분석 사용 — {importPreview.mapping_error}</Text>
            )}
            <Text style={styles.fileSummary}>
              총 {importPreview.summary.total_rows}행 · 매칭 {importPreview.summary.matched} · 미매칭 {importPreview.summary.unmatched}
              {discardedRows > 0 ? ` (버리기 ${discardedRows})` : ''} · 합계 {importPreview.summary.sum_amount.toLocaleString()}원
            </Text>
            {/* 미등록 메뉴 처리: 등록(→매칭 전환) 또는 버리기 — 결정 전에는 저장이 막힌다.
                미매칭 행이 사장님 모르게 조용히 사라지지 않게 하기 위한 명시적 결정 단계. */}
            {unmatchedMenus.length > 0 && (
              <View style={styles.regBox}>
                <View style={styles.regHead}>
                  <Ionicons name="add-circle-outline" size={16} color={colors.pointOrange} />
                  <Text style={styles.regTitle}>미등록 메뉴 {unmatchedMenus.length}개 — 등록하거나 버려주세요</Text>
                </View>
                <Text style={styles.regSub}>
                  파일엔 있지만 앱에 없는 메뉴예요. 등록하면 매칭돼 저장에 포함되고, [버리기]를 누르면
                  그 메뉴의 판매 행은 저장에서 제외돼요. 샷추가·사이즈업 같은 옵션은 버리는 걸 추천해요.
                  모든 메뉴를 결정해야 저장할 수 있어요.
                </Text>
                {unmatchedMenus.map((m) => {
                  const isDiscarded = discardedMenus.has(m.name);
                  return (
                    <View key={m.name} style={styles.regRow}>
                      <Text
                        style={[styles.regName, isDiscarded && styles.regNameDiscarded]}
                        numberOfLines={1}
                      >
                        {m.name}
                      </Text>
                      {!isDiscarded && (
                        <View style={styles.regPriceBox}>
                          <TextInput
                            style={styles.regPriceInput}
                            keyboardType="number-pad"
                            inputMode="numeric"
                            value={menuPrices[m.name] ?? (m.suggested ? String(m.suggested) : '')}
                            onChangeText={(v) => setMenuPrices((p) => ({ ...p, [m.name]: onlyDigits(v) }))}
                            placeholder="0"
                            placeholderTextColor="#C7C7CC"
                          />
                          <Text style={styles.regWon}>원</Text>
                        </View>
                      )}
                      <PressableScale
                        style={[styles.discardBtn, isDiscarded && styles.discardBtnActive]}
                        onPress={() => toggleDiscard(m.name)}
                        to={0.92}
                      >
                        <Ionicons
                          name={isDiscarded ? 'arrow-undo-outline' : 'trash-outline'}
                          size={13}
                          color={isDiscarded ? colors.mochaBrown : '#B23B2E'}
                        />
                        <Text style={[styles.discardBtnText, isDiscarded && styles.discardBtnTextActive]}>
                          {isDiscarded ? '되돌리기' : '버리기'}
                        </Text>
                      </PressableScale>
                    </View>
                  );
                })}
                <View style={styles.regActions}>
                  {pendingMenus.length > 0 && (
                    <PressableScale
                      style={[styles.regBtn, registering && { opacity: 0.6 }]}
                      onPress={registerUnmatched}
                      disabled={registering}
                      to={0.97}
                    >
                      <Ionicons name="checkmark-circle-outline" size={16} color={colors.white} />
                      <Text style={styles.regBtnText}>{registering ? '등록 중…' : `${pendingMenus.length}개 메뉴 등록`}</Text>
                    </PressableScale>
                  )}
                  {pendingMenus.length > 0 && (
                    <PressableScale style={styles.discardAllBtn} onPress={discardAllPending} to={0.97}>
                      <Ionicons name="trash-outline" size={14} color="#B23B2E" />
                      <Text style={styles.discardAllText}>남은 {pendingMenus.length}개 모두 버리기</Text>
                    </PressableScale>
                  )}
                </View>
              </View>
            )}
            {importPreview.rows.slice(0, 30).map((r, i) => {
              const isDiscarded = r.menu_id == null && discardedMenus.has(r.menu_name);
              return (
                <View
                  key={i}
                  style={[
                    styles.fileRow,
                    r.menu_id == null && !isDiscarded && styles.fileRowUnmatched,
                    isDiscarded && styles.fileRowDiscarded,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.fileRowName, isDiscarded && styles.regNameDiscarded]}>
                      {r.menu_name}{r.matched_name && r.matched_name !== r.menu_name ? ` → ${r.matched_name}` : ''}
                    </Text>
                    <Text style={styles.fileRowMeta}>
                      {r.quantity}개 · {(r.total_price ?? 0).toLocaleString()}원{r.sold_at ? ` · ${r.sold_at.slice(0, 16).replace('T', ' ')}` : ''}
                    </Text>
                  </View>
                  <Badge
                    label={r.menu_id != null ? '매칭' : isDiscarded ? '버림' : '미매칭'}
                    tone={r.menu_id != null ? 'green' : isDiscarded ? 'neutral' : 'danger'}
                  />
                </View>
              );
            })}
            {importPreview.rows.length > 30 && (
              <Text style={styles.fileSub}>…외 {importPreview.rows.length - 30}행 (저장은 전체 반영)</Text>
            )}
            {undecidedRows > 0 && (
              <Text style={styles.fileWarn}>
                미매칭 {undecidedRows}행이 결정을 기다려요 — 위에서 등록하거나 [버리기]를 눌러야 저장할 수 있어요.
              </Text>
            )}
            <PressableScale
              style={[styles.fileSaveBtn, undecidedRows > 0 && styles.fileSaveBtnBlocked]}
              onPress={submitImport}
              disabled={importing}
              to={0.97}
            >
              <Text style={styles.fileSaveText}>
                {undecidedRows > 0
                  ? `미매칭 ${undecidedRows}행 결정 후 저장 가능`
                  : `매칭된 ${importPreview.summary.matched}건 저장 (재고 자동 차감)`}
              </Text>
            </PressableScale>
          </View>
        )}
      </Card>

      {/* ── 직접 입력 (파일이 없거나 손으로 적고 싶을 때) ── */}
      <PressableScale style={styles.manualBtn} onPress={() => navigation.navigate('ManualSales')} to={0.98}>
        <View style={styles.manualIcon}>
          <Ionicons name="create-outline" size={20} color={colors.espressoBrown} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.manualTitle}>직접 입력하기</Text>
          <Text style={styles.manualSub}>현금·카드 금액을 손으로 적고 카드 입금 예정을 계산해요</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />
      </PressableScale>

      {/* ── POS 실시간 연동 (Square) — 웹훅 즉시 반영 + 5분 자동 폴링 안전망 ── */}
      <Card>
        <View style={styles.posHead}>
          <View style={[styles.posDot, { backgroundColor: posConn?.connected ? (posConn.last_status === 'error' ? '#D97706' : '#16A34A') : '#A1A1AA' }]} />
          <Text style={styles.posTitle}>POS 실시간 연동</Text>
          <Badge
            label={posConn?.connected ? (posConn.last_status === 'error' ? '오류' : '연결됨') : '미연결'}
            tone={posConn?.connected ? (posConn.last_status === 'error' ? 'orange' : 'green') : 'neutral'}
          />
        </View>

        {posConn?.connected ? (
          <View style={{ gap: 6, marginTop: 8 }}>
            <Text style={styles.posMeta}>
              Square ({posConn.environment === 'sandbox' ? '샌드박스' : '운영'}) · 토큰 {posConn.access_token_masked}
              {posConn.auto_sync ? ' · 5분 자동 동기화' : ' · 자동 동기화 꺼짐'}
            </Text>
            <Text style={styles.posMeta}>
              마지막 동기화: {posConn.last_synced_at ? posConn.last_synced_at.slice(0, 16).replace('T', ' ') : '아직 없음'}
              {posConn.last_status === 'error' && posConn.last_error ? `\n⚠️ ${posConn.last_error}` : ''}
            </Text>
            {posConn.webhook_configured ? (
              <Text style={styles.posMeta}>
                ⚡ 웹훅 실시간 수신 켜짐 — Square 대시보드 Webhooks에 아래 주소를 구독해 두세요:{'\n'}
                {posConn.webhook_url}
              </Text>
            ) : (
              <Text style={styles.posHint}>
                웹훅 서명키를 등록하면 주문 발생 '즉시' 반영돼요 (지금은 5분 폴링만). [설정]에서 추가할 수 있어요.
              </Text>
            )}
            <View style={styles.posBtnRow}>
              <PressableScale style={[styles.posSyncBtn, posSyncing && { opacity: 0.6 }]} onPress={runPosSync} disabled={posSyncing} to={0.97}>
                {posSyncing ? <ActivityIndicator color={colors.white} size="small" /> : <Ionicons name="sync" size={15} color={colors.white} />}
                <Text style={styles.posSyncText}>{posSyncing ? '동기화 중…' : '지금 동기화'}</Text>
              </PressableScale>
              <PressableScale style={styles.posGhostBtn} onPress={() => setPosFormOpen((v) => !v)} to={0.97}>
                <Text style={styles.posGhostText}>설정</Text>
              </PressableScale>
              <PressableScale style={styles.posGhostBtn} onPress={disconnectPos} to={0.97}>
                <Text style={[styles.posGhostText, { color: '#B23B2E' }]}>연결 해제</Text>
              </PressableScale>
            </View>
          </View>
        ) : (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Text style={styles.posHint}>
              Square POS 계정을 연결하면 주문이 결제되는 대로 매출·재고에 자동 반영돼요. 파일 업로드가 필요 없어집니다.
            </Text>
            {!posFormOpen && (
              <PressableScale style={styles.posSyncBtn} onPress={() => setPosFormOpen(true)} to={0.97}>
                <Ionicons name="link-outline" size={15} color={colors.white} />
                <Text style={styles.posSyncText}>연결 설정</Text>
              </PressableScale>
            )}
          </View>
        )}

        {posFormOpen && (
          <View style={styles.posForm}>
            <Text style={styles.posLabel}>Square Access Token</Text>
            <TextInput
              style={styles.posInput}
              value={posToken}
              onChangeText={setPosToken}
              placeholder="developer.squareup.com에서 발급"
              placeholderTextColor="#C7C7CC"
              autoCapitalize="none"
              secureTextEntry
            />
            <Text style={styles.posLabel}>Webhook Signature Key (선택 — 즉시 반영용)</Text>
            <TextInput
              style={styles.posInput}
              value={posSigKey}
              onChangeText={setPosSigKey}
              placeholder="Square Webhooks 구독의 서명 키"
              placeholderTextColor="#C7C7CC"
              autoCapitalize="none"
              secureTextEntry
            />
            <View style={styles.posSwitchRow}>
              <Text style={styles.posLabel}>환경: {posEnv === 'production' ? '운영' : '샌드박스'}</Text>
              <Switch
                value={posEnv === 'production'}
                onValueChange={(v) => setPosEnv(v ? 'production' : 'sandbox')}
                trackColor={{ true: colors.espressoBrown, false: '#D4D4D8' }}
              />
            </View>
            <View style={styles.posSwitchRow}>
              <Text style={styles.posLabel}>5분 자동 동기화</Text>
              <Switch
                value={posAutoSync}
                onValueChange={setPosAutoSync}
                trackColor={{ true: colors.espressoBrown, false: '#D4D4D8' }}
              />
            </View>
            <PressableScale style={[styles.posSyncBtn, posSaving && { opacity: 0.6 }]} onPress={savePos} disabled={posSaving} to={0.97}>
              <Text style={styles.posSyncText}>{posSaving ? '검증 중…' : '저장 (토큰 검증 후 연결)'}</Text>
            </PressableScale>
          </View>
        )}
      </Card>

      <TouchableOpacity
        onPress={() => navigation.navigate('Settings', { section: 'settlement' })}
        style={styles.settingsLink}
      >
        <Ionicons name="settings-outline" size={13} color={colors.mochaBrown} />
        <Text style={styles.settingsLinkText}>수수료율·카드사 입금일 설정 바꾸기</Text>
      </TouchableOpacity>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // ── 히어로: POS 파일 불러오기 ──
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  heroIcon: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: colors.espressoBrown, alignItems: 'center', justifyContent: 'center',
  },
  heroTitle: { fontSize: 17, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.3 },
  heroSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  heroHint: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, marginTop: 12 },

  filePickBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: colors.espressoBrown, borderRadius: 14, paddingVertical: 14,
  },
  filePickText: { color: colors.white, fontSize: 14.5, fontWeight: '800' },
  fileRowCenter: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  fileSub: { ...typography.L5, color: colors.mochaBrown },
  engineRow: { flexDirection: 'row', alignItems: 'center' },
  engineBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  engineAi: { backgroundColor: colors.espressoBrown },
  engineHeur: { backgroundColor: colors.coffeeCream, borderWidth: 1, borderColor: colors.mutedSand },
  engineBadgeText: { fontSize: 11, fontWeight: '800' },
  engineWarn: { ...typography.L5, color: colors.pointOrange, fontWeight: '600' },
  fileSummary: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  fileWarn: { ...typography.L5, color: colors.pointOrange, fontWeight: '600' },

  // ── 미등록 메뉴 등록 박스 ──
  regBox: {
    backgroundColor: '#FFF7EE', borderWidth: 1, borderColor: 'rgba(232, 131, 58, 0.28)',
    borderRadius: 12, padding: 12, gap: 8,
  },
  regHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  regTitle: { fontSize: 13.5, fontWeight: '800', color: colors.espressoBrown },
  regSub: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16 },
  regRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  regName: { flex: 1, ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  regPriceBox: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.mutedSand,
    borderRadius: 9, paddingHorizontal: 10, height: 38, minWidth: 96,
  },
  regPriceInput: {
    flex: 1, fontSize: 15, fontWeight: '800', color: colors.espressoBrown, textAlign: 'right', padding: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  regWon: { ...typography.L5, color: colors.mochaBrown },
  regNameDiscarded: { textDecorationLine: 'line-through', color: colors.mochaBrown, opacity: 0.55 },
  // 메뉴별 버리기/되돌리기 토글
  discardBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'rgba(178, 59, 46, 0.35)', borderRadius: 9,
    paddingHorizontal: 9, height: 38,
  },
  discardBtnActive: { borderColor: colors.mutedSand, backgroundColor: colors.coffeeCream },
  discardBtnText: { fontSize: 12, fontWeight: '800', color: '#B23B2E' },
  discardBtnTextActive: { color: colors.mochaBrown },
  regActions: { gap: 6, marginTop: 2 },
  regBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.pointOrange, borderRadius: 11, paddingVertical: 11,
  },
  regBtnText: { color: colors.white, fontSize: 13.5, fontWeight: '800' },
  discardAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1, borderColor: 'rgba(178, 59, 46, 0.35)', borderRadius: 11, paddingVertical: 10,
  },
  discardAllText: { fontSize: 12.5, fontWeight: '800', color: '#B23B2E' },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10,
    backgroundColor: colors.coffeeCream,
  },
  fileRowUnmatched: { backgroundColor: 'rgba(178, 59, 46, 0.06)' },
  fileRowDiscarded: { opacity: 0.55 },
  fileRowName: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  fileRowMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  fileSaveBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.trendGreenText, borderRadius: 12, paddingVertical: 12, marginTop: 4,
  },
  fileSaveBtnBlocked: { backgroundColor: colors.mochaBrown, opacity: 0.75 },
  fileSaveText: { color: colors.white, fontSize: 14, fontWeight: '800' },

  // ── 직접 입력 진입 버튼 ──
  manualBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginTop: 4,
  },
  manualIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: colors.coffeeCream, alignItems: 'center', justifyContent: 'center',
  },
  manualTitle: { fontSize: 15, fontWeight: '800', color: colors.espressoBrown },
  manualSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },

  // ── POS 실시간 연동 카드 ──
  posHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  posDot: { width: 8, height: 8, borderRadius: 4 },
  posTitle: { flex: 1, fontSize: 15, fontWeight: '800', color: colors.espressoBrown },
  posMeta: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17 },
  posHint: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17 },
  posBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  posSyncBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.espressoBrown, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 14,
  },
  posSyncText: { color: colors.white, fontSize: 13, fontWeight: '800' },
  posGhostBtn: {
    borderWidth: 1, borderColor: colors.mutedSand, borderRadius: 11,
    paddingVertical: 9, paddingHorizontal: 12,
  },
  posGhostText: { fontSize: 12.5, fontWeight: '700', color: colors.mochaBrown },
  posForm: { gap: 6, marginTop: 10, borderTopWidth: 1, borderTopColor: colors.mutedSand, paddingTop: 10 },
  posLabel: { ...typography.L5, fontWeight: '700', color: colors.espressoBrown },
  posInput: {
    height: 40, backgroundColor: colors.coffeeCream, borderRadius: 10, paddingHorizontal: 11,
    fontSize: 12.5, color: colors.espressoBrown,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null),
  },
  posSwitchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },

  settingsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, marginTop: 4 },
  settingsLinkText: { ...typography.L5, color: colors.mochaBrown, textDecorationLine: 'underline' },
});
