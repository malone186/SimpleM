// 알림 감시자 — 설정 화면의 알림 설정을 "실제 동작"으로 연결하는 헤드리스 컴포넌트.
// ① 재고 부족 알림: 안전재고 미달 품목을 60초 주기로 감지해 푸시(토스트) 발송
// ② 단가 급등 알림: 재료 매입 단가가 직전 기준가 대비 10% 이상 오르면 발송
// ③ AI 경영 리포트 수신 주기: 매일 / 매주(월요일) 오전에 리포트 도착 알림
// ④ 방해 금지 시간대: 설정 구간(자정 넘김 포함)에는 위 알림을 전부 보류하고, 구간이 끝나면 발송
// ⑤ 문의 답변 도착: 내 1대1 문의에 관리자 답변이 달리면 어느 화면에 있든 즉시 알림
// ⑥ 음성 비서 알림: 새 완료 이벤트를 30초 주기로 폴링해 TTS로 읽어준다
//    — 설정 > 알림 수신 설정의 '알림 음성 읽어주기' 스위치로 켜고 끄고,
//      바로 아래 '언제 소리로 읽어줄까요?'(항상 / 이어폰 연결 시에만)로 출력 조건을 고른다.
//      기본은 '항상' — 예전엔 이어폰 감지가 실패하면 알림이 통째로 조용해졌다.
// ⑦ 선제 인사이트: 서버가 매장 DB를 훑어 찾아낸 "곧 할 일·놓친 일"을 10분 주기로 받아 알림
//    — 재고 소진 예상일, 신고 기한, 갱신 서류, 주휴수당, 방치된 초안, 어제 매출 미입력,
//      대기 중인 단골, POS 연동 끊김, 원가율이 무너진 메뉴, 내일 수요 급증 등
//      (먼저 말을 걸지는 않는다 — 알림으로만 전하고 대화는 사장님이 시작한다)
// ⑩ 오늘의 브리핑: 하루의 첫 실행에서 한 번, 어제 실적과 오늘 급한 일 3가지를 한 번에
// (관리자 공지는 홈 화면 강아지 말풍선(WelcomeHeader)이 단독으로 전하므로 여기선 토스트를 띄우지 않는다)
// 같은 품목·같은 날 중복 알림은 AsyncStorage에 발송 이력을 남겨 1회로 제한한다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { usePreferences } from '../preferences/PreferencesContext';
import { listMyInquiries } from '../lib/api/inquiry';
import { listStocks, type StockItem } from '../lib/api/inventory';
import { fetchNotifications } from '../lib/api/assistant';
import { fetchBriefing } from '../lib/api/briefing';
import { fetchInsights } from '../lib/api/insights';
import { loadCache, saveCache } from '../lib/cache';
import { enqueue as speechEnqueue, canPlayAudio, cancelAll as speechCancelAll, setAuthToken as speechSetAuthToken } from '../lib/speech/speechPlayer';
import { toast } from '../components/toast';
import { getNotificationSettings, updateNotificationSettings } from '../lib/api/push';
import { getSensorRecommendations } from '../lib/api/sensor';
import { isNativePushAvailable, usePushRegistration } from './pushRegistration';
import { navigateToTarget } from './navigationTarget';

/**
 * 재고 화면의 해당 재료로 보낸다.
 *
 * AlertsWatcher는 NavigationContainer 바깥에 있어 useNavigation을 못 쓴다 —
 * 그래서 푸시 알림과 같은 통로(navigationRef)를 쓴다.
 * ts를 같이 넘기는 이유: 같은 재료 알림을 연달아 눌러도 파라미터가 바뀌어야
 * 받는 화면이 '새 요청'으로 인식하고 다시 스크롤한다.
 */
function goToStock(ingredientId: number) {
  navigateToTarget({
    screen: 'Inventory',
    params: { focusIngredientId: ingredientId, ts: Date.now() },
  });
}

/** 여러 품목이 한꺼번에 부족할 때 가장 급한 것(안전재고 대비 잔여가 가장 적은 품목) */
function lowest(items: StockItem[]): number {
  const ratio = (s: StockItem) =>
    s.safety_quantity > 0 ? s.current_quantity / s.safety_quantity : s.current_quantity;
  return items.reduce((a, b) => (ratio(b) < ratio(a) ? b : a)).ingredient_id;
}

// 감시 폴링의 '첫 실행'을 늦추는 시간.
//
// 여기 있는 것들은 전부 배경 감시다 — 재고 경고·센서 이상·공지·음성 알림·인사이트·브리핑.
// 첫 화면에 그려지는 내용이 아닌데도 로그인 즉시 한꺼번에 튀어 나가서, 정작 눈에 보이는
// 카드(매출·본전·할 일)의 차례를 밀어냈다. 브라우저는 한 서버에 동시 연결이 6개뿐이라
// 이 경합이 그대로 체감 지연이 된다(실측 2026-08-12: 홈 진입 19건 동시 호출).
// 몇 초 늦게 시작해도 감시 목적에는 아무 손해가 없다.
const WATCH_START_DELAY_MS = 4_000;

const POLL_MS = 60_000;           // 감시 주기 (1분)
// 문의 답변 감시 주기 — 관리자가 답을 다는 데 보통 수 분~수 시간 걸린다.
// 15초로 두면 홈에 가만히 있어도 분당 4회 요청이 계속 나가 배터리·서버만 축낸다.
const NOTICE_POLL_MS = 120_000;
const VOICE_POLL_MS = 30_000;     // ⑥ 음성 비서 알림 폴링 주기 (30초)
const INSIGHT_POLL_MS = 600_000;  // ⑦ 선제 인사이트 폴링 주기 (10분 — 하루 단위로 바뀌는 정보라 자주 볼 필요 없다)
const INSIGHT_MAX_PER_CYCLE = 3;  // 한 번에 쏟아붓지 않는다 — 나머지는 다음 주기에
const SURGE_RATIO = 1.1;          // 단가 급등 기준: 기준가 대비 +10% 이상
const REPORT_HOUR = 9;            // 리포트 도착 알림은 오전 9시 이후에만

const STORE_KEY = 'simplem:alerts:state';
// 이미 알림을 보낸 '답변 완료' 문의 id 목록 (중복 토스트 방지)
const INQUIRY_KEY = 'simplem:alerts:inquiry-answered-ids';
// 오늘 이미 알린 인사이트 key 목록 — {date, keys} 형태로 보관해 날짜가 바뀌면 초기화된다
const INSIGHT_KEY = 'simplem:alerts:insight-sent';
// ⑩ 오늘의 브리핑을 이미 보여준 날짜 (YYYY-MM-DD) — 하루 한 번만 뜨게
const BRIEFING_KEY = 'simplem:alerts:briefing-shown';
// 하루가 바뀌는 것만 보면 되므로 느긋하게 (앱을 켜 둔 채 날짜가 넘어가는 경우 대비)
const BRIEFING_POLL_MS = 1_800_000; // 30분
// ⑨ 설비 이상(냉장고 온도·수위) 인앱 감시 — 푸시가 없는 빌드에서만 돈다
const FAULT_KEY = 'simplem:alerts:sensor-fault-sent';
const FAULT_POLL_MS = 300_000;        // 5분 — 온도 이탈은 분 단위로 급변하지 않는다
const SENSOR_COOLDOWN_MS = 6 * 3600_000; // 같은 이상 재알림 간격 (서버 SENSOR_COOLDOWN_HOURS와 동일)

/** 인사이트 카테고리별 아이콘 — 어느 영역 이야기인지 한눈에 */
const INSIGHT_ICON: Record<string, string> = {
  inventory: '📦',
  order: '🚚',
  document: '📄',
  tax: '🧾',
  sales: '📉',
  staff: '👥',
  data: '✏️',
  market: '🏪',      // 주변 상권 변화 (카페 개업·폐업)
  settlement: '💳',  // 카드 정산 — 어제 매출 미입력·오늘 입금
  customer: '🙋',    // 단골 — 대기 중인 체크인·뜸해진 손님
  marketing: '📣',   // 홍보 공백·주말 타이밍
  system: '🔌',      // POS 연동·설비 이상
  forecast: '🔮',    // 내일 수요 급증·비 예보
  menu: '🧮',        // 메뉴 원가율
  reward: '🎁',      // 안 쓴 포인트
};

type AlertState = {
  lowStockDate?: string;          // 재고 부족 알림을 마지막으로 보낸 날짜 (YYYY-MM-DD)
  lowStockIds?: number[];         // 그 날짜에 이미 알린 품목 id
  priceBaseline?: Record<string, number>; // 재료별 단가 기준가 (급등 비교 기준)
  reportDaily?: string;           // 일간 리포트 알림 보낸 날짜
  reportWeekly?: string;          // 주간 리포트 알림 보낸 주 (YYYY-Www)
};

/** 'HH:MM' 문자열 → 자정 기준 분(minute). 형식이 틀리면 null */
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 방해 금지 구간 판정 — 22:00~08:00처럼 자정을 넘기는 구간도 처리 */
export function isInDndWindow(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

// 기기 로컬(=KST) 날짜 키 — toISOString()은 UTC라 오전 9시 전엔 어제가 나와
// 아침 브리핑이 통째로 건너뛰어지고, 하루 1회 중복 방지가 오전 9시에 리셋됐다.
// 구현은 lib/dateKey 한 곳에서 관리한다.
import { dateKey } from '../lib/dateKey';

/** ISO 주차 키 (주간 리포트 중복 발송 방지용) */
function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export default function AlertsWatcher() {
  const { token, user } = useAuth();
  const prefs = usePreferences();
  const running = useRef(false); // 폴링 중복 실행 방지
  const noticeRunning = useRef(false); // 공지·답변 폴링 중복 실행 방지
  const voiceRunning = useRef(false); // ⑥ 음성 알림 폴링 중복 실행 방지
  const insightRunning = useRef(false); // ⑦ 선제 인사이트 폴링 중복 실행 방지
  const faultRunning = useRef(false); // ⑨ 설비 이상 폴링 중복 실행 방지
  const lastVoiceCheck = useRef<string>(new Date().toISOString()); // 마지막 폴링 시각

  // 로그인한 사장님이 있을 때만 감시한다.
  // (토큰만 살아 있고 user가 없는 상태 = 로그인 화면 — 이때 폴링하면 재고 부족·리포트
  //  토스트가 로그인 화면 위로 쏟아진다. 파이어베이스 세션이 기기에 남아 있으면
  //  자동 로그인을 끄고 앱을 켰을 때 바로 이 상황이 된다.)
  const signedIn = !!token && !!user;

  // ⑦ FCM 푸시 등록 — 앱이 꺼져 있을 때도 도착해야 하는 Tier 1 알림용.
  //    위 폴링(①~⑥)은 앱이 열려 있을 때만 도는 인앱 토스트라 서로 역할이 다르다.
  usePushRegistration(token);

  // ⑧-a 알림 설정 서버값 내려받기 — 반드시 올려보내기(⑧-b)보다 먼저 한 번 돈다.
  //     설정은 기기 AsyncStorage에 있는데, 앱을 지웠다 깔면 그게 전부 기본값이 된다.
  //     그 상태로 곧장 PUT하면 서버에 저장돼 있던 사장님 설정을 기본값으로 덮어쓴다.
  //     (예전엔 GET을 아무 데서도 호출하지 않아, 화면의 스위치는 실제 발송 여부와 무관한
  //      장식이었다 — 켜져 있는데 서버는 꺼져 있거나, 그 반대.)
  const [settingsHydrated, setSettingsHydrated] = useState(false);

  useEffect(() => {
    if (!token || !prefs.ready || settingsHydrated) return;
    let alive = true;
    getNotificationSettings(token)
      .then((s) => {
        if (!alive) return;
        prefs.setPref('lowStockAlert', s.stock_alert);
        // '놓친 일 먼저 알려주기'는 이제 인사이트·브리핑 스위치가 주인이다.
        // 구버전 서버(insight_alert 없음)에서는 예전처럼 서류 알림 값을 따른다.
        prefs.setPref(
          'proactiveInsights',
          typeof s.insight_alert === 'boolean' ? s.insight_alert : s.compliance_alert,
        );
        // 구버전 서버는 nearby_alert를 안 준다 — 그때는 기기 값을 그대로 둔다
        if (typeof s.nearby_alert === 'boolean') prefs.setPref('nearbyAlert', s.nearby_alert);
        prefs.setPref('reportFrequency', s.report_frequency);
        prefs.setPref('dndEnabled', s.dnd_enabled);
        prefs.setPref('dndStart', s.dnd_start);
        prefs.setPref('dndEnd', s.dnd_end);
      })
      .catch((e) => {
        // 구버전 서버·오프라인이면 기기 값을 그대로 쓴다 (동기화만 미뤄진다)
        console.warn('알림 설정 서버 조회 실패 — 기기 설정을 사용합니다:', e);
      })
      .finally(() => {
        if (alive) setSettingsHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, [token, prefs.ready, settingsHydrated]);

  // ⑧-b 알림 설정 서버 동기화 — 푸시는 서버가 보내므로 방해금지·수신 주기를 서버도 알아야 한다.
  useEffect(() => {
    if (!token || !prefs.ready || !settingsHydrated) return;
    const t = setTimeout(() => {
      // 스위치를 연속으로 토글할 때 매번 PUT하지 않도록 잠깐 모았다 보낸다
      // 설정 화면의 스위치를 실제로 서버에 반영한다.
      // 예전엔 compliance_alert·sensor_alert를 true로 박아 보내서, '놓친 일 먼저 알려주기'를
      // 꺼도 서버는 계속 그 알림을 보냈다 — 앱 안에서만 꺼진 척했던 것이다.
      updateNotificationSettings(token, {
        push_enabled: true,
        // '놓친 일 먼저 알려주기'가 갱신 서류·기한 알림을 관장한다
        compliance_alert: prefs.proactiveInsights,
        report_alert: true,
        stock_alert: prefs.lowStockAlert,
        // 센서 알림은 여기서 정하지 않는다 — '매장 센서 연동' 스위치가 서버 쪽 별도 플래그
        // (GET/PUT /sensor/feature)로 직접 켜고 끄므로, 그 값을 여기서 덮어쓰면 안 된다.
        sensor_alert: true,
        // 주변 소식(행사·경쟁 카페 변화) — 설정 화면의 '주변 소식 알림' 스위치
        nearby_alert: prefs.nearbyAlert,
        // 아침 브리핑·선제 인사이트 푸시도 '놓친 일 먼저 알려주기'를 따른다 —
        // 앱 안에서만 조용하고 서버는 계속 보내는 상태가 되지 않게 서버에도 알린다
        insight_alert: prefs.proactiveInsights,
        report_frequency: prefs.reportFrequency,
        dnd_enabled: prefs.dndEnabled,
        dnd_start: prefs.dndStart,
        dnd_end: prefs.dndEnd,
      }).catch(() => {
        // 서버 오프라인 — 설정이 바뀔 때 다시 시도된다
      });
    }, 800);
    return () => clearTimeout(t);
  }, [
    token,
    prefs.ready,
    settingsHydrated,
    prefs.lowStockAlert,
    prefs.proactiveInsights, // 이제 서버로 실제 전달되므로 바뀌면 다시 보내야 한다
    prefs.nearbyAlert,
    prefs.reportFrequency,
    prefs.dndEnabled,
    prefs.dndStart,
    prefs.dndEnd,
  ]);

  // ⑤ 문의 답변 도착 — 15초 주기로 감시 (관리자 공지는 홈 말풍선이 담당하므로 제외)
  useEffect(() => {
    if (!signedIn || !prefs.ready) return;

    // ⑤ 내 문의에 관리자 답변이 새로 달렸는지 감시 — 답변 완료 id 목록 비교 방식
    const checkInquiryAnswers = async () => {
      if (!token) return; // 내 문의 조회는 토큰이 있어야 한다 (서버가 토큰 주인 것만 준다)
      const raw = await AsyncStorage.getItem(INQUIRY_KEY);
      const seen: number[] | null = raw ? JSON.parse(raw) : null;

      const list = await listMyInquiries(token);
      const answeredIds = list.filter((i) => i.status === 'answered').map((i) => i.id);

      // 첫 실행에는 기존 답변을 쏟아내지 않도록 현재 상태를 기준선으로만 저장
      if (seen === null) {
        await AsyncStorage.setItem(INQUIRY_KEY, JSON.stringify(answeredIds));
        return;
      }

      const fresh = list.filter((i) => i.status === 'answered' && !seen.includes(i.id));
      if (fresh.length === 0) return;
      for (const inq of fresh.slice(0, 3)) {
        toast('💬 문의 답변 도착', `"${inq.title}" 문의에 관리자 답변이 등록됐어요. 설정 > 1대1 문의에서 확인하세요.`);
      }
      if (fresh.length > 3) {
        toast('💬 문의 답변 도착', `답변이 등록된 문의가 ${fresh.length - 3}건 더 있어요.`);
      }
      await AsyncStorage.setItem(INQUIRY_KEY, JSON.stringify(answeredIds));
    };

    const runOnce = async () => {
      if (noticeRunning.current) return;
      noticeRunning.current = true;
      try {
        // 방해 금지 구간에는 커서를 옮기지 않고 보류 → 구간이 끝나면 밀린 알림이 발송된다.
        if (prefs.dndEnabled && isInDndWindow(new Date(), prefs.dndStart, prefs.dndEnd)) return;
        await checkInquiryAnswers().catch(() => {});
      } finally {
        noticeRunning.current = false;
      }
    };

    const first = setTimeout(runOnce, WATCH_START_DELAY_MS);
    const timer = setInterval(runOnce, NOTICE_POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [signedIn, user?.email, prefs.ready, prefs.dndEnabled, prefs.dndStart, prefs.dndEnd]);

  useEffect(() => {
    if (!signedIn || !prefs.ready) return;

    const check = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const now = new Date();

        // ④ 방해 금지 시간대 — 켜져 있고 구간 안이면 어떤 푸시도 보내지 않는다.
        //    발송 이력을 남기지 않으므로 구간이 끝난 뒤 첫 감시 때 밀린 알림이 나간다.
        if (prefs.dndEnabled && isInDndWindow(now, prefs.dndStart, prefs.dndEnd)) return;

        const raw = await AsyncStorage.getItem(STORE_KEY);
        const state: AlertState = raw ? JSON.parse(raw) : {};
        let dirty = false;

        // 재고를 한 번만 조회해 ①·②에 함께 사용.
        // 홈 화면(dash:stocks)이 방금 받아 둔 값이 있으면 그걸 쓴다 — 앱을 켠 직후에는
        // 홈과 이 감시자가 같은 재고 API를 몇 초 간격으로 두 번 부르고 있었다.
        let stocks: StockItem[] = [];
        try {
          const hit = await loadCache<StockItem[]>('dash:stocks');
          if (hit && Date.now() - hit.at < 45_000) {
            stocks = hit.data;
          } else {
            stocks = await listStocks(token);
            void saveCache('dash:stocks', stocks);
          }
        } catch {
          return; // 서버 오프라인 — 다음 주기에 재시도
        }

        // ① 재고 부족 알림
        if (prefs.lowStockAlert) {
          const today = dateKey(now);
          const alreadyIds = state.lowStockDate === today ? state.lowStockIds ?? [] : [];
          // 안전재고 미설정(0)은 3개 기준으로 본다 — 홈 할 일·재고 배지와 같은 규칙.
          // 이 폴백이 빠지면 safety=0 재료는 1~3개 남아 화면엔 '부족' 배지가 떠도
          // 푸시만 조용히 안 나간다 (아래 문구의 need 계산과도 어긋났다).
          const low = stocks.filter(
            (s) =>
              s.current_quantity <= (s.safety_quantity > 0 ? s.safety_quantity : 3) &&
              !alreadyIds.includes(s.ingredient_id)
          );
          // 문구는 홈 할 일·알림 센터와 같은 쉬운 말로 ('안전재고' 같은 용어는 쓰지 않는다)
          if (low.length === 1) {
            const s = low[0];
            const need = s.safety_quantity > 0 ? s.safety_quantity : 3;
            toast(
              s.current_quantity <= 0 ? `📦 ${s.name} 다 떨어졌어요` : `📦 ${s.name} 얼마 안 남았어요`,
              `${s.current_quantity}${s.unit} 남음 · 최소 ${need}${s.unit} 필요`,
              // 한 품목이면 그 재료로 바로 보낸다 — 목록에서 다시 찾게 하지 않는다
              { label: '재고 보기', onPress: () => goToStock(s.ingredient_id) }
            );
          } else if (low.length > 1) {
            const names = low.slice(0, 3).map((s) => s.name).join(', ');
            const rest = low.length > 3 ? ` 외 ${low.length - 3}종` : '';
            toast(
              '📦 채워야 할 재료가 있어요',
              `${names}${rest} — 얼마 안 남았어요.`,
              // 여러 품목이면 하나로 특정할 수 없으니, 가장 급한 것(잔여 비율 최소)을 짚어 준다
              { label: '재고 보기', onPress: () => goToStock(lowest(low)) }
            );
          }
          if (low.length > 0) {
            state.lowStockDate = today;
            state.lowStockIds = [...alreadyIds, ...low.map((s) => s.ingredient_id)];
            dirty = true;
          }
        }

        // ② 단가 급등 알림 — 직전 기준가 대비 +10% 이상이면 발송.
        // 알림을 꺼 둔 동안에는 '급등을 소비'하지 않는다 — 예전엔 꺼져 있어도 기준가를
        // 올려 버려서, 나중에 알림을 켜도 그 사이의 급등은 영영 안 알려줬다.
        // (신규 품목·가격 하락의 기준가 갱신은 켜짐 여부와 무관하게 유지)
        const baseline = { ...(state.priceBaseline ?? {}) };
        const surged: StockItem[] = [];
        for (const s of stocks) {
          const key = String(s.ingredient_id);
          const base = baseline[key];
          if (base === undefined || s.current_price < base) {
            // 신규 품목이거나 단가가 내려갔으면 기준가를 현재가로 갱신
            if (base !== s.current_price) {
              baseline[key] = s.current_price;
              dirty = true;
            }
          } else if (prefs.priceSurgeAlert && base > 0 && s.current_price >= base * SURGE_RATIO) {
            surged.push(s);
            baseline[key] = s.current_price; // 알린 뒤 기준가 갱신 → 같은 급등 반복 알림 방지
            dirty = true;
          }
        }
        state.priceBaseline = baseline;
        if (prefs.priceSurgeAlert && surged.length > 0) {
          const names = surged.slice(0, 3).map((s) => s.name).join(', ');
          const rest = surged.length > 3 ? ` 외 ${surged.length - 3}종` : '';
          toast('📈 단가 급등 알림', `${names}${rest}의 매입 단가가 10% 이상 올랐어요. 대체 공급처를 확인해 보세요.`);
        }

        // ③ AI 경영 리포트 도착 알림 — 수신 주기(매일/매주) 설정을 그대로 따른다
        if (now.getHours() >= REPORT_HOUR) {
          if (prefs.reportFrequency === 'daily') {
            const today = dateKey(now);
            if (state.reportDaily !== today) {
              toast('📊 AI 경영 리포트 도착', '오늘의 매출·재고 리포트가 준비됐어요. 홈에서 확인해 보세요.');
              state.reportDaily = today;
              dirty = true;
            }
          } else if (now.getDay() === 1) {
            // 매주: 월요일 오전에 1회
            const wk = weekKey(now);
            if (state.reportWeekly !== wk) {
              toast('📊 주간 AI 경영 리포트 도착', '이번 주 매출·재고 리포트가 준비됐어요. 홈에서 확인해 보세요.');
              state.reportWeekly = wk;
              dirty = true;
            }
          }
        }

        if (dirty) await AsyncStorage.setItem(STORE_KEY, JSON.stringify(state));
      } finally {
        running.current = false;
      }
    };

    const first = setTimeout(check, WATCH_START_DELAY_MS);
    const timer = setInterval(check, POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [
    signedIn,
    token,
    prefs.ready,
    prefs.lowStockAlert,
    prefs.priceSurgeAlert,
    prefs.reportFrequency,
    prefs.dndEnabled,
    prefs.dndStart,
    prefs.dndEnd,
  ]);

  // 로그아웃하거나 '알림 음성 읽어주기'를 끄면 재생 중·대기 중인 음성을 즉시 중단한다.
  // (끊지 않으면 큐에 쌓인 TTS가 로그인 화면까지 이어져 흘러나온다)
  useEffect(() => {
    if (!signedIn || !prefs.voiceAlertEnabled) speechCancelAll();
  }, [signedIn, prefs.voiceAlertEnabled]);

  // 서버 TTS(진짜 다른 목소리 4종) 호출용 토큰을 플레이어에 넣어준다.
  // 이게 없으면 speechPlayer는 기기 내장 TTS로만 말한다 (웹은 한국어 보이스가 1개뿐).
  useEffect(() => {
    speechSetAuthToken(signedIn ? token : null);
  }, [signedIn, token]);

  // ⑥ 음성 비서 알림 — 30초 주기로 새 완료 이벤트를 폴링하고, 이어폰 착용 시 음성 재생
  useEffect(() => {
    if (!signedIn || !prefs.ready) return;

    const checkVoiceNotifications = async () => {
      if (voiceRunning.current) return;
      voiceRunning.current = true;
      try {
        // 방해 금지 구간에는 음성 알림도 보류
        if (prefs.dndEnabled && isInDndWindow(new Date(), prefs.dndStart, prefs.dndEnd)) return;

        // 토큰을 실어 내 매장 직원의 완료 알림만 받는다 (토큰 없이 부르면 전 매장이 섞인다)
        const data = await fetchNotifications(lastVoiceCheck.current, token);

        // 다음 폴링을 위해 서버 시각으로 갱신
        lastVoiceCheck.current = data.server_time;

        if (data.notifications.length === 0) return;

        // 설정에서 음성 읽어주기를 꺼뒀으면 TTS는 건너뛰고 토스트만 표시.
        // 켜져 있으면 지금 소리를 내도 되는지 확인 (출력 조건 = 항상 / 이어폰 연결 시에만)
        const permission = prefs.voiceAlertEnabled ? await canPlayAudio() : null;

        for (const noti of data.notifications) {
          // 화면용 토스트는 항상 표시
          toast('✅ ' + noti.title, noti.speech_text);

          // 재생이 허용될 때만 음성 큐에 추가 (겹침 방지)
          if (permission?.allowed) {
            speechEnqueue(noti.speech_text, `noti-${noti.id}`);
          }
        }
      } catch {
        // 서버 오프라인 — 다음 주기에 재시도
      } finally {
        voiceRunning.current = false;
      }
    };

    const first = setTimeout(checkVoiceNotifications, WATCH_START_DELAY_MS);
    const timer = setInterval(checkVoiceNotifications, VOICE_POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [signedIn, token, prefs.ready, prefs.dndEnabled, prefs.dndStart, prefs.dndEnd, prefs.voiceAlertEnabled]);

  // ⑦ 선제 인사이트 — 서버가 매장 DB를 훑어 찾아낸 "곧 할 일 · 놓친 일"을 알림으로 전한다.
  //    묻지 않아도 먼저 알려주되, 말을 걸지는 않는다(대화는 사장님이 시작한다).
  //    low(알아두면 좋음)는 토스트로 띄우지 않는다 — 챗봇에게 물으면 그때 알려준다.
  useEffect(() => {
    if (!token || !prefs.ready || !prefs.proactiveInsights) return;

    const checkInsights = async () => {
      if (insightRunning.current) return;
      insightRunning.current = true;
      try {
        if (prefs.dndEnabled && isInDndWindow(new Date(), prefs.dndStart, prefs.dndEnd)) return;

        // 홈 화면과 같은 캐시(dash:insights)를 거친다 — 서버 인사이트 스캔은 매장 전체를
        // 훑는 7초짜리 계산이라, 홈과 감시자가 앱 시작 직후 각각 부르면 그 계산이 두 번 돈다.
        const hit = await loadCache<Awaited<ReturnType<typeof fetchInsights>>>('dash:insights');
        let scan: Awaited<ReturnType<typeof fetchInsights>>;
        if (hit && Date.now() - hit.at < INSIGHT_POLL_MS) {
          scan = hit.data;
        } else {
          scan = await fetchInsights(token);
          void saveCache('dash:insights', scan);
        }
        const urgent = scan.insights.filter(
          // 주변 상권 변화(market)는 '주변 소식 알림' 스위치를 따로 따른다 —
          // 재고·서류와 성격이 달라 한쪽만 끄고 싶은 사장님이 있다
          (i) => i.severity !== 'low' && (prefs.nearbyAlert || i.category !== 'market'),
        );
        if (urgent.length === 0) return;

        // 같은 인사이트를 하루에 한 번만 알린다 (날짜가 바뀌면 이력은 자동 폐기)
        const today = dateKey(new Date());
        const raw = await AsyncStorage.getItem(INSIGHT_KEY);
        const saved: { date?: string; keys?: string[] } = raw ? JSON.parse(raw) : {};
        const sent = saved.date === today ? saved.keys ?? [] : [];

        const fresh = urgent.filter((i) => !sent.includes(i.key));
        if (fresh.length === 0) return;

        for (const insight of fresh.slice(0, INSIGHT_MAX_PER_CYCLE)) {
          const icon = INSIGHT_ICON[insight.category] ?? '🔔';
          toast(`${icon} ${insight.title}`, insight.body);
        }
        const notified = fresh.slice(0, INSIGHT_MAX_PER_CYCLE).map((i) => i.key);
        await AsyncStorage.setItem(
          INSIGHT_KEY,
          JSON.stringify({ date: today, keys: [...sent, ...notified] })
        );
      } catch {
        // 서버 오프라인 — 다음 주기에 재시도
      } finally {
        insightRunning.current = false;
      }
    };

    const first = setTimeout(checkInsights, WATCH_START_DELAY_MS);
    const timer = setInterval(checkInsights, INSIGHT_POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [
    token,
    prefs.ready,
    prefs.proactiveInsights,
    prefs.nearbyAlert,
    prefs.dndEnabled,
    prefs.dndStart,
    prefs.dndEnd,
  ]);

  // ⑩ 오늘의 브리핑 — 하루의 첫 실행에서 한 번, 브루가 먼저 하루를 정리해 준다.
  //
  // 서버는 이걸 아침(매장 오픈 시각)에 푸시로 보내지만, 그 시각에 앱이 꺼져 있거나
  // 푸시 모듈이 없는 빌드(OTA로만 갱신된 앱)에서는 도착하지 않는다. 사장님이 앱을 여는
  // 순간이 사실상 '하루의 시작'이므로, 그날 아직 안 봤다면 여기서 한 번 전한다.
  // 같은 날 두 번 뜨지 않도록 날짜를 기기에 남긴다 (푸시로 이미 받았어도 앱에서 한 번은
  // 보여준다 — 알림 목록을 지나쳤을 때 유일하게 남는 경로다).
  useEffect(() => {
    if (!signedIn || !prefs.ready || !prefs.proactiveInsights) return;

    let alive = true;
    const run = async () => {
      try {
        if (prefs.dndEnabled && isInDndWindow(new Date(), prefs.dndStart, prefs.dndEnd)) return;
        const today = dateKey(new Date());
        if ((await AsyncStorage.getItem(BRIEFING_KEY)) === today) return;

        const briefing = await fetchBriefing(token);
        if (!alive) return;
        // 서버가 어제 것을 캐시해 둔 상태라면(하루가 막 바뀐 순간) 내일 다시 본다
        if (briefing.date !== today) return;

        toast(`☕ 오늘의 브리핑 · ${briefing.headline}`, briefing.message);
        await AsyncStorage.setItem(BRIEFING_KEY, today);
      } catch {
        // 서버 오프라인·구버전 서버(404) — 다음 주기에 다시 시도한다
      }
    };

    const first = setTimeout(run, WATCH_START_DELAY_MS);
    const timer = setInterval(run, BRIEFING_POLL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [signedIn, token, prefs.ready, prefs.proactiveInsights,
      prefs.dndEnabled, prefs.dndStart, prefs.dndEnd]);

  // ⑨ 설비 이상(냉장고 온도 이탈·수위) — Tier 1 중 유일하게 인앱 감시가 없던 항목.
  //
  // [왜 여기 있나] 서버는 이걸 FCM 푸시로 보내지만, expo-notifications는 네이티브 모듈이라
  // 그 모듈이 없는 빌드(=OTA로만 갱신된 앱)에서는 푸시가 아예 도착하지 않는다.
  // 식자재 폐기로 직결되는 알림이라 "앱이 켜져 있는 동안만이라도" 반드시 전한다.
  // 푸시가 살아 있는 빌드에서는 서버 푸시와 겹치므로 이 감시는 돌리지 않는다.
  useEffect(() => {
    if (!signedIn || !prefs.ready) return;
    if (isNativePushAvailable()) return; // 네이티브 푸시가 가능한 빌드 → 서버 푸시에 맡긴다 (중복 방지)

    const checkFaults = async () => {
      if (faultRunning.current) return;
      faultRunning.current = true;
      try {
        // [방해금지 예외] 설비 이상은 밤에도 알린다 — 새벽에 냉장고가 죽으면 아침에 다 버린다.
        //  (서버 규칙도 sensor만 방해금지를 뚫는다)
        const { items } = await getSensorRecommendations(token!);
        const faults = items.filter(
          (i) => i.priority === 'urgent' && (i.source === '온도센서' || i.source === '수위센서'),
        );
        if (faults.length === 0) return;

        // 같은 이상은 6시간에 한 번만 (서버 SENSOR_COOLDOWN_HOURS와 같은 값)
        const raw = await AsyncStorage.getItem(FAULT_KEY);
        const saved: Record<string, number> = raw ? JSON.parse(raw) : {};
        const now = Date.now();
        const next = { ...saved };
        let notified = false;

        for (const fault of faults) {
          const key = `${fault.source}:${fault.title}`;
          if (saved[key] && now - saved[key] < SENSOR_COOLDOWN_MS) continue;
          toast(`🚨 ${fault.title}`, `${fault.reason} — ${fault.action}`);
          next[key] = now;
          notified = true;
        }
        if (notified) await AsyncStorage.setItem(FAULT_KEY, JSON.stringify(next));
      } catch {
        // 센서 기능이 꺼져 있거나 서버 오프라인 — 다음 주기에 재시도
      } finally {
        faultRunning.current = false;
      }
    };

    const first = setTimeout(checkFaults, WATCH_START_DELAY_MS);
    const timer = setInterval(checkFaults, FAULT_POLL_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [signedIn, token, prefs.ready]);

  return null;
}
