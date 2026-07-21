// WeekdayButtonGroup – Simple button style for selecting multiple weekdays
// 한글 주석: 각 요일을 독립 버튼으로 표시하고, 선택 토글시 상태를 관리합니다.
import { PressableScale } from '../motion';
import { StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';

const DAYS_OF_WEEK = ['월', '화', '수', '목', '금', '토', '일'];

interface WeekdayButtonGroupProps {
  /** 현재 선택된 요일 배열 (예: ['월', '수']) */
  selectedDays: string[];
  /** 선택이 변경될 때 호출되는 콜백 */
  onChange: (days: string[]) => void;
}

export function WeekdayButtonGroup({ selectedDays, onChange }: WeekdayButtonGroupProps) {
  const handleToggle = (day: string) => {
    if (selectedDays.includes(day)) {
      onChange(selectedDays.filter(d => d !== day));
    } else {
      const newSel = [...selectedDays, day];
      // 순서를 원래 DAYS_OF_WEEK 순서대로 정렬
      const sorted = DAYS_OF_WEEK.filter(d => newSel.includes(d));
      onChange(sorted);
    }
  };

  return (
    <View style={styles.container}>
      {DAYS_OF_WEEK.map(day => {
        const isActive = selectedDays.includes(day);
        return (
          <PressableScale
            key={day}
            onPress={() => handleToggle(day)}
            to={0.9}
            style={[styles.chipWrapper, isActive && styles.activeWrapper]}
          >
            <View style={[styles.chip, isActive && styles.activeChip]}>
              <Text style={[styles.chipText, isActive && styles.activeText]}>{day}</Text>
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 8,
    gap: 8,
  },
  chipWrapper: {
    flex: 1,
    maxWidth: 44,
    maxHeight: 44,
  },
  chip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.coffeeCream,
    borderColor: 'rgba(140,111,86,0.15)',
  },
  activeChip: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  chipText: {
    ...typography.L3,
    fontSize: 14,
    fontWeight: '800',
    color: colors.espressoBrown,
  },
  activeText: {
    color: colors.white,
  },
  activeWrapper: {},
});
