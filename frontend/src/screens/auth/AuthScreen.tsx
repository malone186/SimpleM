// 로그인 / 회원가입 화면 — 미로그인 시 이 화면만 노출 (탭 앱은 숨김)
import { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { FadeInUp, PressableScale } from '../../components/motion';
import { Segmented } from '../../components/ui/Segmented';
import { colors, spacing, typography } from '../../theme';

const LOGO = require('../../../assets/logo_transparent.png');

type Mode = 'login' | 'signup';

export default function AuthScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>('login');

  const [name, setName] = useState('');
  // 데모 계정 기본값 — 바로 로그인 버튼만 누르면 됨
  const [email, setEmail] = useState('test@test.com');
  const [password, setPassword] = useState('1234');
  const [autoLogin, setAutoLogin] = useState(true);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.');
      return;
    }
    if (mode === 'signup' && !name.trim()) {
      setError('이름(상호)을 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password, autoLogin);
      else await signup(name, email, password, autoLogin);
    } catch (e) {
      setError(e instanceof Error ? e.message : '문제가 발생했어요.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 브랜드 */}
        <FadeInUp>
          <View style={styles.brand}>
            <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            <Text style={styles.brandSub}>카페 사장님을 위한 운영 파트너</Text>
          </View>
        </FadeInUp>

        {/* 로그인 / 회원가입 탭 */}
        <FadeInUp delay={80}>
          <Segmented<Mode>
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'login', label: '로그인' },
              { value: 'signup', label: '회원가입' },
            ]}
          />
        </FadeInUp>

        <FadeInUp delay={160}>
          <View style={styles.form}>
            {mode === 'signup' && (
              <Field
                icon="storefront-outline"
                placeholder="상호 / 이름"
                value={name}
                onChangeText={setName}
              />
            )}
            <Field
              icon="mail-outline"
              placeholder="이메일"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Field
              icon="lock-closed-outline"
              placeholder="비밀번호"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            {/* 자동 로그인 체크박스 */}
            <PressableScale style={styles.checkRow} onPress={() => setAutoLogin((v) => !v)} to={0.98}>
              <View style={[styles.checkbox, autoLogin && styles.checkboxOn]}>
                {autoLogin && <Ionicons name="checkmark" size={14} color={colors.white} />}
              </View>
              <Text style={styles.checkLabel}>자동 로그인</Text>
              <Text style={styles.checkHint}>다음부터 바로 로그인돼요</Text>
            </PressableScale>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <PressableScale style={styles.submitBtn} onPress={submit} disabled={busy}>
              <Text style={styles.submitText}>
                {busy ? '처리 중…' : mode === 'login' ? '로그인' : '가입하고 시작하기'}
              </Text>
            </PressableScale>

            <Text style={styles.switchText}>
              {mode === 'login' ? '아직 계정이 없으신가요? ' : '이미 계정이 있으신가요? '}
              <Text
                style={styles.switchLink}
                onPress={() => switchMode(mode === 'login' ? 'signup' : 'login')}
              >
                {mode === 'login' ? '회원가입' : '로그인'}
              </Text>
            </Text>
          </View>
        </FadeInUp>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  icon,
  ...props
}: { icon: keyof typeof Ionicons.glyphMap } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Ionicons name={icon} size={18} color={colors.mochaBrown} />
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.mochaBrown}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  content: { padding: spacing.globalPadding, paddingTop: 80, gap: spacing.verticalGap },
  brand: { alignItems: 'center', marginBottom: 8 },
  logo: { width: 216, height: 175 },
  brandSub: { ...typography.L4, color: colors.mochaBrown, marginTop: 10 },
  form: { gap: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    ...typography.L4,
    fontWeight: '500',
    color: colors.espressoBrown,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.mutedSand,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.pointOrange, borderColor: colors.pointOrange },
  checkLabel: { ...typography.L4, color: colors.espressoBrown },
  checkHint: { ...typography.L5, color: colors.mochaBrown },
  error: { ...typography.L5, color: '#B23B2E', fontWeight: '700' },
  submitBtn: {
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  submitText: { ...typography.L3, color: colors.white },
  switchText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', marginTop: 4 },
  switchLink: { color: colors.pointOrange, fontWeight: '700' },
});
