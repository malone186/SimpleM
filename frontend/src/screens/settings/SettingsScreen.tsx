// 설정 화면 — 관리 허브에서 진입. (P0)
// ① 계정/가게 정보  ② 구독/결제(ROI 해지방지)  ③ 알림 설정  ④ 화면 표시/접근성
// 계정은 백엔드 /auth 실연동, 나머지 환경설정은 PreferencesContext(AsyncStorage)에 저장.
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import {
  FONT_SIZE_LABEL,
  PLANS,
  usePreferences,
  type FontSize,
  type PlanTier,
} from '../../preferences/PreferencesContext';
import { Badge, Button, Card, Divider, Screen, SectionTitle } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { API_BASE_URL } from '../../lib/api/client';
import { colors, typography } from '../../theme';

const wonFmt = (n: number) => '₩' + Math.round(n || 0).toLocaleString('ko-KR');

// [데모] 이번 달 SimpleM이 아껴준 것으로 추정되는 금액 — 실제 절감 지표 연동 전 대표값
const SAVED_THIS_MONTH = 342_000;

// 설정 항목 한 줄 (라벨 + 우측 컨트롤)
function Row({ label, hint, right }: { label: string; hint?: string; right: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

// 라벨 붙은 입력칸
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secure?: boolean;
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
        secureTextEntry={secure}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
      />
    </View>
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const { user, token, updateProfile, logout } = useAuth();
  const prefs = usePreferences();

  // ── 계정/가게 정보 상태 ─────────────────────────────
  const [name, setName] = useState(user?.name ?? '');
  const [storeName, setStoreName] = useState('');
  const [businessType, setBusinessType] = useState(prefs.businessType);
  const [newPw, setNewPw] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);

  const initial = (user?.name || 'S').charAt(0).toUpperCase();

  // 현재 가게 이름·회원 id는 로그인 응답에 없어 /users에서 이메일로 조회
  useEffect(() => {
    if (!user) return;
    fetch(`${API_BASE_URL}/api/v1/auth/users`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: number; email: string; store_name?: string }>) => {
        const me = list.find((u) => u.email === user.email);
        if (me) {
          setUserId(me.id);
          setStoreName(me.store_name ?? '');
        }
      })
      .catch(() => {});
  }, [user]);

  const saveAccount = async () => {
    setSavingAccount(true);
    try {
      await updateProfile({ name, store_name: storeName });
      prefs.setPref('businessType', businessType);
      toast('저장 완료', '계정·가게 정보가 업데이트됐어요.');
    } catch (e) {
      toast('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSavingAccount(false);
    }
  };

  const changePassword = async () => {
    if (newPw.trim().length < 4) {
      toast('비밀번호 확인', '4자 이상으로 입력해 주세요.');
      return;
    }
    try {
      await updateProfile({ password: newPw.trim() });
      setNewPw('');
      toast('변경 완료', '비밀번호가 변경됐어요.');
    } catch (e) {
      toast('변경 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  const doLogout = () => {
    confirmDialog('로그아웃 할까요?', { confirmLabel: '로그아웃', onConfirm: () => logout() });
  };

  const deleteAccount = () => {
    confirmDialog('정말 탈퇴하시겠어요? 모든 데이터가 삭제되며 되돌릴 수 없어요.', {
      confirmLabel: '탈퇴하기',
      destructive: true,
      onConfirm: async () => {
        try {
          if (userId != null) {
            await fetch(`${API_BASE_URL}/api/v1/auth/users/${userId}`, {
              method: 'DELETE',
              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
          }
        } catch {
          /* 삭제 실패해도 로컬 로그아웃은 진행 */
        }
        await logout();
      },
    });
  };

  // ── 구독/결제 ──────────────────────────────────────
  const plan = PLANS[prefs.plan];
  // ROI: 아껴준 돈 ÷ 구독료 (Free면 Pro 기준으로 이득 소구)
  const compareTier: PlanTier = prefs.plan === 'free' ? 'pro' : prefs.plan;
  const comparePrice = PLANS[compareTier].price;
  const roi = comparePrice > 0 ? SAVED_THIS_MONTH / comparePrice : 0;

  const changePlan = (tier: PlanTier) => {
    if (tier === prefs.plan) return;
    const up = PLANS[tier].price > plan.price;
    confirmDialog(
      `${PLANS[tier].label} 플랜(${wonFmt(PLANS[tier].price)}/월)으로 ${up ? '업그레이드' : '변경'}할까요?`,
      {
        confirmLabel: up ? '업그레이드' : '변경',
        onConfirm: () => {
          prefs.setPref('plan', tier);
          toast('플랜 변경', `${PLANS[tier].label} 플랜으로 전환됐어요.`);
        },
      }
    );
  };

  return (
    <Screen>
      {/* ① 계정 / 가게 정보 */}
      <Card>
        <SectionTitle>계정 · 가게 정보</SectionTitle>
        <View style={styles.accountHead}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.accountName}>{user?.name ?? '사장님'}</Text>
            <Text style={styles.accountEmail}>{user?.email ?? '-'}</Text>
          </View>
        </View>

        <Field label="사장님 이름" value={name} onChangeText={setName} placeholder="이름" />
        <Field label="가게 이름" value={storeName} onChangeText={setStoreName} placeholder="예: 포슬카페" />
        <Field label="업종" value={businessType} onChangeText={setBusinessType} placeholder="예: 카페 / 베이커리 / 음식점" />
        <Text style={styles.fieldLabel}>이메일 (변경 불가)</Text>
        <Text style={styles.readonly}>{user?.email ?? '-'}</Text>

        <Button
          label={savingAccount ? '저장 중…' : '정보 저장'}
          onPress={saveAccount}
          disabled={savingAccount}
          style={{ marginTop: 16 }}
        />

        <Divider />
        <Text style={[styles.fieldLabel, { marginTop: 4 }]}>비밀번호 변경</Text>
        <View style={styles.pwRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newPw}
            onChangeText={setNewPw}
            placeholder="새 비밀번호 (4자 이상)"
            placeholderTextColor="rgba(140,111,86,0.5)"
            secureTextEntry
            autoCapitalize="none"
          />
          <Button label="변경" variant="secondary" onPress={changePassword} />
        </View>

        <Divider />
        <View style={styles.actionsRow}>
          <Button label="로그아웃" variant="secondary" style={{ flex: 1 }} onPress={doLogout} />
          <PressableScale style={styles.dangerBtn} onPress={deleteAccount}>
            <Ionicons name="trash-outline" size={15} color="#B23B2E" />
            <Text style={styles.dangerText}>회원 탈퇴</Text>
          </PressableScale>
        </View>
      </Card>

      {/* ② 구독 / 결제 */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>구독 · 결제</SectionTitle>
          <Badge label={`현재 ${plan.label}`} tone={prefs.plan === 'free' ? 'neutral' : 'green'} />
        </View>

        {/* ROI — 해지 방지 소구 */}
        <View style={styles.roiBox}>
          <Text style={styles.roiCaption}>이번 달 SimpleM이 아껴준 돈 (추정)</Text>
          <Text style={styles.roiValue}>{wonFmt(SAVED_THIS_MONTH)}</Text>
          {roi > 0 ? (
            <Text style={styles.roiCompare}>
              {compareTier === prefs.plan ? '' : `${PLANS[compareTier].label} `}구독료 {wonFmt(comparePrice)}/월의{' '}
              <Text style={styles.roiHighlight}>{roi.toFixed(1)}배</Text>를 아꼈어요
            </Text>
          ) : (
            <Text style={styles.roiCompare}>유료 플랜으로 올리면 더 많은 기능으로 비용을 아낄 수 있어요.</Text>
          )}
        </View>

        {/* 플랜 선택 */}
        <View style={styles.planRow}>
          {(Object.keys(PLANS) as PlanTier[]).map((tier) => {
            const p = PLANS[tier];
            const active = prefs.plan === tier;
            return (
              <PressableScale
                key={tier}
                style={[styles.planCard, active && styles.planCardActive]}
                onPress={() => changePlan(tier)}
                to={0.97}
              >
                <Text style={[styles.planName, active && styles.planNameActive]}>{p.label}</Text>
                <Text style={[styles.planPrice, active && styles.planNameActive]}>
                  {p.price === 0 ? '무료' : `${wonFmt(p.price)}/월`}
                </Text>
                <Text style={styles.planBlurb}>{p.blurb}</Text>
              </PressableScale>
            );
          })}
        </View>
        {prefs.plan !== 'business' ? (
          <Button
            label="업그레이드"
            style={{ marginTop: 14 }}
            onPress={() => changePlan(prefs.plan === 'free' ? 'pro' : 'business')}
          />
        ) : null}
      </Card>

      {/* ③ 알림 설정 */}
      <Card>
        <SectionTitle>알림 설정</SectionTitle>
        <Row
          label="재고 부족 알림"
          hint="설정한 안전재고 밑으로 떨어지면 먼저 알려드려요"
          right={
            <Switch
              value={prefs.lowStockAlert}
              onValueChange={(v) => prefs.setPref('lowStockAlert', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Row
          label="단가 급등 알림"
          hint="원재료 매입 단가가 크게 오르면 알려드려요"
          right={
            <Switch
              value={prefs.priceSurgeAlert}
              onValueChange={(v) => prefs.setPref('priceSurgeAlert', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        <Divider />
        <Text style={styles.fieldLabel}>AI 경영 리포트 수신 주기</Text>
        <View style={{ marginTop: 8 }}>
          <Segmented
            options={[
              { value: 'daily', label: '매일' },
              { value: 'weekly', label: '매주' },
            ]}
            value={prefs.reportFrequency}
            onChange={(v) => prefs.setPref('reportFrequency', v)}
          />
        </View>
        <Divider />
        <Row
          label="방해 금지 시간대"
          hint="이 시간엔 푸시를 보내지 않아요 (새벽 알림 방지)"
          right={
            <Switch
              value={prefs.dndEnabled}
              onValueChange={(v) => prefs.setPref('dndEnabled', v)}
              trackColor={{ false: '#D6CFC7', true: colors.espressoBrown }}
              thumbColor={colors.white}
            />
          }
        />
        {prefs.dndEnabled ? (
          <View style={styles.dndRow}>
            <TextInput
              style={styles.timeInput}
              value={prefs.dndStart}
              onChangeText={(t) => prefs.setPref('dndStart', t)}
              placeholder="22:00"
              placeholderTextColor="rgba(140,111,86,0.5)"
              maxLength={5}
            />
            <Text style={styles.dndTilde}>~</Text>
            <TextInput
              style={styles.timeInput}
              value={prefs.dndEnd}
              onChangeText={(t) => prefs.setPref('dndEnd', t)}
              placeholder="08:00"
              placeholderTextColor="rgba(140,111,86,0.5)"
              maxLength={5}
            />
          </View>
        ) : null}
      </Card>

      {/* ④ 화면 표시 / 접근성 */}
      <Card>
        <SectionTitle>화면 표시 · 접근성</SectionTitle>
        <Text style={styles.fieldLabel}>글자 크기</Text>
        <View style={{ marginTop: 8 }}>
          <Segmented
            options={(['small', 'normal', 'large', 'xlarge'] as FontSize[]).map((f) => ({
              value: f,
              label: FONT_SIZE_LABEL[f],
            }))}
            value={prefs.fontSize}
            onChange={(v) => prefs.setPref('fontSize', v)}
          />
        </View>

        {/* 미리보기 — 선택한 글자 크기가 즉시 반영 */}
        <View style={styles.previewBox}>
          <Text style={styles.previewCaption}>미리보기</Text>
          <Text style={[styles.previewText, { fontSize: 15 * prefs.fontScale }]}>
            가나다라 ABC 123 · 오늘도 좋은 하루 되세요 ☕
          </Text>
        </View>
        <View style={styles.noteBox}>
          <Ionicons name="information-circle-outline" size={15} color={colors.mochaBrown} />
          <Text style={styles.noteText}>
            글자 크기는 앱 전체에 즉시 적용되고 저장돼요. (실기기 앱 적용은 추후 확대)
          </Text>
        </View>
      </Card>

      <Button label="관리로 돌아가기" variant="secondary" onPress={() => navigation.goBack()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { ...typography.L4, color: colors.espressoBrown },
  rowHint: { ...typography.L5, color: colors.mochaBrown, marginTop: 3, lineHeight: 15 },

  fieldLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700', marginTop: 12 },
  input: {
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 6,
  },
  readonly: { ...typography.L4, color: colors.mochaBrown, marginTop: 6, paddingHorizontal: 2, paddingVertical: 4 },

  accountHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.espressoBrown, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '900', fontSize: 18 },
  accountName: { ...typography.L3, color: colors.espressoBrown },
  accountEmail: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  pwRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  dangerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(178,59,46,0.35)',
  },
  dangerText: { ...typography.L4, color: '#B23B2E' },

  // 구독 ROI
  roiBox: {
    backgroundColor: 'rgba(78,54,41,0.05)', borderRadius: 14, padding: 14, marginTop: 12,
    borderWidth: 1, borderColor: 'rgba(78,54,41,0.08)',
  },
  roiCaption: { ...typography.L5, color: colors.mochaBrown },
  roiValue: { ...typography.L2, color: colors.espressoBrown, marginTop: 4 },
  roiCompare: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 16 },
  roiHighlight: { color: colors.trendGreenText, fontWeight: '900' },

  planRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  planCard: {
    flex: 1, borderRadius: 14, padding: 12,
    backgroundColor: colors.white, borderWidth: 1.5, borderColor: 'rgba(140,111,86,0.14)',
  },
  planCardActive: { borderColor: colors.espressoBrown, backgroundColor: '#FBF7F3' },
  planName: { ...typography.L4, color: colors.mochaBrown },
  planNameActive: { color: colors.espressoBrown },
  planPrice: { ...typography.L5, color: colors.mochaBrown, marginTop: 4, fontWeight: '800' },
  planBlurb: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 14 },

  dndRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  timeInput: {
    ...typography.L4, color: colors.espressoBrown, textAlign: 'center',
    backgroundColor: colors.coffeeCream, borderRadius: 10, paddingVertical: 10, width: 92,
  },
  dndTilde: { ...typography.L3, color: colors.mochaBrown },

  previewBox: {
    marginTop: 16, backgroundColor: colors.coffeeCream, borderRadius: 12, padding: 14,
  },
  previewCaption: { ...typography.L5, color: colors.mochaBrown, marginBottom: 6 },
  previewText: { color: colors.espressoBrown, fontWeight: '600' },

  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: 'rgba(140,111,86,0.06)', borderRadius: 10, padding: 10, marginTop: 12,
  },
  noteText: { ...typography.L5, color: colors.mochaBrown, flex: 1, lineHeight: 16 },
});
