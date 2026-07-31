// 매출 입력 — POS 매출 파일 불러오기를 메인으로 삼는 화면.
//
// 설계 의도(사장님 피드백 반영):
//   · POS기에서 뽑은 엑셀/CSV를 올리면 LLM이 열을 알아서 매핑해 매출로 등록해 준다.
//     이게 가장 빠른 길이라 화면 맨 위 히어로 카드로 크게 배치했다.
//   · LLM이 열을 잘못 분류할 수 있으니, DB에 넣기 전에 미리보기로 사용자에게 꼭 확인받는다.
//   · 파일이 없거나 손으로 적고 싶은 경우를 위해 '직접 입력'은 버튼으로 분리해
//     별도 화면(ManualSalesScreen)에서 열리게 했다.
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Badge, Card, Screen, ScreenTitle } from '../../components/ui';
import { confirmSalesImport, previewSalesImport, type ImportPreview } from '../../lib/api/sales';
import { colors, typography } from '../../theme';

export default function SalesInputScreen() {
  const { token } = useAuth();
  const navigation = useNavigation<any>();

  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importedName, setImportedName] = useState('');

  // ---- 파일 선택 → LLM 매핑 미리보기 (DB 저장은 아직 안 함) ----
  // 웹에서는 네이티브 모듈 없이 <input type="file">로 바로 고른다.
  // 네이티브(안드로이드)에서는 expo-document-picker를 쓰는데, 이 네이티브 모듈이
  // 포함된 새 앱 빌드가 있어야 동작한다(현재 구버전 빌드에는 없음 → 안내만).
  const runPreview = async (picked: { uri: string; mimeType?: string | null; fileName?: string | null }) => {
    if (!token) return;
    setImporting(true);
    setImportPreview(null);
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

  // ---- 미리보기에서 확인한 (매칭된) 행만 실제 매출로 저장 ----
  const submitImport = async () => {
    if (!token || !importPreview) return;
    const rows = importPreview.rows
      .filter((r) => r.menu_id != null)
      .map((r) => ({ menu_id: r.menu_id as number, quantity: r.quantity, total_price: r.total_price, sold_at: r.sold_at }));
    if (rows.length === 0) {
      toast('저장할 항목이 없어요', '메뉴가 매칭된 행이 없어요. 미매칭 메뉴는 메뉴 관리에 먼저 등록해 주세요.');
      return;
    }
    setImporting(true);
    try {
      const result = await confirmSalesImport(token, rows);
      toast('매출을 저장했어요', `${result.created}건 · ${result.total.toLocaleString()}원 반영 (재고 자동 차감)`);
      setImportPreview(null);
      setImportedName('');
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
              총 {importPreview.summary.total_rows}행 · 매칭 {importPreview.summary.matched} · 미매칭 {importPreview.summary.unmatched} · 합계 {importPreview.summary.sum_amount.toLocaleString()}원
            </Text>
            {importPreview.summary.unmatched > 0 && (
              <Text style={styles.fileWarn}>⚠ 미매칭 메뉴는 저장에서 제외돼요. 메뉴 관리에 먼저 등록하면 매칭됩니다.</Text>
            )}
            {importPreview.rows.slice(0, 30).map((r, i) => (
              <View key={i} style={[styles.fileRow, r.menu_id == null && styles.fileRowUnmatched]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fileRowName}>
                    {r.menu_name}{r.matched_name && r.matched_name !== r.menu_name ? ` → ${r.matched_name}` : ''}
                  </Text>
                  <Text style={styles.fileRowMeta}>
                    {r.quantity}개 · {(r.total_price ?? 0).toLocaleString()}원{r.sold_at ? ` · ${r.sold_at.slice(0, 16).replace('T', ' ')}` : ''}
                  </Text>
                </View>
                <Badge label={r.menu_id == null ? '미매칭' : '매칭'} tone={r.menu_id == null ? 'danger' : 'green'} />
              </View>
            ))}
            {importPreview.rows.length > 30 && (
              <Text style={styles.fileSub}>…외 {importPreview.rows.length - 30}행 (저장은 전체 반영)</Text>
            )}
            <PressableScale style={styles.fileSaveBtn} onPress={submitImport} disabled={importing} to={0.97}>
              <Text style={styles.fileSaveText}>매칭된 {importPreview.summary.matched}건 저장 (재고 자동 차감)</Text>
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
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10,
    backgroundColor: colors.coffeeCream,
  },
  fileRowUnmatched: { backgroundColor: 'rgba(178, 59, 46, 0.06)' },
  fileRowName: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  fileRowMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  fileSaveBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.trendGreenText, borderRadius: 12, paddingVertical: 12, marginTop: 4,
  },
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

  settingsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, marginTop: 4 },
  settingsLinkText: { ...typography.L5, color: colors.mochaBrown, textDecorationLine: 'underline' },
});
