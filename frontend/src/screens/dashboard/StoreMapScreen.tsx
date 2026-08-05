// 매장 지도 화면 — 대시보드 웰컴헤더 왼쪽 위 지도 아이콘 직결용
//
// [설계 원칙] 이 화면의 중심은 '기기 현위치'가 아니라 계정에 등록된 매장 고정 위치다.
// 회원가입 2단계에서 찍은 지도 핀이 users.store_lat/lon으로 저장되고, 어느 기기에서
// 로그인하든 지도는 그 자리에 고정된다. (예전엔 GPS로 그려서 집에서 앱을 켜면 매장이 이사했다.)
//
// 그 위에 '주변 카페 상권 분석'을 얹는다 — 백엔드가 네이버 지역검색으로 반경 안의 카페를 모으고,
// 네이버 블로그 후기를 수집해 Gemini로 분석한 결과를 마커·카드로 보여 준다.
//
// 그리고 '주변 행사'(축제·팝업·문화행사)를 같은 지도 위에 오렌지 핀으로 얹는다. 수집 소스는
// 판매 예측이 쓰는 것과 같아서(관광공사·서울 문화행사·네이버 검색+AI) 예측의 매출 부스팅과
// 화면에 보이는 행사가 어긋나지 않는다. 카페는 반경 선택(500m~2km), 행사는 예측과 같은 3km 고정.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { useFrameSheetStyle } from '../../components/DeviceFrame';
import StoreLocationMap from '../../components/dashboard/StoreLocationMap';
import StoreLocationPicker from '../../components/dashboard/StoreLocationPicker';
import {
  getCafeAnalysis,
  getCafeSimilarity,
  getMyCafeCandidates,
  getMyCafeReviews,
  getNearbyCafeChanges,
  getNeighborhoodInsight,
  linkMyCafe,
  type CafeAnalysisResult,
  type CafeCandidate,
  type CafeChangesResult,
  type CafeSimilarity,
  type NearbyCafe,
  type NeighborhoodResult,
} from '../../lib/api/nearbyCafes';
import { describeApiFailure, type ApiFailure } from '../../lib/api/errors';
import {
  getEventPlan,
  getNearbyEvents,
  type EventPlan,
  type NearbyEventItem,
  type NearbyEventsResult,
} from '../../lib/api/nearbyEvents';
import {
  cacheRegisteredStore,
  resolveStoreLocation,
  saveStoreLocation,
  type ResolvedStoreLocation,
} from '../../lib/api/store';
import { colors, shadows, spacing, typography } from '../../theme';
import { useResponsive } from '../../theme/responsive';

const RADIUS_OPTIONS = [500, 1000, 2000] as const;

// 행사 조회 기간 — 예측(1주)보다 넉넉히 잡아 "다음 주말 축제"까지 미리 보이게 한다
const EVENT_DAYS = 14;

// 상권 변화를 되돌아볼 기간 — 알림은 그때그때 한 번 울리고 끝이지만, 화면에서는
// "요즘 우리 동네가 어떻게 바뀌었나"를 한눈에 보려면 지난 기록까지 넘겨볼 수 있어야 한다.
const CHANGE_DAY_OPTIONS = [30, 90] as const;

export default function StoreMapScreen() {
  // [한글 주석] 뷰포트 비례 계산 — 지도가 화면을 다 먹지 않게 높이를 조정한다
  const { vh } = useResponsive();
  // 웹 목업 모드에서 바텀시트를 폰 프레임 크기·위치에 맞춘다 (실기기에서는 null)
  const frameSheet = useFrameSheetStyle();
  const { token, user } = useAuth();

  const [store, setStore] = useState<ResolvedStoreLocation | null>(null);
  const [loadingStore, setLoadingStore] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  const [radius, setRadius] = useState<number>(1000);
  const [nearby, setNearby] = useState<NeighborhoodResult | null>(null);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [nearbyError, setNearbyError] = useState('');

  // 주변 행사 — 카페와 독립적으로 뜬다(반경 고정 3km). 한쪽이 실패해도 다른 쪽은 보인다.
  const [events, setEvents] = useState<NearbyEventsResult | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  // 행사는 '못 찾은 것'과 '못 불러온 것'을 같은 말투로 보여 준다 — 사장님에게는 둘 다
  // "지금은 볼 수 있는 행사가 없다"는 같은 상황이고, 원인은 작은 글씨로만 덧붙인다.
  const [eventsError, setEventsError] = useState<ApiFailure | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);

  // 상권 변화 — 서버가 매일 훑어 쌓아 둔 '새로 생긴 / 없어진 카페'. 순수 DB 조회라 즉시 온다.
  // 알림으로도 같은 내용이 나가지만, 알림을 놓쳤거나 꺼 둔 사장님도 여기서 그대로 볼 수 있어야 한다.
  const [changes, setChanges] = useState<CafeChangesResult | null>(null);
  const [changeDays, setChangeDays] = useState<number>(CHANGE_DAY_OPTIONS[0]);
  const [changesLoading, setChangesLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);

  // 행사 상세 — 카드나 지도 핀을 누르면 먼저 이게 열린다. 여기서 'AI 준비 플랜'으로 이어진다.
  // (예전엔 카드에 달린 버튼 하나뿐이라, 행사 자체가 궁금해도 볼 곳이 없었다.)
  const [detailEvent, setDetailEvent] = useState<NearbyEventItem | null>(null);

  // 행사 하나에 대한 AI 이벤트·준비 플랜 (행사 카드에서 눌러 연다)
  const [planEvent, setPlanEvent] = useState<NearbyEventItem | null>(null);
  const [plan, setPlan] = useState<EventPlan | null>(null);
  const [planError, setPlanError] = useState('');

  // [닫힘 애니메이션 유지용] 시트를 닫으면 state는 그 즉시 null인데 Modal은 슬라이드-아웃이
  // 끝날 때까지 계속 그린다. 그 사이 제목·본문이 다 비고 'D-0' 배지만 남은 빈 시트가
  // 내려가는 게 실제로 보였다(상세→플랜 전환 때마다). 마지막으로 열었던 값을 들고 있다가
  // 닫히는 동안에는 그걸로 그린다 — 열림/닫힘 판정은 여전히 원래 state가 한다.
  const lastDetailEvent = useRef<NearbyEventItem | null>(null);
  if (detailEvent) lastDetailEvent.current = detailEvent;
  const shownDetail = detailEvent ?? lastDetailEvent.current;
  const lastPlanEvent = useRef<NearbyEventItem | null>(null);
  if (planEvent) lastPlanEvent.current = planEvent;
  const shownPlanEvent = planEvent ?? lastPlanEvent.current;

  // 요청 순번 — 이 화면의 조회는 죄다 네이버 수집·Gemini라 몇 초씩 걸린다. 그동안 사장님이
  // 다른 카페를 누르거나 반경을 바꾸면 늦게 도착한 옛 응답이 새 화면을 덮어썼다.
  // (실제로 카페 A의 '우리 대응'이 카페 B 이름 아래 붙는다 — 잘못된 경쟁 분석을 보고 움직이게 된다.)
  // 각 조회는 자기 순번을 들고 나갔다가, 돌아왔을 때 그 사이 더 최근 요청이 나갔으면 조용히 버린다.
  const seq = useRef({ nearby: 0, cafe: 0, plan: 0, changes: 0, events: 0, myCafe: 0 });
  const alive = useRef(true);
  useEffect(() => {
    // 마운트마다 되살린다. 정리 함수만 두면 StrictMode·Fast Refresh가 한 번 정리한 뒤로
    // alive가 영영 false로 남아 모든 응답이 버려진다(스피너가 끝나지 않는다).
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // '주변 소식' 바로가기 — 지도 아래로 카드가 길게 이어져 행사·변화 섹션이 접힌 화면 밖에 있다.
  // 알림으로만 보던 두 가지를 화면 맨 위에서 곧장 찾아갈 수 있게 스크롤 위치를 기억해 둔다.
  const scrollRef = useRef<ScrollView | null>(null);
  const bodyY = useRef(0);
  const changesY = useRef(0);
  const eventsY = useRef(0);
  const jumpTo = useCallback((target: 'changes' | 'events') => {
    const y = bodyY.current + (target === 'changes' ? changesY.current : eventsY.current);
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
  }, []);

  const [selected, setSelected] = useState<NearbyCafe | null>(null);
  const [analysis, setAnalysis] = useState<CafeAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  // 카페 분석 시트도 닫힘 애니메이션 동안 마지막 카페로 그린다 (행사 시트와 같은 이유)
  const lastSelected = useRef<NearbyCafe | null>(null);
  if (selected) lastSelected.current = selected;
  const shownCafe = selected ?? lastSelected.current;

  // 내 카페와의 유사도 — 카페 이름 → {total, tier, axes, reason}. 목록 배지·정렬·상세 비교에 쓴다.
  const [simMap, setSimMap] = useState<Record<string, CafeSimilarity>>({});
  const [sortMode, setSortMode] = useState<'distance' | 'similarity'>('distance');

  // 내 카페 리뷰 — 사장님이 자기 가게 후기를 지도 화면에서 바로 확인
  const [myCafe, setMyCafe] = useState<CafeAnalysisResult | null>(null);
  const [loadingMyCafe, setLoadingMyCafe] = useState(false);
  const [myCafeError, setMyCafeError] = useState('');
  const [myReviewsOpen, setMyReviewsOpen] = useState(false);

  // 내 카페 지정(연결) — 후보 목록에서 '이게 내 가게'를 직접 고른다 (이름 충돌 방지)
  const [cafePickerOpen, setCafePickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<CafeCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidatesError, setCandidatesError] = useState('');
  const [linking, setLinking] = useState(false);

  // 첫 화면은 '요약 + 이번 주 할 일'까지만 — 나머지 분석과 카페 목록은 눌러서 펼친다.
  // (항목을 전부 펼쳐 두면 불릿이 스무 개 넘게 쌓여 무엇부터 볼지 알 수 없다.)
  const [detailOpen, setDetailOpen] = useState(false);
  const [showAllCafes, setShowAllCafes] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false); // 카페 상세의 후기 원문 펼침

  // 1) 매장 고정 위치 — 계정(DB)이 원본, 기기 캐시는 보조. GPS는 쓰지 않는다.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLoadingStore(false);
      return;
    }
    (async () => {
      try {
        const loc = await resolveStoreLocation(token);
        if (!cancelled) setStore(loc);
      } catch (e) {
        console.error('매장 위치 조회 실패:', e);
      } finally {
        if (!cancelled) setLoadingStore(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) 주변 카페 + 상권 AI 분석 — 매장 위치가 확정된 뒤에만 부른다
  const loadNearby = useCallback(
    async (radiusM: number) => {
      if (!token || !store) return;
      const my = ++seq.current.nearby;
      setLoadingNearby(true);
      setNearbyError('');
      // 반경을 바꾸면 옛 배지가 잠깐 남아 새 목록에 엉뚱하게 붙는다 — 먼저 비운다
      setSimMap({});
      try {
        const data = await getNeighborhoodInsight(token, radiusM);
        if (seq.current.nearby !== my || !alive.current) return; // 더 최근 반경 요청이 있다
        setNearby(data);
        // 유사도 채점은 뒤이어 비동기로 — 배지가 준비되는 대로 목록에 나타난다
        if (data.cafes.length > 0) {
          getCafeSimilarity(
            token,
            data.region ?? '',
            data.cafes.map((c) => ({ name: c.name, category: c.category, distance_m: c.distance_m })),
          )
            .then((sim) => {
              if (seq.current.nearby !== my || !alive.current) return;
              const map: Record<string, CafeSimilarity> = {};
              sim.results.forEach((r) => { map[r.name] = r; });
              setSimMap(map);
            })
            .catch(() => { // 채점 실패해도 목록은 그대로 (배지만 생략)
              if (seq.current.nearby === my && alive.current) setSimMap({});
            });
        }
      } catch (e) {
        if (seq.current.nearby !== my || !alive.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setNearbyError(msg.replace(/^\d+\s·\s/, ''));
      } finally {
        // 늦게 온 옛 응답이 새 요청의 로딩 표시를 꺼 버리지 않게
        if (seq.current.nearby === my && alive.current) setLoadingNearby(false);
      }
    },
    [token, store],
  );

  useEffect(() => {
    loadNearby(radius);
    // 반경을 바꾸면 목록·분석이 통째로 달라지므로 펼침 상태도 처음으로 되돌린다
    setShowAllCafes(false);
    setDetailOpen(false);
  }, [loadNearby, radius]);

  // 2-b) 주변 행사 — 반경 칩과 무관하게 한 번만. 카페 조회와 병렬로 돈다.
  const loadEvents = useCallback(async () => {
    if (!token || !store) return;
    const my = ++seq.current.events;
    setLoadingEvents(true);
    setEventsError(null);
    try {
      const data = await getNearbyEvents(token, EVENT_DAYS);
      if (seq.current.events !== my || !alive.current) return;
      setEvents(data);
    } catch (e) {
      if (seq.current.events !== my || !alive.current) return;
      setEventsError(describeApiFailure(e, '주변 행사'));
    } finally {
      if (seq.current.events === my && alive.current) setLoadingEvents(false);
    }
  }, [token, store]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // 2-b') 상권 변화 — 실패해도 조용히 넘어간다(다른 카드가 다 뜨는데 이것만 에러 상자를
  // 세울 이유가 없다. 관측 전이면 애초에 빈 결과가 정상이다).
  const loadChanges = useCallback(
    async (days: number, refresh = false) => {
      if (!token || !store) return;
      const my = ++seq.current.changes;
      if (refresh) setRescanning(true);
      else setChangesLoading(true);
      try {
        const data = await getNearbyCafeChanges(token, days, refresh);
        // '지금 확인'은 서버가 반경을 훑는 몇 초짜리다. 그 사이 기간 칩을 바꾸면
        // 늦게 온 30일 결과가 90일 화면을 덮어썼다 — 칩과 목록이 어긋난다.
        if (seq.current.changes !== my || !alive.current) return;
        setChanges(data);
      } catch {
        // 조용히 — 카드는 '아직 확인 전' 상태로 남는다
      } finally {
        if (seq.current.changes === my && alive.current) {
          setRescanning(false);
          setChangesLoading(false);
        }
      }
    },
    [token, store],
  );

  useEffect(() => {
    loadChanges(changeDays);
  }, [loadChanges, changeDays]);

  // 지도 핀 탭 → 행사 상세. 핀은 이름만 알려 주므로 목록에서 같은 행사를 찾는다.
  const openEventByName = useCallback(
    (name: string) => {
      const hit = (events?.events ?? []).find((e) => e.name === name);
      if (hit) setDetailEvent(hit);
    },
    [events],
  );

  // 행사 카드 → AI 이벤트·준비 플랜 (Gemini 1회, 서버에서 12시간 캐시)
  const openPlan = useCallback(
    async (event: NearbyEventItem) => {
      const my = ++seq.current.plan;
      setPlanEvent(event);
      setPlan(null);
      // 토큰이 없으면 시트를 열지 않는다 — 열어 두면 영영 도는 스피너만 남는다
      if (!token) {
        setPlanError('로그인이 풀렸어요. 다시 로그인한 뒤 열어 주세요.');
        return;
      }
      setPlanError('');
      try {
        const res = await getEventPlan(token, event);
        // 다른 행사를 여는 사이 옛 응답이 도착하면 버린다 — 안 그러면 B 제목 아래 A의 플랜이 붙는다
        if (seq.current.plan !== my || !alive.current) return;
        setPlan(res.plan);
      } catch (e) {
        if (seq.current.plan !== my || !alive.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setPlanError(msg.replace(/^\d+\s·\s/, ''));
      }
    },
    [token],
  );

  // 2-c) 내 카페 리뷰 — 상호만 있으면 조회된다(매장 위치 등록과 무관). 한 번만 부른다.
  const loadMyCafe = useCallback(async () => {
    if (!token) return;
    const my = ++seq.current.myCafe;
    setLoadingMyCafe(true);
    setMyCafeError('');
    try {
      const data = await getMyCafeReviews(token);
      if (seq.current.myCafe !== my || !alive.current) return;
      setMyCafe(data);
    } catch (e) {
      if (seq.current.myCafe !== my || !alive.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setMyCafeError(msg.replace(/^\d+\s·\s/, ''));
    } finally {
      if (seq.current.myCafe === my && alive.current) setLoadingMyCafe(false);
    }
  }, [token]);

  useEffect(() => {
    loadMyCafe();
  }, [loadMyCafe]);

  // 내 카페 후보 목록 열기 (상호로 네이버 지역검색 → 사장님이 주소 보고 자기 가게 선택)
  const openCafePicker = useCallback(async () => {
    if (!token) return;
    setCafePickerOpen(true);
    setCandidatesError('');
    setLoadingCandidates(true);
    try {
      const res = await getMyCafeCandidates(token);
      setCandidates(res.candidates);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCandidatesError(msg.replace(/^\d+\s·\s/, ''));
    } finally {
      setLoadingCandidates(false);
    }
  }, [token]);

  // 후보 하나를 '내 가게'로 지정 → 저장 후 그 장소로 후기 다시 로드
  const chooseCafe = useCallback(
    async (c: CafeCandidate) => {
      if (!token || linking) return;
      setLinking(true);
      try {
        await linkMyCafe(token, c.name, c.address);
        setCafePickerOpen(false);
        setMyReviewsOpen(false);
        await loadMyCafe();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setCandidatesError(msg.replace(/^\d+\s·\s/, ''));
      } finally {
        setLinking(false);
      }
    },
    [token, linking, loadMyCafe],
  );

  // 지도 마커용 변환 — 지도는 '행사 한 건 = 핀 하나'로 날짜 문자열만 보여 주면 된다.
  // (좌표를 못 구한 행사는 핀을 찍을 수 없으니 목록에만 남긴다.)
  // 훅 순서를 지키기 위해 매장 미등록 early return보다 위에 둔다.
  // 좌표가 있어 핀을 찍을 수 있는 행사 수 — 범례의 '위치를 못 찾은 N건'이 이 값을 쓴다.
  // (mapEvents는 15건에서 잘리므로, 그 차이를 '좌표 없음'이라고 말하면 거짓말이 된다)
  const geoEventCount = useMemo(
    () => (events?.events ?? []).filter((e) => !!e.lat && !!e.lon).length,
    [events],
  );

  const mapEvents = useMemo(
    () =>
      (events?.events ?? [])
        .filter((e) => !!e.lat && !!e.lon)
        .slice(0, 15) // 네이티브는 지도 URL에 payload를 실어 보내므로 길이를 묶어 둔다
        .map((e) => ({
          name: e.name,
          place: e.place || '장소 미상',
          // 지도 말풍선에 그대로 찍히는 값이라 여기서 사람이 읽는 형태로 만든다 (8/16(일))
          date: formatEventRange(e.start_date, e.end_date),
          distance_km: e.distance_km ?? 0,
          boost_pct: e.boost_pct,
          source: e.source,
          lat: e.lat,
          lon: e.lon,
          ongoing: e.ongoing,
          d_day: e.d_day,
        })),
    [events],
  );

  // 3) 카페 하나를 고르면 그 집의 네이버 후기 분석을 불러온다
  const openCafe = useCallback(
    async (cafe: NearbyCafe) => {
      const my = ++seq.current.cafe;
      setSelected(cafe);
      setAnalysis(null);
      setReviewsOpen(false); // 다른 카페를 열 때마다 후기는 다시 접힌 상태로
      if (!token) {
        setAnalysisError('로그인이 풀렸어요. 다시 로그인한 뒤 열어 주세요.');
        return;
      }
      setAnalysisError('');
      try {
        const data = await getCafeAnalysis(token, cafe, nearby?.region ?? '');
        // 후기 수집 + AI 분석이라 몇 초 걸린다. 그 사이 다른 카페를 열었으면 버린다 —
        // 안 그러면 B의 이름·거리 아래에 A의 강점/약점·'우리 대응'이 붙는다.
        if (seq.current.cafe !== my || !alive.current) return;
        setAnalysis(data);
      } catch (e) {
        if (seq.current.cafe !== my || !alive.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setAnalysisError(msg.replace(/^\d+\s·\s/, ''));
      }
    },
    [token, nearby?.region],
  );

  const handlePinConfirm = async (picked: { lat: number; lon: number; address?: string }) => {
    if (!token) return;
    setSavingPin(true);
    try {
      await saveStoreLocation(token, { lat: picked.lat, lon: picked.lon, address: picked.address });
      await cacheRegisteredStore({ lat: picked.lat, lon: picked.lon, region: picked.address });
      setStore({ lat: picked.lat, lon: picked.lon, region: picked.address, registered: true });
      // 매장을 옮기면 이전 동네의 결과는 전부 버린다 — 유사도 배지가 이름만 보고 새 동네
      // 카페에 다시 붙거나, 펼쳐 둔 목록이 그대로 남아 새 동네를 다 본 것처럼 보였다
      setNearby(null);
      setSimMap({});
      setEvents(null);
      setChanges(null);
      setShowAllCafes(false);
      setShowAllEvents(false);
      setDetailOpen(false);
      setPickerOpen(false);
    } catch (e) {
      console.error('매장 위치 저장 실패:', e);
    } finally {
      setSavingPin(false);
    }
  };

  // --- 매장 위치가 아직 없을 때 ---
  if (!loadingStore && !store) {
    return (
      <View style={styles.root}>
        <View style={styles.center}>
          <Ionicons name="location-outline" size={40} color={colors.mochaBrown} />
          <Text style={styles.loadingText}>매장 위치가 등록되지 않았습니다.</Text>
          <Text style={styles.hintText}>
            지도에 표시할 매장 자리를 한 번만 지정해 주세요.{'\n'}
            등록한 위치는 계정에 저장되어 어느 기기에서 로그인해도 그대로 유지됩니다.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setPickerOpen(true)}>
            <Ionicons name="map" size={16} color={colors.white} />
            <Text style={styles.primaryBtnText}>매장 위치 등록</Text>
          </TouchableOpacity>
        </View>
        <StoreLocationPicker
          visible={pickerOpen}
          initial={null}
          saving={savingPin}
          onClose={() => setPickerOpen(false)}
          onConfirm={handlePinConfirm}
        />
      </View>
    );
  }

  if (loadingStore || !store) {
    return (
      <View style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.pointOrange} size="large" />
          <Text style={styles.loadingText}>매장 위치 지도를 불러오는 중...</Text>
        </View>
      </View>
    );
  }

  const insight = nearby?.insight ?? null;
  const eventList = events?.events ?? [];
  const visibleEvents = showAllEvents ? eventList : eventList.slice(0, 3);
  const eventInsight = events?.insight ?? null;
  // 목록은 거리순이라 첫 항목이 곧 가장 가까운 경쟁점이다
  const nearest = nearby?.cafes[0]?.distance_m ?? null;
  // 정렬: 거리순(기본) ↔ 유사도순. 유사도 미채점 카페는 뒤로 보낸다.
  const sortedCafes = (() => {
    const list = [...(nearby?.cafes ?? [])];
    if (sortMode === 'similarity') {
      list.sort((a, b) => (simMap[b.name]?.total ?? -1) - (simMap[a.name]?.total ?? -1));
    }
    return list;
  })();
  const visibleCafes = showAllCafes ? sortedCafes : sortedCafes.slice(0, 5);

  return (
    <View style={styles.root}>
      {/* 지도와 본문이 하나로 스크롤된다 — 지도를 스크롤뷰 밖에 고정하면 아래 내용을 볼 때
          지도만 덩그러니 남아 어색하다. 지도를 스크롤뷰 첫 요소로 넣어 함께 위로 밀려 올라가게 한다.
          핀: 진한 브라운 점=내 매장(고정), 작은 갈색 점=주변 카페, 🎪 이름표=주변 행사 */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 28 }}
        showsVerticalScrollIndicator={false}
      >
        {/* [한글 주석] 지도 높이는 뷰포트 비례 — 가로모드/작은 기기에서 화면을 다 먹지 않게 */}
        <View style={[styles.mapBox, { height: Math.min(vh(40), 360) }]}>
          <StoreLocationMap
            lat={store.lat}
            lon={store.lon}
            regionName={nearby?.region ?? store.region ?? ''}
            shopLabel={user?.name ? `내 매장 (${user.name})` : '내 매장'}
            nearbyCafes={nearby?.cafes ?? []}
            nearbyEvents={mapEvents}
            onCafePress={openCafe}
            onEventPress={openEventByName}
            containerId="standalone-store-map"
            radius={radius}
          />
        </View>

        <View style={styles.body} onLayout={(e) => { bodyY.current = e.nativeEvent.layout.y; }}>
          {/* 지도 범례 — 점이 세 종류나 찍히는데 무엇이 무엇인지 알 길이 없었다.
              좌표를 못 구한 행사는 핀을 찍을 수 없으므로 그 사실도 함께 밝힌다. */}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.legendDotStore]} />
              <Text style={styles.legendText}>내 매장</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.legendDotCafe]} />
              <Text style={styles.legendText}>주변 카페 {nearby?.cafes.length ?? 0}</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.legendDotEvent]} />
              <Text style={styles.legendText}>🎪 행사 {mapEvents.length}</Text>
            </View>
            {eventList.length > geoEventCount && (
              <Text style={styles.legendNote}>
                (위치를 못 찾은 행사 {eventList.length - geoEventCount}건은 아래 목록에만)
              </Text>
            )}
          </View>

          {/* 등록된 매장 위치 + 변경 버튼 */}
          <View style={styles.storeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.storeLabel}>등록된 매장 위치</Text>
              <Text style={styles.storeAddress}>
                {store.region || nearby?.region || `${store.lat.toFixed(5)}, ${store.lon.toFixed(5)}`}
              </Text>
            </View>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => setPickerOpen(true)}>
              <Ionicons name="create-outline" size={14} color={colors.espressoBrown} />
              <Text style={styles.ghostBtnText}>위치 변경</Text>
            </TouchableOpacity>
          </View>

          {/* 주변 소식 바로가기 — 알림으로 오던 두 가지(행사 준비, 카페 개업·폐업)가
              화면 어디에 있는지 맨 위에서 알려 준다. 눌러서 해당 섹션으로 바로 내려간다. */}
          <View style={styles.newsBar}>
            <Text style={styles.newsBarLabel}>주변 소식</Text>
            <TouchableOpacity style={styles.newsChip} onPress={() => jumpTo('events')}>
              <Text style={styles.newsChipText}>
                🎪 행사 {loadingEvents ? '확인 중' : `${eventList.length}건`}
              </Text>
              <Ionicons name="chevron-down" size={12} color={colors.espressoBrown} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.newsChip} onPress={() => jumpTo('changes')}>
              <Text style={styles.newsChipText}>
                ☕ 카페 변화 {changesLoading && !changes ? '확인 중' : `${changes?.count ?? 0}건`}
              </Text>
              <Ionicons name="chevron-down" size={12} color={colors.espressoBrown} />
            </TouchableOpacity>
          </View>

          {/* 내 카페 리뷰 — 내가 지정한 '내 가게'가 손님들에게 어떻게 보이는지 (경쟁 카페와 같은 분석) */}
          <View style={styles.myCafeCard}>
            <View style={styles.myCafeHead}>
              <Ionicons name="storefront-outline" size={16} color={colors.pointOrange} />
              <Text style={styles.myCafeTitle}>내 카페 리뷰</Text>
              {myCafe?.linked && !!myCafe.place_name && (
                <Text style={styles.myCafeName} numberOfLines={1}>{myCafe.place_name}</Text>
              )}
            </View>

            {loadingMyCafe ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator size="small" color={colors.mochaBrown} />
                <Text style={styles.inlineLoadingText}>내 카페 후기를 모아 분석하는 중...</Text>
              </View>
            ) : myCafeError ? (
              <>
                <Text style={styles.myCafeEmpty}>{myCafeError}</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={loadMyCafe}>
                  <Text style={styles.retryText}>다시 시도</Text>
                </TouchableOpacity>
              </>
            ) : !myCafe || myCafe.linked === false ? (
              // 아직 '내 가게'를 지정하지 않음 — 이름 충돌로 남의 카페 후기가 섞이지 않게 직접 고르게 한다
              <>
                <Text style={styles.myCafeEmpty}>
                  어느 가게가 사장님 카페인지 지정하면, 그 가게의 네이버 후기를 모아 보여드려요.
                  상호가 같은 다른 카페 후기가 섞이지 않도록 직접 골라 주세요.
                </Text>
                <TouchableOpacity style={styles.linkCafeBtn} onPress={openCafePicker}>
                  <Ionicons name="search" size={14} color={colors.white} />
                  <Text style={styles.linkCafeBtnText}>내 카페 찾아 지정하기</Text>
                </TouchableOpacity>
              </>
            ) : myCafe.review_count === 0 ? (
              <>
                <Text style={styles.myCafeEmpty}>
                  ‘{myCafe.place_name}’을(를) 다룬 네이버 블로그 후기를 아직 못 찾았어요.
                  후기가 쌓이면 여기서 자동으로 정리해 드려요.
                </Text>
                <TouchableOpacity style={styles.changeCafeBtn} onPress={openCafePicker}>
                  <Ionicons name="swap-horizontal" size={13} color={colors.mochaBrown} />
                  <Text style={styles.changeCafeText}>다른 가게로 변경</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {myCafe.analysis ? (
                  <>
                    <View style={styles.tagRow}>
                      <Tag label={`여론 ${myCafe.analysis.sentiment}`} />
                      <Tag label={`가격 ${myCafe.analysis.price_level}`} />
                      {!!myCafe.analysis.main_customers && <Tag label={myCafe.analysis.main_customers} />}
                      {!!myCafe.analysis.atmosphere && <Tag label={myCafe.analysis.atmosphere} />}
                    </View>
                    <Text style={styles.sheetSummary}>{myCafe.analysis.summary}</Text>

                    <TagBlock title="👍 손님들이 좋아하는 점" items={myCafe.analysis.strengths} tone="good" />
                    <TagBlock title="👎 아쉬워하는 점" items={myCafe.analysis.weaknesses} tone="warn" />
                    <TagBlock title="🍰 자주 언급된 메뉴" items={myCafe.analysis.signature_menus} />
                  </>
                ) : (
                  <Text style={styles.sheetSummary}>
                    후기는 모았지만 AI 요약을 만들지 못했어요. 아래 후기 원문을 참고해 주세요.
                  </Text>
                )}

                {myCafe.reviews.length > 0 && (
                  <>
                    <TouchableOpacity style={styles.moreBtn} onPress={() => setMyReviewsOpen((v) => !v)}>
                      <Text style={styles.moreBtnText}>
                        {myReviewsOpen ? '후기 접기' : `내 카페 후기 ${myCafe.review_count}건 원문 보기`}
                      </Text>
                      <Ionicons
                        name={myReviewsOpen ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={colors.espressoBrown}
                      />
                    </TouchableOpacity>
                    {myReviewsOpen &&
                      // 링크가 빈 후기가 섞여 있어 key={r.link}면 키가 겹친다 — 접었다 펴면
                      // 제목 아래 엉뚱한 발췌가 붙거나 줄이 사라졌다
                      myCafe.reviews.map((r, ri) => (
                        <TouchableOpacity
                          key={`my-review-${ri}-${r.link || r.title}`}
                          style={styles.reviewItem}
                          onPress={() => r.link && Linking.openURL(r.link)}
                        >
                          <Text style={styles.reviewTitle} numberOfLines={1}>{r.title}</Text>
                          <Text style={styles.reviewSnippet} numberOfLines={2}>{r.snippet}</Text>
                          <Text style={styles.reviewMeta}>{r.blogger} · {r.date}</Text>
                        </TouchableOpacity>
                      ))}
                  </>
                )}

                <TouchableOpacity style={styles.changeCafeBtn} onPress={openCafePicker}>
                  <Ionicons name="swap-horizontal" size={13} color={colors.mochaBrown} />
                  <Text style={styles.changeCafeText}>내 카페가 아니에요 · 변경</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          {/* 반경 선택 */}
          <View style={styles.radiusRow}>
            <Text style={styles.sectionTitle}>주변 카페</Text>
            <View style={styles.chipRow}>
              {RADIUS_OPTIONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, radius === r && styles.chipActive]}
                  onPress={() => setRadius(r)}
                >
                  <Text style={[styles.chipText, radius === r && styles.chipTextActive]}>
                    {r >= 1000 ? `${r / 1000}km` : `${r}m`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* 정렬 토글 — 유사도는 채점이 끝난 뒤에만 선택 가능 */}
          {Object.keys(simMap).length > 0 && (
            <View style={styles.sortRow}>
              {([['distance', '거리순'], ['similarity', '유사도순']] as const).map(([mode, label]) => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.chip, sortMode === mode && styles.chipActive]}
                  onPress={() => setSortMode(mode)}
                >
                  <Text style={[styles.chipText, sortMode === mode && styles.chipTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.sortHint}>유사도 = 내 카페와 메뉴·가격·컨셉이 겹치는 정도</Text>
            </View>
          )}

          {loadingNearby ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="small" color={colors.mochaBrown} />
              <Text style={styles.inlineLoadingText}>
                네이버에서 주변 카페와 후기를 모아 분석하는 중...
              </Text>
            </View>
          ) : nearbyError ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{nearbyError}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={() => loadNearby(radius)}>
                <Text style={styles.retryText}>다시 시도</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* ① 한눈 요약 — 숫자 세 개로 상권을 먼저 파악하게 한다 */}
              {nearby && nearby.count > 0 && (
                <View style={styles.statRow}>
                  <Stat value={`${nearby.count}곳`} label="주변 카페" />
                  <Stat value={`${nearest ?? '-'}m`} label="가장 가까운 곳" />
                  <Stat value={insight?.competition_level ?? '분석 중'} label="경쟁 강도" accent />
                </View>
              )}

              {/* ② 상권 한 줄 + 이번 주 할 일 3개 — 기본 화면은 여기까지만 보여 준다 */}
              {insight && (
                <View style={styles.insightCard}>
                  <Text style={styles.insightHeadline}>{insight.headline}</Text>
                  <Text style={styles.insightSummary}>{insight.market_summary}</Text>

                  {insight.actions?.length > 0 && (
                    <View style={styles.actionBox}>
                      <Text style={styles.actionTitle}>이번 주에 해 볼 일</Text>
                      {insight.actions.slice(0, 3).map((text, i) => (
                        <View key={`action-${i}`} style={styles.actionRow}>
                          <View style={styles.actionNum}>
                            <Text style={styles.actionNumText}>{i + 1}</Text>
                          </View>
                          <Text style={styles.actionText}>{text}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* 나머지 분석은 접어 둔다 — 필요할 때만 펼쳐 보게 */}
                  <TouchableOpacity style={styles.moreBtn} onPress={() => setDetailOpen((v) => !v)}>
                    <Text style={styles.moreBtnText}>
                      {detailOpen ? '분석 접기' : '기회 · 위협 · 트렌드 더 보기'}
                    </Text>
                    <Ionicons
                      name={detailOpen ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={colors.espressoBrown}
                    />
                  </TouchableOpacity>

                  {detailOpen && (
                    <>
                      <TagBlock title="💡 파고들 자리" items={insight.opportunities} tone="good" />
                      <TagBlock title="⚠️ 위협" items={insight.threats} tone="warn" />
                      <TagBlock title="🔎 동네 트렌드" items={insight.trends} />
                      {insight.watch_list?.length > 0 && (
                        <TagBlock
                          title="👀 주시할 카페"
                          items={insight.watch_list}
                          onPressItem={(name) => {
                            const hit = nearby?.cafes.find((c) => c.name === name);
                            if (hit) openCafe(hit);
                          }}
                        />
                      )}
                      <Text style={styles.aiNote}>
                        네이버 지역정보·블로그 후기를 모아 AI가 정리했어요. 참고용입니다.
                      </Text>
                    </>
                  )}
                </View>
              )}

              {/* ③ 카페 목록 — 기본 5곳만, 나머지는 버튼으로 */}
              {visibleCafes.map((cafe) => (
                <TouchableOpacity
                  key={`${cafe.name}-${cafe.lat}-${cafe.lon}`}
                  style={styles.cafeCard}
                  onPress={() => openCafe(cafe)}
                  activeOpacity={0.85}
                >
                  <View style={styles.distanceBadge}>
                    <Text style={styles.distanceText}>{cafe.distance_m}m</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cafeName} numberOfLines={1}>
                      {cafe.name}
                    </Text>
                    <Text style={styles.cafeMeta} numberOfLines={1}>
                      {cafe.category.split('>').pop()}
                    </Text>
                  </View>
                  {simMap[cafe.name] && (
                    <View style={[styles.simBadge, simBadgeTone(simMap[cafe.name].total).bg]}>
                      <Text style={[styles.simBadgeText, simBadgeTone(simMap[cafe.name].total).fg]}>
                        유사 {simMap[cafe.name].total}%
                      </Text>
                    </View>
                  )}
                  <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
                </TouchableOpacity>
              ))}

              {!!nearby && nearby.cafes.length > visibleCafes.length && (
                <TouchableOpacity style={styles.moreBtn} onPress={() => setShowAllCafes(true)}>
                  <Text style={styles.moreBtnText}>
                    카페 {nearby.cafes.length - visibleCafes.length}곳 더 보기
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.espressoBrown} />
                </TouchableOpacity>
              )}

              {nearby && nearby.count === 0 && (
                <Text style={styles.emptyText}>
                  이 반경에서는 등록된 카페를 찾지 못했어요. 반경을 넓혀 보세요.
                </Text>
              )}
            </>
          )}

          {/* ③-b 상권 변화 — 새로 생긴 카페 / 문 닫은 것으로 보이는 카페.
              매일 훑은 결과를 어제와 비교해 서버가 찾아낸다(같은 내용이 알림으로도 나간다).

              변화가 없어도 카드는 남긴다. 알림은 '변화가 있을 때'만 울리므로, 조용한 날에
              카드까지 사라지면 사장님은 이 기능이 알림으로만 존재한다고 느낀다. 여기서는
              '지금 몇 곳을 지켜보고 있고 언제 확인했는지'를 늘 보여 주고, 직접 다시 확인도 한다. */}
          <View style={styles.changeCard} onLayout={(e) => { changesY.current = e.nativeEvent.layout.y; }}>
            <View style={styles.changeHead}>
              <Ionicons name="pulse-outline" size={16} color={colors.pointOrange} />
              <Text style={styles.changeTitle}>주변 카페 변화</Text>
              <TouchableOpacity
                style={styles.rescanBtn}
                onPress={() => loadChanges(changeDays, true)}
                disabled={rescanning}
              >
                {rescanning ? (
                  <ActivityIndicator size="small" color={colors.espressoBrown} />
                ) : (
                  <>
                    <Ionicons name="refresh" size={13} color={colors.espressoBrown} />
                    <Text style={styles.rescanText}>지금 확인</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* 기간 넘겨보기 — 알림은 그 순간 한 번뿐이라, 지난 변화는 여기서만 다시 볼 수 있다 */}
            <View style={styles.changeChipRow}>
              {CHANGE_DAY_OPTIONS.map((d) => (
                <TouchableOpacity
                  key={`chg-${d}`}
                  style={[styles.changeChip, changeDays === d && styles.changeChipOn]}
                  onPress={() => setChangeDays(d)}
                >
                  <Text style={[styles.changeChipText, changeDays === d && styles.changeChipTextOn]}>
                    최근 {d}일
                  </Text>
                </TouchableOpacity>
              ))}
              <View style={{ flex: 1 }} />
              {!!changes && (
                <Text style={styles.changeNote}>
                  {changes.tracked > 0 ? `${changes.tracked}곳 관측 중` : '관측 준비 중'}
                  {changes.last_scan ? ` · ${formatWatchDay(changes.last_scan)} 확인` : ''}
                </Text>
              )}
            </View>

            {changesLoading && !changes ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator size="small" color={colors.mochaBrown} />
                <Text style={styles.inlineLoadingText}>주변 카페 변화를 확인하는 중...</Text>
              </View>
            ) : !changes || changes.count === 0 ? (
              <Text style={styles.changeEmpty}>
                {!changes || !changes.last_scan
                  ? '아직 주변 카페를 훑기 전이에요. ‘지금 확인’을 누르면 반경 1km를 한 번 살펴봅니다.'
                  : changes.baseline_only
                    ? `지금 있는 카페 ${changes.tracked}곳을 기준으로 지켜보기 시작했어요. 새로 생기거나 없어지는 곳은 내일부터 여기에 쌓입니다.`
                    : `최근 ${changes.days}일 동안 새로 생기거나 문을 닫은 카페는 없었어요.`}
              </Text>
            ) : null}

            {(changes?.opened ?? []).map((c) => (
              <View key={`open-${c.place_key}`} style={styles.changeRow}>
                <View style={[styles.changeBadge, styles.changeBadgeNew]}>
                  <Text style={styles.changeBadgeText}>신규</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.changeName} numberOfLines={1}>{c.name}</Text>
                  <Text style={styles.changeMeta} numberOfLines={1}>
                    {c.distance_m}m · {formatWatchDay(c.first_seen)}부터 보이기 시작
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.changeLookBtn}
                  onPress={() =>
                    openCafe({
                      name: c.name, category: c.category, address: c.address, telephone: '',
                      link: '', lat: c.lat ?? store.lat, lon: c.lon ?? store.lon,
                      distance_m: c.distance_m,
                    })
                  }
                >
                  <Text style={styles.changeLookText}>분석</Text>
                </TouchableOpacity>
              </View>
            ))}

            {(changes?.closed ?? []).map((c) => (
              <View key={`close-${c.place_key}`} style={styles.changeRow}>
                <View style={[styles.changeBadge, styles.changeBadgeGone]}>
                  <Text style={styles.changeBadgeText}>폐업?</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.changeName, styles.changeNameGone]} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={styles.changeMeta} numberOfLines={1}>
                    {c.distance_m}m · {formatWatchDay(c.closed_on || c.last_seen)}부터 검색에서 사라짐
                  </Text>
                </View>
              </View>
            ))}

            <Text style={styles.aiNote}>
              반경 1km를 매일 훑어 네이버 지역검색에 잡히는지로 판단해요.
              같은 내용이 알림으로도 가지만, 알림을 놓쳐도 여기서 다시 볼 수 있어요.
              폐업은 추정이라 실제로는 영업 중일 수 있어요.
            </Text>
          </View>

          {/* ④ 주변 행사 — 지도의 오렌지 핀과 같은 데이터. 반경은 예측과 맞춰 3km 고정 */}
          <View style={styles.radiusRow} onLayout={(e) => { eventsY.current = e.nativeEvent.layout.y; }}>
            <Text style={styles.sectionTitle}>주변 행사</Text>
            <Text style={styles.sectionNote}>
              반경 {events?.radius_km ?? 3}km · 앞으로 {events?.days ?? EVENT_DAYS}일
            </Text>
          </View>

          {loadingEvents ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="small" color={colors.pointOrange} />
              <Text style={styles.inlineLoadingText}>
                축제·팝업·문화행사 일정을 모으는 중...
              </Text>
            </View>
          ) : eventsError ? (
            <View style={styles.eventEmptyBox}>
              <Text style={styles.eventEmptyTitle}>
                앞으로 {EVENT_DAYS}일 안에 열리는 주변 행사를 찾을 수 없어요.
              </Text>
              <Text style={styles.emptyHint}>{eventsError.message}</Text>
              {eventsError.retryable && (
                <TouchableOpacity style={styles.retryBtn} onPress={loadEvents}>
                  <Text style={styles.retryText}>다시 시도</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : eventList.length === 0 ? (
            <View style={styles.eventEmptyBox}>
              <Text style={styles.eventEmptyTitle}>
                앞으로 {events?.days ?? EVENT_DAYS}일 안에 반경 {events?.radius_km ?? 3}km에서
                열리는 행사를 찾을 수 없어요.
              </Text>
              <Text style={styles.emptyHint}>
                한국관광공사·서울시 공공데이터와 뉴스·블로그 검색 기준이라
                소규모 행사는 빠질 수 있어요.
              </Text>
            </View>
          ) : (
            <>
              {/* 행사 요약 — 얼마나 붐빌지와 미리 해 둘 일을 먼저 */}
              {eventInsight && (
                <View style={styles.eventInsightCard}>
                  <View style={styles.eventInsightHead}>
                    <Text style={styles.eventInsightHeadline}>🎉 {eventInsight.headline}</Text>
                    <View style={styles.impactBadge}>
                      <Text style={styles.impactText}>영향 {eventInsight.impact_level}</Text>
                    </View>
                  </View>
                  <Text style={styles.insightSummary}>{eventInsight.summary}</Text>

                  {eventInsight.peak_days?.length > 0 && (
                    <TagBlock title="📈 붐빌 날" items={eventInsight.peak_days} tone="warn" />
                  )}

                  {eventInsight.actions?.length > 0 && (
                    <View style={styles.actionBox}>
                      <Text style={styles.actionTitle}>행사 전에 해 둘 일</Text>
                      {eventInsight.actions.slice(0, 3).map((text, i) => (
                        <View key={`ev-action-${i}`} style={styles.actionRow}>
                          <View style={[styles.actionNum, styles.actionNumEvent]}>
                            <Text style={styles.actionNumText}>{i + 1}</Text>
                          </View>
                          <Text style={styles.actionText}>{text}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {/* 카드 전체가 눌린다 — 행사 자체가 궁금할 때 볼 곳이 없어 버튼만 덩그러니 있었다.
                  카드 → 상세 시트 → (원하면) AI 준비 플랜 순으로 이어진다. */}
              {visibleEvents.map((e) => (
                <TouchableOpacity
                  key={`${e.name}-${e.start_date}`}
                  style={[styles.eventCard, e.ongoing && styles.eventCardNow]}
                  activeOpacity={0.85}
                  onPress={() => setDetailEvent(e)}
                >
                  <View style={styles.eventHead}>
                    <View style={[styles.ddayBadge, e.ongoing && styles.ddayBadgeNow]}>
                      <Text style={[styles.ddayText, e.ongoing && styles.ddayTextNow]}>
                        {e.ongoing ? '오늘' : `D-${e.d_day}`}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.eventName} numberOfLines={2}>
                        {e.name}
                      </Text>
                      <Text style={styles.eventMeta} numberOfLines={1}>
                        {/* 장소를 모를 때만 주최기관으로 대신한다 — 대개 장소에 이미 기관명이 들어 있어
                            둘 다 쓰면 "마포구립서강도서관 · 마포구립서강도서관 3층"처럼 겹친다 */}
                        {formatEventRange(e.start_date, e.end_date)} · {e.place || e.host || '장소 미상'}
                        {e.distance_km != null ? ` · ${e.distance_km}km` : ''}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
                  </View>

                  {!!e.tip && <Text style={styles.eventTip}>💡 {e.tip}</Text>}

                  <View style={styles.eventFootRow}>
                    <Text style={styles.eventSource} numberOfLines={1}>
                      {e.source}
                      {e.boost_pct ? ` · 예측 +${e.boost_pct}%` : ''}
                    </Text>
                    <Text style={styles.eventMore}>자세히 보기</Text>
                  </View>
                </TouchableOpacity>
              ))}

              {eventList.length > visibleEvents.length && (
                <TouchableOpacity style={styles.moreBtn} onPress={() => setShowAllEvents(true)}>
                  <Text style={styles.moreBtnText}>
                    행사 {eventList.length - visibleEvents.length}건 더 보기
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.espressoBrown} />
                </TouchableOpacity>
              )}

              <Text style={styles.aiNote}>
                공공데이터와 뉴스·블로그 검색으로 모은 일정이라 변동될 수 있어요.
                같은 행사가 판매 예측의 매출 보정에도 함께 반영됩니다.
                ‘뭘 준비할까?’는 알림으로 보내드리는 준비 플랜과 같은 내용이라,
                알림을 못 봤어도 여기서 언제든 다시 볼 수 있어요.
              </Text>
            </>
          )}
        </View>
      </ScrollView>

      {/* 카페 상세 — 네이버 후기 기반 AI 분석 */}
      <Modal visible={!!selected} animationType="slide" transparent onRequestClose={() => setSelected(null)}>
        {/* [FormSheet 패턴] 웹에서 Modal이 뷰포트 전체를 덮으므로 폰 프레임(maxWidth 420)에 가둔다 */}
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setSelected(null)} />
          <View style={[styles.sheet, frameSheet]}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{shownCafe?.name}</Text>
                <Text style={styles.sheetMeta}>
                  {shownCafe?.category} · 내 매장에서 {shownCafe?.distance_m}m
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              {/* 내 카페와의 유사도 — 총점 + 5축 비교 (메뉴30·가격25·컨셉20·분위기15·고객층10 가중) */}
              {shownCafe && simMap[shownCafe.name] && (
                <View style={styles.simBox}>
                  <View style={styles.simBoxHead}>
                    <Text style={styles.simBoxTitle}>우리 가게와 유사도 {simMap[shownCafe.name].total}%</Text>
                    <View style={[styles.simBadge, simBadgeTone(simMap[shownCafe.name].total).bg]}>
                      <Text style={[styles.simBadgeText, simBadgeTone(simMap[shownCafe.name].total).fg]}>
                        {simMap[shownCafe.name].tier}
                      </Text>
                    </View>
                  </View>
                  {([['menu', '메뉴'], ['price', '가격대'], ['concept', '컨셉'],
                     ['atmosphere', '분위기'], ['customers', '고객층']] as const).map(([k, label]) => (
                    <View key={k} style={styles.axisRow}>
                      <Text style={styles.axisLabel}>{label}</Text>
                      <View style={styles.axisTrack}>
                        <View style={[styles.axisFill, { width: `${simMap[shownCafe.name].axes[k]}%` }]} />
                      </View>
                      <Text style={styles.axisValue}>{simMap[shownCafe.name].axes[k]}</Text>
                    </View>
                  ))}
                  {!!simMap[shownCafe.name].reason && (
                    <Text style={styles.simReason}>{simMap[shownCafe.name].reason}</Text>
                  )}
                </View>
              )}

              {analysisError ? (
                <Text style={styles.errorText}>{analysisError}</Text>
              ) : !analysis ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator size="small" color={colors.mochaBrown} />
                  <Text style={styles.inlineLoadingText}>네이버 후기를 모아 분석하는 중...</Text>
                </View>
              ) : (
                <>
                  {analysis.analysis ? (
                    <>
                      {/* 태그 한 줄로 성격을 먼저 — 여론·가격·고객층·분위기를 문장 대신 칩으로 */}
                      <View style={styles.tagRow}>
                        <Tag label={`여론 ${analysis.analysis.sentiment}`} />
                        <Tag label={`가격 ${analysis.analysis.price_level}`} />
                        {!!analysis.analysis.main_customers && <Tag label={analysis.analysis.main_customers} />}
                        {!!analysis.analysis.atmosphere && <Tag label={analysis.analysis.atmosphere} />}
                      </View>
                      <Text style={styles.sheetSummary}>{analysis.analysis.summary}</Text>

                      <TagBlock title="👍 강점" items={analysis.analysis.strengths} tone="good" />
                      <TagBlock title="👎 약점" items={analysis.analysis.weaknesses} tone="warn" />
                      <TagBlock title="🍰 대표 메뉴" items={analysis.analysis.signature_menus} />

                      {/* 사장님이 실제로 쓸 한 줄 — 시트에서 가장 눈에 띄어야 한다 */}
                      <View style={styles.strategyBox}>
                        <Text style={styles.strategyLabel}>🎯 우리 대응</Text>
                        <Text style={styles.strategyText}>{analysis.analysis.counter_strategy}</Text>
                      </View>
                    </>
                  ) : (
                    <Text style={styles.sheetSummary}>
                      AI 분석을 생성하지 못했어요. 아래 후기 원문을 참고해 주세요.
                    </Text>
                  )}

                  {analysis.reviews.length > 0 && (
                    <>
                      <TouchableOpacity style={styles.moreBtn} onPress={() => setReviewsOpen((v) => !v)}>
                        <Text style={styles.moreBtnText}>
                          {reviewsOpen ? '후기 접기' : `근거가 된 후기 ${analysis.review_count}건 보기`}
                        </Text>
                        <Ionicons
                          name={reviewsOpen ? 'chevron-up' : 'chevron-down'}
                          size={14}
                          color={colors.espressoBrown}
                        />
                      </TouchableOpacity>
                      {reviewsOpen &&
                        analysis.reviews.map((r, ri) => (
                          <TouchableOpacity
                            key={`cafe-review-${ri}-${r.link || r.title}`}
                            style={styles.reviewItem}
                            onPress={() => r.link && Linking.openURL(r.link)}
                          >
                            <Text style={styles.reviewTitle} numberOfLines={1}>
                              {r.title}
                            </Text>
                            <Text style={styles.reviewSnippet} numberOfLines={2}>
                              {r.snippet}
                            </Text>
                            <Text style={styles.reviewMeta}>
                              {r.blogger} · {r.date}
                            </Text>
                          </TouchableOpacity>
                        ))}
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 내 카페 지정 — 상호로 검색한 후보 중 사장님이 주소를 보고 자기 가게를 고른다 */}
      <Modal visible={cafePickerOpen} animationType="slide" transparent onRequestClose={() => setCafePickerOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setCafePickerOpen(false)} />
          <View style={[styles.sheet, frameSheet]}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>내 카페 지정</Text>
                <Text style={styles.sheetMeta}>목록에서 사장님 가게를 골라 주세요 (주소로 구분)</Text>
              </View>
              <TouchableOpacity onPress={() => setCafePickerOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              {loadingCandidates ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator size="small" color={colors.mochaBrown} />
                  <Text style={styles.inlineLoadingText}>네이버에서 후보 카페를 찾는 중...</Text>
                </View>
              ) : candidatesError ? (
                <>
                  <Text style={styles.errorText}>{candidatesError}</Text>
                  <TouchableOpacity style={styles.retryBtn} onPress={openCafePicker}>
                    <Text style={styles.retryText}>다시 시도</Text>
                  </TouchableOpacity>
                </>
              ) : candidates.length === 0 ? (
                <Text style={styles.myCafeEmpty}>
                  검색된 카페가 없어요. 매장 상호가 네이버 지도에 등록돼 있는지 확인해 주세요.
                </Text>
              ) : (
                candidates.map((c, i) => (
                  <TouchableOpacity
                    key={`${c.name}-${i}`}
                    style={[styles.candidateItem, linking && { opacity: 0.5 }]}
                    onPress={() => chooseCafe(c)}
                    disabled={linking}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.candidateName} numberOfLines={1}>{c.name}</Text>
                      <Text style={styles.candidateAddr} numberOfLines={1}>{c.address || '주소 정보 없음'}</Text>
                    </View>
                    {c.distance_m != null && <Text style={styles.candidateDist}>{c.distance_m}m</Text>}
                    <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 행사 상세 — 카드나 지도 핀을 누르면 먼저 이게 열린다.
          "언제·어디서·얼마나 가까이·우리 매출에 얼마나" 를 한 화면에 놓고,
          그 끝에서 AI 준비 플랜으로 넘어간다. */}
      <Modal visible={!!detailEvent} animationType="slide" transparent onRequestClose={() => setDetailEvent(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setDetailEvent(null)} />
          <View style={[styles.sheet, frameSheet]}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1, gap: 8 }}>
                <View style={styles.detailChipRow}>
                  <View style={[styles.ddayBadge, shownDetail?.ongoing && styles.ddayBadgeNow]}>
                    <Text style={[styles.ddayText, shownDetail?.ongoing && styles.ddayTextNow]}>
                      {shownDetail?.ongoing ? '오늘 열려요' : `D-${shownDetail?.d_day ?? 0}`}
                    </Text>
                  </View>
                  {!!shownDetail?.boost_pct && (
                    <View style={styles.impactBadge}>
                      <Text style={styles.impactText}>{impactWord(shownDetail.boost_pct)}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.sheetTitle}>{shownDetail?.name}</Text>
              </View>
              <TouchableOpacity
                onPress={() => setDetailEvent(null)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              {!!shownDetail && (
                <>
                  <View style={styles.factCard}>
                    <FactRow icon="calendar-outline" label="언제"
                      value={`${formatEventRange(shownDetail.start_date, shownDetail.end_date)}${
                        shownDetail.day_count > 1 ? ` · ${shownDetail.day_count}일간` : ''}`} />
                    <FactRow icon="location-outline" label="어디서"
                      value={shownDetail.place || shownDetail.host || '장소 미상'} />
                    {!!shownDetail.host && !!shownDetail.place && (
                      <FactRow icon="business-outline" label="주최" value={shownDetail.host} />
                    )}
                    <FactRow icon="walk-outline" label="매장에서"
                      value={shownDetail.distance_km != null ? `${shownDetail.distance_km}km` : '거리 정보 없음'} />
                    <FactRow icon="trending-up-outline" label="매출 영향"
                      value={shownDetail.boost_pct
                        ? `예측에 +${shownDetail.boost_pct}% 반영 중`
                        : '예측에는 반영하지 않음'} />
                    <FactRow icon="document-text-outline" label="출처" value={shownDetail.source || '미상'} />
                  </View>

                  {!!shownDetail.tip && (
                    <View style={styles.detailTipBox}>
                      <Text style={styles.detailTipLabel}>이 행사엔 이렇게</Text>
                      <Text style={styles.detailTipText}>{shownDetail.tip}</Text>
                    </View>
                  )}

                  {/* 상세에서 곧장 준비로 — 여기가 이 시트의 목적지다 */}
                  <TouchableOpacity
                    style={styles.detailPlanBtn}
                    onPress={() => {
                      const target = shownDetail;
                      setDetailEvent(null);
                      openPlan(target);
                    }}
                  >
                    <Ionicons name="sparkles" size={15} color={colors.white} />
                    <Text style={styles.detailPlanBtnText}>이 행사, 뭘 준비할까?</Text>
                  </TouchableOpacity>
                  <Text style={styles.detailPlanHint}>
                    이벤트 아이디어 · 한정 메뉴 · 미리 해 둘 일 · 재료와 인력까지 AI가 짜 드려요.
                  </Text>

                  <TouchableOpacity
                    style={styles.detailSearchBtn}
                    onPress={() =>
                      Linking.openURL(
                        `https://search.naver.com/search.naver?query=${encodeURIComponent(shownDetail.name)}`,
                      )
                    }
                  >
                    <Ionicons name="open-outline" size={14} color={colors.espressoBrown} />
                    <Text style={styles.detailSearchText}>네이버에서 이 행사 검색</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 행사 대비 AI 플랜 — "이 행사에 무슨 이벤트를 걸고, 뭘 미리 해 둘까" */}
      <Modal visible={!!planEvent} animationType="slide" transparent onRequestClose={() => setPlanEvent(null)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setPlanEvent(null)} />
          <View style={[styles.sheet, frameSheet]}>
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{shownPlanEvent?.name}</Text>
                <Text style={styles.sheetMeta}>
                  {shownPlanEvent
                    ? `${formatEventRange(shownPlanEvent.start_date, shownPlanEvent.end_date)} · ${shownPlanEvent.place || '장소 미상'}`
                    : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setPlanEvent(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              {planError ? (
                // AI 플랜을 못 만들어도 시트를 빈손으로 닫게 두지 않는다 — 이미 알고 있는
                // 행사 정보(기간·장소·거리·예측 반영·대응 팁)는 그대로 보여 준다.
                <>
                  <Text style={styles.errorText}>{planError}</Text>
                  {!!shownPlanEvent && (
                    <View style={styles.planFactBox}>
                      <Text style={styles.listTitle}>지금 알고 있는 것</Text>
                      <Text style={styles.promoDetail}>
                        {formatEventRange(shownPlanEvent.start_date, shownPlanEvent.end_date)}
                        {shownPlanEvent.day_count > 1 ? ` (${shownPlanEvent.day_count}일간)` : ''}
                        {shownPlanEvent.ongoing ? ' · 진행 중' : ` · D-${shownPlanEvent.d_day}`}
                      </Text>
                      <Text style={styles.promoDetail}>
                        {shownPlanEvent.place || shownPlanEvent.host || '장소 미상'}
                        {shownPlanEvent.distance_km != null ? ` · 매장에서 ${shownPlanEvent.distance_km}km` : ''}
                      </Text>
                      {!!shownPlanEvent.boost_pct && (
                        <Text style={styles.promoDetail}>
                          판매 예측에 매출 +{shownPlanEvent.boost_pct}%로 이미 반영 중이에요.
                        </Text>
                      )}
                      {!!shownPlanEvent.tip && <Text style={styles.promoWhy}>💡 {shownPlanEvent.tip}</Text>}
                    </View>
                  )}
                  {!!shownPlanEvent && (
                    <TouchableOpacity style={styles.retryBtn} onPress={() => openPlan(shownPlanEvent)}>
                      <Text style={styles.retryText}>다시 시도</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : !plan ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator size="small" color={colors.pointOrange} />
                  <Text style={styles.inlineLoadingText}>
                    이 행사에 맞는 이벤트와 준비할 것을 짜는 중...
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.tagRow}>
                    <Tag label={`영향 ${plan.impact_level}`} />
                    {!!plan.busy_window && <Tag label={plan.busy_window} />}
                  </View>
                  <Text style={styles.planHeadline}>{plan.headline}</Text>
                  <Text style={styles.sheetSummary}>{plan.expected_change}</Text>

                  {/* 이벤트 제안 — 이 화면에서 가장 눈에 띄어야 하는 부분 */}
                  {plan.promotions?.length > 0 && (
                    <View style={{ marginTop: 14 }}>
                      <Text style={styles.listTitle}>🎁 이런 이벤트 어때요</Text>
                      {plan.promotions.map((p, i) => (
                        <View key={`promo-${i}`} style={styles.promoBox}>
                          <Text style={styles.promoTitle}>{p.title}</Text>
                          <Text style={styles.promoDetail}>{p.detail}</Text>
                          {!!p.why && <Text style={styles.promoWhy}>→ {p.why}</Text>}
                        </View>
                      ))}
                    </View>
                  )}

                  {!!plan.menu_idea && (
                    <View style={styles.strategyBox}>
                      <Text style={styles.strategyLabel}>☕ 기간 한정 메뉴</Text>
                      <Text style={styles.strategyText}>{plan.menu_idea}</Text>
                    </View>
                  )}

                  {plan.prep_actions?.length > 0 && (
                    <View style={styles.actionBox}>
                      <Text style={styles.actionTitle}>행사 전에 해 둘 일</Text>
                      {plan.prep_actions.map((text, i) => (
                        <View key={`prep-${i}`} style={styles.actionRow}>
                          <View style={[styles.actionNum, styles.actionNumEvent]}>
                            <Text style={styles.actionNumText}>{i + 1}</Text>
                          </View>
                          <Text style={styles.actionText}>{text}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <TagBlock title="📦 넉넉히 준비할 재료" items={plan.stock_prep} tone="warn" />
                  {!!plan.staffing && <TagBlock title="👥 인력 배치" items={[plan.staffing]} />}

                  {!!plan.promo_copy && (
                    <View style={styles.copyBox}>
                      <Text style={styles.copyLabel}>📣 그대로 쓰는 홍보 문구</Text>
                      <Text style={styles.copyText}>{plan.promo_copy}</Text>
                    </View>
                  )}

                  <Text style={styles.aiNote}>
                    공개된 행사 정보를 바탕으로 AI가 짠 제안이에요. 매장 사정에 맞게 골라 쓰세요.
                  </Text>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <StoreLocationPicker
        visible={pickerOpen}
        initial={{ lat: store.lat, lon: store.lon, address: store.region }}
        saving={savingPin}
        onClose={() => setPickerOpen(false)}
        onConfirm={handlePinConfirm}
      />
    </View>
  );
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 행사 기간 표기 — 사장님이 보는 건 '몇 월 며칠 무슨 요일'이지 ISO 날짜가 아니다.
// 하루짜리면 한 날짜만, 여러 날이면 시작~종료로 묶는다.
// 관측 날짜 표기 — 사장님이 읽는 건 "2026-08-01"이 아니라 "어제"다.
// 이번 주 안이면 상대 표현, 그보다 오래되면 8/1 형태로 줄인다.
function formatWatchDay(iso: string) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - target.getTime()) /
      86400000,
  );
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  if (diff > 1 && diff <= 6) return `${diff}일 전`;
  return `${m}/${d}`;
}

function formatEventRange(start: string, end: string) {
  // 날짜가 비어 오면 "undefined/undefined(월)"이 그대로 화면에 찍혔다 —
  // 행사 카드·상세·플랜 제목·지도 말풍선 네 곳에서. 값이 없으면 없다고 말한다.
  const label = (iso: string) => {
    const [y, m, d] = (iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? '';
    return `${m}/${d}(${weekday})`;
  };
  const s = label(start);
  const e = label(end);
  if (!s && !e) return '날짜 미정';
  if (!s || !e || s === e) return s || e;
  return `${s} ~ ${e}`;
}

// 한눈 요약 숫자 한 칸 (주변 카페 수 · 최근접 거리 · 경쟁 강도)
// 유사도 배지 색 — 높을수록 '직접 경쟁'이라 경고 톤, 낮으면 공존 가능이라 초록 톤
function simBadgeTone(total: number) {
  if (total >= 80) {
    return { bg: { backgroundColor: 'rgba(178, 59, 46, 0.10)' }, fg: { color: '#B23B2E' } };
  }
  if (total >= 50) {
    return { bg: { backgroundColor: 'rgba(216, 150, 20, 0.14)' }, fg: { color: '#9A6B00' } };
  }
  return { bg: { backgroundColor: colors.trendGreenBg }, fg: { color: colors.trendGreenText } };
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, accent && { color: colors.trendGreenText }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// 제목 + 칩 묶음. 불릿 문장을 길게 늘어놓는 대신 짧은 칩으로 훑어보게 한다.
function TagBlock({
  title,
  items,
  tone,
  onPressItem,
}: {
  title: string;
  items?: string[];
  tone?: 'good' | 'warn';
  onPressItem?: (item: string) => void;
}) {
  const clean = (items ?? []).filter((t) => t && t.trim());
  if (clean.length === 0) return null;
  const toneStyle = tone === 'good' ? styles.tagGood : tone === 'warn' ? styles.tagWarn : null;
  const toneText = tone === 'good' ? styles.tagGoodText : tone === 'warn' ? styles.tagWarnText : null;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.listTitle}>{title}</Text>
      <View style={styles.chipRow}>
        {clean.map((text, i) => (
          <TouchableOpacity
            key={`${title}-${i}`}
            style={[styles.tag, toneStyle]}
            disabled={!onPressItem}
            onPress={() => onPressItem?.(text)}
          >
            <Text style={[styles.tagText, toneText]}>{text}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

// 행사 상세의 한 줄 — 아이콘 + 라벨 + 값. 줄글로 늘어놓는 것보다 훑기 쉽다.
function FactRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.factRow}>
      <Ionicons name={icon} size={15} color={colors.pointOrange} />
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/** 부스팅(%)을 사장님 말로 — 숫자만 보면 3%가 큰지 작은지 알 수 없다 */
function impactWord(boostPct: number) {
  if (boostPct >= 10) return '손님 많이 늘 듯';
  if (boostPct >= 5) return '손님 조금 늘 듯';
  return '영향은 작을 듯';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.creamSand },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  loadingText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  hintText: {
    fontSize: 11.5,
    lineHeight: 18,
    color: '#A99C90',
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginTop: 6,
  },
  primaryBtnText: { ...typography.L4, color: colors.white },

  // [한글 주석] 높이는 화면에서 뷰포트 비례로 덮어쓴다 (고정 320 은 가로모드에서 화면을 다 먹었다)
  // 지도 아래 모서리를 둥글려 본문과 부드럽게 이어지게 (직각으로 잘리면 화면이 딱딱해 보인다)
  mapBox: {
    backgroundColor: colors.coffeeCream,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    overflow: 'hidden',
    ...shadows.soft,
  },
  body: { paddingHorizontal: spacing.globalPadding, paddingTop: 14, gap: 10 },

  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  storeLabel: { ...typography.L5, color: colors.mochaBrown },
  storeAddress: { ...typography.L4, color: colors.espressoBrown, marginTop: 3, lineHeight: 17 },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: colors.coffeeCream,
  },
  ghostBtnText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  radiusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  sectionTitle: { ...typography.L3, color: colors.espressoBrown },
  sectionNote: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.coffeeCream,
  },
  chipActive: { backgroundColor: colors.espressoBrown },
  chipText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '800' },
  chipTextActive: { color: colors.white },

  inlineLoading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
  inlineLoadingText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '600' },

  errorCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  errorText: { ...typography.L5, color: colors.espressoBrown, lineHeight: 17 },
  retryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.coffeeCream,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  retryText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  // 한눈 요약 3칸
  statRow: { flexDirection: 'row', gap: 8 },
  statBox: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  statValue: { ...typography.L3, color: colors.espressoBrown },
  statLabel: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },

  insightCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    ...shadows.soft,
  },
  insightHeadline: { ...typography.L3, color: colors.espressoBrown, lineHeight: 21 },
  insightSummary: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17, marginTop: 6 },

  // 내 카페 리뷰 카드 — 경쟁 카페 시트와 같은 톤이되, 상단에 오렌지 포인트로 '내 것'임을 표시
  myCafeCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(232, 131, 58, 0.28)',
    gap: 4,
    ...shadows.soft,
  },
  myCafeHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  myCafeTitle: { ...typography.L3, color: colors.espressoBrown },
  myCafeName: { flex: 1, ...typography.L5, color: colors.mochaBrown, textAlign: 'right' },
  myCafeEmpty: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18, marginTop: 2 },
  // '내 카페 지정' CTA + 변경 링크
  linkCafeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.pointOrange, borderRadius: 11, paddingVertical: 11, marginTop: 8,
  },
  linkCafeBtnText: { color: colors.white, fontSize: 13.5, fontWeight: '800' },
  changeCafeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8, marginTop: 4,
  },
  changeCafeText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700', textDecorationLine: 'underline' },
  // 후보 선택 목록
  candidateItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.mutedSand,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 8,
  },
  candidateName: { ...typography.L4, color: colors.espressoBrown, fontWeight: '800' },
  candidateAddr: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  candidateDist: { ...typography.L5, color: colors.pointOrange, fontWeight: '800' },

  // 이번 주 할 일 — 번호를 붙여 '해야 할 목록'으로 읽히게 한다
  actionBox: {
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    gap: 8,
  },
  actionTitle: { ...typography.L4, color: colors.espressoBrown },
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  actionNum: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: colors.espressoBrown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  actionNumText: { fontSize: 10, fontWeight: '900', color: colors.white },
  // 행사 쪽 번호는 지도 핀과 같은 오렌지 — 어느 카드의 할 일인지 색으로 구분된다
  actionNumEvent: { backgroundColor: colors.pointOrange },
  actionText: { ...typography.L5, color: colors.espressoBrown, flex: 1, lineHeight: 17, fontWeight: '600' },

  moreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 11,
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: colors.coffeeCream,
  },
  moreBtnText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },

  listTitle: { ...typography.L4, color: colors.espressoBrown, marginBottom: 6 },
  aiNote: { ...typography.L5, color: '#A99C90', marginTop: 12, lineHeight: 15 },

  cafeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  // 거리를 왼쪽 배지로 — 목록을 훑을 때 '얼마나 가까운가'가 먼저 보이게
  distanceBadge: {
    minWidth: 46,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 9,
    backgroundColor: colors.trendGreenBg,
    alignItems: 'center',
  },
  distanceText: { ...typography.L5, color: colors.trendGreenText, fontWeight: '800' },
  cafeName: { ...typography.L4, color: colors.espressoBrown },
  cafeMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },

  // ── 유사도 (정렬 토글 · 배지 · 상세 축 비교) ──
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  sortHint: { ...typography.L5, color: '#AEAEB2', marginLeft: 2, flexShrink: 1 },
  simBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  simBadgeText: { fontSize: 10.5, fontWeight: '800' },
  simBox: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    gap: 7,
  },
  simBoxHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 },
  simBoxTitle: { ...typography.L4, fontSize: 13.5, color: colors.espressoBrown },
  axisRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  axisLabel: { ...typography.L5, color: colors.mochaBrown, width: 42 },
  axisTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.coffeeCream, overflow: 'hidden' },
  axisFill: { height: '100%', borderRadius: 3, backgroundColor: colors.espressoBrown },
  axisValue: { ...typography.L5, color: colors.espressoBrown, width: 24, textAlign: 'right', fontWeight: '700' },
  simReason: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 3 },

  // --- 주변 행사 ---
  // '없음'과 '못 불러옴'을 같은 상자로 — 화면이 빨간 오류 카드로 놀라게 하지 않는다
  eventEmptyBox: {
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 14,
    gap: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  // 상자 안에서는 emptyText의 위아래 여백(paddingVertical)이 이중이 되므로 따로 둔다
  eventEmptyTitle: {
    ...typography.L4,
    color: colors.espressoBrown,
    textAlign: 'center',
    lineHeight: 18,
  },
  emptyHint: {
    ...typography.L5,
    color: '#A99C90',
    textAlign: 'center',
    lineHeight: 16,
  },
  // 카페 카드(초록 거리 배지)와 헷갈리지 않게 행사는 오렌지 계열로 통일한다 (지도 핀과 같은 색)
  eventInsightCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(226, 130, 87, 0.35)',
    ...shadows.soft,
  },
  eventInsightHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  eventInsightHeadline: { ...typography.L3, color: colors.espressoBrown, flex: 1, lineHeight: 21 },
  impactBadge: {
    backgroundColor: 'rgba(226, 130, 87, 0.14)',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  impactText: { ...typography.L5, color: '#B4542C', fontWeight: '800' },

  eventCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    gap: 7,
  },
  eventHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  // D-day를 왼쪽에 — 목록을 훑을 때 '언제 대비해야 하나'가 먼저 보이게
  ddayBadge: {
    minWidth: 46,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 9,
    backgroundColor: 'rgba(226, 130, 87, 0.12)',
    alignItems: 'center',
  },
  ddayBadgeNow: { backgroundColor: colors.pointOrange },
  ddayText: { ...typography.L5, color: '#B4542C', fontWeight: '800' },
  ddayTextNow: { color: colors.white },
  eventName: { ...typography.L4, color: colors.espressoBrown, lineHeight: 18 },
  eventMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  eventTip: {
    ...typography.L5,
    color: colors.espressoBrown,
    fontWeight: '700',
    lineHeight: 17,
    backgroundColor: colors.creamSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  // 오늘 열리는 행사는 카드도 살짝 물든다 — 지도 핀이 숨 쉬는 것과 같은 신호
  eventCardNow: { borderColor: 'rgba(226, 130, 87, 0.55)', backgroundColor: '#FFFAF6' },
  eventFootRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  eventSource: { ...typography.L5, color: '#A99C90', flex: 1 },
  eventMore: { ...typography.L5, color: '#B4542C', fontWeight: '800' },

  // --- 행사 상세 시트 ---
  detailChipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  factCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(140, 121, 104, 0.12)',
  },
  factLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700', width: 54 },
  factValue: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700', flex: 1, lineHeight: 17 },
  detailTipBox: {
    marginTop: 12,
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  detailTipLabel: { ...typography.L5, color: '#B4542C', fontWeight: '800' },
  detailTipText: { ...typography.L4, color: colors.espressoBrown, lineHeight: 19 },
  detailPlanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 16,
    backgroundColor: colors.pointOrange,
    borderRadius: 14,
    paddingVertical: 13,
    ...shadows.soft,
  },
  detailPlanBtnText: { ...typography.L4, color: colors.white, fontWeight: '800' },
  detailPlanHint: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', marginTop: 7, lineHeight: 16 },
  detailSearchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    backgroundColor: colors.white,
  },
  detailSearchText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  // 행사 카드의 'AI 준비 플랜' — 누를 때만 AI를 부르므로 카드 안에서 확실히 눌리게 보여 준다
  planBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.pointOrange,
    borderRadius: 10,
    paddingVertical: 9,
  },
  planBtnText: { ...typography.L5, color: colors.white, fontWeight: '800' },
  emptyText: { ...typography.L5, color: colors.mochaBrown, textAlign: 'center', paddingVertical: 18 },

  // 상권 변화 — 개업(초록)·폐업(회색)을 배지 색으로 구분한다
  changeCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(226, 130, 87, 0.35)',
    gap: 10,
    ...shadows.soft,
  },
  changeHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  changeTitle: { ...typography.L3, color: colors.espressoBrown, flex: 1 },
  changeNote: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  // '지금 확인' — 서버가 반경을 다시 훑는 동안 자리를 지키도록 최소 너비를 준다
  rescanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 78,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    backgroundColor: colors.creamSand,
  },
  rescanText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  changeChipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  changeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  changeChipOn: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  changeChipText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  changeChipTextOn: { color: colors.white },
  // 변화가 없는 날에도 카드는 남는다 — 그 자리를 채우는 설명문
  changeEmpty: { ...typography.L5, color: colors.mochaBrown, lineHeight: 18 },

  // 지도 범례 — 지도 바로 아래 한 줄
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: colors.white },
  legendDotStore: { backgroundColor: '#3B2314', width: 11, height: 11, borderRadius: 6 },
  legendDotCafe: { backgroundColor: '#7A6250' },
  legendDotEvent: { backgroundColor: '#D2601A', width: 11, height: 11, borderRadius: 6 },
  legendText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  legendNote: { ...typography.L5, color: '#A99C90' },

  // 주변 소식 바로가기 바 — 지도 바로 아래, 스크롤 없이 두 기능의 존재가 보이게
  newsBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' },
  newsBarLabel: { ...typography.L5, color: colors.mochaBrown, fontWeight: '800' },
  newsChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  newsChipText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  changeBadge: {
    minWidth: 46,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 9,
    alignItems: 'center',
  },
  changeBadgeNew: { backgroundColor: 'rgba(93, 158, 106, 0.16)' },
  changeBadgeGone: { backgroundColor: 'rgba(120, 110, 100, 0.14)' },
  changeBadgeText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  changeName: { ...typography.L4, color: colors.espressoBrown },
  changeNameGone: { textDecorationLine: 'line-through', color: colors.mochaBrown },
  changeMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  changeLookBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  changeLookText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '700' },

  // 행사 플랜 시트
  planHeadline: { ...typography.L3, color: colors.espressoBrown, marginTop: 10, lineHeight: 21 },
  // AI 플랜이 안 나온 날에도 남는 '이미 아는 사실' 상자
  planFactBox: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    gap: 4,
  },
  promoBox: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    gap: 3,
  },
  promoTitle: { ...typography.L4, color: colors.espressoBrown },
  promoDetail: { ...typography.L5, color: colors.mochaBrown, lineHeight: 17 },
  promoWhy: { ...typography.L5, color: '#B4542C', fontWeight: '700' },
  copyBox: {
    marginTop: 14,
    backgroundColor: 'rgba(226, 130, 87, 0.12)',
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  copyLabel: { ...typography.L5, color: '#B4542C', fontWeight: '800' },
  copyText: { ...typography.L4, color: colors.espressoBrown, lineHeight: 19 },

  modalRoot: { flex: 1, justifyContent: 'flex-end', width: '100%', maxWidth: 420, alignSelf: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.black40 },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    maxHeight: '85%',
    ...shadows.medium,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  sheetTitle: { ...typography.L1, color: colors.espressoBrown },
  sheetMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  sheetSummary: { ...typography.L5, color: colors.espressoBrown, lineHeight: 18 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  tag: { backgroundColor: colors.coffeeCream, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tagText: { ...typography.L5, color: colors.espressoBrown, fontWeight: '800' },
  // 강점=초록, 약점/위협=주의 — 색만 봐도 좋은 소식인지 나쁜 소식인지 구분된다
  tagGood: { backgroundColor: colors.trendGreenBg },
  tagGoodText: { color: colors.trendGreenText },
  tagWarn: { backgroundColor: 'rgba(226, 130, 87, 0.12)' },
  tagWarnText: { color: '#B4542C' },

  // 카페 상세에서 가장 중요한 한 줄 (우리 대응)
  strategyBox: {
    marginTop: 14,
    backgroundColor: colors.espressoBrown,
    borderRadius: 12,
    padding: 13,
    gap: 4,
  },
  strategyLabel: { ...typography.L5, color: 'rgba(255,255,255,0.7)', fontWeight: '800' },
  strategyText: { ...typography.L4, color: colors.white, lineHeight: 18 },

  reviewItem: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  reviewTitle: { ...typography.L4, color: colors.espressoBrown },
  reviewSnippet: { ...typography.L5, color: colors.mochaBrown, lineHeight: 16, marginTop: 3 },
  reviewMeta: { ...typography.L5, color: '#A99C90', marginTop: 5 },
});
