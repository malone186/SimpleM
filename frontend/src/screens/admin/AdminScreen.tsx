// 관리자 화면 — 일반 앱과 완전히 다른 다크 테마 개발자/운영 콘솔
// 관리자 계정(admin@simplem.com)으로 로그인했을 때만 노출 (RootNavigator에서 분기)
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { confirmDialog, toast } from '../../components/toast';
import { API_BASE_URL } from '../../lib/api/client';
import { colors } from '../../theme';

// 일반 앱과 동일한 테마 (크림/에스프레소)
const A = {
  bg: colors.creamSand,
  card: colors.white,
  cardAlt: colors.coffeeCream,
  border: colors.mutedSand,
  text: colors.espressoBrown,
  sub: colors.mochaBrown,
  accent: colors.pointOrange,
  green: colors.trendGreenText,
  red: '#B23B2E',
  gold: '#B8860B',
  onAccent: colors.white, // 오렌지/에스프레소 배경 위 글자색
};

type Member = { id: number; name: string; email: string; role: '관리자' | '점주' };

const INITIAL_MEMBERS: Member[] = [];

// 유료 플랜(Free/Basic/Pro)은 앱에서 폐지됐다 — 등급·구독·매출 개념을 전부 걷어냈다.
type View3 = 'dash' | 'members';

// GET /admin/stats — 대시보드 지표 (전부 DB 집계값)
type AdminStats = {
  users: number;
  active_stores: number;
  ingredients: number;
  menus: number;
  employees: number;
  ocr_total: number;
  ocr_confirmed: number;
  inquiries_total: number;
  inquiries_pending: number;
};

// GET /health 의 components — 구성요소별 실제 상태
type HealthComponents = {
  api: { ok: boolean };
  db: { ok: boolean; detail?: string; provider?: string; region?: string; database?: string };
  ocr: { ok: boolean; detail?: string; backend?: string };
};

function dbLabel(db: HealthComponents['db']): string {
  return [db.provider, db.region, db.database].filter(Boolean).join(' · ');
}


export default function AdminScreen() {
  const { user, token, logout } = useAuth();
  const [view, setView] = useState<View3>('dash');
  const [members, setMembers] = useState<Member[]>(INITIAL_MEMBERS);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  // 구성요소별 상태 — /health가 API·DB·OCR을 각각 확인해서 준다.
  // 예전엔 DB가 API 상태를 그대로 베끼고 OCR은 '대기'로 하드코딩돼 있어, 셋 다 실제
  // 상태와 무관했다 (OCR은 멀쩡히 도는 중에도 영원히 '대기').
  const [health, setHealth] = useState<HealthComponents | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);

  // [한글 주석] 백엔드 DB와 연동하여 전체 사장님 목록을 실시간으로 새로 로드합니다.
  const loadMembers = useCallback(async () => {
    try {
      // 관리자 전용 API — 로그인 토큰을 실어 보낸다 (백엔드가 관리자 권한 확인)
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/users`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        // [한글 주석] DB에서 읽어온 원본 사용자 객체 리스트를 화면 렌더링에 적합한 Member 구조로 변환
        const mapped = data.map((u: any) => ({
          id: u.id,
          name: u.store_name || u.name,
          email: u.email,
          role: u.email === 'admin@simplem.com' ? '관리자' : '점주',
        }));
        setMembers(mapped);
      }
    } catch (err) {
      console.error("회원 목록 데이터 로딩 실패:", err);
    }
  }, [token]);

  useEffect(() => {
    // 예전엔 `/`를 찔러 봤는데, 웹 빌드(frontend/dist)가 마운트되면 그 경로는 SPA를
    // 돌려주므로 백엔드가 죽어도 200이 나올 수 있다. 상태 전용 엔드포인트를 쓴다.
    fetch(`${API_BASE_URL}/health`)
      .then(async (r) => {
        setApiUp(r.ok);
        if (!r.ok) return;
        const body = await r.json();
        setHealth(body?.components ?? null);
      })
      .catch(() => {
        setApiUp(false);
        setHealth(null);
      });
    loadMembers();
    // 지표는 관리자 토큰이 있어야 조회된다
    if (token) {
      fetch(`${API_BASE_URL}/api/v1/admin/stats`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => setStats(b))
        .catch((e) => console.error('관리자 지표 조회 실패:', e));
    }
  }, [loadMembers, token]);

  // [한글 주석] 회원을 실제 데이터베이스(DB)에서 영구 탈퇴/삭제 처리하는 함수
  const withdraw = (m: Member) =>
    confirmDialog(`${m.name}(${m.email}) 회원을 탈퇴 처리할까요? 관련 매장 데이터가 비활성화됩니다.`, {
      confirmLabel: '탈퇴 처리',
      destructive: true,
      onConfirm: async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/auth/users/${m.id}`, {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          if (res.ok) {
            setMembers((prev) => prev.filter((x) => x.id !== m.id));
            toast('탈퇴 처리 완료', `${m.name} 회원을 탈퇴 처리했습니다.`);
          } else {
            toast('탈퇴 실패', '서버에서 삭제를 거부했습니다.');
          }
        } catch (err) {
          toast('탈퇴 실패', '네트워크 통신 중 오류가 발생했습니다.');
        }
      },
    });

  return (
    <View style={styles.root}>
      {/* 헤더 */}
      <View style={styles.header}>
        <View style={styles.badge}>
          <Ionicons name="shield-checkmark" size={14} color={A.bg} />
          <Text style={styles.badgeText}>ADMIN</Text>
        </View>
        <Text style={styles.title}>관리자 콘솔</Text>
        <Text style={styles.sub}>{user?.email}</Text>
      </View>

      <View style={styles.seg}>
        {([['dash', '대시보드'], ['members', '회원 관리']] as [View3, string][]).map(([v, label]) => (
          <Pressable key={v} style={[styles.segItem, view === v && styles.segActive]} onPress={() => setView(v)}>
            <Text style={[styles.segText, view === v && styles.segTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {view === 'dash' && <Dashboard apiUp={apiUp} health={health} stats={stats} />}
        {view === 'members' && <Members members={members} onWithdraw={withdraw} />}

        <PressableScale style={styles.logoutBtn} onPress={logout} to={0.98}>
          <Ionicons name="log-out-outline" size={18} color={A.red} />
          <Text style={styles.logoutText}>로그아웃</Text>
        </PressableScale>
      </ScrollView>
    </View>
  );
}

// ── 대시보드 ──
function Dashboard({
  apiUp,
  health,
  stats,
}: {
  apiUp: boolean | null;
  health: HealthComponents | null;
  stats: AdminStats | null;
}) {
  // 집계 전에는 '—'을 보여준다. 0으로 두면 "정말 0건"인지 "아직 못 셌는지" 구분이 안 된다.
  const n = (v: number | undefined) => (stats ? String(v ?? 0) : '—');
  // 아직 /health 응답 전이면 null(확인 중), 응답이 왔으면 각 구성요소의 실제 결과
  const dbOk = health ? health.db.ok : apiUp === false ? false : null;
  const ocrOk = health ? health.ocr.ok : apiUp === false ? false : null;
  return (
    <>
      <Text style={styles.sectionTitle}>시스템 상태</Text>
      <View style={styles.row3}>
        <StatusPill label="API" ok={apiUp} />
        <StatusPill label="DB" ok={dbOk} />
        <StatusPill label="OCR" ok={ocrOk} />
      </View>
      {health && (
        <Text style={styles.statusNote}>
          {dbLabel(health.db) ? `DB ${dbLabel(health.db)}\n` : ''}
          OCR 엔진 {health.ocr.backend} · {health.ocr.detail}
          {!health.db.ok && health.db.detail ? `\nDB 오류: ${health.db.detail}` : ''}
        </Text>
      )}

      {/* 지표는 전부 DB 집계값이다 (GET /admin/stats). 예전엔 회원 수만 실제였고
          유료 구독 4·누적 재료 12·OCR 처리 0은 화면에 박아 둔 상수였다. */}
      <Text style={styles.sectionTitle}>주요 지표</Text>
      <View style={styles.grid}>
        <Metric icon="people" label="전체 회원" value={n(stats?.users)} />
        <Metric icon="storefront" label="사용 중 매장" value={n(stats?.active_stores)} />
        <Metric icon="cube" label="등록 재료" value={n(stats?.ingredients)} />
        <Metric icon="cafe" label="등록 메뉴" value={n(stats?.menus)} />
        <Metric icon="scan" label="OCR 처리" value={n(stats?.ocr_total)} />
        <Metric
          icon="chatbubble-ellipses"
          label="미답변 문의"
          value={n(stats?.inquiries_pending)}
        />
      </View>
      {stats && (
        <Text style={styles.statusNote}>
          OCR 확정 {stats.ocr_confirmed}건 / 전체 {stats.ocr_total}건 · 문의 누적 {stats.inquiries_total}건
        </Text>
      )}

      <Text style={styles.sectionTitle}>개발자 도구</Text>
      <View style={styles.card}>
        <ToolRow icon="document-text-outline" label="API 문서" value={`${API_BASE_URL}/docs`} />
        <ToolRow icon="server-outline" label="백엔드" value={API_BASE_URL} last />
      </View>
    </>
  );
}

// ── 회원 관리 (탈퇴) ──
function Members({
  members,
  onWithdraw,
}: {
  members: Member[];
  onWithdraw: (m: Member) => void;
}) {
  return (
    <>
      <Text style={styles.sectionTitle}>전체 회원 {members.length}명</Text>
      {members.map((m) => (
        <View key={m.id} style={styles.memberCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{m.name.charAt(0)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.memberName}>{m.name}</Text>
            <Text style={styles.memberEmail}>{m.email}</Text>
          </View>
          {m.role === '관리자' ? (
            <View style={styles.adminTag}>
              <Text style={styles.adminTagText}>관리자</Text>
            </View>
          ) : (
            <PressableScale style={styles.withdrawBtn} onPress={() => onWithdraw(m)} to={0.9}>
              <Text style={styles.withdrawText}>탈퇴</Text>
            </PressableScale>
          )}
        </View>
      ))}
      {members.length === 0 && (
        <Text style={styles.note}>· 아직 가입한 회원이 없거나, 목록을 불러오지 못했어요.</Text>
      )}
    </>
  );
}

// ── 구독 관리 ──
// 구독 관리 / 매출 화면은 삭제됨 — 앱에서 유료 플랜을 없앴으므로 관리자도 볼 게 없다.
// (구독 등급·MRR·결제 내역은 전부 더미였고, 실제 결제 연동은 처음부터 없었다.)

function StatusPill({ label, ok, note }: { label: string; ok: boolean | null; note?: string }) {
  const color = ok == null ? A.sub : ok ? A.green : A.red;
  const text = ok == null ? note ?? '확인 중' : ok ? '정상' : '중단';
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.pillLabel}>{label}</Text>
      <Text style={[styles.pillState, { color }]}>{text}</Text>
    </View>
  );
}

function Metric({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={20} color={A.accent} />
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function ToolRow({ icon, label, value, last }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.toolRow, last && { borderBottomWidth: 0 }]}>
      <Ionicons name={icon} size={18} color={A.sub} />
      <Text style={styles.toolLabel}>{label}</Text>
      <Text style={styles.toolValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: A.bg },
  header: { paddingHorizontal: 20, paddingTop: Platform.OS === 'web' ? 40 : 56, paddingBottom: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: A.accent, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10 },
  badgeText: { color: A.onAccent, fontWeight: '900', fontSize: 11, letterSpacing: 1 },
  title: { color: A.text, fontSize: 24, fontWeight: '900' },
  sub: { color: A.sub, fontSize: 12, marginTop: 3 },
  seg: { flexDirection: 'row', marginHorizontal: 20, backgroundColor: A.cardAlt, borderRadius: 12, padding: 4, borderWidth: 1, borderColor: A.border },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: A.card },
  segText: { color: A.sub, fontSize: 12, fontWeight: '700' },
  segTextActive: { color: A.text },
  content: { padding: 20, paddingBottom: 40, gap: 10 },
  sectionTitle: { color: A.sub, fontSize: 12, fontWeight: '700', marginTop: 14, marginBottom: 2 },
  statusNote: { color: A.sub, fontSize: 11, marginTop: 6, lineHeight: 15 },
  row3: { flexDirection: 'row', gap: 8 },
  pill: { flex: 1, backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillLabel: { color: A.text, fontSize: 11, fontWeight: '700', marginTop: 2 },
  pillState: { fontSize: 10, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { width: '47.5%', backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 16, padding: 16 },
  metricValue: { color: A.text, fontSize: 24, fontWeight: '900', marginTop: 8 },
  metricLabel: { color: A.sub, fontSize: 12, marginTop: 2 },
  card: { backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 16, overflow: 'hidden' },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: A.border },
  toolLabel: { color: A.text, fontSize: 13, fontWeight: '600' },
  toolValue: { color: A.sub, fontSize: 11, flex: 1, textAlign: 'right' },
  // 회원
  memberCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 16, padding: 12 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: A.border, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: A.text, fontWeight: '900', fontSize: 16 },
  memberName: { color: A.text, fontSize: 14, fontWeight: '700' },
  memberEmail: { color: A.sub, fontSize: 11, marginTop: 2 },
  planTag: { backgroundColor: A.cardAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: A.border },
  planTagText: { color: A.text, fontSize: 11, fontWeight: '700' },
  adminTag: { backgroundColor: A.accent, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  adminTagText: { color: A.onAccent, fontSize: 11, fontWeight: '700' },
  withdrawBtn: { backgroundColor: 'rgba(208,96,78,0.15)', borderWidth: 1, borderColor: A.red, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  withdrawText: { color: A.red, fontSize: 11, fontWeight: '700' },
  note: { color: A.sub, fontSize: 11, marginTop: 8, lineHeight: 15 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginHorizontal: 20, paddingVertical: 6 },
  backText: { color: A.text, fontSize: 15, fontWeight: '700' },
  // 구독
  mrrCard: { backgroundColor: A.accent, borderRadius: 18, padding: 20, marginTop: 4 },
  mrrTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mrrMore: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  mrrMoreText: { color: A.onAccent, fontSize: 11, fontWeight: '700' },
  mrrLabel: { color: A.onAccent, fontSize: 12, fontWeight: '700', opacity: 0.9 },
  mrrValue: { color: A.onAccent, fontSize: 30, fontWeight: '900', marginTop: 4 },
  mrrSub: { color: A.onAccent, fontSize: 12, marginTop: 2, opacity: 0.9 },
  // 활동 피드
  actRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: A.border },
  actName: { color: A.text, fontSize: 13, fontWeight: '700' },
  actText: { color: A.sub, fontSize: 11, marginTop: 2 },
  actAgo: { color: A.sub, fontSize: 11 },
  // 매출 상세
  revHeadCard: { backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 18, padding: 20, marginTop: 4 },
  revLabel: { color: A.sub, fontSize: 12, fontWeight: '700' },
  revSub: { color: A.sub, fontSize: 12, marginTop: 2 },
  revBig: { color: A.text, fontSize: 32, fontWeight: '900', marginTop: 4 },
  revRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: A.border },
  revPlan: { color: A.text, fontSize: 13, fontWeight: '700', width: 44 },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: A.border, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  revAmt: { color: A.text, fontSize: 12, fontWeight: '700', width: 78, textAlign: 'right' },
  planCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: A.card, borderWidth: 1, borderColor: A.border, borderRadius: 16, padding: 16 },
  planDot: { width: 10, height: 10, borderRadius: 5 },
  planName: { color: A.text, fontSize: 15, fontWeight: '800' },
  planDesc: { color: A.sub, fontSize: 11, marginTop: 2 },
  planPrice: { color: A.text, fontSize: 13, fontWeight: '700' },
  planCount: { color: A.sub, fontSize: 11, marginTop: 2 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, marginTop: 12 },
  logoutText: { color: A.red, fontSize: 14, fontWeight: '700' },
});
