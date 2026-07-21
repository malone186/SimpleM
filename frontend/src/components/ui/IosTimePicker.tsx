// [iOS 스타일 드럼 휠 시간 선택기 - 2차 개선]
// PC 웹 환경에서 마우스 클릭 및 휠 스크롤을 통해 부드럽게 시간을 조작할 수 있도록 5줄 확장형 드럼 휠을 설계했습니다.
import { useEffect, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, typography } from '../../theme';

// 시작 시간 후보군 (00시 ~ 23시)
const START_HOURS = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));
// 종료 시간 후보군 (00시 ~ 24시, 자정 마감 고려)
const END_HOURS = Array.from({ length: 25 }, (_, i) => i.toString().padStart(2, '0'));

// 휠의 1칸당 세로 높이 (스냅 크기 기준 - 콤팩트 축소)
const ITEM_HEIGHT = 36;

interface IosTimePickerProps {
  // 시간 값 (형식: "09–15" 혹은 "13–21")
  value: string;
  // 시간 변경 시 호출되는 콜백 함수 (형식: "09–15" 반환)
  onChange: (value: string) => void;
  // [한글 주석] 시작 시간 컬럼 헤더 라벨 (기본값: '시작 시간', 예: '오픈 시간')
  startLabel?: string;
  // [한글 주석] 종료 시간 컬럼 헤더 라벨 (기본값: '종료 시간', 예: '마감 시간')
  endLabel?: string;
}

export function IosTimePicker({
  value,
  onChange,
  startLabel = '시작 시간',
  endLabel = '종료 시간',
}: IosTimePickerProps) {
  // [시간 파싱] 기존의 "시작시–종료시" 형식 파싱 (대시 기호 유연성 처리)
  const parseTime = (val: string) => {
    if (!val) return { start: '09', end: '18' };
    const parts = val.split(/[–-]/); // 대시(–) 또는 하이픈(-) 매칭
    const start = parts[0]?.trim().padStart(2, '0') || '09';
    const end = parts[1]?.trim().padStart(2, '0') || '18';
    return { start, end };
  };

  const { start: initialStart, end: initialEnd } = parseTime(value);

  const [startHour, setStartHour] = useState(initialStart);
  const [endHour, setEndHour] = useState(initialEnd);

  // [상태 동기화] 내부 선택값이 변할 때 부모 상태로 포맷팅 전달
  const handleTimeChange = (newStart: string, newEnd: string) => {
    onChange(`${newStart}–${newEnd}`);
  };

  return (
    <View style={styles.pickerContainer}>
      {/* 시작/오픈 시간 휠 스피너 */}
      <View style={styles.wheelWrapper}>
        <Text style={styles.wheelTitle}>{startLabel}</Text>
        <HourWheel
          items={START_HOURS}
          selectedValue={startHour}
          onValueChange={(val) => {
            setStartHour(val);
            handleTimeChange(val, endHour);
          }}
        />
      </View>

      {/* 중앙 연결 연산자 (물결선) */}
      <View style={styles.dividerWrapper}>
        <Text style={styles.dividerText}>~</Text>
      </View>

      {/* 종료/마감 시간 휠 스피너 */}
      <View style={styles.wheelWrapper}>
        <Text style={styles.wheelTitle}>{endLabel}</Text>
        <HourWheel
          items={END_HOURS}
          selectedValue={endHour}
          onValueChange={(val) => {
            setEndHour(val);
            handleTimeChange(startHour, val);
          }}
        />
      </View>
    </View>
  );
}

// ==========================================
// [단일 세로 드럼 휠 스크롤 컴포넌트]
// ==========================================
interface HourWheelProps {
  items: string[];
  selectedValue: string;
  onValueChange: (value: string) => void;
}

function HourWheel({ items, selectedValue, onValueChange }: HourWheelProps) {
  const scrollRef = useRef<ScrollView>(null);
  
  // [5줄 확장 패딩 적용] 
  // 5줄 휠 피커의 정가운데(3번째 행)에 선택 아이템이 고정되도록 앞뒤에 각각 2개씩 빈 여백 추가
  const fullItems = ['', '', ...items, '', ''];
  const [isScrolling, setIsScrolling] = useState(false);

  // 현재 활성화된 값의 인덱스 매핑 (패딩 2개가 앞에 있으므로 index + 2)
  const targetIndex = items.indexOf(selectedValue);

  // [초기 스크롤 및 포커스 동기화] 
  // 외부 값 주입 혹은 클릭 시 해당 픽셀 오프셋(targetIndex * ITEM_HEIGHT)으로 스무스하게 롤링
  useEffect(() => {
    if (targetIndex !== -1 && scrollRef.current && !isScrolling) {
      const timer = setTimeout(() => {
        scrollRef.current?.scrollTo({
          y: targetIndex * ITEM_HEIGHT,
          animated: true,
        });
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [targetIndex, isScrolling]);

  // [스크롤 종료 감지] 손가락 드래그나 마우스 휠이 끝났을 때 중심선을 기반으로 값을 재스냅
  const handleScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIsScrolling(false);
    const yOffset = e.nativeEvent.contentOffset.y;
    // 가장 가까운 42px 경계선 인덱스 계산
    const index = Math.round(yOffset / ITEM_HEIGHT);
    const clampedIndex = Math.max(0, Math.min(items.length - 1, index));
    const newValue = items[clampedIndex];

    if (newValue && newValue !== selectedValue) {
      onValueChange(newValue);
    }
  };

  const handleScrollBegin = () => {
    setIsScrolling(true);
  };

  // [웹 친화적 스크롤 스타일 정의] 
  // PC 웹 환경에서 브라우저 스크롤 휠이 자석처럼 들러붙고 지저분한 스크롤바가 숨겨지도록 인라인 스타일 병합
  const webScrollStyle = Platform.OS === 'web' ? {
    scrollSnapType: 'y mandatory',
    scrollbarWidth: 'none' as const,
  } : {};

  return (
    <View style={styles.wheelOuter}>
      {/* 중앙 포커스 가이드라인 영역 (5줄 중 정확히 3번째 줄에 붉은 띠 보더 매핑) */}
      <View style={styles.selectionIndicator} />

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScrollBeginDrag={handleScrollBegin}
        onMomentumScrollBegin={handleScrollBegin}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollEndDrag={handleScrollEnd}
        contentContainerStyle={{ paddingVertical: 0 }}
        style={[styles.scrollView, webScrollStyle as any]}
      >
        {fullItems.map((item, idx) => {
          // 양 끝 빈 영역 패딩 렌더링
          if (item === '') {
            return (
              <View 
                key={`pad-${idx}`} 
                style={{ 
                  height: ITEM_HEIGHT,
                  ...(Platform.OS === 'web' ? { scrollSnapAlign: 'start' } : {}) 
                }} 
              />
            );
          }

          // 해당 셀이 선택된 값인지 여부
          const isSelected = item === selectedValue;
          
          // [한글 주석: 입체 3D 각도 연출]
          // 중앙에서 멀어질수록 투명도를 부여해 3D 구체(Sphere)의 곡면 실린더를 구현
          const distanceFromSelected = Math.abs((idx - 2) - targetIndex);
          const opacity = Math.max(0.2, 1 - distanceFromSelected * 0.35);

          return (
            <Pressable
              key={item}
              onPress={() => {
                // [웹 조작성 핵심] 마우스 드래그가 먹히지 않는 PC 환경에서 숫자를 '딸깍 클릭'하면 자동으로 휠이 이동
                if (!isScrolling) {
                  onValueChange(item);
                }
              }}
              style={({ pressed }) => [
                styles.itemWrapper,
                pressed && { backgroundColor: 'rgba(78, 54, 41, 0.05)' },
                Platform.OS === 'web' ? { scrollSnapAlign: 'start' } : {}
              ]}
            >
              <Text
                style={[
                  styles.itemText,
                  isSelected ? styles.itemTextSelected : styles.itemTextUnselected,
                  { opacity } // [3D 기법] 불투명도 조절로 원근감 구현
                ]}
              >
                {item}시
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // [전체 피커 레이아웃] 두 개 휠을 중앙 정렬로 좌우 수평 매치
  pickerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.coffeeCream + '40',
    borderRadius: 14,
    borderWidth: 1.2,
    borderColor: colors.mutedSand,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  // [개별 휠 블록]
  wheelWrapper: {
    flex: 1,
    alignItems: 'center',
  },
  // [휠 윗쪽 소제목]
  wheelTitle: {
    ...typography.L4,
    fontSize: 12,
    color: colors.espressoBrown,
    fontWeight: '800',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  // [휠 바깥 컨테이너] 높이를 딱 5줄 크기(ITEM_HEIGHT * 5 = 210px)로 설정
  wheelOuter: {
    height: ITEM_HEIGHT * 5,
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    width: '100%',
    height: '100%',
  },
  // [선택 지시선 영역] 중앙에 위치한 3번째 줄을 반투명 바와 상하단 보더로 고정
  selectionIndicator: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    top: ITEM_HEIGHT * 2, // 5줄 중 3번째 줄의 위치 (42 * 2 = 84px)
    height: ITEM_HEIGHT, // 42px 크기 확보
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: colors.pointOrange + '40', // 은은한 오렌지 지시 가이드 라인
    backgroundColor: colors.pointOrange + '08',
    borderRadius: 8,
    pointerEvents: 'none', // 클릭 간섭 방지
  },
  // [중앙 배치 셀]
  itemWrapper: {
    height: ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  // [글자 기본값]
  itemText: {
    ...typography.L3,
    textAlign: 'center',
  },
  // [선택된 시간] 진하고 또렷한 에스프레소 브라운 계열로 강조
  itemTextSelected: {
    color: colors.espressoBrown,
    fontWeight: '900',
    fontSize: 16,
  },
  // [선택되지 않은 스피너 리스트] 톤다운 처리 및 옅은 브라운
  itemTextUnselected: {
    color: colors.mochaBrown,
    fontWeight: '500',
    fontSize: 13,
  },
  // [중앙 분할기 영역]
  dividerWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: 26, // 제목 높이 보정
  },
  dividerText: {
    ...typography.L2,
    color: colors.mochaBrown,
    fontWeight: '300',
  },
});
