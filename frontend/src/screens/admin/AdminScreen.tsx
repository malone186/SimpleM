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

type Member = { id: number; name: string; email: string; role: '관리자' | '점주'; plan: 'Free' | 'Basic' | 'Pro' };

const INITIAL_MEMBERS: Member[] = [
  { id: 3, name: '관리자', email: 'admin@simplem.com', role: '관리자', plan: 'Pro' },
  { id: 2, name: '포자카페', email: 'cafe@test.com', role: '점주', plan: 'Basic' },
  { id: 1, name: '포자카페', email: 'test@test.com', role: '점주', plan: 'Free' },
  { id: 4, name: '언덕위카페', email: 'hill@cafe.com', role: '점주', plan: 'Pro' },
  { id: 5, name: '모닝브루', email: 'morning@cafe.com', role: '점주', plan: 'Basic' },
];

const PLANS = [
  { name: 'Free', price: 0, desc: '기본 재고·판매', color: A.sub },
  { name: 'Basic', price: 9900, desc: '+ AI 리포트·OCR', color: A.green },
  { name: 'Pro', price: 29900, desc: '+ 예측·전체 챗봇', color: A.gold },
] as const;

type View3 = 'dash' | 'members' | 'subs' | 'revenue';

type Activity = { id: number; name: string; action: 'sub' | 'cancel' | 'change'; plan: Member['plan']; ago: string };
const INITIAL_FEED: Activity[] = [
  { id: 3, name: '언덕위카페', action: 'sub', plan: 'Pro', ago: '방금' },
  { id: 2, name: '모닝브루', action: 'sub', plan: 'Basic', ago: '12분 전' },
  { id: 1, name: '포자카페', action: 'cancel', plan: 'Basic', ago: '1시간 전' },
];

export default function AdminScreen() {
  const { user, logout } = useAuth();
  const [view, setView] = useState<View3>('dash');
  const [members, setMembers] = useState<Member[]>(INITIAL_MEMBERS);
  const [feed, setFeed] = useState<Activity[]>(INITIAL_FEED);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const feedSeq = useRef(100);

  useEffect(() => {
    fetch(`${API_BASE_URL}/`).then((r) => setApiUp(r.ok)).catch(() => setApiUp(false));
  }, []);

  // 구독/취소 발생 시 알림(토스트) + 활동 피드 기록
  const emitEvent = useCallback((m: Member, action: Activity['action'], plan: Member['plan']) => {
    setFeed((prev) => [{ id: ++feedSeq.current, name: m.name, action, plan, ago: '방금' }, ...prev].slice(0, 20));
    if (action === 'sub') toast('새 구독 🎉', `${m.name}님이 ${plan} 구독을 시작했어요`);
    else if (action === 'cancel') toast('구독 취소', `${m.name}님이 구독을 해지했어요`);
    else toast('구독 변경', `${m.name}님이 ${plan}(으)로 변경했어요`);
  }, []);

  // 외부 사용자 구독/취소 실시간 시뮬레이션 (관리자 화면에 있는 동안)
  const membersRef = useRef(members);
  membersRef.current = members;
  useEffect(() => {
    const id = setInterval(() => {
      const candidates = membersRef.current.filter((m) => m.role !== '관리자');
      if (!candidates.length) return;
      const m = candidates[Math.floor(Math.random() * candidates.length)];
      const willSub = m.plan === 'Free';
      const next: Member['plan'] = willSub ? (Math.random() > 0.5 ? 'Pro' : 'Basic') : 'Free';
      setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, plan: next } : x)));
      emitEvent({ ...m, plan: next }, willSub ? 'sub' : 'cancel', willSub ? next : m.plan);
    }, 9000);
    return () => clearInterval(id);
  }, [emitEvent]);

  const withdraw = (m: Member) =>
    confirmDialog(`${m.name}(${m.email}) 회원을 탈퇴 처리할까요? 관련 매장 데이터가 비활성화됩니다.`, {
      confirmLabel: '탈퇴 처리',
      destructive: true,
      onConfirm: () => {
        setMembers((prev) => prev.filter((x) => x.id !== m.id));
        toast('탈퇴 처리 완료', `${m.name} 회원을 탈퇴 처리했어요.`);
      },
    });

  const changePlan = (m: Member) => {
    const order: Member['plan'][] = ['Free', 'Basic', 'Pro'];
    const next = order[(order.indexOf(m.plan) + 1) % order.length];
    setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, plan: next } : x)));
    const action: Activity['action'] = next === 'Free' ? 'cancel' : m.plan === 'Free' ? 'sub' : 'change';
    emitEvent({ ...m, plan: next }, action, next === 'Free' ? m.plan : next);
  };

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

      {/* 세그먼트 (매출 상세일 땐 뒤로가기) */}
      {view === 'revenue' ? (
        <Pressable style={styles.backRow} onPress={() => setView('subs')}>
          <Ionicons name="chevron-back" size={20} color={A.text} />
          <Text style={styles.backText}>구독 관리</Text>
        </Pressable>
      ) : (
        <View style={styles.seg}>
          {([['dash', '대시보드'], ['members', '회원 관리'], ['subs', '구독 관리']] as [View3, string][]).map(
            ([v, label]) => (
              <Pressable key={v} style={[styles.segItem, view === v && styles.segActive]} onPress={() => setView(v)}>
                <Text style={[styles.segText, view === v && styles.segTextActive]}>{label}</Text>
              </Pressable>
            )
          )}
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {view === 'dash' && <Dashboard apiUp={apiUp} memberCount={members.length} />}
        {view === 'members' && <Members members={members} onWithdraw={withdraw} onChangePlan={changePlan} />}
        {view === 'subs' && (
          <Subs members={members} feed={feed} onOpenRevenue={() => setView('revenue')} />
        )}
        {view === 'revenue' && <Revenue members={members} feed={feed} />}

        {view !== 'revenue' && (
          <PressableScale style={styles.logoutBtn} onPress={logout} to={0.98}>
            <Ionicons name="log-out-outline" size={18} color={A.red} />
            <Text style={styles.logoutText}>로그아웃</Text>
          </PressableScale>
        )}
      </ScrollView>
    </View>
  );
}

// ── 대시보드 ──
function Dashboard({ apiUp, memberCount }: { apiUp: boolean | null; memberCount: number }) {
  return (
    <>
      <Text style={styles.sectionTitle}>시스템 상태</Text>
      <View style={styles.row3}>
        <StatusPill label="API" ok={apiUp} />
        <StatusPill label="DB" ok={apiUp} />
        <StatusPill label="OCR" ok={null} note="대기" />
      </View>

      <Text style={styles.sectionTitle}>주요 지표</Text>
      <View style={styles.grid}>
        <Metric icon="people" label="전체 회원" value={String(memberCount)} />
        <Metric icon="card" label="유료 구독" value="4" />
        <Metric icon="cube" label="누적 재료" value="12" />
        <Metric icon="scan" label="OCR 처리" value="0" />
      </View>

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
  onChangePlan,
}: {
  members: Member[];
  onWithdraw: (m: Member) => void;
  onChangePlan: (m: Member) => void;
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
          <Pressable onPress={() => onChangePlan(m)} style={styles.planTag}>
            <Text style={styles.planTagText}>{m.plan}</Text>
          </Pressable>
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
      <Text style={styles.note}>· 구독 등급을 누르면 Free → Basic → Pro 순으로 바꿀 수 있어요.</Text>
    </>
  );
}

// ── 구독 관리 ──
function Subs({
  members,
  feed,
  onOpenRevenue,
}: {
  members: Member[];
  feed: Activity[];
  onOpenRevenue: () => void;
}) {
  const count = (p: string) => members.filter((m) => m.plan === p).length;
  const mrr = PLANS.reduce((s, p) => s + p.price * count(p.name), 0);

  return (
    <>
      {/* 매출 카드 — 터치하면 매출 상세로 전환 */}
      <PressableScale style={styles.mrrCard} onPress={onOpenRevenue} to={0.98}>
        <View style={styles.mrrTop}>
          <Text style={styles.mrrLabel}>월 반복 매출 (MRR)</Text>
          <View style={styles.mrrMore}>
            <Text style={styles.mrrMoreText}>상세</Text>
            <Ionicons name="chevron-forward" size={14} color={A.bg} />
          </View>
        </View>
        <Text style={styles.mrrValue}>₩{mrr.toLocaleString()}</Text>
        <Text style={styles.mrrSub}>유료 구독 {count('Basic') + count('Pro')}명 · 터치해 상세 보기</Text>
      </PressableScale>

      <Text style={styles.sectionTitle}>구독 플랜</Text>
      {PLANS.map((p) => (
        <View key={p.name} style={styles.planCard}>
          <View style={[styles.planDot, { backgroundColor: p.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.planName}>{p.name}</Text>
            <Text style={styles.planDesc}>{p.desc}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.planPrice}>{p.price === 0 ? '무료' : `₩${p.price.toLocaleString()}/월`}</Text>
            <Text style={styles.planCount}>{count(p.name)}명 구독</Text>
          </View>
        </View>
      ))}

      <Text style={styles.sectionTitle}>실시간 구독 활동</Text>
      <View style={styles.card}>
        {feed.slice(0, 6).map((a, i, arr) => (
          <ActivityRow key={a.id} a={a} last={i === arr.length - 1} />
        ))}
      </View>
    </>
  );
}

function ActivityRow({ a, last }: { a: Activity; last?: boolean }) {
  const map = {
    sub: { icon: 'arrow-up-circle' as const, color: A.green, text: `${a.plan} 구독 시작` },
    cancel: { icon: 'close-circle' as const, color: A.red, text: '구독 해지' },
    change: { icon: 'swap-horizontal' as const, color: A.gold, text: `${a.plan}로 변경` },
  }[a.action];
  return (
    <View style={[styles.actRow, last && { borderBottomWidth: 0 }]}>
      <Ionicons name={map.icon} size={18} color={map.color} />
      <View style={{ flex: 1 }}>
        <Text style={styles.actName}>{a.name}</Text>
        <Text style={styles.actText}>{map.text}</Text>
      </View>
      <Text style={styles.actAgo}>{a.ago}</Text>
    </View>
  );
}

// ── 매출 상세 ──
function Revenue({ members, feed }: { members: Member[]; feed: Activity[] }) {
  const count = (p: string) => members.filter((m) => m.plan === p).length;
  const paid = PLANS.filter((p) => p.price > 0);
  const mrr = PLANS.reduce((s, p) => s + p.price * count(p.name), 0);
  const paidCount = count('Basic') + count('Pro');
  const arpu = paidCount ? Math.round(mrr / paidCount) : 0;
  const conv = members.length ? Math.round((paidCount / members.length) * 100) : 0;
  const maxRev = Math.max(1, ...paid.map((p) => p.price * count(p.name)));

  return (
    <>
      <View style={styles.revHeadCard}>
        <Text style={styles.revLabel}>월 반복 매출 (MRR)</Text>
        <Text style={styles.revBig}>₩{mrr.toLocaleString()}</Text>
        <Text style={styles.revSub}>연 환산 ₩{(mrr * 12).toLocaleString()}</Text>
      </View>

      <View style={styles.grid}>
        <Metric icon="cash" label="ARPU (인당)" value={`₩${arpu.toLocaleString()}`} />
        <Metric icon="trending-up" label="유료 전환율" value={`${conv}%`} />
        <Metric icon="people" label="유료 구독" value={String(paidCount)} />
        <Metric icon="calendar" label="예상 연매출" value={`₩${((mrr * 12) / 10000).toFixed(0)}만`} />
      </View>

      <Text style={styles.sectionTitle}>플랜별 매출</Text>
      <View style={styles.card}>
        {paid.map((p, i) => {
          const rev = p.price * count(p.name);
          return (
            <View key={p.name} style={[styles.revRow, i === paid.length - 1 && { borderBottomWidth: 0 }]}>
              <Text style={styles.revPlan}>{p.name}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${(rev / maxRev) * 100}%`, backgroundColor: p.color }]} />
              </View>
              <Text style={styles.revAmt}>₩{rev.toLocaleString()}</Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>최근 결제·해지</Text>
      <View style={styles.card}>
        {feed.slice(0, 8).map((a, i, arr) => (
          <ActivityRow key={a.id} a={a} last={i === arr.length - 1} />
        ))}
      </View>
    </>
  );
}

// ── 공용 소품 ──
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
