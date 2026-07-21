// [한글 주석: 원두 메모장 컴포넌트 - 아코디언 토글 & 이모지 완전 제거 버전]
// 사장님이 현재 사용 중인 원두와 이전에 주문/발주해본 원두를 기록하는 깔끔한 대장 UI입니다.
// AsyncStorage에 로컬 저장되므로 백엔드 없이도 동작합니다.
import { useEffect, useState, useRef } from 'react';
import {
  Alert,
  Animated,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  PanResponder,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows, typography } from '../../theme';
import { listRoasteryBeans, RoasteryBean } from '../../lib/api/inventory';
import {
  getSensorLive,
  getSensorRecommendations,
  setSensorBeans,
  setSensorFeature,
  LiveMetrics,
  SensorLive,
  SensorRecommendation,
} from '../../lib/api/sensor';
import SensorSetupModal from './SensorSetupModal';

// 대시보드 지표 → 센서 스테이션 기기 id 매핑 (설비 칩 탭 시 해당 가이드로 바로 진입)
const METRIC_TO_DEVICE: Record<keyof LiveMetrics, string> = {
  hoppers: 'bean_scale',
  rfid: 'rfid_reader',
  milk: 'milk_scale',
  fridge: 'fridge_temp',
  water: 'water_level',
  machine: 'smart_plug',
};

// 🟢 [한글 주석: 실시간으로 부드럽게 점멸(Pulse)하는 라이브 연동 배지 컴포넌트]
// variant: 'connecting'(회색, 서버 응답 없음) | 'demo'(주황, 센서 0개 연결) | 'live'(초록)
const LivePulseBadge: React.FC<{
  variant?: 'connecting' | 'demo' | 'live';
  label?: string;
}> = ({ variant = 'live', label }) => {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [pulseAnim]);

  if (variant === 'connecting') {
    return (
      <View style={[liveComponentStyles.pulseBadgeContainer, liveComponentStyles.pulseBadgeContainerOff]}>
        <View style={[liveComponentStyles.pulseDot, liveComponentStyles.pulseDotOff]} />
        <Text style={[liveComponentStyles.pulseText, liveComponentStyles.pulseTextOff]}>센서 연결 중</Text>
      </View>
    );
  }

  if (variant === 'demo') {
    return (
      <View style={[liveComponentStyles.pulseBadgeContainer, liveComponentStyles.pulseBadgeContainerDemo]}>
        <Animated.View
          style={[liveComponentStyles.pulseDot, liveComponentStyles.pulseDotDemo, { opacity: pulseAnim }]}
        />
        <Text style={[liveComponentStyles.pulseText, liveComponentStyles.pulseTextDemo]}>데모 모드</Text>
      </View>
    );
  }

  return (
    <View style={liveComponentStyles.pulseBadgeContainer}>
      <Animated.View style={[liveComponentStyles.pulseDot, { opacity: pulseAnim }]} />
      <Text style={liveComponentStyles.pulseText}>{label ?? 'LIVE 실시간 연동'}</Text>
    </View>
  );
};

// 📺 [한글 주석: 매장 원두 가동 상태를 전광판처럼 롤링 전송해주는 실시간 틱커 배너]
// messages는 백엔드 /sensor/live 의 events 피드 — 없으면 연결 대기 문구를 보여준다.
const FALLBACK_TICKER = ['📡 매장 센서 연결을 기다리는 중이에요 (백엔드 /sensor/live)'];

const LiveTickerBanner: React.FC<{ messages?: string[] }> = ({ messages }) => {
  const list = messages && messages.length > 0 ? messages : FALLBACK_TICKER;
  const [index, setIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setIndex((prev) => prev + 1);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    }, 4000);

    return () => clearInterval(timer);
  }, [fadeAnim]);

  return (
    <View style={liveComponentStyles.tickerContainer}>
      <Ionicons name="radio-outline" size={14} color={colors.pointOrange} />
      <Animated.Text style={[liveComponentStyles.tickerText, { opacity: fadeAnim }]} numberOfLines={1}>
        {list[index % list.length]}
      </Animated.Text>
    </View>
  );
};

// ─── 타입 정의 ───────────────────────────────────────────────────────────
interface BeanNote {
  id: string;
  name: string;         // 원두 이름
  memo: string;         // 간단 메모
  date: string;         // 날짜 (YYYY-MM-DD)
  usageCount: number;   // 주문(사용) 횟수
  status?: string;      // 하위 호환성용
}

interface NotepadData {
  currentCaffeine: string;   // 현재 사용 카페인 원두명
  currentDecaf: string;      // 현재 사용 디카페인 원두명
  caffeineFlavor?: string;   // 선호 향/맛 ('산미' | '단맛' | '고소함' | '묵직함' | '') [NEW]
  decafFlavor?: string;      // 선호 향/맛 ('산미' | '단맛' | '고소함' | '묵직함' | '') [NEW]
  notes: BeanNote[];         // 체험 노트 목록
}

const STORAGE_KEY = 'simplem:bean_notepad';
const today = () => new Date().toISOString().split('T')[0];

// 🎚️ 양옆으로 부드럽게 드래그되는 제스처 기반의 커스냅 슬라이더 컴포넌트 [NEW]
interface CurationSliderProps {
  label: string;
  value: 'any' | 'low' | 'medium' | 'high';
  onChange: (val: 'any' | 'low' | 'medium' | 'high') => void;
}

const CurationSlider: React.FC<CurationSliderProps> = ({ label, value, onChange }) => {
  // [한글 주석: 슬라이더 1단계 라벨을 '상관없음'에서 '없음'으로 변경하여 텍스트 잘림 방지]
  const steps = [
    { key: 'any', label: '없음' },
    { key: 'low', label: '낮음' },
    { key: 'medium', label: '중간' },
    { key: 'high', label: '높음' }
  ] as const;

  const activeIndex = steps.findIndex(s => s.key === value);
  const staticPercent = (activeIndex / (steps.length - 1)) * 100;

  // 드래그 중인 실시간 좌표 비율 (0~100)
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const trackWidthRef = useRef<number>(0);
  const startPercentRef = useRef<number>(0);

  // X 좌표 비율 연산 헬퍼 (최초 클릭 및 터치 좌표용)
  const getPercentFromX = (x: number) => {
    const width = trackWidthRef.current || 1;
    const usableWidth = width - 20; // 좌우 10px씩 제외한 활성 영역
    let localX = x - 10;
    if (localX < 0) localX = 0;
    if (localX > usableWidth) localX = usableWidth;
    return (localX / usableWidth) * 100;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        // 드래그 시작 시점의 가로 백분율 기억
        const initialTouchX = evt.nativeEvent.locationX;
        const initialPercent = getPercentFromX(initialTouchX);
        startPercentRef.current = initialPercent;
        setDragPercent(initialPercent);
      },
      onPanResponderMove: (evt, gestureState) => {
        const width = trackWidthRef.current || 1;
        const usableWidth = width - 20;
        // 드래그 변위(dx)를 가로폭 비율로 환산해서 시작 지점에 더해줌
        const deltaPercent = (gestureState.dx / usableWidth) * 100;
        let nextPercent = startPercentRef.current + deltaPercent;
        if (nextPercent < 0) nextPercent = 0;
        if (nextPercent > 100) nextPercent = 100;
        setDragPercent(nextPercent);
      },
      onPanResponderRelease: (evt, gestureState) => {
        const width = trackWidthRef.current || 1;
        const usableWidth = width - 20;
        const deltaPercent = (gestureState.dx / usableWidth) * 100;
        let finalPercent = startPercentRef.current + deltaPercent;
        if (finalPercent < 0) finalPercent = 0;
        if (finalPercent > 100) finalPercent = 100;

        // 가장 가까운 4분할 눈금으로 스냅
        const ratio = finalPercent / 100;
        const exactIndex = ratio * (steps.length - 1);
        const snappedIndex = Math.round(exactIndex);
        const snappedStep = steps[snappedIndex].key;

        setDragPercent(null);
        onChange(snappedStep);
      },
      onPanResponderTerminate: () => {
        setDragPercent(null);
      }
    })
  ).current;

  const displayPercent = dragPercent !== null ? dragPercent : staticPercent;
  const currentHoverIndex = dragPercent !== null
    ? Math.round((dragPercent / 100) * (steps.length - 1))
    : activeIndex;

  const trackWidth = trackWidthRef.current || 200;
  const activeBarWidth = (displayPercent / 100) * (trackWidth - 20);
  const thumbLeftPosition = 10 + (displayPercent / 100) * (trackWidth - 20);

  return (
    <View style={[styles.sliderContainer, { userSelect: 'none' } as any]}>
      {/* 슬라이더 라벨과 현재 값 표시 */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <Text style={styles.sliderLabel}>{label}</Text>
        <Text style={styles.sliderActiveVal}>
          {steps[currentHoverIndex].label}
        </Text>
      </View>

      {/* 드래그를 감지할 트랙 영역 (패딩 및 높이 확장하여 클릭 면적 극대화) */}
      <View
        style={styles.sliderTrackWrapper}
        onLayout={(e) => {
          trackWidthRef.current = e.nativeEvent.layout.width;
        }}
        {...panResponder.panHandlers}
      >
        {/* 비활성 베이스 트랙 라인 */}
        <View style={styles.sliderTrackBase} pointerEvents="none" />

        {/* 활성 컬러 게이지 라인 */}
        <View
          style={[
            styles.sliderTrackActive,
            { width: activeBarWidth }
          ]}
          pointerEvents="none"
        />

        {/* 4개의 가이드 스냅 점 */}
        <View style={styles.sliderNodesRow} pointerEvents="none">
          {steps.map((step, idx) => {
            const isActive = idx <= (dragPercent !== null ? (dragPercent / 100) * (steps.length - 1) : activeIndex);
            return (
              <View
                key={step.key}
                style={[
                  styles.sliderNodeDot,
                  isActive && styles.sliderNodeDotActive
                ]}
              />
            );
          })}
        </View>

        {/* 드래그 및 스냅되어 따라오는 Thumb 핸들 */}
        <View
          style={[
            styles.sliderNodeThumbAbsolute,
            { left: thumbLeftPosition }
          ]}
          pointerEvents="none"
        />
      </View>

      {/* 라벨 텍스트들을 트랙 아래에 별도 그리드로 분리하여 클릭 간섭 원천 차단 */}
      <View style={styles.sliderLabelsGrid} pointerEvents="none">
        {steps.map((step, idx) => {
          const isThumb = idx === currentHoverIndex;
          return (
            <Text
              key={step.key}
              style={[
                styles.sliderNodeLabel,
                isThumb && styles.sliderNodeLabelSelected
              ]}
            >
              {step.label}
            </Text>
          );
        })}
      </View>
    </View>
  );
};

export default function BeanNotepad() {
  const [data, setData] = useState<NotepadData>({
    currentCaffeine: '',
    currentDecaf: '',
    caffeineFlavor: '',
    decafFlavor: '',
    notes: [],
  });

  // 로스터리 전체 원두 목록 (큐레이션 필터 검색용)
  const [roasteryBeans, setRoasteryBeans] = useState<RoasteryBean[]>([]);

  // 📡 매장 IoT 센서 실시간 상태 (5초 폴링) + AI 발주 코치 (60초 폴링)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [sensor, setSensor] = useState<SensorLive | null>(null);
  const [coachItems, setCoachItems] = useState<SensorRecommendation[]>([]);
  const [coachUpdatedAt, setCoachUpdatedAt] = useState<string | null>(null);

  // 🔌 센서 스테이션(페어링 마법사) 모달 상태
  const [showSensorSetup, setShowSensorSetup] = useState(false);
  const [setupInitialDevice, setSetupInitialDevice] = useState<string | null>(null);

  // 🎛️ 센서 기능 매장별 ON/OFF — false면 라이브·데모 배너·코치 알림 전부 숨김 (센서 없는 카페용)
  // null = 서버 응답 전 (이때는 조용히 '연결 중' 상태만 표시)
  const [sensorFeatureOn, setSensorFeatureOn] = useState<boolean | null>(null);

  const toggleSensorFeature = (next: boolean) => {
    setSensorFeatureOn(next);
    if (!next) {
      // 즉시 화면에서 라이브 요소·알림 제거
      setSensor(null);
      setCoachItems([]);
      setShowSensorSetup(false);
    }
    if (authToken) {
      setSensorFeature(authToken, next)
        .then(() => {
          if (next) refreshAfterPairing();
        })
        .catch(() => {});
    }
  };

  const openSensorSetup = (deviceId: string | null = null) => {
    setSetupInitialDevice(deviceId);
    setShowSensorSetup(true);
  };

  // 페어링이 바뀌면 다음 5초 폴링을 기다리지 않고 즉시 라이브/코치 갱신
  const refreshAfterPairing = () => {
    if (!authToken) return;
    getSensorLive(authToken).then(setSensor).catch(() => {});
    getSensorRecommendations(authToken)
      .then((res) => {
        setCoachItems(res.items);
        setCoachUpdatedAt(res.generated_at);
      })
      .catch(() => {});
  };

  // 취향 추천 모달 및 질문 상태들
  const [showSurveyModal, setShowSurveyModal] = useState(false);
  const [surveyDecaf, setSurveyDecaf] = useState<'any' | 'normal' | 'decaf'>('any'); // 카페인
  const [surveyRoast, setSurveyRoast] = useState<'any' | 'light' | 'medium' | 'medium-dark' | 'dark'>('any'); // 로스팅 정도
  const [surveyAcidity, setSurveyAcidity] = useState<'any' | 'low' | 'medium' | 'high'>('any'); // 산미
  const [surveyBody, setSurveyBody] = useState<'any' | 'low' | 'medium' | 'high'>('any'); // 바디감
  const [surveySweetness, setSurveySweetness] = useState<'any' | 'low' | 'medium' | 'high'>('any'); // 단맛
  const [surveyBitterness, setSurveyBitterness] = useState<'any' | 'low' | 'medium' | 'high'>('any'); // 쓴맛
  const [surveyProcess, setSurveyProcess] = useState<'any' | 'washed' | 'natural' | 'honey' | 'anaerobic'>('any'); // 가공방식
  const [surveyOrigin, setSurveyOrigin] = useState<'any' | 'ethiopia' | 'colombia' | 'brazil' | 'kenya'>('any'); // 원산지

  // 추천 결과 상태
  interface SurveyResultItem {
    bean: RoasteryBean;
    score: number;
    matchRate: number;
    matchedReasons: string[];
  }
  const [surveyResult, setSurveyResult] = useState<SurveyResultItem[]>([]);
  const [hasSearchedSurvey, setHasSearchedSurvey] = useState(false);

  // 아코디언 상태: 현재 메모가 열린 원두의 ID를 저장합니다. (기본적으로 모두 접힌 상태)
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);

  // 모달 상태
  const [showCurrentEdit, setShowCurrentEdit] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [editingNote, setEditingNote] = useState<BeanNote | null>(null);

  // 현재 사용 원두 편집 임시값 (이모지 없이 텍스트만)
  const [tempCaffeine, setTempCaffeine] = useState('');
  const [tempDecaf, setTempDecaf] = useState('');

  // 노트 편집 임시값 (구분 status 제거, 이모지 없음)
  const [tempName, setTempName] = useState('');
  const [tempMemo, setTempMemo] = useState('');
  const [tempUsageCount, setTempUsageCount] = useState(1);

  // AsyncStorage 및 로스터리 원두 로드
  useEffect(() => {
    // 1. 메모장 데이터 불러오기
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try { setData(JSON.parse(raw)); } catch { }
      }
    });

    // 2. 추천 필터용 원두 데이터 불러오기
    const loadBeansData = async () => {
      try {
        const rawSession = await AsyncStorage.getItem('simplem:session');
        if (rawSession) {
          const session = JSON.parse(rawSession);
          const token = session?.token;
          if (token) {
            setAuthToken(token); // 센서 폴링 시작 트리거
            const list = await listRoasteryBeans(token, 40);
            setRoasteryBeans(list);
          }
        }
      } catch (err) {
        console.error('원두 목록 로딩 실패:', err);
      }
    };
    loadBeansData();
  }, []);

  // 📡 센서 라이브 5초 폴링 + AI 발주 코치 60초 폴링 (토큰 확보 후 시작)
  useEffect(() => {
    if (!authToken) return;
    let alive = true;

    const pollLive = async () => {
      try {
        const snap = await getSensorLive(authToken);
        if (!alive) return;
        if (snap.feature_enabled === false) {
          // 매장이 센서 기능을 꺼둔 상태 — 라이브 요소 전부 숨김
          setSensorFeatureOn(false);
          setSensor(null);
        } else {
          setSensorFeatureOn(true);
          setSensor(snap);
        }
      } catch {
        // 백엔드 미기동/네트워크 단절 시 '센서 연결 중' 상태로 강등
        if (alive) setSensor(null);
      }
    };
    const pollCoach = async () => {
      try {
        const res = await getSensorRecommendations(authToken);
        if (alive) {
          setCoachItems(res.feature_enabled === false ? [] : res.items);
          setCoachUpdatedAt(res.generated_at);
        }
      } catch {
        // 추천 실패는 조용히 무시 (다음 주기에 재시도)
      }
    };

    pollLive();
    pollCoach();
    const liveTimer = setInterval(pollLive, 5000);
    const coachTimer = setInterval(pollCoach, 60000);
    return () => {
      alive = false;
      clearInterval(liveTimer);
      clearInterval(coachTimer);
    };
  }, [authToken]);

  // 가상의 폴백 원두 (DB에 추천용 원두가 아직 없을 때를 위한 안정적인 예시 데이터)
  const MOCK_FALLBACK_BEANS: RoasteryBean[] = [
    {
      id: -101,
      name: '에티오피아 예가체프 G2 워시드',
      price: 13000,
      roastery_id: 1,
      thumbnail_url: null,
      product_url: 'https://smartstore.naver.com',
      date_added: null,
      best: true,
      new: false,
      sold_out: false,
      description: '은은한 꽃향기와 시트러스한 오렌지 계열의 화사한 산미, 홍차처럼 깔끔한 목넘김이 특징입니다.',
      country: '에티오피아',
      process: '워시드',
      blend: false,
      decaf: false,
      gesha: false,
      price_per_gram: null,
      naver_product_id: null,
      roastery: { id: 1, name: '심플엠 로스터스', thumbnail_url: null, roastery_info: null, file_path: null }
    },
    {
      id: -102,
      name: '디카페인 콜롬비아 수프리모',
      price: 14500,
      roastery_id: 1,
      thumbnail_url: null,
      product_url: 'https://smartstore.naver.com',
      date_added: null,
      best: true,
      new: false,
      sold_out: false,
      description: '카카오의 달콤 쌉싸름함과 고소한 구운 견과류의 밸런스가 좋은 깔끔한 디카페인 원두입니다.',
      country: '콜롬비아',
      process: '스위스 워터 가공',
      blend: false,
      decaf: true,
      gesha: false,
      price_per_gram: null,
      naver_product_id: null,
      roastery: { id: 1, name: '심플엠 로스터스', thumbnail_url: null, roastery_info: null, file_path: null }
    }
  ];

  // 사용자의 설문 선택 조건 매칭 알고리즘 함수
  const handleRunSurveyRecommendation = () => {
    // 만약 로딩된 원두가 없으면 가상의 폴백 원두 목록 사용
    const sourceBeans = roasteryBeans.length > 0 ? roasteryBeans : MOCK_FALLBACK_BEANS;
    const scoredList: SurveyResultItem[] = [];

    sourceBeans.forEach(bean => {
      let score = 0;
      let maxPossibleScore = 0;
      const reasons: string[] = [];

      // 1. 카페인 함량 매칭
      if (surveyDecaf !== 'any') {
        maxPossibleScore += 15;
        const isDecafTarget = surveyDecaf === 'decaf';
        if (bean.decaf === isDecafTarget) {
          score += 15;
          reasons.push(isDecafTarget ? '디카페인' : '일반 카페인');
        }
      }

      // 2. 원산지 매칭
      if (surveyOrigin !== 'any') {
        maxPossibleScore += 10;
        const countryMap: Record<string, string> = {
          ethiopia: '에티오피아',
          colombia: '콜롬비아',
          brazil: '브라질',
          kenya: '케냐'
        };
        const targetCountry = countryMap[surveyOrigin];
        if (bean.country && bean.country.includes(targetCountry)) {
          score += 10;
          reasons.push(`${targetCountry} 원산지`);
        }
      }

      // 3. 가공 방식 매칭
      if (surveyProcess !== 'any') {
        maxPossibleScore += 8;
        const processKeywords: Record<string, string[]> = {
          washed: ['워시드', 'washed'],
          natural: ['내추럴', 'natural'],
          honey: ['허니', 'honey'],
          anaerobic: ['무산소', '애너로빅', 'anaerobic']
        };
        const keywords = processKeywords[surveyProcess];
        const isMatch = keywords.some(k => (bean.process || '').toLowerCase().includes(k));
        if (isMatch) {
          score += 8;
          reasons.push(`${surveyProcess.toUpperCase()} 가공`);
        }
      }

      const desc = (bean.description || '').toLowerCase();
      const name = (bean.name || '').toLowerCase();

      // 4. 로스팅 정도 매칭
      if (surveyRoast !== 'any') {
        maxPossibleScore += 10;
        const roastKeywords: Record<string, string[]> = {
          light: ['라이트', '약배전', 'light'],
          medium: ['미디엄', '중배전', 'medium'],
          'medium-dark': ['미디엄 다크', '중강배전', 'medium dark'],
          dark: ['다크', '강배전', 'dark']
        };
        const keywords = roastKeywords[surveyRoast];
        const isMatch = keywords.some(k => name.includes(k) || desc.includes(k));
        if (isMatch) {
          score += 10;
          reasons.push(`${surveyRoast === 'medium-dark' ? '미디엄 다크' : surveyRoast.toUpperCase()} 로스팅`);
        }
      }

      // 5. 산미 정도
      if (surveyAcidity !== 'any') {
        maxPossibleScore += 8;
        const hasAcidity = desc.includes('산미') || desc.includes('신맛') || desc.includes('플로럴') || desc.includes('꽃향') || desc.includes('과일') || desc.includes('베리') || desc.includes('acidity');
        if (surveyAcidity === 'high' && hasAcidity) {
          score += 8; reasons.push('화사한 산미');
        } else if (surveyAcidity === 'medium' && hasAcidity && !desc.includes('강한 산미')) {
          score += 8; reasons.push('은은한 산미');
        } else if (surveyAcidity === 'low' && (!hasAcidity || desc.includes('산미가 적은') || desc.includes('부드러운'))) {
          score += 8; reasons.push('부드럽고 낮은 산미');
        }
      }

      // 6. 바디감
      if (surveyBody !== 'any') {
        maxPossibleScore += 8;
        const isHeavy = desc.includes('묵직') || desc.includes('바디') || desc.includes('heavy') || desc.includes('중후') || desc.includes('다크');
        const isLight = desc.includes('가벼') || desc.includes('깔끔') || desc.includes('클린') || desc.includes('clean') || desc.includes('light');
        if (surveyBody === 'high' && isHeavy) {
          score += 8; reasons.push('묵직한 바디감');
        } else if (surveyBody === 'medium' && !isHeavy && !isLight) {
          score += 8; reasons.push('중간 바디감');
        } else if (surveyBody === 'low' && isLight) {
          score += 8; reasons.push('가볍고 깔끔한 바디');
        }
      }

      // 7. 단맛
      if (surveySweetness !== 'any') {
        maxPossibleScore += 8;
        const hasSweet = desc.includes('단맛') || desc.includes('달콤') || desc.includes('캐러멜') || desc.includes('꿀') || desc.includes('sweet');
        if (surveySweetness === 'high' && hasSweet) {
          score += 8; reasons.push('달콤한 단맛');
        } else if (surveySweetness === 'medium' && hasSweet) {
          score += 8; reasons.push('적당한 단맛');
        } else if (surveySweetness === 'low' && !hasSweet) {
          score += 6; reasons.push('깔끔함');
        }
      }

      // 8. 쓴맛
      if (surveyBitterness !== 'any') {
        maxPossibleScore += 8;
        const hasBitter = desc.includes('쓴맛') || desc.includes('씁쓸') || desc.includes('쌉싸름') || desc.includes('스모키') || desc.includes('다크') || desc.includes('bitter');
        if (surveyBitterness === 'high' && hasBitter) {
          score += 8; reasons.push('쌉싸름한 쓴맛');
        } else if (surveyBitterness === 'medium' && hasBitter) {
          score += 8; reasons.push('적당한 쌉싸름함');
        } else if (surveyBitterness === 'low' && !hasBitter) {
          score += 8; reasons.push('쓴맛이 덜함');
        }
      }

      // 최소 가능 점수가 없으면 매칭 점수는 100%
      const matchRate = maxPossibleScore > 0 ? Math.round((Math.max(0, score) / maxPossibleScore) * 100) : 100;

      scoredList.push({
        bean,
        score,
        matchRate,
        matchedReasons: reasons
      });
    });

    // 높은 일치율 순으로 정렬
    scoredList.sort((a, b) => b.matchRate - a.matchRate);

    // 점수가 0 이상이거나 상위 3개까지 선택
    const topMatches = scoredList.filter(item => item.score >= 0).slice(0, 3);
    setSurveyResult(topMatches);
    setHasSearchedSurvey(true);
  };




  // AsyncStorage에 저장하는 헬퍼
  const save = (next: NotepadData) => {
    setData(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };


  // ── 현재 사용 원두 저장 ──
  const saveCurrentBeans = () => {
    save({
      ...data,
      currentCaffeine: tempCaffeine.trim(),
      currentDecaf: tempDecaf.trim(),
    });
    // 호퍼 RFID 태그에도 원두명 재기록 → 다음 폴링부터 센서 응답에 반영됨
    if (authToken) {
      setSensorBeans(authToken, {
        caffeine: tempCaffeine.trim(),
        decaf: tempDecaf.trim(),
      })
        .then(() => getSensorLive(authToken).then(setSensor).catch(() => {}))
        .catch(() => {});
    }
    setShowCurrentEdit(false);
  };

  const openCurrentEdit = () => {
    setTempCaffeine(data.currentCaffeine);
    setTempDecaf(data.currentDecaf);
    setShowCurrentEdit(true);
  };

  // ── 노트 추가/수정 ──
  const openAddNote = () => {
    setEditingNote(null);
    setTempName(''); setTempMemo('');
    setTempUsageCount(1);
    setShowNoteModal(true);
  };

  const openEditNote = (note: BeanNote) => {
    setEditingNote(note);
    setTempName(note.name);
    setTempMemo(note.memo);
    setTempUsageCount(note.usageCount || 1);
    setShowNoteModal(true);
  };

  const saveNote = () => {
    if (!tempName.trim()) return;
    if (editingNote) {
      // 수정
      const updated = data.notes.map((n) =>
        n.id === editingNote.id
          ? {
            ...n,
            name: tempName.trim(),
            memo: tempMemo.trim(),
            usageCount: tempUsageCount,
          }
          : n
      );
      save({ ...data, notes: updated });
    } else {
      // 추가
      const newNote: BeanNote = {
        id: Date.now().toString(),
        name: tempName.trim(),
        memo: tempMemo.trim(),
        date: today(),
        usageCount: tempUsageCount,
      };
      save({ ...data, notes: [newNote, ...data.notes] });
    }
    setShowNoteModal(false);
  };

  const deleteNote = (id: string) => {
    const doDelete = () => {
      if (expandedNoteId === id) setExpandedNoteId(null);
      save({ ...data, notes: data.notes.filter((n) => n.id !== id) });
    };

    if (Platform.OS === 'web') {
      if (window.confirm('이 노트를 삭제하시겠습니까?')) {
        doDelete();
      }
    } else {
      Alert.alert('삭제', '이 노트를 삭제할까요?', [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  // ─── 렌더링 ────────────────────────────────────────────────────────────
  // 센서(RFID) 원두명이 있으면 우선, 없으면 로컬 메모 값으로 폴백
  const cafHopper = sensor?.hoppers.caffeine ?? null;
  const decafHopper = sensor?.hoppers.decaf ?? null;
  const cafDisplayName = sensor?.rfid.caffeine_bean || data.currentCaffeine;
  const decafDisplayName = sensor?.rfid.decaf_bean || data.currentDecaf;

  // 호퍼 잔량 게이지 색: 20% 이하 빨강, 40% 이하 주황, 그 외 브라운
  const gaugeColor = (percent: number, base: string) =>
    percent <= 20 ? '#C0392B' : percent <= 40 ? '#D97706' : base;

  // 카페인/디카페인 공용 행 렌더러 (센서 연동 시 게이지·샷 수·소진 예상까지 표시)
  // isLive=false면 게이지 옆에 '데모' 태그를 붙여 실측이 아님을 정직하게 보여준다.
  const renderHopperRow = (
    label: string,
    icon: 'cafe' | 'cafe-outline',
    iconColor: string,
    name: string,
    hopperState: typeof cafHopper,
    barBaseColor: string,
    tagId?: string,
    isLive?: boolean,
  ) => (
    <View style={styles.currentRow}>
      <View style={styles.currentLabel}>
        <Ionicons name={icon} size={14} color={iconColor} />
        <Text style={styles.currentLabelText}>{label}</Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={[styles.currentValue, !name && styles.currentEmpty]} numberOfLines={1}>
            {name || (hopperState ? '원두명 미지정 — 수정에서 입력' : '아직 입력하지 않았어요')}
          </Text>
          {hopperState ? (
            <View style={liveComponentStyles.shotBadge}>
              <Text style={liveComponentStyles.shotBadgeText}>오늘 {hopperState.shots_today}잔 추출</Text>
            </View>
          ) : null}
        </View>

        {/* [한글 주석: 무게센서(로드셀) 실측 기반 호퍼 잔량 게이지] */}
        {hopperState ? (
          <>
            <View style={liveComponentStyles.gaugeRow}>
              <View style={liveComponentStyles.gaugeTrack}>
                <View
                  style={[
                    liveComponentStyles.gaugeFill,
                    {
                      width: `${Math.min(100, Math.max(2, hopperState.percent))}%`,
                      backgroundColor: gaugeColor(hopperState.percent, barBaseColor),
                    },
                  ]}
                />
              </View>
              <Text style={liveComponentStyles.gaugeText}>
                호퍼 {hopperState.percent}% ({(hopperState.remaining_g / 1000).toFixed(1)}kg)
              </Text>
              {isLive === false ? (
                <TouchableOpacity style={liveComponentStyles.demoTag} onPress={() => openSensorSetup('bean_scale')}>
                  <Text style={liveComponentStyles.demoTagText}>데모</Text>
                </TouchableOpacity>
              ) : isLive ? (
                <View style={liveComponentStyles.liveTag}>
                  <Text style={liveComponentStyles.liveTagText}>실측</Text>
                </View>
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {tagId ? (
                <Text style={liveComponentStyles.rfidTagText}>{tagId}</Text>
              ) : null}
              {hopperState.depletion_at ? (
                <Text style={liveComponentStyles.depletionText}>
                  현재 페이스면 {hopperState.depletion_at}경 재장전 필요
                </Text>
              ) : hopperState.refills_today > 0 ? (
                <Text style={liveComponentStyles.depletionText}>
                  오늘 재장전 {hopperState.refills_today}회 감지
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.wrapper}>

      {/* ━━━ 현재 사용 중인 원두 카드 (실시간 라이브 대시보드) ━━━ */}
      <View style={styles.card}>
        {/* [한글 주석: /sensor/live events 피드를 롤링하는 실시간 틱커 — 기능 OFF 매장은 숨김] */}
        {sensorFeatureOn !== false && <LiveTickerBanner messages={sensor?.events} />}

        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>현재 사용 중인 원두</Text>
            {/* [한글 주석: 회색=서버 미응답 / 주황=센서 0개(데모) / 초록=LIVE — 기능 OFF면 배지 자체를 숨김] */}
            {sensorFeatureOn !== false && (
              <LivePulseBadge
                variant={!sensor ? 'connecting' : sensor.pairing?.demo_mode ? 'demo' : 'live'}
                label={
                  sensor?.pairing && !sensor.pairing.demo_mode && sensor.pairing.paired_count < sensor.pairing.total
                    ? `LIVE · 센서 ${sensor.pairing.paired_count}/${sensor.pairing.total}`
                    : undefined
                }
              />
            )}
          </View>
          <TouchableOpacity style={styles.editBtn} onPress={openCurrentEdit}>
            <Ionicons name="pencil-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.editBtnText}>수정</Text>
          </TouchableOpacity>
        </View>

        {/* 🔌 센서 연동 유도 배너 — 데모 모드면 큰 배너, 부분 연결이면 얇은 진행 줄 */}
        {sensor?.pairing?.demo_mode ? (
          <TouchableOpacity
            style={liveComponentStyles.demoBanner}
            onPress={() => openSensorSetup(null)}
            activeOpacity={0.8}
          >
            <Ionicons name="hardware-chip-outline" size={18} color="#B45309" />
            <View style={{ flex: 1 }}>
              <Text style={liveComponentStyles.demoBannerTitle}>지금 수치는 가상 데모예요</Text>
              <Text style={liveComponentStyles.demoBannerDesc}>
                무게·온도 센서를 연결하면 내 매장 실측값으로 바뀌어요
              </Text>
            </View>
            <View style={liveComponentStyles.demoBannerCta}>
              <Text style={liveComponentStyles.demoBannerCtaText}>센서 연결</Text>
              <Ionicons name="chevron-forward" size={11} color={colors.white} />
            </View>
          </TouchableOpacity>
        ) : sensor?.pairing && sensor.pairing.paired_count < sensor.pairing.total ? (
          <TouchableOpacity
            style={liveComponentStyles.partialRow}
            onPress={() => openSensorSetup(null)}
            activeOpacity={0.7}
          >
            <Text style={liveComponentStyles.partialRowText}>
              🧩 센서 {sensor.pairing.paired_count}/{sensor.pairing.total} 연결됨 — 나머지도 연결하고 전 지표 실측 만들기
            </Text>
            <Ionicons name="chevron-forward" size={12} color={colors.mochaBrown} />
          </TouchableOpacity>
        ) : null}

        {renderHopperRow(
          '카페인', 'cafe', colors.espressoBrown,
          cafDisplayName, cafHopper, colors.espressoBrown,
          sensor?.live_metrics?.rfid ? sensor.rfid.caffeine_tag : undefined,
          sensor ? !!sensor.live_metrics?.hoppers : undefined,
        )}

        <View style={styles.divider} />

        {renderHopperRow(
          '디카페인', 'cafe-outline', colors.mochaBrown,
          decafDisplayName, decafHopper, colors.mochaBrown,
          sensor?.live_metrics?.rfid ? sensor.rfid.decaf_tag : undefined,
          sensor ? !!sensor.live_metrics?.hoppers : undefined,
        )}

        {/* 🛠️ 매장 설비 미니 상태 스트립 — 미연결 센서는 점선 칩, 탭하면 해당 페어링 가이드로 */}
        {sensor ? (
          <View style={liveComponentStyles.equipStrip}>
            {([
              {
                metric: 'machine' as const,
                icon: sensor.machine.status === 'extracting' ? 'flash' : 'flash-outline',
                alert: false,
                text:
                  sensor.machine.status === 'extracting'
                    ? `추출 중${sensor.machine.current_menu ? ` · ${sensor.machine.current_menu}` : ''}`
                    : sensor.machine.status === 'idle' ? '머신 대기' : '영업 전',
                activeColor: sensor.machine.status === 'extracting' ? '#D97706' : colors.mochaBrown,
              },
              {
                metric: 'milk' as const,
                icon: 'water-outline',
                alert: sensor.milk.percent <= 25,
                text: `우유 ${(sensor.milk.remaining_ml / 1000).toFixed(1)}L`,
                activeColor: colors.mochaBrown,
              },
              {
                metric: 'water' as const,
                icon: 'filter-outline',
                alert: !sensor.water.ok,
                text: `정수 ${sensor.water.percent}%`,
                activeColor: colors.mochaBrown,
              },
              {
                metric: 'fridge' as const,
                icon: 'thermometer-outline',
                alert: !sensor.fridge.ok,
                text: `냉장 ${sensor.fridge.temp_c}℃`,
                activeColor: colors.mochaBrown,
              },
            ]).map((chip) => {
              const isLive = !!sensor.live_metrics?.[chip.metric];
              const color = chip.alert ? '#C0392B' : isLive ? chip.activeColor : '#A8A29E';
              return (
                <TouchableOpacity
                  key={chip.metric}
                  style={[liveComponentStyles.equipChip, !isLive && liveComponentStyles.equipChipDemo]}
                  onPress={() => openSensorSetup(METRIC_TO_DEVICE[chip.metric])}
                  activeOpacity={0.7}
                >
                  <Ionicons name={chip.icon as any} size={11} color={color} />
                  <Text
                    style={[
                      liveComponentStyles.equipChipText,
                      chip.alert && liveComponentStyles.equipAlertText,
                      !isLive && !chip.alert && liveComponentStyles.equipChipTextDemo,
                    ]}
                  >
                    {chip.text}
                  </Text>
                  {!isLive && (
                    <Ionicons name="add-circle-outline" size={10} color="#A8A29E" />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        {/* ☕ 나만의 원두 취향 큐레이션 추천 탐색기 버튼 [NEW] */}
        <View style={styles.curationBtnWrapper}>
          <TouchableOpacity
            style={styles.curationBtn}
            onPress={() => {
              // 큐레이션 필터 값 리셋 후 모달 열기
              setSurveyDecaf('any');
              setSurveyRoast('any');
              setSurveyAcidity('any');
              setSurveyBody('any');
              setSurveySweetness('any');
              setSurveyBitterness('any');
              setSurveyProcess('any');
              setSurveyOrigin('any');
              setSurveyResult([]);
              setHasSearchedSurvey(false);
              setShowSurveyModal(true);
            }}
            activeOpacity={0.8}
          >
            <Ionicons name="compass-outline" size={16} color={colors.white} />
            <Text style={styles.curationBtnText}>취향 맞춤 로스터리 원두 추천받기</Text>
          </TouchableOpacity>
        </View>
      </View>


      {/* ━━━ AI 발주 코치 카드 (센서+판매 데이터 근거 기반 추천) ━━━ */}
      {coachItems.length > 0 && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="sparkles" size={15} color={colors.espressoBrown} />
              <Text style={styles.cardTitle}>AI 발주 코치</Text>
            </View>
            {coachUpdatedAt ? (
              <Text style={coachStyles.updatedAt}>
                {new Date(coachUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준
              </Text>
            ) : null}
          </View>

          <View style={{ gap: 8 }}>
            {coachItems.map((item, idx) => {
              const barColor =
                item.priority === 'urgent' ? '#C0392B'
                  : item.priority === 'warn' ? '#D97706'
                    : colors.mochaBrown;
              const priorityLabel =
                item.priority === 'urgent' ? '긴급' : item.priority === 'warn' ? '주의' : '참고';
              return (
                <View key={idx} style={coachStyles.item}>
                  <View style={[coachStyles.bar, { backgroundColor: barColor }]} />
                  <View style={coachStyles.body}>
                    <View style={coachStyles.titleRow}>
                      <View style={[coachStyles.priorityChip, { backgroundColor: `${barColor}18`, borderColor: `${barColor}44` }]}>
                        <Text style={[coachStyles.priorityChipText, { color: barColor }]}>{priorityLabel}</Text>
                      </View>
                      <Text style={coachStyles.title} numberOfLines={2}>{item.title}</Text>
                    </View>

                    {/* 근거 수치 — 사장님이 "왜?"를 바로 알 수 있게 */}
                    <Text style={coachStyles.reason}>{item.reason}</Text>

                    {/* 실행 액션 — 지금 뭘 하면 되는지 */}
                    <View style={coachStyles.actionRow}>
                      <Ionicons name="arrow-forward-circle" size={13} color={colors.espressoBrown} />
                      <Text style={coachStyles.actionText}>{item.action}</Text>
                    </View>

                    <Text style={coachStyles.source}>근거: {item.source}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* ━━━ 원두 체험 노트 카드 ━━━ */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>원두 체험 노트</Text>
          </View>
          <TouchableOpacity style={styles.addBtn} onPress={openAddNote}>
            <Ionicons name="add" size={15} color={colors.white} />
            <Text style={styles.addBtnText}>추가</Text>
          </TouchableOpacity>
        </View>

        {data.notes.length === 0 ? (
          <View style={styles.emptyNote}>
            <Ionicons name="document-text-outline" size={28} color={colors.stone300} />
            <Text style={styles.emptyNoteText}>
              발주해본 원두나 써본 원두를 기록해 보세요
            </Text>
          </View>
        ) : (
          <View style={styles.noteList}>
            {[...data.notes]
              .sort((a, b) => {
                const cntA = a.usageCount || 0;
                const cntB = b.usageCount || 0;
                if (cntB !== cntA) return cntB - cntA; // 사용 횟수 많은 순 정렬
                return b.id.localeCompare(a.id); // 2차: 등록 최신 순
              })
              .map((note) => {
                const isExpanded = expandedNoteId === note.id;
                return (
                  <View key={note.id} style={styles.noteItem}>
                    {/* 왼쪽 구분 바 */}
                    <View style={[styles.noteBar, { backgroundColor: colors.mochaBrown }]} />

                    <View style={styles.noteContent}>
                      {/* 상단 줄: 원두명 클릭 가능 영역 + 횟수 + 아이콘 */}
                      <View style={styles.noteTopRow}>
                        <TouchableOpacity
                          style={styles.noteNamePressable}
                          onPress={() => setExpandedNoteId(isExpanded ? null : note.id)}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.noteName} numberOfLines={1}>{note.name}</Text>

                          {/* 사용 횟수 태그 (이모지 없음) */}
                          <View style={styles.countBadge}>
                            <Text style={styles.countBadgeText}>{note.usageCount || 1}회 주문</Text>
                          </View>

                          <Ionicons
                            name={isExpanded ? 'chevron-up' : 'chevron-down'}
                            size={12}
                            color={colors.stone300}
                          />
                        </TouchableOpacity>

                        {/* 조작 버튼그룹 */}
                        <View style={styles.actionGroup}>
                          <TouchableOpacity
                            onPress={() => openEditNote(note)}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Ionicons name="create-outline" size={14} color={colors.mochaBrown} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => deleteNote(note.id)}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Ionicons name="trash-outline" size={14} color="#C07070" />
                          </TouchableOpacity>
                        </View>
                      </View>

                      {/* 메모 영역 (클릭 시 아코디언 토글 노출) */}
                      {isExpanded && (
                        <View style={styles.memoBox}>
                          {note.memo ? (
                            <Text style={styles.noteMemo}>{note.memo}</Text>
                          ) : (
                            <Text style={styles.noteMemoEmpty}>작성된 내용이 없습니다.</Text>
                          )}
                          <View style={styles.memoFooter}>
                            <Text style={styles.noteDate}>{note.date.replace(/-/g, '.')}</Text>
                          </View>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
          </View>
        )}
      </View>

      {/* ━━━ 현재 사용 원두 편집 모달 (이모지 없음) ━━━ */}
      <Modal visible={showCurrentEdit} transparent animationType="slide" onRequestClose={() => setShowCurrentEdit(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowCurrentEdit(false)} />
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>현재 사용 중인 원두 수정</Text>

            <Text style={modalStyles.label}>카페인 원두</Text>
            <TextInput
              style={modalStyles.input}
              value={tempCaffeine}
              onChangeText={setTempCaffeine}
              placeholder="예: 에티오피아 구지 내추럴"
              placeholderTextColor={colors.stone300}
            />

            <Text style={[modalStyles.label, { marginTop: 14 }]}>디카페인 원두</Text>
            <TextInput
              style={modalStyles.input}
              value={tempDecaf}
              onChangeText={setTempDecaf}
              placeholder="예: 콜롬비아 워시드 디카페인"
              placeholderTextColor={colors.stone300}
            />

            {/* 🎛️ 매장 센서 연동 ON/OFF — 센서 없는 카페는 끄면 라이브·데모 안내·코치 알림이 모두 사라짐 */}
            <View style={modalStyles.featureToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={[modalStyles.label, { marginBottom: 2 }]}>매장 센서 연동</Text>
                <Text style={modalStyles.featureToggleDesc}>
                  {sensorFeatureOn === false
                    ? '꺼짐 — 실시간 게이지·연동 안내가 표시되지 않아요'
                    : '켜짐 — 센서 실시간 게이지와 AI 발주 코치를 사용해요'}
                </Text>
              </View>
              <Switch
                value={sensorFeatureOn !== false}
                onValueChange={toggleSensorFeature}
                trackColor={{ false: '#D6D3D1', true: colors.mochaBrown }}
                thumbColor={colors.white}
              />
            </View>

            <TouchableOpacity
              style={[modalStyles.saveBtn, !tempCaffeine.trim() && !tempDecaf.trim() && { opacity: 0.5 }]}
              onPress={saveCurrentBeans}
            >
              <Text style={modalStyles.saveBtnText}>저장하기</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ━━━ 원두 노트 추가/수정 모달 (이모지 및 status 배지 완전 배제) ━━━ */}
      <Modal visible={showNoteModal} transparent animationType="slide" onRequestClose={() => setShowNoteModal(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowNoteModal(false)} />
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>{editingNote ? '노트 수정' : '원두 노트 추가'}</Text>

            <Text style={modalStyles.label}>원두 이름 *</Text>
            <TextInput
              style={modalStyles.input}
              value={tempName}
              onChangeText={setTempName}
              placeholder="예: 타팟 에티오피아 구지"
              placeholderTextColor={colors.stone300}
            />

            {/* 사용 횟수 카운터 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>주문 횟수</Text>
            <View style={modalStyles.counterRow}>
              <TouchableOpacity
                style={modalStyles.counterBtn}
                onPress={() => setTempUsageCount(Math.max(1, tempUsageCount - 1))}
              >
                <Ionicons name="remove" size={16} color={colors.espressoBrown} />
              </TouchableOpacity>
              <Text style={modalStyles.counterVal}>{tempUsageCount}회</Text>
              <TouchableOpacity
                style={modalStyles.counterBtn}
                onPress={() => setTempUsageCount(tempUsageCount + 1)}
              >
                <Ionicons name="add" size={16} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            {/* 간단 메모 */}
            <Text style={[modalStyles.label, { marginTop: 14 }]}>간단 메모</Text>
            <TextInput
              style={[modalStyles.input, modalStyles.inputMulti]}
              value={tempMemo}
              onChangeText={setTempMemo}
              placeholder="특이사항이나 만족도를 자유롭게 메모하세요"
              placeholderTextColor={colors.stone300}
              multiline
              numberOfLines={3}
            />

            <TouchableOpacity
              style={[modalStyles.saveBtn, !tempName.trim() && { opacity: 0.4 }]}
              onPress={saveNote}
              disabled={!tempName.trim()}
            >
              <Text style={modalStyles.saveBtnText}>{editingNote ? '수정 완료' : '노트 추가'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* ━━━ 원두 취향 큐레이션 설문 & 추천 결과 모달 [NEW] ━━━ */}
      <Modal visible={showSurveyModal} transparent animationType="slide" onRequestClose={() => setShowSurveyModal(false)}>
        <View style={modalStyles.root}>
          <TouchableOpacity style={modalStyles.backdrop} onPress={() => setShowSurveyModal(false)} />
          <View style={[modalStyles.sheet, { maxHeight: '90%', paddingBottom: 24 }]}>
            <View style={modalStyles.handle} />

            {/* 헤더 */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="compass" size={18} color={colors.mochaBrown} />
                <Text style={[modalStyles.title, { marginBottom: 0, fontSize: 16 }]}>나만의 원두 취향 큐레이터</Text>
              </View>
              <TouchableOpacity onPress={() => setShowSurveyModal(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={20} color={colors.espressoBrown} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 10 }}>

              {/* 카페인 함량 */}
              <View style={styles.surveySection}>
                <Text style={styles.surveyLabel}>카페인 함량</Text>
                <View style={styles.chipRow}>
                  {([
                    { key: 'any', label: '상관없음' },
                    { key: 'normal', label: '일반 원두' },
                    { key: 'decaf', label: '디카페인' }
                  ] as const).map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.surveyChip, surveyDecaf === opt.key && styles.surveyChipActive]}
                      onPress={() => setSurveyDecaf(opt.key)}
                    >
                      <Text style={[styles.surveyChipText, surveyDecaf === opt.key && styles.surveyChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 원산지 */}
              <View style={styles.surveySection}>
                <Text style={styles.surveyLabel}>원산지 (Origin)</Text>
                <View style={styles.chipRow}>
                  {([
                    { key: 'any', label: '전체' },
                    { key: 'ethiopia', label: '에티오피아' },
                    { key: 'colombia', label: '콜롬비아' },
                    { key: 'brazil', label: '브라질' },
                    { key: 'kenya', label: '케냐' }
                  ] as const).map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.surveyChip, surveyOrigin === opt.key && styles.surveyChipActive]}
                      onPress={() => setSurveyOrigin(opt.key)}
                    >
                      <Text style={[styles.surveyChipText, surveyOrigin === opt.key && styles.surveyChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 가공 방식 */}
              <View style={styles.surveySection}>
                <Text style={styles.surveyLabel}>가공 방식 (Process)</Text>
                <View style={styles.chipRow}>
                  {([
                    { key: 'any', label: '전체' },
                    { key: 'washed', label: '워시드 (Washed)' },
                    { key: 'natural', label: '내추럴 (Natural)' },
                    { key: 'honey', label: '허니 (Honey)' },
                    { key: 'anaerobic', label: '애너로빅 (무산소)' }
                  ] as const).map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.surveyChip, surveyProcess === opt.key && styles.surveyChipActive]}
                      onPress={() => setSurveyProcess(opt.key)}
                    >
                      <Text style={[styles.surveyChipText, surveyProcess === opt.key && styles.surveyChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 로스팅 정도 */}
              <View style={styles.surveySection}>
                <Text style={styles.surveyLabel}>로스팅 정도 (Roast Level)</Text>
                <View style={styles.chipRow}>
                  {([
                    { key: 'any', label: '전체' },
                    { key: 'light', label: '라이트' },
                    { key: 'medium', label: '미디엄' },
                    { key: 'medium-dark', label: '미디엄 다크' },
                    { key: 'dark', label: '다크' }
                  ] as const).map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.surveyChip, surveyRoast === opt.key && styles.surveyChipActive]}
                      onPress={() => setSurveyRoast(opt.key)}
                    >
                      <Text style={[styles.surveyChipText, surveyRoast === opt.key && styles.surveyChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 맛 강도 조절 (Interactive Snap Sliders) */}
              <CurationSlider label="산미 (Acidity)" value={surveyAcidity} onChange={setSurveyAcidity} />
              <CurationSlider label="바디감 (Body)" value={surveyBody} onChange={setSurveyBody} />

              {/* 단맛 */}
              <CurationSlider label="단맛 (Sweetness)" value={surveySweetness} onChange={setSurveySweetness} />

              {/* 쓴맛 */}
              <CurationSlider label="쓴맛 (Bitterness)" value={surveyBitterness} onChange={setSurveyBitterness} />

              {/* 🔍 추천 실행 버튼 (한 화면 컴팩트 핏) */}
              <TouchableOpacity
                style={[modalStyles.saveBtn, { marginTop: 6, paddingVertical: 11, backgroundColor: colors.mochaBrown }]}
                onPress={handleRunSurveyRecommendation}
                activeOpacity={0.8}
              >
                <Text style={[modalStyles.saveBtnText, { fontSize: 13 }]}>취향 조건으로 로스터리 원두 찾기</Text>
              </TouchableOpacity>

              {/* 🎯 매칭 추천 결과 섹션 */}
              {hasSearchedSurvey && (
                <View style={styles.resultContainer}>
                  <View style={styles.resultHeader}>
                    <Ionicons name="sparkles" size={14} color={colors.espressoBrown} />
                    <Text style={styles.resultTitle}>취향 저격 로스터리 원두 추천</Text>
                  </View>

                  {surveyResult.length === 0 ? (
                    <View style={styles.emptyResult}>
                      <Text style={styles.emptyResultText}>
                        해당 취향 필터에 완벽하게 일치하는 원두가 현재 없습니다. 다른 옵션을 탭해 보세요!
                      </Text>
                    </View>
                  ) : (
                    <View style={{ gap: 12, marginTop: 8 }}>
                      {surveyResult.map(({ bean, matchRate, matchedReasons }, index) => (
                        <View key={bean.id} style={styles.resultCard}>
                          {/* 등수 & 일치율 헤더 */}
                          <View style={styles.resultCardHeader}>
                            <View style={styles.rankBadge}>
                              <Text style={styles.rankBadgeText}>{index + 1}순위</Text>
                            </View>
                            <View style={styles.matchRateBadge}>
                              <Text style={styles.matchRateBadgeText}>일치율 {matchRate}%</Text>
                            </View>
                          </View>

                          <Text style={styles.resultBeanName}>{bean.name}</Text>
                          <Text style={styles.resultBeanPrice}>
                            {bean.price ? `${bean.price.toLocaleString()}원` : '가격 정보 없음'}
                          </Text>

                          {/* 메타데이터 */}
                          <Text style={styles.resultBeanMeta}>
                            {bean.country || '원산지 미지정'} · {bean.process || '가공방식 미지정'} {bean.decaf ? '(디카페인)' : ''}
                          </Text>

                          {/* 쓴맛/산미 가이드에 근거한 매칭 칩 목록 */}
                          <View style={styles.resultTagRow}>
                            {matchedReasons.map((reason, i) => (
                              <View key={i} style={styles.resultTagChip}>
                                <Text style={styles.resultTagChipText}>{reason}</Text>
                              </View>
                            ))}
                          </View>

                          {bean.description && (
                            <Text style={styles.resultBeanDesc} numberOfLines={2}>
                              {bean.description.replace(/^매칭 조건:[^/]*\/\s*/, '')}
                            </Text>
                          )}

                          {bean.product_url ? (
                            <TouchableOpacity
                              style={styles.resultGoBtn}
                              onPress={() => Linking.openURL(bean.product_url!)}
                              activeOpacity={0.7}
                            >
                              <Text style={styles.resultGoText}>원두 보러가기</Text>
                              <Ionicons name="arrow-forward-outline" size={10} color={colors.white} />
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ━━━ 센서 스테이션 페어링 마법사 모달 ━━━ */}
      <SensorSetupModal
        visible={showSensorSetup}
        token={authToken}
        initialDeviceId={setupInitialDevice}
        onClose={() => setShowSensorSetup(false)}
        onPairingChanged={refreshAfterPairing}
        onDisableFeature={() => toggleSensorFeature(false)}
      />

    </View>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  wrapper: { gap: 10 },

  card: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 16,
    ...shadows.soft,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { ...typography.L3, color: colors.espressoBrown },

  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.coffeeCream,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
  },
  editBtnText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },

  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
  },
  addBtnText: { ...typography.L5, fontWeight: '700', color: colors.white },

  // 현재 사용 원두
  currentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  currentLabel: { flexDirection: 'row', alignItems: 'center', gap: 5, width: 64 },
  currentLabelText: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown },
  currentValue: { ...typography.L5, color: colors.espressoBrown, flex: 1, fontWeight: '600' },
  currentEmpty: { color: colors.stone300, fontWeight: '400', fontStyle: 'italic' },
  divider: { height: 1, backgroundColor: colors.coffeeCream, marginVertical: 2 },

  // 노트 목록
  emptyNote: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  emptyNoteText: { ...typography.L5, color: colors.stone300, textAlign: 'center', lineHeight: 18 },

  noteList: { gap: 10 },
  noteItem: {
    flexDirection: 'row',
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    overflow: 'hidden',
  },
  noteBar: { width: 4, flexShrink: 0 },
  noteContent: { flex: 1, padding: 12, gap: 5 },

  noteTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  noteNamePressable: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  noteName: { ...typography.L4, color: colors.espressoBrown, maxWidth: '60%', fontWeight: '700' },

  countBadge: {
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.mochaBrown,
  },

  actionGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  noteDate: { ...typography.L5, fontSize: 9, color: colors.stone300 },

  memoBox: {
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(140, 111, 86, 0.08)',
  },
  memoFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  noteMemo: {
    ...typography.L5,
    color: colors.espressoBrown,
    lineHeight: 16,
  },
  noteMemoEmpty: {
    ...typography.L5,
    color: colors.stone300,
  },

  // ☕ 큐레이팅 추천 탐색 버튼 스타일
  curationBtnWrapper: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.coffeeCream,
  },
  curationBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.mochaBrown,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  curationBtnText: {
    ...typography.L4,
    color: colors.white,
    fontWeight: '700',
  },

  // 📋 설문 폼 섹션 스타일 (한 화면 컴팩트 핏)
  surveySection: {
    marginBottom: 4,
  },
  surveyLabel: {
    ...typography.L5,
    fontSize: 11,
    fontWeight: '700',
    color: colors.espressoBrown,
    marginBottom: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  surveyChip: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  surveyChipActive: {
    backgroundColor: colors.espressoBrown,
    borderColor: colors.espressoBrown,
  },
  surveyChipText: {
    fontSize: 10,
    color: colors.mochaBrown,
    fontWeight: '600',
  },
  surveyChipTextActive: {
    color: colors.white,
    fontWeight: '700',
  },

  // 🎯 매칭 추천 결과 카드 영역 스타일
  resultContainer: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1.5,
    borderTopColor: colors.coffeeCream,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  resultTitle: {
    ...typography.L3,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  emptyResult: {
    backgroundColor: 'rgba(140, 111, 86, 0.04)',
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  emptyResultText: {
    ...typography.L5,
    color: colors.mochaBrown,
    textAlign: 'center',
    lineHeight: 18,
  },
  resultCard: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 16,
    padding: 14,
    gap: 6,
    ...shadows.soft,
  },
  resultCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  rankBadge: {
    backgroundColor: colors.espressoBrown,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  rankBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.white,
  },
  matchRateBadge: {
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  matchRateBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.mochaBrown,
  },
  resultBeanName: {
    ...typography.L3,
    fontSize: 15,
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  resultBeanPrice: {
    ...typography.L4,
    color: colors.mochaBrown,
    fontWeight: '700',
  },
  resultBeanMeta: {
    fontSize: 11,
    color: colors.stone300,
    fontWeight: '600',
  },
  resultTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginVertical: 4,
  },
  resultTagChip: {
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
    borderColor: 'rgba(140, 111, 86, 0.12)',
    borderWidth: 0.5,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  resultTagChipText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  resultBeanDesc: {
    ...typography.L5,
    color: colors.espressoBrown,
    lineHeight: 16,
    opacity: 0.8,
  },
  resultGoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: colors.espressoBrown,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 6,
    alignSelf: 'stretch',
  },
  resultGoText: {
    ...typography.L4,
    fontSize: 12,
    fontWeight: '700',
    color: colors.white,
  },

  // 🎚️ 커스텀 슬라이더 바 스타일 (한 화면 컴팩트 핏)
  sliderContainer: {
    marginBottom: 2,
    width: '100%',
  },
  sliderLabel: {
    ...typography.L5,
    fontSize: 11,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  sliderActiveVal: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.mochaBrown,
  },
  sliderTrackWrapper: {
    height: 24,
    justifyContent: 'center',
    position: 'relative',
    marginTop: 0,
  },
  sliderTrackBase: {
    height: 4,
    backgroundColor: colors.mutedSand,
    borderRadius: 2,
    position: 'absolute',
    left: 10,
    right: 10,
  },
  sliderTrackActive: {
    height: 4,
    backgroundColor: colors.mochaBrown,
    borderRadius: 2,
    position: 'absolute',
    left: 10,
  },
  sliderNodesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    position: 'absolute',
    left: 10,
    right: 10,
    top: 0,
    bottom: 0,
    alignItems: 'center',
  },
  sliderLabelsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: -20,
    marginTop: -2,
  },
  sliderNodeTouch: {
    width: 60,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sliderNodeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.mutedSand,
    borderWidth: 1,
    borderColor: colors.white,
  },
  sliderNodeDotActive: {
    backgroundColor: colors.mochaBrown,
  },
  sliderNodeThumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.white,
    borderWidth: 4,
    borderColor: colors.espressoBrown,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  sliderNodeLabel: {
    fontSize: 9,
    color: colors.stone300,
    fontWeight: '600',
    width: 60,
    textAlign: 'center',
  },
  sliderNodeLabelSelected: {
    color: colors.espressoBrown,
    fontWeight: '800',
  },
  sliderNodeThumbAbsolute: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.white,
    borderWidth: 4,
    borderColor: colors.espressoBrown,
    position: 'absolute',
    top: 3,
    marginLeft: -9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
});

// 모달 스타일 (FormSheet 패턴)
const modalStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center' as const,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
    gap: 4,
  },
  handle: {
    width: 40, height: 4,
    borderRadius: 999,
    backgroundColor: colors.stone300,
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: { ...typography.L1, color: colors.espressoBrown, marginBottom: 16, fontSize: 18 },
  label: { ...typography.L5, fontWeight: '700', color: colors.mochaBrown, marginBottom: 6 },
  input: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...typography.L4,
    color: colors.espressoBrown,
  },
  inputMulti: { height: 80, textAlignVertical: 'top' },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  counterBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counterVal: {
    ...typography.L4,
    color: colors.espressoBrown,
    fontWeight: '800',
    minWidth: 32,
    textAlign: 'center',
  },
  saveBtn: {
    marginTop: 20,
    backgroundColor: colors.espressoBrown,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  saveBtnText: { ...typography.L3, color: colors.white },

  // 🎛️ 매장 센서 연동 토글 행
  featureToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 16,
  },
  featureToggleDesc: {
    fontSize: 10,
    color: colors.stone300,
    lineHeight: 14,
  },
});

// 🟢 [한글 주석: 실시간(LIVE) 대시보드 컴포넌트 전용 스타일 시트]
const liveComponentStyles = StyleSheet.create({
  pulseBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#E8F5E9',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#2E7D32',
  },
  pulseText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#2E7D32',
  },
  tickerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(234, 88, 12, 0.06)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(234, 88, 12, 0.12)',
  },
  tickerText: {
    ...typography.L5,
    fontSize: 11,
    color: colors.espressoBrown,
    fontWeight: '700',
    flex: 1,
  },
  shotBadge: {
    backgroundColor: 'rgba(140, 111, 86, 0.10)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  shotBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  shotBadgeDecaf: {
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  shotBadgeTextDecaf: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.mochaBrown,
  },
  gaugeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  gaugeTrack: {
    flex: 1,
    height: 5,
    backgroundColor: colors.coffeeCream,
    borderRadius: 3,
    overflow: 'hidden',
  },
  gaugeFill: {
    height: '100%',
    borderRadius: 3,
  },
  gaugeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.mochaBrown,
  },

  // 센서 미연결(회색) 배지 상태
  pulseBadgeContainerOff: {
    backgroundColor: 'rgba(120, 113, 108, 0.08)',
    borderColor: 'rgba(120, 113, 108, 0.18)',
  },
  pulseDotOff: {
    backgroundColor: '#A8A29E',
  },
  pulseTextOff: {
    color: '#78716C',
  },

  // 데모 모드(주황) 배지 상태 — 센서 0개 연결
  pulseBadgeContainerDemo: {
    backgroundColor: '#FEF3E2',
    borderColor: '#FDE4C0',
  },
  pulseDotDemo: {
    backgroundColor: '#B45309',
  },
  pulseTextDemo: {
    color: '#B45309',
  },

  // 🔌 데모 모드 센서 연동 유도 배너
  demoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FEF7EC',
    borderWidth: 1,
    borderColor: '#FDE4C0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  demoBannerTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#92400E',
  },
  demoBannerDesc: {
    fontSize: 10,
    color: '#B45309',
    marginTop: 1,
    lineHeight: 14,
  },
  demoBannerCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#B45309',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  demoBannerCtaText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.white,
  },

  // 부분 연결 시 얇은 진행 줄
  partialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
  },
  partialRowText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.mochaBrown,
    flex: 1,
  },

  // 게이지 옆 실측/데모 미니 태그
  liveTag: {
    backgroundColor: '#E8F5E9',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  liveTagText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#2E7D32',
  },
  demoTag: {
    backgroundColor: 'rgba(120, 113, 108, 0.10)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  demoTagText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#78716C',
  },

  // RFID 태그 · 소진 예상 보조 텍스트
  rfidTagText: {
    fontSize: 8,
    fontWeight: '800',
    color: colors.stone300,
    letterSpacing: 0.5,
  },
  depletionText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#D97706',
  },

  // 🛠️ 설비 미니 상태 스트립 (머신·우유·정수·냉장)
  equipStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.coffeeCream,
  },
  equipChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(140, 111, 86, 0.12)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  equipChipText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  equipAlertText: {
    color: '#C0392B',
  },
  // 미연결 센서 칩 (점선 테두리 + 회색 텍스트, 탭하면 페어링 가이드로)
  equipChipDemo: {
    backgroundColor: 'transparent',
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: 'rgba(120, 113, 108, 0.35)',
  },
  equipChipTextDemo: {
    color: '#A8A29E',
  },
});

// 🤖 [한글 주석: AI 발주 코치 카드 전용 스타일 시트]
const coachStyles = StyleSheet.create({
  updatedAt: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.stone300,
  },
  item: {
    flexDirection: 'row',
    backgroundColor: colors.creamSand,
    borderRadius: 12,
    overflow: 'hidden',
  },
  bar: {
    width: 4,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    padding: 11,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  priorityChip: {
    borderRadius: 5,
    borderWidth: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  priorityChipText: {
    fontSize: 9,
    fontWeight: '800',
  },
  title: {
    ...typography.L4,
    fontSize: 13,
    fontWeight: '800',
    color: colors.espressoBrown,
    flex: 1,
  },
  reason: {
    ...typography.L5,
    fontSize: 11,
    color: colors.mochaBrown,
    lineHeight: 16,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(140, 111, 86, 0.07)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 2,
  },
  actionText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.espressoBrown,
    flex: 1,
    lineHeight: 15,
  },
  source: {
    fontSize: 8,
    fontWeight: '600',
    color: colors.stone300,
    alignSelf: 'flex-end',
  },
});

