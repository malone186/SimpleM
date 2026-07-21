// 설정 화면 — 관리 허브에서 진입. (P0)
// ① 계정/가게 정보  ② 구독/결제(ROI 해지방지)  ③ 알림 설정  ④ 화면 표시/접근성
// 계정은 백엔드 /auth 실연동, 나머지 환경설정은 PreferencesContext(AsyncStorage)에 저장.
import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
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
import { Badge, Button, Card, Divider, Screen, SectionTitle, IosTimePicker } from '../../components/ui';
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
  // [한글 주석] 저장 성공 시 확실한 정보 확정 시각 피백을 제공하는 상태
  const [savedSuccess, setSavedSuccess] = useState(false);
  // [한글 주석] 운영 시간 변경 모드 활성화 여부 (평소에는 휠 조작이 안 되게 잠금 확정 뷰로 표시)
  const [isEditingTime, setIsEditingTime] = useState(false);

  // [한글 주석] 사장님 1대1 문의 / 요청사항 데이터 및 작성 모달 상태
  const [showInquiryModal, setShowInquiryModal] = useState(false);
  const [inquiryCategory, setInquiryCategory] = useState('💡 기능 요청 / 개선');
  const [inquiryTitle, setInquiryTitle] = useState('');
  const [inquiryContent, setInquiryContent] = useState('');
  const [inquiries, setInquiries] = useState<
    Array<{ id: number; category: string; title: string; content: string; date: string; status: 'answered' | 'pending'; answer?: string }>
  >([
    {
      id: 1,
      category: '💡 기능 요청 / 개선',
      title: '원두 발주 추천 시 디카페인 자동 추가 기능 요청',
      content: '주말마다 디카페인 손님이 늘어나고 있어서 AI 추천에 포함되었으면 좋겠습니다.',
      date: '2026.07.20',
      status: 'answered',
      answer: '사장님, 좋은 의견 감사드립니다! 해당 기능은 다음주 알고리즘 업데이트에 자동 반영될 예정입니다.',
    },
    {
      id: 2,
      category: '❓ 사용 문의',
      title: '알바생 기피 시간대 자동 반영 범위 문의',
      content: '기피 시간대를 설정해두면 AI 스케줄 추천 시 자동으로 제외되는지 궁금합니다.',
      date: '2026.07.21',
      status: 'pending',
    },
  ]);

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
      setSavedSuccess(true);
      setIsEditingTime(false); // [한글 주석] 저장 성공 시 시간 변경 모드를 닫고 확정 잠금 상태로 전환
      toast('저장 완료', '계정·가게 정보가 확정 업데이트됐어요.');
      setTimeout(() => setSavedSuccess(false), 2200);
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

  // [한글 주석] 백엔드에서 1대1 문의 실시간 내역 불러오기
  const fetchInquiries = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/inquiries`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setInquiries(data);
        }
      }
    } catch {
      /* 서버 오프라인 시 기본 내역 유지 */
    }
  };

  useEffect(() => {
    fetchInquiries();
  }, []);

  // [한글 주석] 1대1 문의 / 요청사항 백엔드 및 관리자 콘솔 이중 직통 전송 제출 함수
  const handleSubmitInquiry = async () => {
    if (!inquiryTitle.trim()) {
      toast('입력 확인', '문의 제목을 입력해 주세요.');
      return;
    }
    if (!inquiryContent.trim()) {
      toast('입력 확인', '문의 내용을 입력해 주세요.');
      return;
    }

    const newInquiryObj = {
      id: Date.now(),
      category: inquiryCategory,
      title: inquiryTitle.trim(),
      content: inquiryContent.trim(),
      date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      status: 'pending' as const,
    };

    // 1. 사장님 화면 state에 즉시 100% 접수 카드 반영 (절대로 안 사라짐)
    setInquiries((prev) => [newInquiryObj, ...prev]);

    const payload = {
      user_email: user?.email || 'owner@cafe.com',
      store_name: storeName || '포슬카페',
      category: inquiryCategory,
      title: inquiryTitle.trim(),
      content: inquiryContent.trim(),
    };

    // 2. 관리자 웹과 사장님 백엔드 양쪽에 직통 전송
    try {
      await fetch(`http://localhost:8000/api/v1/admin/cs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('Admin CS direct fetch error:', err);
    }

    try {
      await fetch(`http://localhost:8000/api/v1/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('Inquiries API fetch error:', err);
    }

    setInquiryTitle('');
    setInquiryContent('');
    setShowInquiryModal(false);
    toast('접수 완료', '1대1 문의 및 요청사항이 관리자에게 전달되었어요.');
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
        <View style={styles.rowBetween}>
          <SectionTitle>계정 · 가게 정보</SectionTitle>
          {savedSuccess && <Badge label="✓ 설정 확정됨" tone="green" />}
        </View>
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
        
        {/* [한글 주석] 평소에는 시간이 고정 확정되어 함부로 변경되지 않게 잠금 뷰로 표시하고, '시간 변경' 버튼 클릭 시에만 휠 피커 오픈 */}
        <View style={{ marginTop: 14, marginBottom: 8, gap: 8 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.fieldLabel}>가게 운영 시간</Text>
            <PressableScale
              onPress={() => setIsEditingTime(!isEditingTime)}
              style={{
                backgroundColor: isEditingTime ? colors.pointOrange + '20' : 'rgba(140, 111, 86, 0.1)',
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 8,
              }}
              to={0.94}
            >
              <Text
                style={{
                  ...typography.L5,
                  fontSize: 12,
                  fontWeight: '800',
                  color: isEditingTime ? colors.pointOrange : colors.espressoBrown,
                }}
              >
                {isEditingTime ? '닫기' : '✏ 시간 변경'}
              </Text>
            </PressableScale>
          </View>

          {isEditingTime ? (
            /* 시간 변경 모드: 드럼 휠 피커 노출 */
            <View style={{ gap: 8 }}>
              <IosTimePicker
                value={`${(prefs.openHour || '09:00').slice(0, 2)}–${(prefs.closeHour || '21:00').slice(0, 2)}`}
                startLabel="오픈 시간"
                endLabel="마감 시간"
                onChange={(val) => {
                  const parts = val.split(/[–-]/);
                  if (parts[0]) prefs.setPref('openHour', `${parts[0].trim().padStart(2, '0')}:00`);
                  if (parts[1]) prefs.setPref('closeHour', `${parts[1].trim().padStart(2, '0')}:00`);
                }}
              />
              <PressableScale
                style={{
                  backgroundColor: colors.coffeeCream,
                  paddingVertical: 8,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: 'rgba(140, 111, 86, 0.18)',
                }}
                onPress={() => setIsEditingTime(false)}
                to={0.96}
              >
                <Text style={{ ...typography.L4, fontSize: 12, fontWeight: '700', color: colors.espressoBrown }}>
                  ✓ 시간 수정 완료 (정보 저장 시 최종 반영)
                </Text>
              </PressableScale>
            </View>
          ) : (
            /* 평소 / 저장 후: 함부로 움직이지 않게 딱 고정된 확정 운영시간 카드 뷰 */
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: 'rgba(242, 236, 224, 0.55)',
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderRadius: 14,
                borderWidth: 1.2,
                borderColor: 'rgba(140, 111, 86, 0.18)',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="time-outline" size={18} color={colors.pointOrange} />
                <Text style={{ ...typography.L3, fontSize: 14, fontWeight: '800', color: colors.espressoBrown }}>
                  🌅 오픈 {prefs.openHour || '09:00'} ~ 🌙 마감 {prefs.closeHour || '21:00'}
                </Text>
              </View>
              <Badge label="확정 고정됨" tone="green" />
            </View>
          )}
        </View>

        <Text style={styles.fieldLabel}>이메일 (변경 불가)</Text>
        <Text style={styles.readonly}>{user?.email ?? '-'}</Text>

        {/* [한글 주석] 정보 확정 시 초록 체크 효과로 확실한 반응성을 제공하는 버튼 */}
        <Button
          label={savingAccount ? '저장 처리 중…' : savedSuccess ? '✓ 정보 변경 확정 완료!' : '정보 저장'}
          onPress={saveAccount}
          disabled={savingAccount}
          style={[
            { marginTop: 16 },
            savedSuccess && { backgroundColor: '#3E8E5A', borderColor: '#3E8E5A' },
          ]}
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

      {/* ⑤ [한글 주석] 사장님 1대1 문의 & 요청사항 서비스 카드 */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>💬 1대1 문의 · 요청사항</SectionTitle>
          <Badge label="관리자 실시간 연동" tone="green" />
        </View>
        <Text style={[styles.roiCompare, { marginTop: 4, marginBottom: 12 }]}>
          매장 운영 중 필요한 문의사항이나 AI 기능 개선 요청을 남겨주시면 관리자가 빠른 시일 내 답변해 드려요.
        </Text>

        {/* 1대1 문의 및 요청 내역 리스트 */}
        <View style={{ gap: 10 }}>
          {inquiries.map((inq) => (
            <View
              key={inq.id}
              style={{
                backgroundColor: colors.white,
                borderRadius: 14,
                padding: 12,
                borderWidth: 1,
                borderColor: 'rgba(140, 111, 86, 0.15)',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Badge
                    label={inq.status === 'answered' ? '답변완료' : '접수완료'}
                    tone={inq.status === 'answered' ? 'green' : 'orange'}
                  />
                  <Text style={{ ...typography.L5, fontSize: 11, fontWeight: '700', color: colors.mochaBrown }}>
                    {inq.category}
                  </Text>
                </View>
                <Text style={{ ...typography.L5, fontSize: 11, color: colors.mochaBrown + '80' }}>{inq.date}</Text>
              </View>

              <Text style={{ ...typography.L3, fontSize: 13.5, fontWeight: '800', color: colors.espressoBrown, marginTop: 2 }}>
                {inq.title}
              </Text>
              <Text style={{ ...typography.L4, fontSize: 12, color: colors.mochaBrown, marginTop: 4, lineHeight: 17 }}>
                {inq.content}
              </Text>

              {inq.answer && (
                <View
                  style={{
                    backgroundColor: colors.coffeeCream,
                    borderRadius: 10,
                    padding: 10,
                    marginTop: 8,
                    borderLeftWidth: 3,
                    borderLeftColor: colors.pointOrange,
                  }}
                >
                  <Text style={{ ...typography.L4, fontSize: 12, fontWeight: '700', color: colors.espressoBrown }}>
                    💬 관리자 답변
                  </Text>
                  <Text style={{ ...typography.L4, fontSize: 12, color: colors.espressoBrown, marginTop: 2, lineHeight: 17 }}>
                    {inq.answer}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>

        <Button
          label="+ 새로운 1대1 문의 / 요청 작성"
          variant="secondary"
          style={{ marginTop: 14 }}
          onPress={() => setShowInquiryModal(true)}
        />
      </Card>

      {/* ⑥ 약관 및 정책 */}
      <Card>
        <SectionTitle>약관 및 정책</SectionTitle>
        <PressableScale
          style={styles.legalRow}
          onPress={() => navigation.navigate('Legal', { doc: 'terms' })}
        >
          <Text style={styles.legalLabel}>이용약관</Text>
          <Ionicons name="chevron-forward" size={17} color={colors.mochaBrown} />
        </PressableScale>
        <Divider />
        <PressableScale
          style={styles.legalRow}
          onPress={() => navigation.navigate('Legal', { doc: 'privacy' })}
        >
          <Text style={styles.legalLabel}>개인정보처리방침</Text>
          <Ionicons name="chevron-forward" size={17} color={colors.mochaBrown} />
        </PressableScale>
      </Card>

      <Button label="관리로 돌아가기" variant="secondary" onPress={() => navigation.goBack()} />

      {/* [한글 주석] 1대1 문의 & 요청사항 작성 모달 */}
      <Modal
        visible={showInquiryModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowInquiryModal(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalContent}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>💬 1대1 문의 / 요청사항 작성</Text>
              <PressableScale onPress={() => setShowInquiryModal(false)} to={0.9}>
                <Ionicons name="close" size={20} color={colors.espressoBrown} />
              </PressableScale>
            </View>

            <ScrollView style={{ maxHeight: 420, marginVertical: 10 }}>
              {/* [한글 주석] 문의 유형 선택 칩: 4개 버튼이 한 줄(nowrap)에 쏙 정갈하게 들어가도록 배치 */}
              <Text style={styles.fieldLabel}>문의 유형 선택</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: 4, marginVertical: 8 }}>
                {[
                  { id: '💡 기능 요청 / 개선', label: '💡 기능 요청' },
                  { id: '❓ 사용 문의', label: '❓ 사용 문의' },
                  { id: '⚠ 에러 / 불편 제보', label: '⚠ 에러 제보' },
                  { id: '📞 기타 문의', label: '📞 기타 문의' },
                ].map((item) => {
                  const active = inquiryCategory === item.id;
                  return (
                    <PressableScale
                      key={item.id}
                      onPress={() => setInquiryCategory(item.id)}
                      style={{
                        flex: 1,
                        paddingHorizontal: 2,
                        paddingVertical: 7,
                        borderRadius: 999,
                        backgroundColor: active ? colors.pointOrange : 'rgba(242, 236, 224, 0.6)',
                        borderWidth: 1,
                        borderColor: active ? colors.pointOrange : 'rgba(140, 111, 86, 0.15)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      to={0.95}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          fontSize: 11.5,
                          fontWeight: active ? '800' : '700',
                          color: active ? colors.white : colors.mochaBrown,
                        }}
                      >
                        {item.label}
                      </Text>
                    </PressableScale>
                  );
                })}
              </View>

              {/* 제목 입력 */}
              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>문의 제목</Text>
              <TextInput
                style={[styles.input, { marginTop: 4 }]}
                placeholder="제목을 입력해 주세요 (예: 발주 추천 단위 변경 요청)"
                placeholderTextColor="rgba(140,111,86,0.5)"
                value={inquiryTitle}
                onChangeText={setInquiryTitle}
              />

              {/* 내용 입력 */}
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>상세 내용 / 요청사항</Text>
              <TextInput
                style={[
                  styles.input,
                  { marginTop: 4, height: 100, textAlignVertical: 'top', paddingTop: 10, paddingBottom: 10 },
                ]}
                placeholder="관리자에게 전달하실 내용이나 개선 요청사항을 상세히 작성해 주세요."
                placeholderTextColor="rgba(140,111,86,0.5)"
                multiline
                numberOfLines={4}
                value={inquiryContent}
                onChangeText={setInquiryContent}
              />
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <Button
                label="취소"
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => setShowInquiryModal(false)}
              />
              <Button
                label="문의 제출하기"
                style={{ flex: 1.6 }}
                onPress={handleSubmitInquiry}
              />
            </View>
          </View>
        </View>
      </Modal>
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

  legalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 },
  legalLabel: { ...typography.L4, color: colors.espressoBrown },

  // [한글 주석] 1대1 문의 및 팝업 모달 전용 레이아웃 스타일 (스마트폰 중앙 너비 420px 한정 조형)
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: colors.white,
    borderRadius: 22,
    padding: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  modalHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    ...typography.L2,
    fontSize: 16,
    color: colors.espressoBrown,
    fontWeight: '900',
  },
});
