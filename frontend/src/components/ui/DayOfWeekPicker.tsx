// [요일 다중 선택 컴포넌트 - 3차 애니메이션 개선]
// 탭 시 팍팍 바뀌던 투박한 색상 변화를 Animated API 기반의 부드러운 전이(Transition) 효과로 업그레이드했습니다.
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, typography } from '../../theme';
import { PressableScale } from '../motion';

// 요일 목록 정의 (월요일부터 일요일까지)
const DAYS_OF_WEEK = ['월', '화', '수', '목', '금', '토', '일'];

interface DayOfWeekPickerProps {
  // 현재 선택된 요일들의 배열 (예: ['월', '수', '금'])
  selectedDays: string[];
  // 요일 선택이 변경될 때 호출되는 콜백 함수
  onChange: (days: string[]) => void;
}

export function DayOfWeekPicker({ selectedDays, onChange }: DayOfWeekPickerProps) {
  // [토글 핸들러] 요일 버튼을 눌렀을 때 선택 상태를 전환합니다.
  const handleToggleDay = (day: string) => {
    if (selectedDays.includes(day)) {
      // 이미 선택되어 있다면 제거
      onChange(selectedDays.filter((d) => d !== day));
    } else {
      // 선택되어 있지 않다면 추가 (순서대로 정렬)
      const newSelection = [...selectedDays, day];
      const sortedSelection = DAYS_OF_WEEK.filter((d) => newSelection.includes(d));
      onChange(sortedSelection);
    }
  };

  return (
    <View style={styles.container}>
      {DAYS_OF_WEEK.map((day) => {
        // [활성화 여부 검사] 현재 요일이 선택 목록에 포함되어 있는지 확인
        const isActive = selectedDays.includes(day);

        return (
          <AnimatedDayChip
            key={day}
            day={day}
            isActive={isActive}
            onPress={() => handleToggleDay(day)}
          />
        );
      })}
    </View>
  );
}

// ==========================================
// [애니메이션 지원 개별 요일 칩 컴포넌트]
// ==========================================
interface AnimatedDayChipProps {
  day: string;
  isActive: boolean;
  onPress: () => void;
}

function AnimatedDayChip({ day, isActive, onPress }: AnimatedDayChipProps) {
  // [애니메이션 상태값 설정] 활성 유무에 따라 0 또는 1로 수렴
  const animValue = useRef(new Animated.Value(isActive ? 1 : 0)).current;

  // [상태 변동 감지 및 부드러운 트랜지션 구동]
  useEffect(() => {
    Animated.timing(animValue, {
      toValue: isActive ? 1 : 0,
      duration: 220, // 0.22초 동안 미려하게 페이드 효과 수행
      useNativeDriver: false, // 배경색/테두리색 속성은 JS 스레드 보간 활용
    }).start();
  }, [isActive]);

  // [배경색 보간 필터] 0 (비활성 커피크림) ➡️ 1 (활성 오렌지)
  const backgroundColor = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.coffeeCream, colors.pointOrange],
  });

  // [테두리색 보간 필터] 0 (비활성 연한모카) ➡️ 1 (활성 오렌지)
  const borderColor = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(140, 111, 86, 0.15)', colors.pointOrange],
  });

  // [글자색 보간 필터] 0 (비활성 에스프레소 브라운) ➡️ 1 (활성 화이트)
  const textColor = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.espressoBrown, colors.white],
  });

  return (
    <PressableScale
      onPress={onPress}
      to={0.86} // 탭할 때 통통 튀는 탄성 햅틱 스케일 반응성 지정
      style={styles.chipWrapper}
    >
      <Animated.View style={[styles.dayChip, { backgroundColor, borderColor }]}>
        <Animated.Text style={[styles.dayText, { color: textColor }]}>
          {day}
        </Animated.Text>
      </Animated.View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  // [전체 컨테이너] 중앙에 예쁘게 정렬하고 버튼 간격을 균등 배치
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 8,
    gap: 8,
  },
  chipWrapper: {
    // 횡방향 균등 배치를 원할 경우 flex: 1을 주고 최대폭 잠금
    flex: 1,
    maxWidth: 44,
    maxHeight: 44,
  },
  // [기본 칩 스타일] 완전한 동그라미 레이아웃
  dayChip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.2,
  },
  // [텍스트 스타일] 굵고 정갈한 서체
  dayText: {
    ...typography.L3,
    fontSize: 14,
    fontWeight: '800',
  },
});
