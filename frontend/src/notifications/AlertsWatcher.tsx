// 알림 감시자 — 설정 화면의 알림 설정을 "실제 동작"으로 연결하는 헤드리스 컴포넌트.
// ① 재고 부족 알림: 안전재고 미달 품목을 60초 주기로 감지해 푸시(토스트) 발송
// ② 단가 급등 알림: 재료 매입 단가가 직전 기준가 대비 10% 이상 오르면 발송
// ③ AI 경영 리포트 수신 주기: 매일 / 매주(월요일) 오전에 리포트 도착 알림
// ④ 방해 금지 시간대: 설정 구간(자정 넘김 포함)에는 위 알림을 전부 보류하고, 구간이 끝나면 발송
// ⑤ 문의 답변 도착: 내 1대1 문의에 관리자 답변이 달리면 어느 화면에 있든 즉시 알림
// ⑥ 음성 비서 알림: 새 완료 이벤트를 30초 주기로 폴링, 이어폰(블루투스 포함) 착용 시 TTS 음성 재생
//    — 설정 > 알림 수신 설정의 '알림 음성 읽어주기' 스위치로 켜고 끌 수 있다
// (관리자 공지는 홈 화면 강아지 말풍선(WelcomeHeader)이 단독으로 전하므로 여기선 토스트를 띄우지 않는다)
// 같은 품목·같은 날 중복 알림은 AsyncStorage에 발송 이력을 남겨 1회로 제한한다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';

import { useAuth } from '../auth/AuthContext';
import { usePreferences } from '../preferences/PreferencesContext';
import { listMyInquiries } from '../lib/api/inquiry';
import { listStocks, type StockItem } from '../lib/api/inventory';
import { fetchNotifications } from '../lib/api/assistant';
import { enqueue as speechEnqueue, canPlayAudio } from '../lib/speech/speechPlayer';
import { toast } from '../components/toast';

const POLL_MS = 60_000;           // 감시 주기 (1분)
const NOTICE_POLL_MS = 15_000;    // 문의 답변 감시 주기 (15초 — 답변 후 빠른 도착 체감)
const VOICE_POLL_MS = 30_000;     // ⑥ 음성 비서 알림 폴링 주기 (30초)
const SURGE_RATIO = 1.1;          // 단가 급등 기준: 기준가 대비 +10% 이상
const REPORT_HOUR = 9;            // 리포트 도착 알림은 오전 9시 이후에만

const STORE_KEY = 'simplem:alerts:state';
// 이미 알림을 보낸 '답변 완료' 문의 id 목록 (중복 토스트 방지)
const INQUIRY_KEY = 'simplem:alerts:inquiry-answered-ids';

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

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

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
  const lastVoiceCheck = useRef<string>(new Date().toISOString()); // 마지막 폴링 시각

  // ⑤ 문의 답변 도착 — 15초 주기로 감시 (관리자 공지는 홈 말풍선이 담당하므로 제외)
  useEffect(() => {
    if (!token || !prefs.ready) return;

    // ⑤ 내 문의에 관리자 답변이 새로 달렸는지 감시 — 답변 완료 id 목록 비교 방식
    const checkInquiryAnswers = async () => {
      if (!user?.email) return;
      const raw = await AsyncStorage.getItem(INQUIRY_KEY);
      const seen: number[] | null = raw ? JSON.parse(raw) : null;

      const list = await listMyInquiries(user.email);
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

    runOnce();
    const timer = setInterval(runOnce, NOTICE_POLL_MS);
    return () => clearInterval(timer);
  }, [token, user?.email, prefs.ready, prefs.dndEnabled, prefs.dndStart, prefs.dndEnd]);

  useEffect(() => {
    if (!token || !prefs.ready) return;

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

        // 재고를 한 번만 조회해 ①·②에 함께 사용
        let stocks: StockItem[] = [];
        try {
          stocks = await listStocks(token);
        } catch {
          return; // 서버 오프라인 — 다음 주기에 재시도
        }

        // ① 재고 부족 알림
        if (prefs.lowStockAlert) {
          const today = dateKey(now);
          const alreadyIds = state.lowStockDate === today ? state.lowStockIds ?? [] : [];
          const low = stocks.filter(
            (s) => s.current_quantity <= s.safety_quantity && !alreadyIds.includes(s.ingredient_id)
          );
          if (low.length === 1) {
            const s = low[0];
            toast(
              `📦 ${s.name} 재고 부족`,
              `잔여 ${s.current_quantity}${s.unit} · 안전재고 ${s.safety_quantity}${s.unit} — 발주를 검토해 주세요.`
            );
          } else if (low.length > 1) {
            const names = low.slice(0, 3).map((s) => s.name).join(', ');
            const rest = low.length > 3 ? ` 외 ${low.length - 3}종` : '';
            toast('📦 재고 부족 알림', `${names}${rest}이(가) 안전재고 아래로 떨어졌어요.`);
          }
          if (low.length > 0) {
            state.lowStockDate = today;
            state.lowStockIds = [...alreadyIds, ...low.map((s) => s.ingredient_id)];
            dirty = true;
          }
        }

        // ② 단가 급등 알림 — 직전 기준가 대비 +10% 이상이면 발송
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
          } else if (base > 0 && s.current_price >= base * SURGE_RATIO) {
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

    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
  }, [
    token,
    prefs.ready,
    prefs.lowStockAlert,
    prefs.priceSurgeAlert,
    prefs.reportFrequency,
    prefs.dndEnabled,
    prefs.dndStart,
    prefs.dndEnd,
  ]);

  // ⑥ 음성 비서 알림 — 30초 주기로 새 완료 이벤트를 폴링하고, 이어폰 착용 시 음성 재생
  useEffect(() => {
    if (!token || !prefs.ready) return;

    const checkVoiceNotifications = async () => {
      if (voiceRunning.current) return;
      voiceRunning.current = true;
      try {
        // 방해 금지 구간에는 음성 알림도 보류
        if (prefs.dndEnabled && isInDndWindow(new Date(), prefs.dndStart, prefs.dndEnd)) return;

        const data = await fetchNotifications(lastVoiceCheck.current);

        // 다음 폴링을 위해 서버 시각으로 갱신
        lastVoiceCheck.current = data.server_time;

        if (data.notifications.length === 0) return;

        // 설정에서 음성 읽어주기를 꺼뒀으면 TTS는 건너뛰고 토스트만 표시.
        // 켜져 있으면 지금 소리를 내도 되는지 확인 (이어폰·에어팟 연결 시에만 재생)
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

    checkVoiceNotifications();
    const timer = setInterval(checkVoiceNotifications, VOICE_POLL_MS);
    return () => clearInterval(timer);
  }, [token, prefs.ready, prefs.dndEnabled, prefs.dndStart, prefs.dndEnd, prefs.voiceAlertEnabled]);

  return null;
}
