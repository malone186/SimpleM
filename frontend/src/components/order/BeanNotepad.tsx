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

// 🟢 [한글 주석: 실시간으로 부드럽게 점멸(Pulse)하는 라이브 연동 배지 컴포넌트]
const LivePulseBadge: React.FC<{ label?: string }> = ({ label = 'LIVE 실시간 연동' }) => {
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

  return (
    <View style={liveComponentStyles.pulseBadgeContainer}>
      <Animated.View style={[liveComponentStyles.pulseDot, { opacity: pulseAnim }]} />
      <Text style={liveComponentStyles.pulseText}>{label}</Text>
    </View>
  );
};

// 📺 [한글 주석: 매장 원두 가동 상태를 전광판처럼 롤링 전송해주는 실시간 틱커 배너]
const TICKER_MESSAGES = [
  '🟢 [실시간] 카페인 호퍼 온·습도 93.5°C / 45% 최적 유지',
  '☕ [방금 전] 콜롬비아 원두 에스프레소 142번째 샷 추출 완료',
  '⚡ [센서 연동] 디카페인 호퍼 잔여량 60% (1.2kg 남음)',
  '💡 [AI 추천] 주말 피크타임 전 카페인 원두 1.5kg 추가 장착 추천',
];

const LiveTickerBanner: React.FC = () => {
  const [index, setIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setIndex((prev) => (prev + 1) % TICKER_MESSAGES.length);
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
        {TICKER_MESSAGES[index]}
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
  return (
    <View style={styles.wrapper}>

      {/* ━━━ 현재 사용 중인 원두 카드 (실시간 라이브 대시보드 연출) ━━━ */}
      <View style={styles.card}>
        {/* [한글 주석: 실시간 매장 원두 가동 상태 롤링 피드 틱커] */}
        <LiveTickerBanner />

        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>현재 사용 중인 원두</Text>
            {/* [한글 주석: 실시간 점멸 연동 라이브 배지] */}
            <LivePulseBadge />
          </View>
          <TouchableOpacity style={styles.editBtn} onPress={openCurrentEdit}>
            <Ionicons name="pencil-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.editBtnText}>수정</Text>
          </TouchableOpacity>
        </View>

        {/* 카페인 원두 정보 및 실시간 샷/호퍼 잔여량 게이지 */}
        <View style={styles.currentRow}>
          <View style={styles.currentLabel}>
            <Ionicons name="cafe" size={14} color={colors.espressoBrown} />
            <Text style={styles.currentLabelText}>카페인</Text>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[styles.currentValue, !data.currentCaffeine && styles.currentEmpty]}>
                {data.currentCaffeine || '아직 입력하지 않았어요'}
              </Text>
              {data.currentCaffeine ? (
                <View style={liveComponentStyles.shotBadge}>
                  <Text style={liveComponentStyles.shotBadgeText}>오늘 142잔 추출</Text>
                </View>
              ) : null}
            </View>

            {/* [한글 주석: 실시간 호퍼 잔량 프로그레스 바 게이지] */}
            {data.currentCaffeine ? (
              <View style={liveComponentStyles.gaugeRow}>
                <View style={liveComponentStyles.gaugeTrack}>
                  <View style={[liveComponentStyles.gaugeFill, { width: '85%', backgroundColor: colors.espressoBrown }]} />
                </View>
                <Text style={liveComponentStyles.gaugeText}>호퍼 85% (1.7kg)</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.divider} />

        {/* 디카페인 원두 정보 및 실시간 샷/호퍼 잔여량 게이지 */}
        <View style={styles.currentRow}>
          <View style={styles.currentLabel}>
            <Ionicons name="cafe-outline" size={14} color={colors.mochaBrown} />
            <Text style={styles.currentLabelText}>디카페인</Text>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[styles.currentValue, !data.currentDecaf && styles.currentEmpty]}>
                {data.currentDecaf || '아직 입력하지 않았어요'}
              </Text>
              {data.currentDecaf ? (
                <View style={liveComponentStyles.shotBadgeDecaf}>
                  <Text style={liveComponentStyles.shotBadgeTextDecaf}>오늘 48잔 추출</Text>
                </View>
              ) : null}
            </View>

            {/* [한글 주석: 실시간 호퍼 잔량 프로그레스 바 게이지] */}
            {data.currentDecaf ? (
              <View style={liveComponentStyles.gaugeRow}>
                <View style={liveComponentStyles.gaugeTrack}>
                  <View style={[liveComponentStyles.gaugeFill, { width: '60%', backgroundColor: colors.mochaBrown }]} />
                </View>
                <Text style={liveComponentStyles.gaugeText}>호퍼 60% (1.2kg)</Text>
              </View>
            ) : null}
          </View>
        </View>

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
});

